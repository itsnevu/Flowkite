import 'webextension-polyfill';
import { t } from '@extension/i18n';
import { createLogger } from '@src/background/log';
import { activityLogStore } from '@extension/storage';
import { analytics } from '../services/analytics';
import {
  type BrowserContextConfig,
  type BrowserState,
  DEFAULT_BROWSER_CONTEXT_CONFIG,
  type TabInfo,
  URLNotAllowedError,
} from './views';
import Page, { build_initial_state } from './page';
import { isUrlAllowed } from './util';
import TaskTabGroup, { type TabGroupStatus } from './tabGroup';

const logger = createLogger('BrowserContext');

/**
 * Best-effort append to the user's own local activity log (the privacy dashboard's data). Only
 * real web hosts are worth recording, and a log write must never fail a navigation.
 */
function recordLocalVisit(url: string): void {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      void activityLogStore.recordVisit(parsed.host).catch(() => {});
    }
  } catch {
    // an unparseable URL is not a visit
  }
}
export default class BrowserContext {
  private _config: BrowserContextConfig;
  private _currentTabId: number | null = null;
  private _attachedPages: Map<number, Page> = new Map();
  /** Null outside a task, and whenever the user has turned tab grouping off. */
  private _tabGroup: TaskTabGroup | null = null;
  /**
   * Whether the agent is announcing itself on the tabs it drives, and what it is doing right now.
   *
   * Kept on the context rather than on a Page because the announcement belongs to the task, not to
   * a tab: the agent moves between tabs mid-task, and every tab it lands on has to carry the banner
   * from the moment it arrives.
   */
  private _activityDetail: string | null = null;
  /** Called when the user presses the stop button drawn on the page. */
  private _activityStopHandler: (() => void) | null = null;

  constructor(config: Partial<BrowserContextConfig>) {
    this._config = { ...DEFAULT_BROWSER_CONTEXT_CONFIG, ...config };
  }

  public getConfig(): BrowserContextConfig {
    return this._config;
  }

  public updateConfig(config: Partial<BrowserContextConfig>): void {
    this._config = { ...this._config, ...config };
  }

  public updateCurrentTabId(tabId: number): void {
    // only update tab id, but don't attach it.
    this._currentTabId = tabId;
  }

  /**
   * Open a labelled tab group for a task. Tabs are only adopted as they are attached, so no group
   * appears in the tab strip until the agent actually takes hold of a tab - a task that fails on
   * its first model call leaves the browser exactly as it found it.
   */
  public startTaskGroup(label: string): void {
    this._tabGroup = this._config.groupTabs ? new TaskTabGroup(label) : null;
  }

  /**
   * Stamp the task's outcome on the group chip and let go of it. The group and its tabs stay in
   * the browser: they hold whatever the user asked the agent to find.
   */
  public async finishTaskGroup(status: TabGroupStatus): Promise<void> {
    const group = this._tabGroup;
    this._tabGroup = null;
    await group?.setStatus(status);
  }

  private async _getOrCreatePage(tab: chrome.tabs.Tab, forceUpdate = false): Promise<Page> {
    if (!tab.id) {
      throw new Error('Tab ID is not available');
    }

    const existingPage = this._attachedPages.get(tab.id);
    if (existingPage) {
      logger.info('getOrCreatePage', tab.id, 'already attached');
      if (!forceUpdate) {
        return existingPage;
      }
      // detach the page and remove it from the attached pages if forceUpdate is true
      await existingPage.detachPuppeteer();
      this._attachedPages.delete(tab.id);
    }
    logger.info('getOrCreatePage', tab.id, 'creating new page');
    return new Page(tab.id, tab.url || '', tab.title || '', this._config);
  }

  public async cleanup(): Promise<void> {
    // Deliberately not `getCurrentPage()`. With no current tab that helper queries the active tab
    // and attaches to it - or creates one when there is none - so teardown could raise the
    // debugging banner on a tab this context never touched. It could also throw before the detach
    // loop ran, leaving every page attached and the map populated for the next task to inherit.
    const currentPage = this._currentTabId !== null ? this._attachedPages.get(this._currentTabId) : undefined;
    try {
      await currentPage?.removeHighlight();
    } catch (error) {
      logger.warning('Failed to remove highlights during cleanup:', error);
    }

    await this.hideActivity();

    // detach all pages; one page failing to detach must not strand the rest
    for (const page of this._attachedPages.values()) {
      try {
        await page.detachPuppeteer();
      } catch (error) {
        logger.warning('Failed to detach page during cleanup:', error);
      }
    }
    this._attachedPages.clear();
    this._currentTabId = null;
  }

