import { describe, it, expect } from 'vitest';
import {
  ACTIVITY_OVERLAY_ID,
  ACTIVITY_STOP_BINDING,
  markActivityTarget,
  prepareForCapture,
  readVisibleTextWithoutOverlay,
  removeActivityOverlay,
  renderActivityOverlay,
  restoreAfterCapture,
  sanitizeOverlayDetail,
  takeActivityStopRequest,
} from '../activityOverlay';

/**
 * These functions are never called here. They are stringified by Puppeteer and evaluated inside the
 * page, where this module's scope does not exist - so the only thing worth asserting is the one
 * property that cannot be checked by the type system and fails silently in production: that each
 * one is self-contained.
 *
 * The failure this guards is specific and easy to reintroduce. Writing `ACTIVITY_OVERLAY_ID` inside
 * one of them type-checks, bundles, and throws `ReferenceError` in the page - which is swallowed by
 * the debug-level catch around every overlay call, so the banner simply never appears and nothing
 * says why.
 */
const INJECTED = {
  renderActivityOverlay,
  markActivityTarget,
  prepareForCapture,
  restoreAfterCapture,
  readVisibleTextWithoutOverlay,
  takeActivityStopRequest,
  removeActivityOverlay,
};

/** Names that exist in this module and must therefore never appear inside an injected function. */
const MODULE_SCOPE = ['ACTIVITY_OVERLAY_ID', 'ACTIVITY_STOP_BINDING', 'INJECTED', 'MODULE_SCOPE'];

/**
 * The detail line is written by the model, and the model reads the page. Everything here is about
 * one question: can a page get its own sentence printed inside Flowkite's badge, where a user reads
 * it as Flowkite talking?
 */
describe('sanitizeOverlayDetail', () => {
  it('leaves an ordinary intent alone', () => {
    expect(sanitizeOverlayDetail('Clicking the Submit button')).toBe('Clicking the Submit button');
  });

  it('flattens line breaks, which is how a second fake line would be drawn', () => {
    expect(sanitizeOverlayDetail('Working\n\nFlowkite has stopped')).toBe('Working Flowkite has stopped');
  });

  it('strips control characters', () => {
    expect(sanitizeOverlayDetail('Clicking\u0007\u0000 Submit')).toBe('Clicking Submit');
  });

  it('strips bidi overrides, which can reorder a line into a different sentence', () => {
    expect(sanitizeOverlayDetail('Reading \u202eevil\u202c page')).toBe('Reading evil page');
    expect(sanitizeOverlayDetail('safe\u2066\u2069')).toBe('safe');
  });

  it('caps the length so the agent line cannot crowd out the product name', () => {
    const long = sanitizeOverlayDetail('x'.repeat(500));
    expect(long.length).toBeLessThanOrEqual(88);
    expect(long.endsWith('…')).toBe(true);
  });

  it('collapses runs of whitespace rather than letting them pad the line', () => {
    expect(sanitizeOverlayDetail('   Clicking      Submit   ')).toBe('Clicking Submit');
  });

  it('answers empty for an intent that was only formatting', () => {
    expect(sanitizeOverlayDetail('\n\t  \u200e ')).toBe('');
  });
});

describe('injected overlay functions', () => {
  for (const [name, fn] of Object.entries(INJECTED)) {
    it(`${name} closes over nothing from this module`, () => {
      const source = fn.toString();
      for (const identifier of MODULE_SCOPE) {
        expect(source, `${name} references ${identifier}, which does not exist in the page`).not.toContain(identifier);
      }
    });
  }

  it('every function that looks the host up spells the id out', () => {
    const lookups = [
      markActivityTarget,
      prepareForCapture,
      restoreAfterCapture,
      readVisibleTextWithoutOverlay,
      takeActivityStopRequest,
      removeActivityOverlay,
      renderActivityOverlay,
    ];
    for (const fn of lookups) {
      expect(fn.toString()).toContain(ACTIVITY_OVERLAY_ID);
    }
  });

  it('the stop button calls the binding name the worker actually exposes', () => {
    expect(renderActivityOverlay.toString()).toContain(ACTIVITY_STOP_BINDING);
  });

  it('the overlay is hidden from the DOM parse by the same id the parser skips', () => {
    // buildDomTree.js cannot import this constant - it is a plain script injected into the page -
    // so the two spellings are kept honest here instead.
    expect(ACTIVITY_OVERLAY_ID).toBe('flowkite-activity-overlay');
  });

  it('the product line and the agent-written line are separate elements', () => {
    // The badge is a trust surface: only Flowkite's own words may sit inside the bordered pill, and
    // the model's sentence has to be visibly a different thing. Nesting the detail back into
    // `.badge` would type-check and look fine, and would quietly undo that.
    const markup = renderActivityOverlay.toString();
    const badgeOpen = markup.indexOf('<div class="badge">');
    const detailOpen = markup.indexOf('<div class="detail">');
    expect(badgeOpen).toBeGreaterThan(-1);
    expect(detailOpen).toBeGreaterThan(badgeOpen);
    // The badge has to have closed before the detail opens, or the agent's line is inside the pill.
    expect(markup.slice(badgeOpen, detailOpen)).toContain('</div>');
  });

  it('nothing in the overlay can swallow a click except the stop button', () => {
    const css = renderActivityOverlay.toString();
    expect(css).toContain('pointer-events:none');
    // Exactly one opt-in, and it is the button.
    expect(css.match(/pointer-events: auto/g) ?? []).toHaveLength(1);
  });
});
