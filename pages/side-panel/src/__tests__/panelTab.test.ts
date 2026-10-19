import { describe, it, expect } from 'vitest';
import { panelTabIdFrom, isPrefillForThisPanel } from '../panelTab';

describe('panelTabIdFrom', () => {
  it('reads the tab the background opened this panel for', () => {
    expect(panelTabIdFrom('?tabId=42')).toBe(42);
  });

  it('treats a missing or malformed id as no tab, so the panel falls back to the active tab', () => {
    expect(panelTabIdFrom('')).toBeNull();
    expect(panelTabIdFrom('?tabId=')).toBeNull();
    expect(panelTabIdFrom('?tabId=abc')).toBeNull();
    expect(panelTabIdFrom('?tabId=-3')).toBeNull();
    expect(panelTabIdFrom('?tabId=1.5')).toBeNull();
  });
});

describe('isPrefillForThisPanel', () => {
  // the test environment has no ?tabId=, which is the panel-opened-as-a-tab case
  it('lets a panel without a tab of its own take any prefill, as before', () => {
    expect(isPrefillForThisPanel(7)).toBe(true);
    expect(isPrefillForThisPanel(undefined)).toBe(true);
  });
});
