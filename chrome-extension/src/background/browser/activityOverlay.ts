/**
 * The badge and white ring the agent draws on a tab it is driving.
 *
 * Its whole job is to answer "is something else typing in my browser right now, and what is it
 * doing?" without the user having to watch the side panel. That makes two properties load-bearing:
 *
 * - It must be impossible to mistake for the page. It sits above everything and is drawn in
 *   Flowkite's own white-on-graphite. Everything in it is `pointer-events: none` so it cannot
 *   swallow an interaction meant for the page underneath - with one deliberate exception, the stop
 *   button, which is the one part of the overlay the user is meant to be able to hit.
 * - It must be invisible to the agent itself. A banner that reached the model would be a banner the
 *   model reads back as page content and reasons about. It is skipped by the DOM parse (by id, in
 *   buildDomTree), lives in a shadow root so it cannot be selected as page markup, and is switched
 *   off entirely around a screenshot or a text extraction - see `Page.withActivityOverlayHidden`.
 *
 * Every function below is stringified and evaluated in the page, so none of them may close over
 * anything in this module: the id is spelled out again inside each one on purpose.
 */

/** The overlay's host element. Also referenced by buildDomTree.js, which must skip it. */
export const ACTIVITY_OVERLAY_ID = 'flowkite-activity-overlay';

/** How much of the agent's own description of an action the badge will show. */
const DETAIL_MAX_CHARS = 88;

/**
 * Make one line of agent-written text safe to print inside Flowkite's own badge.
 *
 * This matters more than its size suggests. The detail line is whatever the model put in the
 * action's `intent` field, and the model reads the page - so a hostile page can steer what appears
 * there. The badge is the exact surface a user reads to decide "this is Flowkite, and this is what
 * it is doing", which makes it worth attacking: "Session expired - enter your password to continue"
 * reads very differently inside a white-bordered badge with a kite on it than it does in the page.
 *
 * The structural half of the answer is in the markup - the product line and the agent's line are
 * separate elements with different weight, and only the product line is ever Flowkite's own words.
 * This is the textual half:
 *
 * - Control characters and line breaks go, so nothing can fake a second line or a separate element.
 * - Bidi overrides go specifically. They are the one class of invisible character that can reorder
 *   a single line of text into something that reads as an entirely different sentence.
 * - The length is capped, so the line cannot crowd out the product name it sits under.
 */
