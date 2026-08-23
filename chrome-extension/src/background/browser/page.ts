import 'webextension-polyfill';
import {
  connect,
  ExtensionTransport,
  type HTTPRequest,
  type HTTPResponse,
  type ProtocolType,
  type KeyInput,
} from 'puppeteer-core/lib/esm/puppeteer/puppeteer-core-browser.js';
import { createLogger } from '@src/background/log';
import {
  getClickableElements as _getClickableElements,
  removeHighlights as _removeHighlights,
  getScrollInfo as _getScrollInfo,
  scrollPage as _scrollPage,
} from './dom/service';
import { DOMElementNode, type DOMState } from './dom/views';
import {
  ACTIVITY_STOP_BINDING,
  flashActivityCapture,
  moveActivityCursor,
  pulseActivityTarget,
  removeActivityOverlay,
  renderActivityOverlay,
  setActivityOverlayHidden,
  takeActivityStopRequest,
  type ActivityOverlayContent,
  type ActivityTargetRect,
} from './activityOverlay';
import { type BrowserContextConfig, DEFAULT_BROWSER_CONTEXT_CONFIG, type PageState, URLNotAllowedError } from './views';
import { ClickableElementProcessor } from './dom/clickable/service';
import { isUrlAllowed } from './util';
import type { Browser } from 'puppeteer-core/lib/esm/puppeteer/api/Browser.js';
import type { Page as PuppeteerPage } from 'puppeteer-core/lib/esm/puppeteer/api/Page.js';
import type { ElementHandle } from 'puppeteer-core/lib/esm/puppeteer/api/ElementHandle.js';
import type { Frame } from 'puppeteer-core/lib/esm/puppeteer/api/Frame.js';

const logger = createLogger('Page');

/**
 * How long a click is waited on before the agent stops blocking on it.
 *
 * This bounds waiting only. The click is not cancellable once dispatched, so exceeding this is not
 * treated as "the click failed" - see `clickElementNode`.
 */
const CLICK_DEADLINE_MS = 2000;

/** How often the overlay's stop button is polled, on the pages where its binding did not install. */
const ACTIVITY_STOP_POLL_MS = 500;

/**
 * The absolute ceiling on waiting for a click to settle.
 *
 * Past the deadline the click is left to land rather than being repeated, but it still has to be
 * bounded: a renderer blocked on a modal dialog or a synchronous loop never returns and never
 * rejects, and the agent checks for cancellation only between actions - so an unbounded wait means
 * Stop does nothing and the task cannot end. Generous enough that a merely slow click finishes.
 */
const CLICK_SETTLE_CEILING_MS = 30_000;

const IGNORED_URL_PATTERNS = new Set([
  // Analytics and tracking. The two hosts are named in full because host labels are matched
  // whole: `google-analytics` is not `analytics`, and splitting labels on hyphens to make it one
  // would also ignore `metrics-dashboard.example.com`, which a page genuinely renders from.
  'google-analytics.com',
  'googletagmanager.com',
  'analytics',
  'tracking',
  'telemetry',
  'beacon',
  'metrics',
  // Ad-related
  'doubleclick',
  'adsystem',
  'adserver',
  'advertising',
  // Social media widgets
  'facebook.com/plugins',
  'platform.twitter',
  'linkedin.com/embed',
  // Live chat and support
  'livechat',
  'zendesk',
  'intercom',
  'crisp.chat',
  'hotjar',
  // Push notifications
  'push-notifications',
  'onesignal',
  'pushwoosh',
  // Background sync/heartbeat
  'heartbeat',
  'ping',
  'alive',
  // WebRTC and streaming
  'webrtc',
  'rtmp://',
  'wss://',
  // Common CDNs
  'cloudfront.net',
  'fastly.net',
]);

/**
 * Whether a URL is one of the background chatter the wait should not care about.
 *
 * Matched against the host's labels and the path's segments rather than the raw string. A bare
 * `url.includes(pattern)` made `ping` match `shopping.com`, `/api/shipping/` and `/mapping/`,
 * so requests those pages genuinely depend on were dropped from the wait.
 */
export const isIgnoredUrl = (raw: string): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  const hostLabels = host.split('.');
  const segments = parsed.pathname.toLowerCase().split('/').filter(Boolean);
  return Array.from(IGNORED_URL_PATTERNS).some(pattern => {
    // A pattern carrying a dot or a scheme names a host, e.g. `cloudfront.net`, `wss://`.
    if (pattern.includes('://')) return raw.startsWith(pattern);
    if (pattern.includes('.')) return host === pattern || host.endsWith(`.${pattern}`);
    // Otherwise it is a word, and it has to be a whole host label or a whole path segment.
    //
    // Host labels are compared whole while path segments are split on `-` and `_`, which is a
    // deliberate asymmetry: a hostname is someone's identity and `metrics-dashboard.example.com` is
    // not a metrics endpoint, whereas `/api/user-analytics-v2` plainly is one. Where the two rules
    // disagree the tie goes to waiting — a request wrongly waited for costs at most the
    // stale-request expiry, while one wrongly ignored gets the page parsed mid-flight.
    return (
      hostLabels.includes(pattern) ||
      segments.some(segment => segment === pattern || segment.split(/[-_.]/).includes(pattern))
    );
  });
};

export function build_initial_state(tabId?: number, url?: string, title?: string): PageState {
  return {
    elementTree: new DOMElementNode({
      tagName: 'root',
      isVisible: true,
      parent: null,
      xpath: '',
      attributes: {},
      children: [],
    }),
    selectorMap: new Map(),
    tabId: tabId || 0,
    url: url || '',
    title: title || '',
    screenshot: null,
    scrollY: 0,
    scrollHeight: 0,
    visualViewportHeight: 0,
  };
}

/**
 * Cached clickable elements hashes for the last state
 */
export class CachedStateClickableElementsHashes {
  url: string;
  hashes: Set<string>;

  constructor(url: string, hashes: Set<string>) {
    this.url = url;
    this.hashes = hashes;
  }
}

export default class Page {
  private _tabId: number;
  private _browser: Browser | null = null;
  private _puppeteerPage: PuppeteerPage | null = null;
  private _config: BrowserContextConfig;
  private _state: PageState;
  private _validWebPage = false;
  private _cachedState: PageState | null = null;
  private _cachedStateClickableElementsHashes: CachedStateClickableElementsHashes | null = null;

  constructor(tabId: number, url: string, title: string, config: Partial<BrowserContextConfig> = {}) {
    this._tabId = tabId;
    this._config = { ...DEFAULT_BROWSER_CONTEXT_CONFIG, ...config };
    this._state = build_initial_state(tabId, url, title);
    // chrome://newtab/, chrome://newtab/extensions, https://chromewebstore.google.com/ are not valid web pages, can't be attached
    const lowerCaseUrl = url.trim().toLowerCase();
    this._validWebPage =
      (tabId &&
        lowerCaseUrl &&
        lowerCaseUrl.startsWith('http') &&
        !lowerCaseUrl.startsWith('https://chromewebstore.google.com')) ||
      false;
  }

  get tabId(): number {
    return this._tabId;
  }

  get validWebPage(): boolean {
    return this._validWebPage;
  }

  get attached(): boolean {
    return this._validWebPage && this._puppeteerPage !== null;
  }

  async attachPuppeteer(): Promise<boolean> {
    if (!this._validWebPage) {
      return false;
    }

    if (this._puppeteerPage) {
      return true;
    }

    logger.info('attaching puppeteer', this._tabId);
    const browser = await connect({
      transport: await ExtensionTransport.connectTab(this._tabId),
      defaultViewport: null,
      protocol: 'cdp' as ProtocolType,
    });
    this._browser = browser;

    const [page] = await browser.pages();
    this._puppeteerPage = page;

    // Add anti-detection scripts
    await this._addAntiDetectionScripts();

    this._handleJavaScriptDialogs();

    return true;
  }

  /**
   * Answer JavaScript dialogs, so one can never freeze the tab.
   *
   * With CDP attached and `Page.enable` on, Chrome suppresses the native dialog UI and blocks the
   * renderer until someone sends `Page.handleJavaScriptDialog`. Puppeteer only re-emits the event;
   * nothing here used to listen. So a `confirm()` behind "unsubscribe me" or "delete these files"
   * stopped the renderer dead, every later evaluate/screenshot/input on that tab hung, and the
   * click sat on an unbounded `await`. Stop could not free it either - it sets a flag and aborts an
   * AbortController that a CDP call does not observe - so the task was genuinely unkillable short
   * of closing the tab.
   *
   * `confirm` and `prompt` are DISMISSED, not accepted. A dialog is the last gate a site puts in
   * front of something irreversible, and an agent that clicks OK on every one of them is an agent
   * that deletes the account. Dismissing loses nothing that cannot be retried; accepting can lose
   * something that cannot. `alert` carries no choice, and `beforeunload` is answered so a navigation
   * the agent decided on is not vetoed by a form it filled in itself.
   */
  private _handleJavaScriptDialogs(): void {
    this._puppeteerPage?.on('dialog', dialog => {
      const type = dialog.type();
      const accept = type === 'alert' || type === 'beforeunload';
      logger.info(`${accept ? 'accepting' : 'dismissing'} ${type} dialog: ${dialog.message()}`);
      const answered = accept ? dialog.accept() : dialog.dismiss();
      // A dialog already gone (the page navigated, the tab closed) rejects here. Nothing is left to
      // free at that point, and an unhandled rejection in a listener would be the only consequence.
      answered.catch(error => logger.warning('could not answer dialog:', error));
    });
  }