  /**
   * Route the on-page stop button to whoever can actually stop the task.
   *
   * Set once per Executor and pushed to every page, including ones attached later: a button that
   * silently does nothing on the second tab of a task is worse than no button at all.
   */
  public setActivityStopHandler(handler: (() => void) | null): void {
    this._activityStopHandler = handler;
    for (const page of this._attachedPages.values()) {
      page.setActivityStopHandler(handler);
    }
  }

  /**
   * Announce the agent on the tab it is driving, and say what it is doing.
   *
   * Deliberately not `getCurrentPage()`: that helper attaches to - or creates - a tab when there is
   * no current one, and drawing a banner is never a reason to raise the debugging banner on a tab
   * this task has not touched. With no attached current page there is simply nothing to draw on
   * yet, and the next action that does attach one draws it then.
   */
  public async showActivity(detail: string): Promise<void> {
    if (!this._config.showActivityOverlay) return;
    this._activityDetail = detail;
    const page = this._currentTabId !== null ? this._attachedPages.get(this._currentTabId) : undefined;
    await page?.showActivityOverlay({
      title: t('bg_overlay_active'),
      detail,
      stopLabel: t('bg_overlay_stop'),
    });
  }

  /** Take the banner off every tab this task touched. Never throws: it runs on the teardown path. */
  public async hideActivity(): Promise<void> {
    this._activityDetail = null;
    for (const page of this._attachedPages.values()) {
      try {
        await page.hideActivityOverlay();
      } catch (error) {
        logger.debug('Failed to remove the activity overlay:', error);
      }
    }
  }

  public async attachPage(page: Page): Promise<boolean> {
    // check if page is already attached
    if (this._attachedPages.has(page.tabId)) {
      logger.info('attachPage', page.tabId, 'already attached');
      return true;
    }

    if (await page.attachPuppeteer()) {
      logger.info('attachPage', page.tabId, 'attached');
      // add page to managed pages
      this._attachedPages.set(page.tabId, page);
      page.setActivityStopHandler(this._activityStopHandler);
      // A tab the task switches to mid-run has to carry the banner too, so it is drawn on arrival
      // rather than waiting for the next action to redraw it.
      if (this._activityDetail !== null) {
        void page
          .showActivityOverlay({
            title: t('bg_overlay_active'),
            detail: this._activityDetail,
            stopLabel: t('bg_overlay_stop'),
          })
          .catch(() => undefined);
      }
      // Disclose the tab as agent-driven. Awaited so the chip is in place before the agent acts on
      // the page, but it can never fail the attach - TaskTabGroup swallows its own errors.
      await this._tabGroup?.adopt(page.tabId);
      return true;
    }
    return false;
  }

  public async detachPage(tabId: number): Promise<void> {
    // detach page
    const page = this._attachedPages.get(tabId);
    if (page) {
      await page.detachPuppeteer();
      // remove page from managed pages
      this._attachedPages.delete(tabId);
    }
  }

  public async getCurrentPage(): Promise<Page> {
    // 1. If _currentTabId not set, query the active tab and attach it
    if (!this._currentTabId) {
      let activeTab: chrome.tabs.Tab;
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        // open a new tab with blank page
        const newTab = await chrome.tabs.create({ url: this._config.homePageUrl });
        if (!newTab.id) {
          // this should rarely happen
          throw new Error('No tab ID available');
        }
        activeTab = newTab;
      } else {
        activeTab = tab;
      }
      logger.info('active tab', activeTab.id, activeTab.url, activeTab.title);
      const page = await this._getOrCreatePage(activeTab);
      await this.attachPage(page);
      this._currentTabId = activeTab.id || null;
      return page;
    }

    // 2. If _currentTabId is set but not in attachedPages, attach the tab
    const existingPage = this._attachedPages.get(this._currentTabId);
    if (!existingPage) {
      const tab = await chrome.tabs.get(this._currentTabId);
      const page = await this._getOrCreatePage(tab);
      // set current tab id to null if the page is not attached successfully
      await this.attachPage(page);
      return page;
    }

