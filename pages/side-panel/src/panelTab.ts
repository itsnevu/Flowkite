/**
 * The tab this panel belongs to.
 *
 * The background opens each panel for one tab, with `?tabId=` in its URL (see openPanelForTab in
 * the background). A task sent from here runs on that tab, so a panel never drives a tab it was not
 * opened on. Null for a panel opened without one, such as a test harness loading the page as a tab,
 * which falls back to the active tab as panels did before.
 */
export function panelTabIdFrom(search: string): number | null {
  const raw = new URLSearchParams(search).get('tabId');
  if (!raw) return null;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export const PANEL_TAB_ID: number | null = panelTabIdFrom(typeof window === 'undefined' ? '' : window.location.search);

/** The tab a task sent from this panel should run on. */
export async function resolveTaskTabId(): Promise<number | undefined> {
  if (PANEL_TAB_ID !== null) return PANEL_TAB_ID;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

/**
 * Whether a context-menu prefill is meant for this panel: the one opened on the tab that was
 * right-clicked. With a panel per tab, several can be open at once and all of them hear the same
 * storage change; only the right one may take the text.
 */
export function isPrefillForThisPanel(prefillTabId: unknown): boolean {
  if (PANEL_TAB_ID === null || typeof prefillTabId !== 'number') return true;
  return prefillTabId === PANEL_TAB_ID;
}