  private async _addAntiDetectionScripts(): Promise<void> {
    if (!this._puppeteerPage) {
      return;
    }

    await this._puppeteerPage.evaluateOnNewDocument(`
      // Webdriver property
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined
      });

      // Languages
      // Object.defineProperty(navigator, 'languages', {
      //   get: () => ['en-US']
      // });

      // Plugins
      // Object.defineProperty(navigator, 'plugins', {
      //   get: () => [1, 2, 3, 4, 5]
      // });

      // Chrome runtime
      window.chrome = { runtime: {} };

      // Permissions
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications' ?
          Promise.resolve({ state: Notification.permission }) :
          originalQuery(parameters)
      );

      // Shadow DOM
      (function () {
        const originalAttachShadow = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function attachShadow(options) {
          return originalAttachShadow.call(this, { ...options, mode: "open" });
        };
      })();
    `);
  }

  async detachPuppeteer(): Promise<void> {
    // Before anything else: an interval left running holds a reference to a page that is going away,
    // and would keep evaluating against a detached target every half second.
    this._stopActivityStopPolling();
    if (this._browser) {
      await this._browser.disconnect();
      this._browser = null;
      this._puppeteerPage = null;
      // reset the state
      this._state = build_initial_state(this._tabId);
    }
  }

  /**
   * What the on-page banner says while this page is being driven, or null when the agent is not
   * announcing itself on it. Held so a navigation, which wipes the overlay along with the document,
   * can be answered by redrawing the same content rather than by losing it.
   */
  private _activityContent: ActivityOverlayContent | null = null;
  /** Called when the user presses the overlay's stop button. Set by the BrowserContext. */
  private _activityStopHandler: (() => void) | null = null;
  /** Whether `ACTIVITY_STOP_BINDING` has been bound on this page. Binding twice throws. */
  private _activityStopBound = false;
  /** Set only when the binding did not take, and the stop button has to be polled for instead. */
  private _activityStopPoll: ReturnType<typeof setInterval> | null = null;

  setActivityStopHandler(handler: (() => void) | null): void {
    this._activityStopHandler = handler;
  }

  /**
   * Draw, or redraw, the "Flowkite is active" banner, ring and stop button on this page.
   *
   * Called on every action rather than once per task on purpose: the overlay lives in the document,
   * so every navigation destroys it, and re-asserting it is both how it survives and how the detail
   * line stays current. Failures are swallowed - a page that will not take the banner (a PDF
   * viewer, a document mid-navigation) is still a page the agent must be allowed to work on.
   */
  async showActivityOverlay(content: ActivityOverlayContent): Promise<void> {
    if (!this._validWebPage || !this._puppeteerPage) return;
    this._activityContent = content;
    try {
      await this._bindActivityStop();
      await this._puppeteerPage.evaluate(renderActivityOverlay, content);
    } catch (error) {
      logger.debug('Could not draw the activity overlay:', error);
    }
  }

  /** Move the drawn cursor onto an element and ring it, just before the agent acts on it. */
  async markActivityTarget(element: ElementHandle): Promise<void> {
    if (!this._activityContent || !this._puppeteerPage) return;
    try {
      const box = await element.boundingBox();
      if (!box) return;
      const rect: ActivityTargetRect = { x: box.x, y: box.y, width: box.width, height: box.height };
      await this._puppeteerPage.evaluate(moveActivityCursor, rect);
      await this._puppeteerPage.evaluate(pulseActivityTarget, rect);
    } catch (error) {
      logger.debug('Could not mark the activity target:', error);
    }
  }

  /** Take the banner off this page and forget it, so a later navigation does not bring it back. */
  async hideActivityOverlay(): Promise<void> {
    this._activityContent = null;
    this._stopActivityStopPolling();
    if (!this._puppeteerPage) return;
    try {
      await this._puppeteerPage.evaluate(removeActivityOverlay);
    } catch (error) {
      logger.debug('Could not remove the activity overlay:', error);
    }
  }

  /**
   * Run something with the overlay switched off.
   *
   * Every read of the page the model will see goes through here. The banner is drawn for the user
   * and only for the user: in a screenshot it is a caption the model tries to read, and in the
   * extracted text it is a line of prose that was never on the page.
   */
  private async _withActivityOverlayHidden<T>(read: () => Promise<T>): Promise<T> {
    if (!this._activityContent || !this._puppeteerPage) return read();
    try {
      await this._puppeteerPage.evaluate(setActivityOverlayHidden, true);
    } catch {
      // Nothing to hide, or the page went away; the read is what matters.
    }
    try {
      return await read();
    } finally {
      try {
        await this._puppeteerPage.evaluate(setActivityOverlayHidden, false);
      } catch {
        // The overlay is redrawn on the next action anyway.
      }
    }
  }

  /**
   * Give the overlay's stop button a way to reach the executor.
   *
   * `exposeFunction` installs the binding for the page's whole lifetime, navigations included, so
   * this runs once. It throws if the name is already taken, which is the one failure worth
   * recording as already-done rather than retrying forever.
   */
  private async _bindActivityStop(): Promise<void> {
    if (this._activityStopBound || !this._puppeteerPage) return;
    this._activityStopBound = true;
    try {
      await this._puppeteerPage.exposeFunction(ACTIVITY_STOP_BINDING, () => {
        logger.info('Stop requested from the on-page overlay');
        this._activityStopHandler?.();
      });
      // Asked, not assumed. exposeFunction resolving is not proof the binding is reachable from the
      // page - the transport here is chrome.debugger rather than a normal Puppeteer connection - and
      // the failure mode is a stop button that does nothing, which is the one outcome not worth
      // risking. The page itself is the only witness that can answer.
      const bound = await this._puppeteerPage.evaluate(
        name => typeof (window as unknown as Record<string, unknown>)[name] === 'function',
        ACTIVITY_STOP_BINDING,
      );
      if (!bound) {
        logger.warning('Overlay stop binding did not install; falling back to polling the button');
        this._startActivityStopPolling();
      }
    } catch (error) {
      logger.debug('Could not bind the overlay stop button:', error);
      this._startActivityStopPolling();
    }
  }

  /**
   * Watch the page for a stop the binding could not deliver.
   *
   * Only ever started when the binding is known not to have installed, so the common case pays
   * nothing. The interval is a compromise: fast enough that the button feels like a button, slow
   * enough that it is not a CDP round-trip per frame.
   */
  private _startActivityStopPolling(): void {
    if (this._activityStopPoll) return;
    this._activityStopPoll = setInterval(() => {
      if (!this._activityContent || !this._puppeteerPage) return;
      this._puppeteerPage
        .evaluate(takeActivityStopRequest)
        .then(requested => {
          if (requested) {
            logger.info('Stop requested from the on-page overlay (polled)');
            this._activityStopHandler?.();
          }
        })
        .catch(() => {
          // A navigation in flight, or a page that has gone away. The next tick asks again.
        });
    }, ACTIVITY_STOP_POLL_MS);
  }

  private _stopActivityStopPolling(): void {
    if (!this._activityStopPoll) return;
    clearInterval(this._activityStopPoll);
    this._activityStopPoll = null;
  }

  /**
   * Tear down anything the agent drew on this page.
   *
   * Deliberately not gated on the overlay preference. Boxes get drawn for reasons the preference does
   * not cover - the useVision OR below, a Page holding a config snapshot from before the user changed
   * the setting, a container left behind by an earlier session - and a removal that only fires when
   * drawing is enabled can never clean any of those up. Removal is idempotent and cheap, so the only
   * thing gating it buys is overlays that outlive the run that made them.
   */
  async removeHighlight(): Promise<void> {
    if (this._validWebPage) {
      await _removeHighlights(this._tabId);
    }
  }

  async getClickableElements(showHighlightElements: boolean, focusElement: number): Promise<DOMState | null> {
    if (!this._validWebPage) {
      return null;
    }
    return _getClickableElements(
      this._tabId,
      this.url(),
      showHighlightElements,
      focusElement,
      this._config.viewportExpansion,
    );
  }

  /**
   * Delays between grounding attempts, in milliseconds. Client-rendered apps routinely report the
   * document as loaded while React or Vue is still mounting, and cross-origin iframes settle later
   * still, so an empty first parse is common on exactly the pages users care about.
   *
   * The escalating waits are what make this cheap: a page that was simply slow answers on the
   * second try, and only genuinely element-free pages pay the full cost.
   */
  private static readonly GROUNDING_RETRY_DELAYS_MS = [300, 700, 1200];