    // 3. Return existing page from attachedPages
    return existingPage;
  }

  /**
   * Get all tab IDs from the browser and the current window.
   * @returns A set of tab IDs.
   */
  public async getAllTabIds(): Promise<Set<number>> {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    return new Set(tabs.map(tab => tab.id).filter(id => id !== undefined));
  }

  /**
   * Wait for tab events to occur after a tab is created or updated.
   * @param tabId - The ID of the tab to wait for events on.
   * @param options - An object containing options for the wait.
   * @returns A promise that resolves when the tab events occur.
   */
  private async waitForTabEvents(
    tabId: number,
    options: {
      waitForUpdate?: boolean;
      waitForActivation?: boolean;
      timeoutMs?: number;
    } = {},
  ): Promise<void> {
    const { waitForUpdate = true, waitForActivation = true, timeoutMs = 5000 } = options;

    const promises: Promise<void>[] = [];
    // Hoisted so the `finally` can remove them on every path. They used to be removed only from
    // inside their own resolve branches, so a timeout left the listener registered for the life of
    // the worker - and a stale listener then runs on every tab update in the entire browser.
    let onUpdatedHandler: ((id: number, info: chrome.tabs.TabChangeInfo) => void) | undefined;
    let onActivatedHandler: ((info: chrome.tabs.TabActiveInfo) => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (waitForUpdate) {
      const updatePromise = new Promise<void>(resolve => {
        let hasUrl = false;
        let hasTitle = false;
        let isComplete = false;

        onUpdatedHandler = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
          if (updatedTabId !== tabId) return;

          if (changeInfo.url) hasUrl = true;
          if (changeInfo.title) hasTitle = true;
          if (changeInfo.status === 'complete') isComplete = true;

          // Resolve when we have all the information we need
          if (hasUrl && hasTitle && isComplete) resolve();
        };
        chrome.tabs.onUpdated.addListener(onUpdatedHandler);

        // Check current state. The catch matters: a tab that closed mid-wait rejects here, and an
        // unhandled rejection would leave this promise pending until the timeout instead.
        chrome.tabs
          .get(tabId)
          .then(tab => {
            if (tab.url) hasUrl = true;
            if (tab.title) hasTitle = true;
            if (tab.status === 'complete') isComplete = true;

            if (hasUrl && hasTitle && isComplete) resolve();
          })
          .catch(() => {});
      });
      promises.push(updatePromise);
    }

    if (waitForActivation) {
      const activatedPromise = new Promise<void>(resolve => {
        onActivatedHandler = (activeInfo: chrome.tabs.TabActiveInfo) => {
          if (activeInfo.tabId === tabId) resolve();
        };
        chrome.tabs.onActivated.addListener(onActivatedHandler);

        // Check current state
        chrome.tabs
          .get(tabId)
          .then(tab => {
            if (tab.active) resolve();
          })
          .catch(() => {});
      });
      promises.push(activatedPromise);
    }

    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Tab operation timed out after ${timeoutMs} ms`)), timeoutMs);
      });

      await Promise.race([Promise.all(promises), timeoutPromise]);
    } finally {
      if (onUpdatedHandler) chrome.tabs.onUpdated.removeListener(onUpdatedHandler);
      if (onActivatedHandler) chrome.tabs.onActivated.removeListener(onActivatedHandler);
      // The timer used to outlive every successful call, keeping the worker busy for its full span.
      clearTimeout(timer);
    }
  }

  public async switchTab(tabId: number, options: { activate?: boolean } = {}): Promise<Page> {
    const { activate = true } = options;
    logger.info('switchTab', tabId, activate ? '' : '(without focusing it)');

    // An unattended run pins a tab it deliberately created inactive. Activating it here undid that
    // one line later and yanked the user's focus to a blank tab whenever a schedule fired.
    if (activate) {
      await chrome.tabs.update(tabId, { active: true });
    }
    await this.waitForTabEvents(tabId, { waitForUpdate: false, waitForActivation: activate });

    const page = await this._getOrCreatePage(await chrome.tabs.get(tabId));
    await this.attachPage(page);
    this._currentTabId = tabId;
    return page;
  }

  public async navigateTo(url: string): Promise<void> {
    if (!isUrlAllowed(url, this._config.allowedUrls, this._config.deniedUrls)) {
      throw new URLNotAllowedError(`URL: ${url} is not allowed`);
    }

    // Track domain visit for analytics, and in the user's own local activity log
    void analytics.trackDomainVisit(url);
    recordLocalVisit(url);

    const page = await this.getCurrentPage();
    if (!page) {
      await this.openTab(url);
      return;
    }
    // if page is attached, use puppeteer to navigate to the url
    if (page.attached) {
      await page.navigateTo(url);
      return;
    }
    //  Use chrome.tabs.update only if the page is not attached
    const tabId = page.tabId;
    // Update tab and wait for events
    await chrome.tabs.update(tabId, { url, active: true });
    await this.waitForTabEvents(tabId);

    // Reattach the page after navigation completes
    const updatedPage = await this._getOrCreatePage(await chrome.tabs.get(tabId), true);
    await this.attachPage(updatedPage);
    this._currentTabId = tabId;
  }

  public async openTab(url: string, options: { active?: boolean } = {}): Promise<Page> {
    const { active = true } = options;

    if (!isUrlAllowed(url, this._config.allowedUrls, this._config.deniedUrls)) {
      throw new URLNotAllowedError(`Open tab failed. URL: ${url} is not allowed`);
    }

    recordLocalVisit(url);

    // Create the new tab
    const tab = await chrome.tabs.create({ url, active });
    if (!tab.id) {
      throw new Error('No tab ID available');
    }
    const tabId = tab.id;

    try {
      // Activation is awaited only for a tab we actually asked to be active. Only one tab can be
      // active at a time, so several concurrent opens would otherwise each wait on an event that
      // can only ever fire for the last one created - and the rest would time out holding a tab
      // that had in fact opened perfectly well.
      await this.waitForTabEvents(tabId, { waitForActivation: active });

      // Get updated tab information
      const updatedTab = await chrome.tabs.get(tabId);
      // Create and attach the page after tab is fully loaded and activated
      const page = await this._getOrCreatePage(updatedTab);
      await this.attachPage(page);
      this._currentTabId = tabId;

      return page;
    } catch (error) {
      // The tab exists even though the wait or the attach did not finish, and the caller holds no
      // other handle on it. Carry the id on the error so it can be closed rather than leaked.
      if (error instanceof Error) {
        (error as Error & { tabId?: number }).tabId = tabId;
      }
      throw error;
    }
  }

  public async closeTab(tabId: number): Promise<void> {
    await this.detachPage(tabId);
    await chrome.tabs.remove(tabId);
    this._tabGroup?.forget(tabId);
    // update current tab id if needed
    if (this._currentTabId === tabId) {
      this._currentTabId = null;
    }
  }

  /**
   * Remove a tab from the attached pages map. This will not run detachPuppeteer.
   * @param tabId - The ID of the tab to remove.
   */
  public removeAttachedPage(tabId: number): void {
    this._attachedPages.delete(tabId);
    this._tabGroup?.forget(tabId);
    // update current tab id if needed
    if (this._currentTabId === tabId) {
      this._currentTabId = null;
    }
  }

  public async getTabInfos(): Promise<TabInfo[]> {
    const tabs = await chrome.tabs.query({});
    const tabInfos: TabInfo[] = [];

    for (const tab of tabs) {
      if (tab.id && tab.url && tab.title) {
        tabInfos.push({
          id: tab.id,
          url: tab.url,
          title: tab.title,
        });
      }
    }
    return tabInfos;
  }

  public async getCachedState(useVision = false, cacheClickableElementsHashes = false): Promise<BrowserState> {
    const currentPage = await this.getCurrentPage();

    let pageState = !currentPage ? build_initial_state() : currentPage.getCachedState();
    if (!pageState) {
      pageState = await currentPage.getState(useVision, cacheClickableElementsHashes);
    }

    const tabInfos = await this.getTabInfos();
    const browserState: BrowserState = {
      ...pageState,
      tabs: tabInfos,
    };
    return browserState;
  }

  public async getState(useVision = false, cacheClickableElementsHashes = false): Promise<BrowserState> {
    const currentPage = await this.getCurrentPage();

    const pageState = !currentPage
      ? build_initial_state()
      : await currentPage.getState(useVision, cacheClickableElementsHashes);
    const tabInfos = await this.getTabInfos();
    const browserState: BrowserState = {
      ...pageState,
      tabs: tabInfos,
      // browser_errors: [],
    };
    return browserState;
  }

  public async removeHighlight(): Promise<void> {
    const page = await this.getCurrentPage();
    if (page) {
      await page.removeHighlight();
    }
  }
}