export function sanitizeOverlayDetail(detail: string): string {
  const flattened = detail
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[\u202a-\u202e\u2066-\u2069\u200e\u200f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return flattened.length > DETAIL_MAX_CHARS ? `${flattened.slice(0, DETAIL_MAX_CHARS - 1)}…` : flattened;
}

/** What the overlay says: a fixed product line, plus whatever the agent is doing this second. */
export interface ActivityOverlayContent {
  /** "Flowkite is active" - already localised by the caller. */
  title: string;
  /** The current action, in the user's language, or empty for none. */
  detail: string;
  /** Label for the stop button, already localised. */
  stopLabel: string;
  /**
   * Where the drawn cursor should start, in viewport coordinates, or null for offscreen.
   *
   * Carried in the content because a navigation builds a fresh host with no memory of where the
   * cursor was: without this the pointer teleports back to the corner and walks in again on every
   * page, which reads as a glitch rather than as one continuous agent.
   */
  cursorAt?: { x: number; y: number } | null;
  /**
   * The "now on <site>" toast, as a template with a literal `{host}` token, already localised.
   *
   * The host is filled in by the page from `location.host`, never from the page's title or anything
   * else the site controls: this line sits in Flowkite's own styling, and a title such as "Session
   * expired, enter your password" must not be able to borrow that authority.
   */
  arrivalTemplate?: string;
  /** Shown with a progress bar while the document unloads for a navigation nobody announced. */
  leavingLabel?: string;
}

/** How the drawn pointer behaves when it reaches its target. */
export type ActivityTargetMode = 'click' | 'type' | 'hover';

/** A target in viewport coordinates - where the cursor goes and where the ring is drawn. */
export interface ActivityTargetRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The page-side function name the stop button calls.
 *
 * Bound through Puppeteer's `exposeFunction`, which is the only channel out of the page that does
 * not require a content script: the overlay is injected from the worker over CDP, so there is no
 * extension script in the page to post a message from.
 */
export const ACTIVITY_STOP_BINDING = '__flowkiteRequestStop';

/**
 * Create or update the overlay. Idempotent, and safe to call on every action: a navigation wipes
 * the host along with the rest of the document, and the next call simply draws it again.
 */
export function renderActivityOverlay(content: ActivityOverlayContent): void {
  const HOST_ID = 'flowkite-activity-overlay';
  const parent = document.body || document.documentElement;
  if (!parent) return;

  let host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = HOST_ID;
    // Not content, and not a control: hidden from assistive tech the same way it is hidden from
    // the model, so a screen reader is not made to read the banner out on every action.
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;display:block;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { contain: layout style; }
        .ring {
          position: fixed; inset: 0; border: 3px solid rgba(255,255,255,0.95); border-radius: 4px;
          box-shadow: inset 0 0 0 1px rgba(24,24,27,0.35), 0 0 22px rgba(255,255,255,0.28);
          animation: fk-breathe 2.6s ease-in-out infinite;
        }
        .stack {
          position: fixed; top: 14px; left: 50%; transform: translateX(-50%);
          max-width: min(560px, 82vw); box-sizing: border-box;
          display: flex; flex-direction: column; align-items: center; gap: 5px;
        }
        .badge {
          max-width: 100%; box-sizing: border-box;
          display: flex; align-items: center; gap: 9px;
          padding: 8px 15px; border-radius: 999px;
          background: rgba(24,24,27,0.93); border: 1.5px solid rgba(255,255,255,0.95);
          box-shadow: 0 8px 26px rgba(0,0,0,0.35);
          font: 500 12.5px/1.25 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
          color: #fff; letter-spacing: 0.01em;
        }
        .kite { width: 15px; height: 15px; flex: none; }
        .title { white-space: nowrap; }
        /* Deliberately outside the badge. Everything inside that pill is Flowkite's own words; this
           line is the agent's, and the two must not read as one sentence from one author. */
        .detail {
          max-width: 100%; box-sizing: border-box;
          padding: 4px 11px; border-radius: 999px;
          background: rgba(24,24,27,0.72);
          font: 400 11.5px/1.25 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
          color: rgba(255,255,255,0.78);
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .detail:empty { display: none; }
        .dot {
          width: 6px; height: 6px; border-radius: 50%; background: #fff; flex: none;
          animation: fk-blink 1.4s ease-in-out infinite;
        }
        .pulse {
          position: fixed; border: 2.5px solid rgba(255,255,255,0.95); border-radius: 7px;
          box-shadow: 0 0 0 2px rgba(24,24,27,0.45), 0 0 18px rgba(255,255,255,0.55);
          opacity: 0;
        }
        .pulse.on { animation: fk-pulse 900ms cubic-bezier(0.2, 0, 0.2, 1); }
        /* The pointer is the cursor plus its name tag, moved as one so the label never lags. */
        .pointer {
          position: fixed; top: 0; left: 0;
          transform: translate3d(-40px, -40px, 0);
          transition: transform 380ms cubic-bezier(0.22, 0.61, 0.36, 1), opacity 240ms ease;
          opacity: 0;
        }
        .pointer.on { opacity: 1; }
        .cursor {
          display: block; width: 22px; height: 22px; transform-origin: 4px 3px;
          filter: drop-shadow(0 2px 4px rgba(0,0,0,0.55));
        }
        .pointer.press .cursor { animation: fk-press 320ms ease-out; }
        .tag {
          position: absolute; left: 17px; top: 19px;
          display: flex; align-items: center; gap: 4px;
          padding: 2px 8px; border-radius: 999px;
          background: rgba(24,24,27,0.92); border: 1px solid rgba(255,255,255,0.9);
          box-shadow: 0 3px 10px rgba(0,0,0,0.3);
          font: 600 10.5px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
          color: #fff; white-space: nowrap; letter-spacing: 0.01em;
        }
        .caret { display: none; width: 1.5px; height: 10px; background: #fff; animation: fk-caret 0.9s steps(1) infinite; }
        .pointer.typing .caret { display: inline-block; }
        /* Navigation: a bar across the top and a chip under the badge, so a page change is an event
           the user watches happen rather than a page that is simply different a second later. */
        .bar { position: fixed; top: 0; left: 0; width: 100%; height: 3px; overflow: hidden; opacity: 0; }
        .bar::after {
          content: ''; position: absolute; top: 0; left: -40%; width: 40%; height: 100%;
          background: linear-gradient(90deg, transparent, #fff, transparent);
        }
        .bar.on { opacity: 1; background: rgba(24,24,27,0.55); }
        .bar.on::after { animation: fk-slide 1.1s ease-in-out infinite; }
        .chip {
          max-width: 100%; box-sizing: border-box;
          display: none; align-items: center; gap: 8px;
          padding: 6px 13px; border-radius: 999px;
          background: rgba(255,255,255,0.97); color: #18181b; border: 1.5px solid rgba(24,24,27,0.85);
          box-shadow: 0 8px 22px rgba(0,0,0,0.3);
          font: 600 12px/1.25 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .chip.on { display: flex; }
        .arrive.on { animation: fk-arrive 2600ms ease forwards; }
        .spinner {
          width: 11px; height: 11px; flex: none; border-radius: 50%;
          border: 2px solid rgba(24,24,27,0.2); border-top-color: #18181b; animation: fk-spin 0.8s linear infinite;
        }
        .check { width: 8px; height: 8px; flex: none; border-radius: 50%; background: #16a34a; }
        .ring.arrived { animation: fk-arrive-ring 900ms ease-out, fk-breathe 2.6s ease-in-out 900ms infinite; }
        /* Scrolling: chevrons on the right edge, pointing the way the page is moving. */
        .scrollcue {
          position: fixed; right: 22px; top: 50%; transform: translateY(-50%);
          display: none; flex-direction: column; align-items: center; gap: 3px;
          padding: 9px 7px; border-radius: 999px;
          background: rgba(24,24,27,0.88); border: 1.5px solid rgba(255,255,255,0.92);
          box-shadow: 0 6px 18px rgba(0,0,0,0.35);
        }
        .scrollcue.on { display: flex; animation: fk-fade 1300ms ease forwards; }
        .scrollcue i {
          display: block; width: 7px; height: 7px; border-right: 2px solid #fff; border-bottom: 2px solid #fff;
          transform: rotate(45deg); opacity: 0.25; animation: fk-chev 0.9s ease-in-out infinite;
        }
        .scrollcue.up i { transform: rotate(-135deg); }
        .scrollcue i:nth-child(2) { animation-delay: 0.15s; }
        .scrollcue i:nth-child(3) { animation-delay: 0.3s; }
        .scrollcue.up i:nth-child(1) { animation-delay: 0.3s; }
        .scrollcue.up i:nth-child(3) { animation-delay: 0s; }
        .stop {
          position: fixed; bottom: 26px; left: 50%; transform: translateX(-50%);
          pointer-events: auto; cursor: pointer;
          display: flex; align-items: center; gap: 9px;
          padding: 11px 20px; border: 1.5px solid rgba(255,255,255,0.95); border-radius: 999px;
          background: rgba(24,24,27,0.95); color: #fff;
          font: 500 13px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
          box-shadow: 0 10px 30px rgba(0,0,0,0.45);
        }
        .stop:hover { background: #18181b; }
        .stop:active { transform: translateX(-50%) translateY(1px); }
        .stop-glyph {
          width: 15px; height: 15px; flex: none; border-radius: 50%;
          border: 2px solid #fff; display: grid; place-items: center;
        }
        .stop-glyph::after { content: ''; width: 5px; height: 5px; background: #fff; border-radius: 1px; }
        .flash { position: fixed; inset: 0; background: #fff; opacity: 0; }
        .flash.on { animation: fk-flash 420ms ease-out; }
        @keyframes fk-breathe {
          0%, 100% { box-shadow: inset 0 0 0 1px rgba(24,24,27,0.35), 0 0 18px rgba(255,255,255,0.20); }
          50% { box-shadow: inset 0 0 0 1px rgba(24,24,27,0.35), 0 0 30px rgba(255,255,255,0.45); }
        }
        @keyframes fk-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
        @keyframes fk-pulse {
          0% { opacity: 0; transform: scale(1.06); }
          25% { opacity: 1; transform: scale(1); }
          100% { opacity: 0; transform: scale(1); }
        }
        @keyframes fk-flash { 0% { opacity: 0.55; } 100% { opacity: 0; } }
        @keyframes fk-press {
          0% { scale: 1; }
          45% { scale: 0.72; }
          100% { scale: 1; }
        }
        @keyframes fk-caret { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
        @keyframes fk-slide { 0% { left: -40%; } 100% { left: 100%; } }
        @keyframes fk-spin { to { transform: rotate(360deg); } }
        @keyframes fk-arrive {
          0% { opacity: 0; transform: translateY(-6px); }
          10% { opacity: 1; transform: none; }
          82% { opacity: 1; }
          100% { opacity: 0; }
        }
        @keyframes fk-arrive-ring {
          0% { border-color: rgba(255,255,255,0.2); box-shadow: inset 0 0 0 1px rgba(24,24,27,0.35), 0 0 60px rgba(255,255,255,0.9); }
          100% { border-color: rgba(255,255,255,0.95); }
        }
        @keyframes fk-fade { 0% { opacity: 0; } 15% { opacity: 1; } 75% { opacity: 1; } 100% { opacity: 0; } }
        @keyframes fk-chev { 0%, 100% { opacity: 0.25; } 50% { opacity: 1; } }
        @media (prefers-reduced-motion: reduce) {
          .ring, .dot, .pulse.on, .flash.on, .pointer.press .cursor, .bar.on::after, .spinner,
          .ring.arrived, .scrollcue i, .caret { animation: none; }
          .arrive.on, .scrollcue.on { animation: none; }
          .pulse.on { opacity: 1; }
          .pointer { transition: none; }
        }
      </style>
      <div class="ring"></div>
      <div class="pulse"></div>
      <div class="flash"></div>
      <div class="bar"></div>
      <div class="scrollcue"><i></i><i></i><i></i></div>
      <div class="pointer">
        <svg class="cursor" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 2.5L19 12.2L12.4 13.1L15.7 20.2L13.2 21.4L9.9 14.3L5.6 18.8Z"
                fill="#fff" stroke="#18181b" stroke-width="1.3" stroke-linejoin="round"/>
        </svg>
        <span class="tag">Flowkite<span class="caret"></span></span>
      </div>
      <div class="stack">
        <div class="badge">
          <svg class="kite" viewBox="0 0 24 24" aria-hidden="true">
            <g fill="#fff">
              <path d="M18.35 3.61L11.19 7.33L15.4 8.42ZM18.56 3.67L15.62 8.48L20.05 9.62ZM15.23 8.69L11.02 7.6L11.67 14.48ZM15.45 8.74L19.89 9.89L11.89 14.54Z"/>
              <path d="M11.9 14.9C10.5 17.2 9 18.2 7.6 17.6 6.4 17.1 5.4 17.5 4.6 18.6 5.2 16.9 6.6 16.1 8 16.6 9 17 10 16.5 10.6 14.6Z"/>
            </g>
          </svg>
          <span class="title"></span>
          <span class="dot"></span>
        </div>
        <div class="detail"></div>
        <div class="chip nav"><span class="spinner"></span><span class="nav-text"></span></div>
        <div class="chip arrive"><span class="check"></span><span class="arrive-text"></span></div>
      </div>
      <button class="stop" type="button"><span class="stop-glyph"></span><span class="stop-label"></span></button>`;

    // The page can neither see this listener nor reach the binding it calls: both live in the
    // shadow root, and the binding name is the agent's own channel out of the page.
    root.querySelector('.stop')?.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      // Two independent ways out, because the binding is the one part of this that can fail to
      // install: the direct call when it is there, and a mark on the host that the worker polls for
      // when it is not. A stop button that silently does nothing is worse than no stop button.
      document.getElementById('flowkite-activity-overlay')?.setAttribute('data-fk-stop', '1');
      const requestStop = (window as unknown as Record<string, unknown>).__flowkiteRequestStop;
      if (typeof requestStop === 'function') (requestStop as () => void)();
      const button = event.currentTarget as HTMLElement;
      button.style.opacity = '0.5';
      button.style.pointerEvents = 'none';
    });
    parent.appendChild(host);
    // Only on creation: an existing host already has the cursor where the last action left it, and
    // re-seeding would drag it backwards mid-animation. With no previous position the pointer starts
    // in the middle of the viewport, visible, rather than hidden until the first click: an agent
    // whose hand appears only at the moment it acts reads as something that happened to the page.
    const seed = content.cursorAt ?? { x: window.innerWidth / 2, y: window.innerHeight * 0.55 };
    const pointer = root.querySelector('.pointer') as HTMLElement | null;
    if (pointer) {
      pointer.style.transition = 'none';
      pointer.style.transform = `translate3d(${Math.round(seed.x)}px, ${Math.round(seed.y)}px, 0)`;
      pointer.dataset.x = String(Math.round(seed.x));
      pointer.dataset.y = String(Math.round(seed.y));
      // Next frame, or the transition-none would still be in force for the first real move.
      requestAnimationFrame(() => {
        pointer.style.removeProperty('transition');
        pointer.classList.add('on');
      });
    }

    // Any navigation, including the ones the agent did not announce (a link, a form, a redirect),
    // unloads this document. Saying so while the old page is still on screen is what makes a page
    // change something the user sees coming instead of a jump.
    window.addEventListener('beforeunload', () => {
      const current = document.getElementById('flowkite-activity-overlay')?.shadowRoot;
      const nav = current?.querySelector('.nav');
      const label = current?.host.getAttribute('data-fk-leaving') ?? '';
      if (!current || !nav || nav.classList.contains('on') || !label) return;
      const text = current.querySelector('.nav-text');
      if (text) text.textContent = label;
      nav.classList.add('on');
      current.querySelector('.bar')?.classList.add('on');
    });
  }

  // Re-appending on every call is what survives a page that rebuilds its own body, and it is a
  // no-op when the host is already the last child.
  if (host.parentNode !== parent) parent.appendChild(host);
  host.removeAttribute('data-fk-hidden');
  host.style.display = 'block';

  const root = host.shadowRoot;
  if (!root) return;
  const title = root.querySelector('.title');
  const detail = root.querySelector('.detail');
  const stopLabel = root.querySelector('.stop-label');
  if (title) title.textContent = content.title;
  if (detail) detail.textContent = content.detail;
  if (stopLabel) stopLabel.textContent = content.stopLabel;
  host.setAttribute('data-fk-leaving', content.leavingLabel ?? '');

  // Once per site per document: a fresh document has no mark, so every page change the agent makes
  // is announced on the page it lands on, while redraws on the same page stay quiet.
  const site = location.host;
  if (content.arrivalTemplate && site && host.getAttribute('data-fk-site') !== site) {
    host.setAttribute('data-fk-site', site);
    const arrive = root.querySelector('.arrive');
    const arriveText = root.querySelector('.arrive-text');
    const ring = root.querySelector('.ring');
    if (arrive && arriveText) {
      arriveText.textContent = content.arrivalTemplate.replace('{host}', site);
      arrive.classList.remove('on');
      void (arrive as HTMLElement).offsetWidth;
      arrive.classList.add('on');
    }
    if (ring) {
      ring.classList.remove('arrived');
      void (ring as HTMLElement).offsetWidth;
      ring.classList.add('arrived');
    }
  }
}

/**
 * Walk the drawn pointer to an element, so the action that follows reads as a movement the user can
 * track rather than something that simply happened somewhere on the page.
 *
 * The travel is a CSS transition on the element itself: the worker sends one coordinate per action,
 * not a stream of frames, so the animation has to be the page's job. Its duration scales with the
 * distance, and is returned so the worker can wait for the pointer to arrive before it acts; the
 * press and the ring land on arrival, at the moment the real click does.
 *
 * @param mode - `click` squashes the cursor on arrival, `type` shows a caret in the name tag for
 *   `holdMs`, `hover` just arrives
 * @returns how long the pointer will take to arrive, in ms, or -1 when there is no overlay to draw on
 */
export function markActivityTarget(
  rect: { x: number; y: number; width: number; height: number },
  mode: ActivityTargetMode = 'click',
  holdMs = 0,
): number {
  const host = document.getElementById('flowkite-activity-overlay');
  const root = host?.shadowRoot;
  if (!root) return -1;

  const x = Math.round(rect.x + rect.width / 2);
  const y = Math.round(rect.y + rect.height / 2);
  let travel = 0;

  const pointer = root.querySelector('.pointer') as HTMLElement | null;
  if (pointer) {
    const fromX = Number(pointer.dataset.x ?? x);
    const fromY = Number(pointer.dataset.y ?? y);
    const distance = Math.hypot(x - fromX, y - fromY);
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    // Long enough to follow by eye, short enough that a ten-action step does not crawl.
    travel = reduced ? 0 : Math.round(Math.min(560, Math.max(180, distance * 0.6)));
    pointer.style.transitionDuration = `${travel}ms, 240ms`;
    pointer.classList.add('on');
    pointer.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    pointer.dataset.x = String(x);
    pointer.dataset.y = String(y);
    pointer.classList.remove('press');
    pointer.classList.toggle('typing', mode === 'type');
    if (mode === 'type' && holdMs > 0) {
      setTimeout(() => pointer.classList.remove('typing'), travel + holdMs);
    }
    if (mode === 'click') {
      setTimeout(() => {
        void pointer.offsetWidth;
        pointer.classList.add('press');
      }, travel);
    }
  }

  const pulse = root.querySelector('.pulse') as HTMLElement | null;
  if (pulse) {
    pulse.style.left = `${Math.max(0, rect.x - 3)}px`;
    pulse.style.top = `${Math.max(0, rect.y - 3)}px`;
    pulse.style.width = `${Math.max(6, rect.width + 6)}px`;
    pulse.style.height = `${Math.max(6, rect.height + 6)}px`;
    // Restarting a CSS animation needs the class gone, a reflow, then the class back; without the
    // reflow the browser coalesces both changes and nothing replays on a second click of one button.
    pulse.classList.remove('on');
    setTimeout(() => {
      void pulse.offsetWidth;
      pulse.classList.add('on');
    }, travel);
  }
  return travel;
}

/**
 * Show that the agent is scrolling, and which way: the pointer moves to the middle of the page and
 * chevrons on the right edge run in the direction of travel.
 *
 * @returns how long the pointer will take to get there, in ms, or -1 when there is no overlay
 */
export function markActivityScroll(direction: 'up' | 'down'): number {
  const root = document.getElementById('flowkite-activity-overlay')?.shadowRoot;
  if (!root) return -1;

  let travel = 0;
  const pointer = root.querySelector('.pointer') as HTMLElement | null;
  if (pointer) {
    const x = Math.round(window.innerWidth / 2);
    const y = Math.round(window.innerHeight / 2);
    const distance = Math.hypot(x - Number(pointer.dataset.x ?? x), y - Number(pointer.dataset.y ?? y));
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    travel = reduced ? 0 : Math.round(Math.min(420, Math.max(0, distance * 0.5)));
    pointer.style.transitionDuration = `${travel}ms, 240ms`;
    pointer.classList.add('on');
    pointer.classList.remove('typing', 'press');
    pointer.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    pointer.dataset.x = String(x);
    pointer.dataset.y = String(y);
  }

  const cue = root.querySelector('.scrollcue') as HTMLElement | null;
  if (cue) {
    cue.classList.remove('on', 'up', 'down');
    void cue.offsetWidth;
    cue.classList.add('on', direction);
  }
  return travel;
}

/**
 * Say, on the page that is about to go away, where the agent is taking it.
 *
 * The label is Flowkite's own sentence ("Opening example.com"), built by the worker from the URL it
 * is about to load. It clears itself if no navigation follows, so a refused or same-document
 * navigation does not leave a spinner running forever.
 *
 * @returns false when there is no overlay on this page
 */
export function showNavigationPending(label: string): boolean {
  const root = document.getElementById('flowkite-activity-overlay')?.shadowRoot;
  if (!root) return false;
  const nav = root.querySelector('.nav');
  const text = root.querySelector('.nav-text');
  const bar = root.querySelector('.bar');
  if (!nav || !text || !bar) return false;
  text.textContent = label;
  nav.classList.add('on');
  bar.classList.add('on');
  setTimeout(() => {
    nav.classList.remove('on');
    bar.classList.remove('on');
  }, 9000);
  return true;
}

/**
 * Park the overlay and freeze animations, in one call, for the duration of a capture.
 *
 * The two belong together because they bracket the same operation and both have to be undone by
 * `restoreAfterCapture`. Splitting them cost two extra worker round-trips per screenshot, and every
 * one of those is time the page spends visibly missing its banner.
 */
export function prepareForCapture(): void {
  const host = document.getElementById('flowkite-activity-overlay');
  if (host) {
    host.setAttribute('data-fk-hidden', '1');
    host.style.display = 'none';
  }
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
}

/** Undo {@link prepareForCapture}, and flash if the capture is one the user should notice. */
export function restoreAfterCapture(flash: boolean): void {
  document.getElementById('puppeteer-disable-animations')?.remove();
  const host = document.getElementById('flowkite-activity-overlay');
  if (!host) return;
  host.removeAttribute('data-fk-hidden');
  host.style.display = 'block';
  if (!flash) return;
  const flashEl = host.shadowRoot?.querySelector('.flash') as HTMLElement | null;
  if (!flashEl) return;
  // After the restore, never before: a flash caught in the frame is a white page handed to the model.
  flashEl.classList.remove('on');
  void flashEl.offsetWidth;
  flashEl.classList.add('on');
}

/**
 * The page's rendered text, read with the overlay parked for exactly as long as the read takes.
 *
 * One call rather than hide / read / restore as three, which is not only two fewer round trips but
 * the difference between an overlay that blinks off on every extraction and one that does not: the
 * three-call version left the banner missing for however long the worker took to come back.
 */
export function readVisibleTextWithoutOverlay(): string {
  const host = document.getElementById('flowkite-activity-overlay');
  // Only park an overlay that is currently up. One already hidden for a screenshot must be left
  // exactly as it was, or this read would put it back mid-capture.
  const parked = host !== null && !host.hasAttribute('data-fk-hidden');
  if (parked) host.style.display = 'none';
  try {
    return document.body?.innerText ?? '';
  } finally {
    if (parked) host.style.display = 'block';
  }
}

/**
 * Whether the user has pressed stop since this was last asked, clearing the mark as it reads it.
 *
 * The fallback path for when `exposeFunction` did not install: the worker polls this instead. It
 * consumes the mark so one press cannot be read as two cancels.
 */
export function takeActivityStopRequest(): { requested: boolean; hidden: boolean } {
  const host = document.getElementById('flowkite-activity-overlay');
  // The visibility rides along so the worker can slow down on a tab nobody is looking at. Nobody
  // presses a button they cannot see, and this poll only exists on pages where the binding failed.
  const hidden = document.hidden === true;
  if (!host?.hasAttribute('data-fk-stop')) return { requested: false, hidden };
  host.removeAttribute('data-fk-stop');
  return { requested: true, hidden };
}

/** Take the overlay off the page entirely. Idempotent: the task may end on a tab that never had one. */
export function removeActivityOverlay(): void {
  document.getElementById('flowkite-activity-overlay')?.remove();
}