  /**
   * Parse the page's interactive elements, retrying while the result comes back empty.
   *
   * An empty parse is ambiguous - it means either "this page has nothing to click" or "this page has
   * not rendered yet" - and the two are indistinguishable at the moment of the first attempt. Retrying
   * costs a few hundred milliseconds on a genuinely empty page and rescues the step entirely on a slow
   * one, so it is worth doing before reporting the page as empty to the model.
   */
  async getClickableElementsWithRetry(showHighlightElements: boolean, focusElement: number): Promise<DOMState | null> {
    let content = await this._tryGetClickableElements(showHighlightElements, focusElement);
    if (content && content.selectorMap.size > 0) return content;

    for (const delay of Page.GROUNDING_RETRY_DELAYS_MS) {
      logger.info(`No interactive elements found, retrying grounding in ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
      const retried = await this._tryGetClickableElements(showHighlightElements, focusElement);
      if (retried && retried.selectorMap.size > 0) {
        logger.info(`Grounding recovered after ${delay}ms with ${retried.selectorMap.size} element(s)`);
        return retried;
      }
      // An empty tree is still a real answer about the page; a failed parse is not. Keep whichever
      // of the two the page has most recently managed to give us.
      content = retried ?? content;
    }

    return content;
  }

  /**
   * One grounding attempt, with a thrown parse reported the same way as an empty one.
   *
   * Two of the conditions the retries exist for do not come back as an empty tree at all: a frame
   * that navigates out from under the parse, and a page Chrome will not script - its own error
   * pages most of all. Left as exceptions they skip the retries entirely and unwind into the
   * caller, so the slow-page case gets its second chance while these two, which a redirect settling
   * would just as often fix, get none.
   */
  private async _tryGetClickableElements(
    showHighlightElements: boolean,
    focusElement: number,
  ): Promise<DOMState | null> {
    try {
      return await this.getClickableElements(showHighlightElements, focusElement);
    } catch (error) {
      logger.warning('Failed to parse the page DOM:', error);
      return null;
    }
  }

  // Get scroll position information for the current page.
  async getScrollInfo(): Promise<[number, number, number]> {
    if (!this._validWebPage) {
      return [0, 0, 0];
    }
    return _getScrollInfo(this._tabId);
  }

  // Get scroll position information for a specific element.
  async getElementScrollInfo(elementNode: DOMElementNode): Promise<[number, number, number]> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }

    const element = await this.locateElement(elementNode);
    if (!element) {
      throw new Error(`Element: ${elementNode} not found`);
    }

    // Find the nearest scrollable ancestor
    const scrollableElement = await this._findNearestScrollableElement(element);
    if (!scrollableElement) {
      throw new Error(`No scrollable ancestor found for element: ${elementNode}`);
    }

    const scrollInfo = await scrollableElement.evaluate(el => {
      return {
        scrollTop: el.scrollTop,
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
      };
    });

    return [scrollInfo.scrollTop, scrollInfo.clientHeight, scrollInfo.scrollHeight];
  }

  /**
   * Find the nearest scrollable ancestor of the given element
   * @param element The element to start searching from
   * @returns The nearest scrollable ancestor or null if none found
   */
  private async _findNearestScrollableElement(element: ElementHandle): Promise<ElementHandle | null> {
    if (!this._puppeteerPage) {
      return null;
    }

    // Check if the current element is scrollable
    const isScrollable = await element.evaluate((el: Element) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const hasVerticalScrollbar = el.scrollHeight > el.clientHeight;
      const canScrollVertically =
        style.overflowY === 'scroll' ||
        style.overflowY === 'auto' ||
        style.overflow === 'scroll' ||
        style.overflow === 'auto';

      return hasVerticalScrollbar && canScrollVertically;
    });

    if (isScrollable) {
      return element;
    }

    // Check parent elements
    let currentElement: ElementHandle<Element> | null = element;

    try {
      while (currentElement) {
        // Get the parent element (as an ElementHandle) of the current element
        const parentHandle = (await currentElement.evaluateHandle(
          (el: Element) => el.parentElement,
        )) as ElementHandle<Element> | null;

        const parentElement = parentHandle ? await parentHandle.asElement() : null;

        if (!parentElement) {
          // Reached the root without finding a scrollable ancestor
          currentElement = null;
          break;
        }

        const parentIsScrollable = await parentElement.evaluate((el: Element) => {
          if (!(el instanceof HTMLElement)) return false;
          const style = window.getComputedStyle(el);
          const hasVerticalScrollbar = el.scrollHeight > el.clientHeight;
          const canScrollVertically =
            ['scroll', 'auto'].includes(style.overflowY) || ['scroll', 'auto'].includes(style.overflow);

          return hasVerticalScrollbar && canScrollVertically;
        });

        if (parentIsScrollable) {
          // Found a scrollable ancestor – return it (the caller should dispose when finished)
          return parentElement;
        }

        // Move up the DOM tree – dispose the previous element handle before continuing
        if (currentElement !== element) {
          try {
            await currentElement.dispose();
          } catch (disposeErr) {
            logger.debug('Failed to dispose element handle:', disposeErr);
          }
        }

        currentElement = parentElement;
      }
    } catch (error) {
      // Error accessing parent, break out of loop
      logger.error('Error finding scrollable parent:', error);
    }

    // If no scrollable ancestor found, return the document body or documentElement
    try {
      const bodyElement = await this._puppeteerPage.$('body');
      if (bodyElement) {
        const bodyIsScrollable = await bodyElement.evaluate(el => {
          if (!(el instanceof HTMLElement)) return false;
          return el.scrollHeight > el.clientHeight;
        });
        if (bodyIsScrollable) {
          return bodyElement;
        }
      }

      // Last resort: return document element for page-level scrolling
      const documentElement = await this._puppeteerPage.evaluateHandle(() => document.documentElement);
      const docElement = (await documentElement.asElement()) as ElementHandle<Element> | null;
      return docElement;
    } catch (error) {
      logger.error('Failed to find scrollable element:', error);
      return null;
    }
  }

  async getContent(): Promise<string> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer page is not connected');
    }
    return await this._puppeteerPage.content();
  }

  /**
   * The page's rendered text, as a reader would see it — what the extractor wants: prose and
   * tables, no markup. innerText rather than textContent so hidden elements stay out and layout
   * linebreaks survive. Callers cap the length; a long feed's innerText can run to megabytes.
   */
  async getVisibleText(): Promise<string> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer page is not connected');
    }
    return this._withActivityOverlayHidden(async () => {
      // innerText is layout-based, so the banner's own words would land in the extracted text if it
      // were merely behind a shadow root rather than switched off.
      const page = this._puppeteerPage;
      if (!page) throw new Error('Puppeteer page is not connected');
      return page.evaluate(() => document.body?.innerText ?? '');
    });
  }

  getCachedState(): PageState | null {
    return this._cachedState;
  }

  async getState(useVision = false, cacheClickableElementsHashes = false): Promise<PageState> {
    if (!this._validWebPage) {
      // return the initial state
      return build_initial_state(this._tabId);
    }
    await this.waitForPageAndFramesLoad();
    const updatedState = await this._updateState(useVision);

    // Find out which elements are new
    // Do this only if url has not changed
    if (cacheClickableElementsHashes) {
      // If we are on the same url as the last state, we can use the cached hashes
      if (
        this._cachedStateClickableElementsHashes &&
        this._cachedStateClickableElementsHashes.url === updatedState.url
      ) {
        // Get clickable elements from the updated state
        const updatedStateClickableElements = ClickableElementProcessor.getClickableElements(updatedState.elementTree);

        // Mark elements as new if they weren't in the previous state
        for (const domElement of updatedStateClickableElements) {
          const hash = await ClickableElementProcessor.hashDomElement(domElement);
          domElement.isNew = !this._cachedStateClickableElementsHashes.hashes.has(hash);
        }
      }

      // In any case, we need to cache the new hashes
      const newHashes = await ClickableElementProcessor.getClickableElementsHashes(updatedState.elementTree);
      this._cachedStateClickableElementsHashes = new CachedStateClickableElementsHashes(updatedState.url, newHashes);
    }

    // Save the updated state as the cached state
    this._cachedState = updatedState;

    return updatedState;
  }

  async _updateState(useVision = false, focusElement = -1): Promise<PageState> {
    try {
      // Test if page is still accessible
      // @ts-expect-error - puppeteerPage is not null, already checked before calling this function
      await this._puppeteerPage.evaluate('1');
    } catch (error) {
      logger.warning('Current page is no longer accessible:', error);
      if (this._browser) {
        const pages = await this._browser.pages();
        if (pages.length > 0) {
          this._puppeteerPage = pages[0];
        } else {
          throw new Error('Browser closed: no valid pages available');
        }
      }
    }

    try {
      await this.removeHighlight();

      // Get DOM content (equivalent to dom_service.get_clickable_elements)
      // Boxes are drawn when the user asked for them, and also whenever vision is on regardless of
      // the preference: the model reads the numbers off the screenshot, so without them a vision run
      // has no way to map what it sees back onto an element index.
      const drawBoxes = this._config.agentOverlay === 'boxes' || useVision;
      const content = await this.getClickableElementsWithRetry(drawBoxes, focusElement);
      if (!content) {
        logger.warning('Failed to get clickable elements');
        return await this._stateForUnreadablePage();
      }

      // If the DOM yielded nothing even after retrying, the page is either genuinely empty or is one
      // the DOM cannot describe (canvas, cross-origin iframe). Either way the screenshot is the only
      // grounding left, so take one regardless of the vision setting.
      const domGroundingFailed = content.selectorMap.size === 0;
      if (domGroundingFailed) {
        logger.warning('DOM grounding found no interactive elements, falling back to a screenshot');
      }
      // log the attributes of content object
      if ('selectorMap' in content) {
        logger.debug('content.selectorMap:', content.selectorMap.size);
      } else {
        logger.debug('content.selectorMap: not found');
      }
      if ('elementTree' in content) {
        logger.debug('content.elementTree:', content.elementTree?.tagName);
      } else {
        logger.debug('content.elementTree: not found');
      }

      // Take screenshot if needed. Everything from here to the assignments below is an extra layered
      // on top of a tree that has already been read successfully, so none of it may be allowed to
      // throw: the catch at the bottom answers with the last committed state, which at this point is
      // still the previous page's. Losing a screenshot is a smaller loss than that.
      const screenshot = useVision || domGroundingFailed ? await this.takeScreenshot().catch(() => null) : null;

      // Boxes drawn only to ground the screenshot have done their job the moment it is captured. Clear
      // them here rather than at the start of the next parse, or they sit on the user's screen for the
      // whole model round-trip - seconds of graffiti instead of the length of a capture.
      if (drawBoxes && this._config.agentOverlay !== 'boxes') {
        await this.removeHighlight();
      }

      // Measured through the same injection that read the tree, so a navigation landing between the
      // two calls takes these out on its own.
      const [scrollY, visualViewportHeight, scrollHeight] = await this.getScrollInfo().catch(error => {
        logger.warning('Could not measure the scroll position:', error);
        return [0, 0, 0] as [number, number, number];
      });

      // update the state
      this._state.elementTree = content.elementTree;
      this._state.selectorMap = content.selectorMap;
      this._state.url = this._puppeteerPage?.url() || '';
      this._state.title = (await this._puppeteerPage?.title().catch(() => '')) || '';
      this._state.screenshot = screenshot;
      this._state.domGroundingFailed = domGroundingFailed;
      this._state.scrollY = scrollY;
      this._state.visualViewportHeight = visualViewportHeight;
      this._state.scrollHeight = scrollHeight;
      return this._state;
    } catch (error) {
      // Anything reaching here failed after the DOM had already been read - a screenshot, the scroll
      // measurements - so the tree in hand is still the tree of the page in front of us. That case
      // keeps the last good state; a page that could not be read at all does not, and takes the
      // _stateForUnreadablePage branch instead.
      logger.error('Failed to update state:', error);
      return this._state;
    }
  }

  /**
   * What to report for a page whose DOM could not be read on any attempt.
   *
   * The obvious answer, and the one this used to give, is the last state that worked. It is the
   * wrong one: it hands the model a tree belonging to a page the tab has already left, whose element
   * indices now resolve to nothing, and gives it no way to tell. The model keeps clicking indices
   * off that stale tree and cannot understand why nothing responds.
   *
   * An empty tree grounds worse but grounds honestly. `domGroundingFailed` routes the prompt down
   * the screenshot path - the one grounding that survives when scripting does not - and the URL and
   * title say where the tab really is, so the model can decide to go back, retry, or give up. The
   * scroll figures reset to zero because they are measured by the same injection that just failed;
   * carrying the old page's numbers forward would only invite a scroll against them.
   */
  private async _stateForUnreadablePage(): Promise<PageState> {
    this._state.elementTree = build_initial_state(this._tabId).elementTree;
    this._state.selectorMap = new Map();
    this._state.domGroundingFailed = true;
    this._state.url = this.url();
    this._state.title = await this.title().catch(() => this._state.title);
    this._state.screenshot = await this.takeScreenshot().catch(() => null);
    this._state.scrollY = 0;
    this._state.visualViewportHeight = 0;
    this._state.scrollHeight = 0;
    return this._state;
  }

  async takeScreenshot(fullPage = false): Promise<string | null> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer page is not connected');
    }
    const screenshot = await this._withActivityOverlayHidden(() => this._captureScreenshot(fullPage));
    // Flashed after the capture and after the overlay is back, never before: a flash that made it
    // into the frame would be a white page handed to the model. Not awaited - the animation is for
    // the user, and the agent has no reason to wait out 400ms of it.
    if (this._activityContent) {
      this._puppeteerPage?.evaluate(flashActivityCapture).catch(() => undefined);
    }
    return screenshot;
  }

  private async _captureScreenshot(fullPage: boolean): Promise<string | null> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer page is not connected');
    }

    try {
      // First disable animations/transitions
      await this._puppeteerPage.evaluate(() => {
        const styleId = 'puppeteer-disable-animations';
        if (!document.getElementById(styleId)) {
          const style = document.createElement('style');
          style.id = styleId;
          style.textContent = `
            *, *::before, *::after {
              animation: none !important;
              transition: none !important;
            }
          `;
          document.head.appendChild(style);
        }
      });

      // Take the screenshot using JPEG format with 80% quality
      const screenshot = await this._puppeteerPage.screenshot({
        fullPage: fullPage,
        encoding: 'base64',
        type: 'jpeg',
        quality: 80, // Good balance between quality and file size
      });

      // Clean up the style element
      await this._puppeteerPage.evaluate(() => {
        const style = document.getElementById('puppeteer-disable-animations');
        if (style) {
          style.remove();
        }
      });

      return screenshot as string;
    } catch (error) {
      logger.error('Failed to take screenshot:', error);
      throw error;
    }
  }

  url(): string {
    if (this._puppeteerPage) {
      return this._puppeteerPage.url();
    }
    return this._state.url;
  }

  async title(): Promise<string> {
    if (this._puppeteerPage) {
      return await this._puppeteerPage.title();
    }
    return this._state.title;
  }

  async navigateTo(url: string): Promise<void> {
    if (!this._puppeteerPage) {
      return;
    }
    logger.info('navigateTo', url);

    // Check if URL is allowed
    if (!isUrlAllowed(url, this._config.allowedUrls, this._config.deniedUrls)) {
      throw new URLNotAllowedError(`URL: ${url} is not allowed`);
    }

    try {
      await Promise.all([this.waitForPageAndFramesLoad(), this._puppeteerPage.goto(url)]);
      logger.info('navigateTo complete');
    } catch (error) {
      if (error instanceof URLNotAllowedError) {
        throw error;
      }

      if (error instanceof Error && error.message.includes('timeout')) {
        logger.warning('Navigation timeout, but page might still be usable:', error);
        return;
      }

      logger.error('Navigation failed:', error);
      throw error;
    }
  }

  async refreshPage(): Promise<void> {
    if (!this._puppeteerPage) return;

    try {
      await Promise.all([this.waitForPageAndFramesLoad(), this._puppeteerPage.reload()]);
      logger.info('Page refresh complete');
    } catch (error) {
      if (error instanceof URLNotAllowedError) {
        throw error;
      }

      if (error instanceof Error && error.message.includes('timeout')) {
        logger.warning('Refresh timeout, but page might still be usable:', error);
        return;
      }

      logger.error('Page refresh failed:', error);
      throw error;
    }
  }

  async goBack(): Promise<void> {
    if (!this._puppeteerPage) return;

    try {
      await Promise.all([this.waitForPageAndFramesLoad(), this._puppeteerPage.goBack()]);
      logger.info('Navigation back completed');
    } catch (error) {
      if (error instanceof URLNotAllowedError) {
        throw error;
      }

      if (error instanceof Error && error.message.includes('timeout')) {
        logger.warning('Back navigation timeout, but page might still be usable:', error);
        return;
      }

      logger.error('Could not navigate back:', error);
      throw error;
    }
  }

  async goForward(): Promise<void> {
    if (!this._puppeteerPage) return;

    try {
      await Promise.all([this.waitForPageAndFramesLoad(), this._puppeteerPage.goForward()]);
      logger.info('Navigation forward completed');
    } catch (error) {
      if (error instanceof URLNotAllowedError) {
        throw error;
      }

      if (error instanceof Error && error.message.includes('timeout')) {
        logger.warning('Forward navigation timeout, but page might still be usable:', error);
        return;
      }

      logger.error('Could not navigate forward:', error);
      throw error;
    }
  }

  // scroll to a percentage of the page or element
  // if yPercent is 0, scroll to the top of the page, if 100, scroll to the bottom of the page
  // if elementNode is provided, scroll to a percentage of the element
  // if elementNode is not provided, scroll to a percentage of the page
  async scrollToPercent(yPercent: number, elementNode?: DOMElementNode): Promise<void> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }
    if (!elementNode) {
      // Through the shared resolver, so this moves whatever getScrollInfo just measured.
      await _scrollPage(this._tabId, { kind: 'toPercent', yPercent });
    } else {
      const element = await this.locateElement(elementNode);
      if (!element) {
        throw new Error(`Element: ${elementNode} not found`);
      }

      // Find the nearest scrollable ancestor
      const scrollableElement = await this._findNearestScrollableElement(element);
      if (!scrollableElement) {
        throw new Error(`No scrollable ancestor found for element: ${elementNode}`);
      }

      await scrollableElement.evaluate((el, yPercent) => {
        const scrollHeight = el.scrollHeight;
        const viewportHeight = el.clientHeight;
        const scrollTop = (scrollHeight - viewportHeight) * (yPercent / 100);
        el.scrollTo({
          top: scrollTop,
          left: el.scrollLeft,
          behavior: 'smooth',
        });
      }, yPercent);
    }
  }

  async scrollBy(y: number, elementNode?: DOMElementNode): Promise<void> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }
    if (!elementNode) {
      await this._puppeteerPage.evaluate(y => {
        window.scrollBy({
          top: y,
          left: 0,
          behavior: 'smooth',
        });
      }, y);
    } else {
      const element = await this.locateElement(elementNode);
      if (!element) {
        throw new Error(`Element: ${elementNode} not found`);
      }

      // Find the nearest scrollable ancestor
      const scrollableElement = await this._findNearestScrollableElement(element);
      if (!scrollableElement) {
        throw new Error(`No scrollable ancestor found for element: ${elementNode}`);
      }
      await scrollableElement.evaluate(el => {
        el.scrollBy({
          top: y,
          left: 0,
          behavior: 'smooth',
        });
      });
    }
  }

  async scrollToPreviousPage(elementNode?: DOMElementNode): Promise<void> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }

    if (!elementNode) {
      await _scrollPage(this._tabId, { kind: 'byPages', pages: -1 });
    } else {
      // Scroll the specific element up by its client height
      const element = await this.locateElement(elementNode);
      if (!element) {
        throw new Error(`Element: ${elementNode} not found`);
      }

      // Find the nearest scrollable ancestor
      const scrollableElement = await this._findNearestScrollableElement(element);
      if (!scrollableElement) {
        throw new Error(`No scrollable ancestor found for element: ${elementNode}`);
      }

      await scrollableElement.evaluate(el => {
        el.scrollBy(0, -el.clientHeight);
      });
    }
  }

  async scrollToNextPage(elementNode?: DOMElementNode): Promise<void> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }

    if (!elementNode) {
      await _scrollPage(this._tabId, { kind: 'byPages', pages: 1 });
    } else {
      // Scroll the specific element down by its client height
      const element = await this.locateElement(elementNode);
      if (!element) {
        throw new Error(`Element: ${elementNode} not found`);
      }

      // Find the nearest scrollable ancestor
      const scrollableElement = await this._findNearestScrollableElement(element);
      if (!scrollableElement) {
        throw new Error(`No scrollable ancestor found for element: ${elementNode}`);
      }

      await scrollableElement.evaluate(el => {
        el.scrollBy(0, el.clientHeight);
      });
    }
  }

  async sendKeys(keys: string): Promise<void> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer page is not connected');
    }

    // Split combination keys (e.g., "Control+A" or "Shift+ArrowLeft")
    const keyParts = keys.split('+');
    const modifiers = keyParts.slice(0, -1);
    const mainKey = keyParts[keyParts.length - 1];

    // Press modifiers and main key, ensure modifiers are released even if an error occurs.
    try {
      // Press all modifier keys (e.g., Control, Shift, etc.)
      for (const modifier of modifiers) {
        await this._puppeteerPage.keyboard.down(this._convertKey(modifier));
      }
      // Press the main key
      // also wait for stable state
      await Promise.all([
        this._puppeteerPage.keyboard.press(this._convertKey(mainKey)),
        this.waitForPageAndFramesLoad(),
      ]);
      logger.info('sendKeys complete', keys);
    } catch (error) {
      logger.error('Failed to send keys:', error);
      throw new Error(`Failed to send keys: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      // Release all modifier keys in reverse order regardless of any errors in key press.
      for (const modifier of [...modifiers].reverse()) {
        try {
          await this._puppeteerPage.keyboard.up(this._convertKey(modifier));
        } catch (releaseError) {
          logger.error('Failed to release modifier:', modifier, releaseError);
        }
      }
    }
  }

  private _convertKey(key: string): KeyInput {
    const lowerKey = key.trim().toLowerCase();
    const isMac = navigator.userAgent.toLowerCase().includes('mac os x');

    if (isMac) {
      if (lowerKey === 'control' || lowerKey === 'ctrl') {
        return 'Meta' as KeyInput; // Use Command key on Mac
      }
      if (lowerKey === 'command' || lowerKey === 'cmd') {
        return 'Meta' as KeyInput; // Map Command/Cmd to Meta on Mac
      }
      if (lowerKey === 'option' || lowerKey === 'opt') {
        return 'Alt' as KeyInput; // Map Option/Opt to Alt on Mac
      }
    }

    const keyMap: { [key: string]: string } = {
      // Letters
      a: 'KeyA',
      b: 'KeyB',
      c: 'KeyC',
      d: 'KeyD',
      e: 'KeyE',
      f: 'KeyF',
      g: 'KeyG',
      h: 'KeyH',
      i: 'KeyI',
      j: 'KeyJ',
      k: 'KeyK',
      l: 'KeyL',
      m: 'KeyM',
      n: 'KeyN',
      o: 'KeyO',
      p: 'KeyP',
      q: 'KeyQ',
      r: 'KeyR',
      s: 'KeyS',
      t: 'KeyT',
      u: 'KeyU',
      v: 'KeyV',
      w: 'KeyW',
      x: 'KeyX',
      y: 'KeyY',
      z: 'KeyZ',

      // Numbers
      '0': 'Digit0',
      '1': 'Digit1',
      '2': 'Digit2',
      '3': 'Digit3',
      '4': 'Digit4',
      '5': 'Digit5',
      '6': 'Digit6',
      '7': 'Digit7',
      '8': 'Digit8',
      '9': 'Digit9',

      // Special keys
      control: 'Control',
      shift: 'Shift',
      alt: 'Alt',
      meta: 'Meta',
      enter: 'Enter',
      backspace: 'Backspace',
      delete: 'Delete',
      arrowleft: 'ArrowLeft',
      arrowright: 'ArrowRight',
      arrowup: 'ArrowUp',
      arrowdown: 'ArrowDown',
      escape: 'Escape',
      tab: 'Tab',
      space: 'Space',
    };

    const convertedKey = keyMap[lowerKey] || key;
    logger.info('convertedKey', convertedKey);
    return convertedKey as KeyInput;
  }

  async scrollToText(text: string, nth: number = 1): Promise<boolean> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }

    try {
      // Convert text to lowercase for consistent searching
      const lowerCaseText = text.toLowerCase();

      // Try different locator strategies to find all elements containing the text
      const selectors = [
        // Using text selector (equivalent to get_by_text) - for exact text match
        `::-p-text(${text})`,
        // Using XPath selector (contains text) - case insensitive
        `::-p-xpath(//*[contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '${lowerCaseText}')])`,
      ];

      for (const selector of selectors) {
        try {
          // Use $$ to get all matching elements
          const elements = await this._puppeteerPage.$$(selector);

          if (elements.length > 0) {
            // Find visible elements and select the nth occurrence
            const visibleElements = [];

            for (const element of elements) {
              const isVisible = await element.evaluate(el => {
                const style = window.getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                return (
                  style.display !== 'none' &&
                  style.visibility !== 'hidden' &&
                  style.opacity !== '0' &&
                  rect.width > 0 &&
                  rect.height > 0
                );
              });

              if (isVisible) {
                visibleElements.push(element);
              }
            }

            // Check if we have enough visible elements for the requested nth occurrence
            if (visibleElements.length >= nth) {
              const targetElement = visibleElements[nth - 1]; // Convert to 0-indexed
              await this._scrollIntoViewIfNeeded(targetElement);
              await new Promise(resolve => setTimeout(resolve, 500)); // Wait for scroll to complete

              // Dispose of all element handles to prevent memory leaks
              for (const element of elements) {
                await element.dispose();
              }

              return true;
            }
          }

          // Dispose of all element handles to prevent memory leaks
          for (const element of elements) {
            await element.dispose();
          }
        } catch (e) {
          logger.debug(`Locator attempt failed: ${e}`);
        }
      }
      return false;
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Takes the node rather than an index: an index is only meaningful against the parse it came from,
   * and this method used to look it up in `_cachedState`, which the caller's step may already have
   * overwritten with a differently-numbered parse.
   */
  async getDropdownOptions(element: DOMElementNode): Promise<Array<{ index: number; text: string; value: string }>> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }

