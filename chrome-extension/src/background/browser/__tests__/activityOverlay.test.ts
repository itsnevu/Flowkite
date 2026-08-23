import { describe, it, expect } from 'vitest';
import {
  ACTIVITY_OVERLAY_ID,
  ACTIVITY_STOP_BINDING,
  flashActivityCapture,
  moveActivityCursor,
  pulseActivityTarget,
  removeActivityOverlay,
  renderActivityOverlay,
  setActivityOverlayHidden,
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
  moveActivityCursor,
  pulseActivityTarget,
  flashActivityCapture,
  setActivityOverlayHidden,
  takeActivityStopRequest,
  removeActivityOverlay,
};

/** Names that exist in this module and must therefore never appear inside an injected function. */
const MODULE_SCOPE = ['ACTIVITY_OVERLAY_ID', 'ACTIVITY_STOP_BINDING', 'INJECTED', 'MODULE_SCOPE'];

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
      moveActivityCursor,
      pulseActivityTarget,
      flashActivityCapture,
      setActivityOverlayHidden,
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

  it('nothing in the overlay can swallow a click except the stop button', () => {
    const css = renderActivityOverlay.toString();
    expect(css).toContain('pointer-events:none');
    // Exactly one opt-in, and it is the button.
    expect(css.match(/pointer-events: auto/g) ?? []).toHaveLength(1);
  });
});
