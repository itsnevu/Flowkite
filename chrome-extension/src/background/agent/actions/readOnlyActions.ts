/**
 * Actions an agent may use when it must not change anything on a site.
 *
 * Parallel subtasks run in background tabs with no way to reach the user, so a confirmation prompt
 * raised from one would block with nobody able to answer it. Rather than skip the confirmation --
 * which would make background tabs the one place the agent can act unsupervised -- those agents are
 * restricted to reading: they can navigate, scroll and extract, and nothing they do changes state.
 *
 * Kept free of imports so the guarantee can be asserted in a test without pulling in the extension
 * runtime, and so adding an action elsewhere never silently widens it.
 */
export const READ_ONLY_ACTION_NAMES: ReadonlySet<string> = new Set([
  'done',
  'search_google',
  'go_to_url',
  'go_back',
  'cache_content',
  // reads the page through the extractor model; writes nothing. NOT ask_user: a background tab
  // has no user standing by, and a handoff from one would park the subtask forever.
  'extract_content',
  // fills the shared dataset rather than the page; the parent's table is where those rows land
  'extract_structured',
  // reveals hover-only UI; dispatches pointer events and nothing else, so no state moves
  'hover_element',
  'scroll_to_percent',
  'scroll_to_top',
  'scroll_to_bottom',
  'previous_page',
  'next_page',
  'scroll_to_text',
  'get_dropdown_options',
  'wait',
]);