    try {
      // Get the element handle using the element's selector
      const elementHandle = await this.locateElement(element);
      if (!elementHandle) {
        throw new Error('Dropdown element not found');
      }

      // Evaluate the select element to get all options
      const options = await elementHandle.evaluate(select => {
        if (!(select instanceof HTMLSelectElement)) {
          throw new Error('Element is not a select element');
        }

        return Array.from(select.options).map(option => ({
          index: option.index,
          text: option.text, // Not trimming to maintain exact match for selection
          value: option.value,
        }));
      });

      if (!options.length) {
        throw new Error('No options found in dropdown');
      }

      return options;
    } catch (error) {
      throw new Error(`Failed to get dropdown options: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Takes the node for the same reason as {@link getDropdownOptions}. */
  async selectDropdownOption(element: DOMElementNode, text: string): Promise<string> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }
    // recovered from the node so the log lines and error messages below cannot disagree with the target
    const index = element.highlightIndex ?? -1;

    logger.debug(`Attempting to select '${text}' from dropdown`);
    logger.debug(`Element attributes: ${JSON.stringify(element.attributes)}`);
    logger.debug(`Element tag: ${element.tagName}`);

    // Validate that we're working with a select element
    if (element.tagName?.toLowerCase() !== 'select') {
      const msg = `Cannot select option: Element with index ${index} is a ${element.tagName}, not a SELECT`;
      logger.error(msg);
      throw new Error(msg);
    }

    try {
      // Get the element handle using the element's selector
      const elementHandle = await this.locateElement(element);
      if (!elementHandle) {
        throw new Error(`Dropdown element with index ${index} not found`);
      }

      // Verify dropdown and select option in one call
      const result = await elementHandle.evaluate(
        (select, optionText, elementIndex) => {
          if (!(select instanceof HTMLSelectElement)) {
            return {
              found: false,
              message: `Element with index ${elementIndex} is not a SELECT`,
            };
          }

          const options = Array.from(select.options);
          const option = options.find(opt => opt.text.trim() === optionText);

          if (!option) {
            const availableOptions = options.map(o => o.text.trim()).join('", "');
            return {
              found: false,
              message: `Option "${optionText}" not found in dropdown element with index ${elementIndex}. Available options: "${availableOptions}"`,
            };
          }

          // Set the value and dispatch events
          const previousValue = select.value;
          select.value = option.value;

          // Only dispatch events if the value actually changed
          if (previousValue !== option.value) {
            select.dispatchEvent(new Event('change', { bubbles: true }));
            select.dispatchEvent(new Event('input', { bubbles: true }));
          }

          return {
            found: true,
            message: `Selected option "${optionText}" with value "${option.value}"`,
          };
        },
        text,
        index,
      );

      logger.debug('Selection result:', result);
      // whether found or not, return the message
      return result.message;
    } catch (error) {
      const errorMessage = `${error instanceof Error ? error.message : String(error)}`;
      logger.error(errorMessage);
      throw new Error(errorMessage);
    }
  }

  async locateElement(element: DOMElementNode): Promise<ElementHandle | null> {
    if (!this._puppeteerPage) {
      // throw new Error('Puppeteer page is not connected');
      logger.warning('Puppeteer is not connected');
      return null;
    }
    let currentFrame: PuppeteerPage | Frame = this._puppeteerPage;

    // Start with the target element and collect all parents
    const parents: DOMElementNode[] = [];
    let current = element;
    while (current.parent) {
      parents.push(current.parent);
      current = current.parent;
    }

    // Process all iframe parents in sequence (in reverse order - top to bottom)
    const iframes = parents.reverse().filter(item => item.tagName === 'iframe');
    for (const parent of iframes) {
      const cssSelector = parent.enhancedCssSelectorForElement(this._config.includeDynamicAttributes);
      const frameElement: ElementHandle | null = await currentFrame.$(cssSelector);
      if (!frameElement) {
        // throw new Error(`Could not find iframe with selector: ${cssSelector}`);
        logger.warning(`Could not find iframe with selector: ${cssSelector}`);
        return null;
      }
      const frame: Frame | null = await frameElement.contentFrame();
      if (!frame) {
        // throw new Error(`Could not access frame content for selector: ${cssSelector}`);
        logger.warning(`Could not access frame content for selector: ${cssSelector}`);
        return null;
      }
      currentFrame = frame;
      logger.info('currentFrame changed', currentFrame);
    }

    const cssSelector = element.enhancedCssSelectorForElement(this._config.includeDynamicAttributes);

    try {
      // Try CSS selector first
      let elementHandle: ElementHandle | null = await currentFrame.$(cssSelector);

      // If CSS selector failed, try XPath
      if (!elementHandle) {
        const xpath = element.xpath;
        if (xpath) {
          try {
            logger.info('Trying XPath selector:', xpath);
            const fullXpath = xpath.startsWith('/') ? xpath : `/${xpath}`;
            const xpathSelector = `::-p-xpath(${fullXpath})`;
            elementHandle = await currentFrame.$(xpathSelector);
          } catch (xpathError) {
            logger.error('Failed to locate element using XPath:', xpathError);
          }
        }
      }

      // If element found, check visibility and scroll into view
      if (elementHandle) {
        const isHidden = await elementHandle.isHidden();
        if (!isHidden) {
          await this._scrollIntoViewIfNeeded(elementHandle);
        }
        return elementHandle;
      }

      logger.info('elementHandle not located');
    } catch (error) {
      logger.error('Failed to locate element:', error);
    }

    return null;
  }

  async inputTextElementNode(useVision: boolean, elementNode: DOMElementNode, text: string): Promise<void> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }

    try {
      // Highlight before typing
      // if (elementNode.highlightIndex != null) {
      //   await this._updateState(useVision, elementNode.highlightIndex);
      // }

      const element = await this.locateElement(elementNode);
      if (!element) {
        throw new Error(`Element: ${elementNode} not found`);
      }

      // Ensure element is ready for input
      try {
        // First wait for element stability
        await this._waitForElementStability(element, 1500);

        // Then check visibility and scroll into view if needed
        const isHidden = await element.isHidden();
        if (!isHidden) {
          await this._scrollIntoViewIfNeeded(element, 1500);
        }
      } catch (e) {
        // Continue even if these operations fail
        logger.debug(`Non-critical error preparing element: ${e}`);
      }

      await this.markActivityTarget(element);

      // Get element properties to determine input method
      const tagName = await element.evaluate(el => el.tagName.toLowerCase());
      const isContentEditable = await element.evaluate(el => {
        if (el instanceof HTMLElement) {
          return el.isContentEditable;
        }
        return false;
      });
      const isReadOnly = await element.evaluate(el => {
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          return el.readOnly;
        }
        return false;
      });
      const isDisabled = await element.evaluate(el => {
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          return el.disabled;
        }
        return false;
      });

      // Choose appropriate input method based on element properties
      if ((isContentEditable || tagName === 'input') && !isReadOnly && !isDisabled) {
        // Clear content and set value directly
        await element.evaluate(el => {
          if (el instanceof HTMLElement) {
            el.textContent = '';
          }
          if ('value' in el) {
            (el as HTMLInputElement).value = '';
          }
          // Dispatch events
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        });

        // Type the text with a small delay between keypresses
        await element.type(text, { delay: 50 });
      } else {
        // Use direct value setting for other types of elements
        await element.evaluate((el, value) => {
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            el.value = value;
          } else if (el instanceof HTMLElement && el.isContentEditable) {
            el.textContent = value;
          }
          // Dispatch events
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, text);
      }

      // Wait for page stability after input
      await this.waitForPageAndFramesLoad();
    } catch (error) {
      const errorMsg = `Failed to input text into element: ${elementNode}. Error: ${error instanceof Error ? error.message : String(error)}`;
      logger.error(errorMsg);
      throw new Error(errorMsg);
    }
  }

  /**
   * Wait for an element to become stable (no position/size changes)
   * Similar to Playwright's wait_for_element_state('stable')
   */
  private async _waitForElementStability(element: ElementHandle, timeout = 1000): Promise<void> {
    const startTime = Date.now();
    let lastRect = await element.boundingBox();

    while (Date.now() - startTime < timeout) {
      // Wait a short time
      await new Promise(resolve => setTimeout(resolve, 50));

      // Get current position and size
      const currentRect = await element.boundingBox();

      // If element is no longer in DOM or not visible
      if (!currentRect) {
        break;
      }

      // Compare with previous position/size
      if (
        lastRect &&
        Math.abs(lastRect.x - currentRect.x) < 2 &&
        Math.abs(lastRect.y - currentRect.y) < 2 &&
        Math.abs(lastRect.width - currentRect.width) < 2 &&
        Math.abs(lastRect.height - currentRect.height) < 2
      ) {
        // Position is stable - wait a bit more to be sure and then return
        await new Promise(resolve => setTimeout(resolve, 50));
        return;
      }

      // Update last position
      lastRect = currentRect;
    }

    // If we got here, either the element stabilized or we timed out
    logger.debug('Element stability check completed (timeout or stable)');
  }

  private async _scrollIntoViewIfNeeded(element: ElementHandle, timeout = 1000): Promise<void> {
    const startTime = Date.now();

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Check if element is in viewport
      const isVisible = await element.evaluate(el => {
        const rect = el.getBoundingClientRect();

        // Check if element has size
        if (rect.width === 0 || rect.height === 0) return false;

        // Check if element is hidden
        const style = window.getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') {
          return false;
        }

        // Check if element is in viewport
        const isInViewport =
          rect.top >= 0 &&
          rect.left >= 0 &&
          rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
          rect.right <= (window.innerWidth || document.documentElement.clientWidth);

        if (!isInViewport) {
          // Scroll into view if not visible
          el.scrollIntoView({
            behavior: 'auto',
            block: 'center',
            inline: 'center',
          });
          return false;
        }

        return true;
      });

      if (isVisible) break;

      // Check timeout - log warning and return instead of throwing
      if (Date.now() - startTime > timeout) {
        logger.warning('Timed out while trying to scroll element into view, continuing anyway');
        break;
      }

      // Small delay before next check
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  /**
   * Put a file the user attached into a page's file input.
   *
   * Not Puppeteer's `uploadFile`, and not CDP's `DOM.setFileInputFiles`: both take a path on disk,
   * and an extension never has one. A file input hands JavaScript a File object, never its
   * location, so the only route left is to build the File from bytes we already hold and assign it.
   *
   * Runs in the MAIN world on purpose. `input.files` only accepts a FileList, which cannot be
   * constructed directly - it has to come out of a DataTransfer - and a DataTransfer built in the
   * isolated world belongs to a different realm than the input it is being assigned to. Building
   * both in the page's own realm sidesteps that entirely, and has the second benefit that the
   * File the site's own upload code reads is an ordinary same-realm File.
   *
   * The change and input events are dispatched by hand afterwards. Assigning `.files` fires
   * nothing, so without them every framework on the page still believes the field is empty - which
   * is the failure mode where the file is visibly attached and the Submit button stays disabled.
   *
   * @param elementNode the element the model chose, or null to take the page's first file input
   * @param file name, type and base64 bytes of the attachment
   * @returns a short description of the input that received it, for the action's result message
   */
  async uploadFileToElement(
    elementNode: DOMElementNode | null,
    file: { name: string; mimeType: string; data: string },
  ): Promise<string> {
    // Only ever a hint: an input inside a shadow root or a cross-origin frame will not match it,
    // and the injected side falls back to searching rather than failing.
    const selector = elementNode
      ? elementNode.enhancedCssSelectorForElement(this._config.includeDynamicAttributes)
      : '';

    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: this._tabId },
      world: 'MAIN',
      args: [selector, file.name, file.mimeType, file.data],
      func: (cssSelector: string, fileName: string, mimeType: string, base64: string) => {
        /** The file input to fill: the chosen element, one inside it, or the page's first one. */
        const resolveInput = (): HTMLInputElement | null => {
          const isFileInput = (node: Element | null | undefined): node is HTMLInputElement =>
            node instanceof HTMLInputElement && node.type === 'file';

          if (cssSelector) {
            let chosen: Element | null = null;
            try {
              chosen = document.querySelector(cssSelector);
            } catch {
              // a selector built from page attributes can be syntactically invalid; fall through
            }
            if (isFileInput(chosen)) return chosen;
            // The visible "Choose file" control is very often a label or button that hides the real
            // input somewhere nearby, so look inside it and then at its siblings before giving up.
            const nested = chosen?.querySelector('input[type="file"]');
            if (isFileInput(nested)) return nested;
            const inLabel = chosen?.closest('label')?.querySelector('input[type="file"]');
            if (isFileInput(inLabel)) return inLabel;
          }

          // Last resort: the first file input on the page. Deliberately not filtered by visibility -
          // a hidden input driven by a styled button is the common case, not the exception.
          const first = document.querySelector('input[type="file"]');
          return isFileInput(first) ? first : null;
        };

        const input = resolveInput();
        if (!input) return { ok: false as const, reason: 'no-input' };

        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);

        const transfer = new DataTransfer();
        transfer.items.add(new File([bytes], fileName, { type: mimeType || 'application/octet-stream' }));
        try {
          input.files = transfer.files;
        } catch {
          return { ok: false as const, reason: 'assign-failed' };
        }

        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));

        const label =
          input.getAttribute('aria-label') ?? input.getAttribute('name') ?? input.getAttribute('id') ?? 'file input';
        return { ok: true as const, label };
      },
    });

    const result = injection?.result;
    if (!result || !result.ok) {
      throw new Error(
        result?.reason === 'assign-failed'
          ? 'The page refused the file, which usually means the field only accepts a different file type'
          : 'No file input could be found on this page',
      );
    }
    return result.label;
  }

  /**
   * Park the mouse over an element so whatever only exists on hover appears: a nav submenu, a row's
   * action buttons, a tooltip carrying the real price.
   *
   * Nothing here mirrors clickElementNode's deadline dance, because the hazard that motivated it
   * does not exist: a hover that lands twice is the same hover, so a plain retry is safe. The
   * fallback dispatches the pointer/mouse sequence a real cursor produces, in the order a listener
   * expects, since libraries listen for different members of it (pointerover, mouseover, mouseenter)
   * and one alone leaves half of them unfired.
   *
   * Deliberately no wait afterwards. What hover reveals is animated at wildly different speeds, so
   * any fixed sleep is either dead time or too short; the agent reads the page on its next step,
   * which is when the reveal has to be there anyway.
   */
  async hoverElementNode(elementNode: DOMElementNode): Promise<void> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }

    try {
      const element = await this.locateElement(elementNode);
      if (!element) {
        throw new Error(`Element: ${elementNode} not found`);
      }

      await this._scrollIntoViewIfNeeded(element);
      await this.markActivityTarget(element);

      try {
        await element.hover();
      } catch (error) {
        // Puppeteer's hover needs a hit-testable point, which an element covered by a sticky header
        // or sized zero does not have. Synthesising the events reaches the listeners anyway.
        logger.info('Native hover failed, dispatching pointer events directly', error);
        await element.evaluate(el => {
          const target = el as HTMLElement;
          const box = target.getBoundingClientRect();
          const init: MouseEventInit = {
            bubbles: true,
            cancelable: true,
            clientX: box.left + box.width / 2,
            clientY: box.top + box.height / 2,
            view: window,
          };
          target.dispatchEvent(new PointerEvent('pointerover', init));
          target.dispatchEvent(new PointerEvent('pointerenter', { ...init, bubbles: false }));
          target.dispatchEvent(new MouseEvent('mouseover', init));
          target.dispatchEvent(new MouseEvent('mouseenter', { ...init, bubbles: false }));
          target.dispatchEvent(new MouseEvent('mousemove', init));
        });
      }
    } catch (error) {
      throw new Error(
        `Failed to hover element: ${elementNode}. Error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async clickElementNode(useVision: boolean, elementNode: DOMElementNode): Promise<void> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }

    try {
      // Highlight before clicking
      // if (elementNode.highlightIndex !== null) {
      //   await this._updateState(useVision, elementNode.highlightIndex);
      // }

      const element = await this.locateElement(elementNode);
      if (!element) {
        throw new Error(`Element: ${elementNode} not found`);
      }

      // Scroll element into view if needed
      await this._scrollIntoViewIfNeeded(element);

      // Show the user where the click is about to land, after the scroll so the coordinates are the
      // ones the click will actually use.
      await this.markActivityTarget(element);

      // A deadline decides how long to wait for the click, never whether to click again.
      //
      // Puppeteer's click is a sequence of CDP round-trips - scroll into view, hit-test for a
      // clickable point, dispatch the mouse event - so on a loaded machine it can outlast a short
      // deadline while still being perfectly in flight. `Promise.race` cannot cancel the loser: that
      // click goes on to dispatch a real trusted event. Clicking again at that point is not a
      // retry, it is a second click, which is how one approved "Place order" became two orders. So
      // the JS fallback now runs only when the native click is known to have rejected.
      let clickRejected = false;
      const nativeClick = element.click();
      nativeClick.catch(() => {
        clickRejected = true;
      });

      let deadline: ReturnType<typeof setTimeout> | undefined;
      let ceiling: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          nativeClick,
          new Promise((_, reject) => {
            deadline = setTimeout(() => reject(new Error('Click timeout')), CLICK_DEADLINE_MS);
          }),
        ]);
      } catch (error) {
        // if URLNotAllowedError, throw it
        if (error instanceof URLNotAllowedError) {
          throw error;
        }

        if (!clickRejected) {
          // The deadline passed with the click still running. It will land on its own, and a second
          // click would double whatever it triggers, so waiting it out is the only safe option.
          logger.warning('Click is taking longer than its deadline; letting it finish rather than clicking again');
          try {
            await Promise.race([
              nativeClick,
              new Promise((_, reject) => {
                ceiling = setTimeout(
                  () => reject(new Error(`Click did not settle within ${CLICK_SETTLE_CEILING_MS} ms`)),
                  CLICK_SETTLE_CEILING_MS,
                );
              }),
            ]);
          } catch (lateError) {
            if (lateError instanceof URLNotAllowedError) throw lateError;
            // It rejected after all, so the click provably never dispatched and the JS fallback is
            // safe. (A ceiling timeout lands here too and is reported as the failure it is.)
            logger.info('Click failed after its deadline, trying again', lateError);
            await element.evaluate(el => (el as HTMLElement).click());
          }
        } else {
          // Second attempt: Use evaluate to perform a direct click
          logger.info('Failed to click element, trying again', error);
          try {
            await element.evaluate(el => (el as HTMLElement).click());
          } catch (secondError) {
            // if URLNotAllowedError, throw it
            if (secondError instanceof URLNotAllowedError) {
              throw secondError;
            }
            throw new Error(
              `Failed to click element: ${secondError instanceof Error ? secondError.message : String(secondError)}`,
            );
          }
        }
      } finally {
        // The timer used to be left running, so every click kept the service worker's event loop
        // busy for the full deadline after the click had already settled.
        if (deadline !== undefined) clearTimeout(deadline);
        if (ceiling !== undefined) clearTimeout(ceiling);
      }

      // Kept out of the click's try/catch on purpose: a navigation check that throws is not a
      // reason to click the element a second time.
      await this._checkAndHandleNavigation();
    } catch (error) {
      throw new Error(
        `Failed to click element: ${elementNode}. Error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // getSelectorMap / getElementByIndex / getDomElementByIndex used to live here. They resolved a
  // model-chosen index against `_cachedState`, i.e. against whichever parse happened to have run
  // last rather than the one the model was shown - which is how an action could silently retarget
  // itself at a different element. Every caller now resolves through AgentContext.stepState instead,
  // so they are removed rather than left as a tempting shortcut back to the old pattern.

  isFileUploader(elementNode: DOMElementNode, maxDepth = 3, currentDepth = 0): boolean {
    if (currentDepth > maxDepth) {
      return false;
    }

    // Check current element
    if (elementNode.tagName === 'input') {
      // Check for file input attributes
      const attributes = elementNode.attributes;
      // biome-ignore lint/complexity/useLiteralKeys: <explanation>
      if (attributes['type']?.toLowerCase() === 'file' || !!attributes['accept']) {
        return true;
      }
    }

    // Recursively check children
    if (elementNode.children && currentDepth < maxDepth) {
      for (const child of elementNode.children) {
        if ('tagName' in child) {
          // DOMElementNode type guard
          if (this.isFileUploader(child as DOMElementNode, maxDepth, currentDepth + 1)) {
            return true;
          }
        }
      }
    }

    return false;
  }

  async waitForPageLoadState(timeout?: number) {
    const timeoutValue = timeout || 8000;
    await this._puppeteerPage?.waitForNavigation({ timeout: timeoutValue });
  }

  private async _waitForStableNetwork() {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer page is not connected');
    }

    // `xhr` and `fetch` are the two that matter most on a modern site and were the two missing.
    // Without them a click that fires a search, a filter or a "load more" was never waited on at
    // all: the loop saw nothing pending, served its 0.5s quiet period, and parsed the DOM while the
    // response was still in flight. The old view is still mounted at that moment, so the parse
    // succeeds and the model is handed the previous screen's elements, renumbered - stale in the
    // way that looks most plausible.
    const RELEVANT_RESOURCE_TYPES = new Set([
      'document',
      'stylesheet',
      'image',
      'font',
      'script',
      'iframe',
      'xhr',
      'fetch',
    ]);

    const RELEVANT_CONTENT_TYPES = new Set([
      'text/html',
      'text/css',
      'application/javascript',
      'image/',
      'font/',
      'application/json',
    ]);

    /**
     * Pending requests, each stamped with when it started.
     *
     * The stamp is what makes waiting on `xhr`/`fetch` safe. A long-poll, an SSE-over-fetch or an
     * analytics socket that slipped the filter never completes, and without an expiry one of those
     * would hold every single wait open to the full `maximumWaitPageLoadTime` ceiling. A request
     * still outstanding after this long is not what the page is rendering from.
     */
    const STALE_REQUEST_MS = 2_000;
    const pendingRequests = new Map<HTTPRequest, number>();
    let lastActivity = Date.now();

    const onRequest = (request: HTTPRequest) => {
      // Filter by resource type
      const resourceType = request.resourceType();
      if (!RELEVANT_RESOURCE_TYPES.has(resourceType)) {
        return;
      }

      // Filter out streaming, websocket, and other real-time requests
      if (['websocket', 'media', 'eventsource', 'manifest', 'other'].includes(resourceType)) {
        return;
      }

      // Filter out by URL patterns
      const url = request.url().toLowerCase();
      if (isIgnoredUrl(url)) {
        return;
      }

      // Filter out data URLs and blob URLs
      if (url.startsWith('data:') || url.startsWith('blob:')) {
        return;
      }

      // Filter out requests with certain headers
      const headers = request.headers();
      if (
        // biome-ignore lint/complexity/useLiteralKeys: <explanation>
        headers['purpose'] === 'prefetch' ||
        headers['sec-fetch-dest'] === 'video' ||
        headers['sec-fetch-dest'] === 'audio'
      ) {
        return;
      }

      pendingRequests.set(request, Date.now());
      lastActivity = Date.now();
    };

    const onResponse = (response: HTTPResponse) => {
      const request = response.request();
      if (!pendingRequests.has(request)) {
        return;
      }

      // Filter by content type
      const contentType = response.headers()['content-type']?.toLowerCase() || '';

      // Skip streaming content
      if (
        ['streaming', 'video', 'audio', 'webm', 'mp4', 'event-stream', 'websocket', 'protobuf'].some(t =>
          contentType.includes(t),
        )
      ) {
        pendingRequests.delete(request);
        return;
      }

      // Only process relevant content types
      if (!Array.from(RELEVANT_CONTENT_TYPES).some(ct => contentType.includes(ct))) {
        pendingRequests.delete(request);
        return;
      }

      // Skip large responses
      const contentLength = response.headers()['content-length'];
      if (contentLength && Number.parseInt(contentLength) > 5 * 1024 * 1024) {
        // 5MB
        pendingRequests.delete(request);
        return;
      }

      pendingRequests.delete(request);
      lastActivity = Date.now();
    };

    // Add event listeners
    this._puppeteerPage.on('request', onRequest);
    this._puppeteerPage.on('response', onResponse);

    try {
      const startTime = Date.now();

      // eslint-disable-next-line no-constant-condition
      while (true) {
        await new Promise(resolve => setTimeout(resolve, 100));

        const now = Date.now();
        const timeSinceLastActivity = (now - lastActivity) / 1000; // Convert to seconds

        for (const [request, startedAt] of pendingRequests) {
          if (now - startedAt > STALE_REQUEST_MS) pendingRequests.delete(request);
        }

        if (pendingRequests.size === 0 && timeSinceLastActivity >= this._config.waitForNetworkIdlePageLoadTime) {
          break;
        }

        const elapsedTime = (now - startTime) / 1000; // Convert to seconds
        if (elapsedTime > this._config.maximumWaitPageLoadTime) {
          console.debug(
            `Network timeout after ${this._config.maximumWaitPageLoadTime}s with ${pendingRequests.size} pending requests:`,
            Array.from(pendingRequests.keys()).map(r => r.url()),
          );
          break;
        }
      }
    } finally {
      // Clean up event listeners
      this._puppeteerPage.off('request', onRequest);
      this._puppeteerPage.off('response', onResponse);
    }
    console.debug(`Network stabilized for ${this._config.waitForNetworkIdlePageLoadTime} seconds`);
  }

  async waitForPageAndFramesLoad(timeoutOverwrite?: number): Promise<void> {
    // Start timing
    const startTime = Date.now();

    // Wait for page load
    try {
      await this._waitForStableNetwork();

      // Check if the loaded URL is allowed
      if (this._puppeteerPage) {
        await this._checkAndHandleNavigation();
      }
    } catch (error) {
      if (error instanceof URLNotAllowedError) {
        throw error;
      }
      console.warn('Page load failed, continuing...', error);
    }

    // Calculate remaining time to meet minimum wait time
    const elapsed = (Date.now() - startTime) / 1000; // Convert to seconds
    const minWaitTime = timeoutOverwrite || this._config.minimumWaitPageLoadTime;
    const remaining = Math.max(minWaitTime - elapsed, 0);

    console.debug(
      `--Page loaded in ${elapsed.toFixed(2)} seconds, waiting for additional ${remaining.toFixed(2)} seconds`,
    );

    // Sleep remaining time if needed
    if (remaining > 0) {
      await new Promise(resolve => setTimeout(resolve, remaining * 1000)); // Convert seconds to milliseconds
    }
  }

  /**
   * Check the current page URL and handle if it's not allowed
   * @throws URLNotAllowedError if the current URL is not allowed
   */
  private async _checkAndHandleNavigation(): Promise<void> {
    if (!this._puppeteerPage) {
      return;
    }

    const currentUrl = this._puppeteerPage.url();
    if (!isUrlAllowed(currentUrl, this._config.allowedUrls, this._config.deniedUrls)) {
      const errorMessage = `URL: ${currentUrl} is not allowed`;
      logger.error(errorMessage);

      // Navigate to home page or about:blank
      const safeUrl = this._config.homePageUrl || 'about:blank';
      logger.info(`Redirecting to safe URL: ${safeUrl}`);

      try {
        await this._puppeteerPage.goto(safeUrl);
      } catch (error) {
        logger.error(`Failed to redirect to safe URL: ${error instanceof Error ? error.message : String(error)}`);
      }

      throw new URLNotAllowedError(errorMessage);
    }
  }
}
