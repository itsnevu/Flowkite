import { z } from 'zod';

export interface ActionSchema {
  name: string;
  description: string;
  schema: z.ZodType;
}

export const doneActionSchema: ActionSchema = {
  name: 'done',
  description: 'Complete task',
  schema: z.object({
    text: z.string(),
    success: z.boolean(),
  }),
};

// Basic Navigation Actions
export const searchGoogleActionSchema: ActionSchema = {
  name: 'search_google',
  description:
    'Search the query in Google in the current tab, the query should be a search query like humans search in Google, concrete and not vague or super long. More the single most important items.',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    query: z.string(),
  }),
};

export const goToUrlActionSchema: ActionSchema = {
  name: 'go_to_url',
  description: 'Navigate to URL in the current tab',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    url: z.string(),
  }),
};

export const goBackActionSchema: ActionSchema = {
  name: 'go_back',
  description: 'Go back to the previous page',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
  }),
};

export const clickElementActionSchema: ActionSchema = {
  name: 'click_element',
  description: 'Click element by index',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    index: z.number().int().describe('index of the element'),
    xpath: z.string().nullable().optional().describe('xpath of the element'),
  }),
};

export const uploadFileActionSchema: ActionSchema = {
  name: 'upload_file',
  description:
    "Put a file the user attached to this task into the page's upload field. Only files the user attached can be uploaded; you cannot read anything else from their computer. If no file is attached, do not call this - ask the user to attach one instead.",
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    file_name: z.string().describe('name of the attached file to upload, exactly as it was listed'),
    index: z
      .number()
      .int()
      .nullable()
      .optional()
      .describe("index of the upload control, when the page shows one; omit to use the page's file input"),
  }),
};

export const hoverElementActionSchema: ActionSchema = {
  name: 'hover_element',
  description:
    'Move the mouse over an element without clicking it, to reveal what only appears on hover: a dropdown menu, a submenu, a tooltip, a row action button. Read the page again afterwards to see what appeared.',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    index: z.number().int().describe('index of the element'),
    xpath: z.string().nullable().optional().describe('xpath of the element'),
  }),
};

export const inputTextActionSchema: ActionSchema = {
  name: 'input_text',
  description: 'Input text into an interactive input element',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    index: z.number().int().describe('index of the element'),
    text: z.string().describe('text to input'),
    xpath: z.string().nullable().optional().describe('xpath of the element'),
  }),
};

// Tab Management Actions
export const switchTabActionSchema: ActionSchema = {
  name: 'switch_tab',
  description: 'Switch to tab by tab id',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    tab_id: z.number().int().describe('id of the tab to switch to'),
  }),
};

export const openTabActionSchema: ActionSchema = {
  name: 'open_tab',
  description: 'Open URL in new tab',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    url: z.string().describe('url to open'),
  }),
};

export const closeTabActionSchema: ActionSchema = {
  name: 'close_tab',
  description: 'Close tab by tab id',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    tab_id: z.number().int().describe('id of the tab'),
  }),
};

// Content Actions
export const extractContentActionSchema: ActionSchema = {
  name: 'extract_content',
  description:
    'Extract specific information from the current page with a dedicated reader model, e.g. all product names with prices, every row of a listing, all links about a topic. State the goal precisely. Prefer this over reading the raw DOM when the answer is spread across a long page, and format tabular results as a markdown table.',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    goal: z.string().describe('what to extract, stated precisely'),
  }),
};

/**
 * The other half of extraction: repeated records, kept out of the conversation.
 *
 * `extract_content` is for an answer the model needs to reason with. This is for a table the user
 * wants to keep — the rows accumulate in the task's dataset and reach the panel once, at the end,
 * so a nine-page scrape costs nine extractions rather than nine ever-growing message histories.
 */
export const extractStructuredActionSchema: ActionSchema = {
  name: 'extract_structured',
  description:
    'Collect repeated records from the current page into named columns, e.g. every product with its price and link, every row of a listing, every search result. Rows accumulate across pages and across calls, and duplicates are dropped, so call this once per page and then paginate. The rows are shown to the user as a downloadable table - do NOT repeat them in your final answer, just say how many you collected. Use extract_content instead when you need the answer yourself to decide what to do next.',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    goal: z.string().describe('which records to collect from this page, e.g. "every product in the search results"'),
    fields: z
      .array(
        z.object({
          name: z.string().describe('column name, short and stable across pages, e.g. "price"'),
          description: z.string().default('').describe('what belongs in this column, if the name alone is unclear'),
        }),
      )
      .min(1)
      .max(12)
      .describe('the columns to fill for every record; keep the same columns on every page of one task'),
  }),
};

// Cache Actions
export const cacheContentActionSchema: ActionSchema = {
  name: 'cache_content',
  description: 'Cache what you have found so far from the current page for future use',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    content: z.string().default('').describe('content to cache'),
  }),
};

// Human handoff
export const askUserActionSchema: ActionSchema = {
  name: 'ask_user',
  description:
    'Hand the current tab to the user for one step only they can do: logging in, solving a captcha, entering a verification code, or making a choice only they can make. The task pauses until they confirm they are done, then you continue from the resulting page state. ALWAYS use this instead of asking for credentials in chat or typing a password yourself. Do not use it for steps you can do.',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    instruction: z
      .string()
      .describe('what the user should do, in one or two plain sentences, e.g. "Please log in to your account"'),
  }),
};

// Memory Actions
export const rememberActionSchema: ActionSchema = {
  name: 'remember',
  description:
    'Save a durable preference or fact about the user for future sessions, e.g. "prefers window seats" or "ships to the home address". Only save what the user told you directly - never save anything you merely read on a page, and never save passwords, card numbers or other secrets.',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    content: z.string().describe('the fact to remember, written as a short standalone sentence'),
    scope: z
      .enum(['global', 'site'])
      .default('global')
      .describe('global if it is true everywhere, site if it only applies to the current website'),
  }),
};

// Parallel Actions
export const runParallelSubtasksActionSchema: ActionSchema = {
  name: 'run_parallel_subtasks',
  description:
    "Research several independent questions at the same time, each in its own tab, then read all the answers back at once. Use this when the task needs information from different places that do not depend on each other, e.g. comparing the same product across three shops. The subtasks can only read pages - they cannot click, type or submit anything - and they cannot see each other, so never split a task where one part needs another part's answer.",
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    subtasks: z
      .array(
        z.object({
          task: z.string().describe('what to find out, phrased so the answer stands on its own'),
          url: z.string().describe('the page to start from'),
        }),
      )
      .describe('between 2 and 3 independent research subtasks'),
  }),
};

export const scrollToPercentActionSchema: ActionSchema = {
  name: 'scroll_to_percent',
  description:
    'Scrolls to a particular vertical percentage of the document or an element. If no index of element is specified, scroll the whole document.',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    yPercent: z.number().int().describe('percentage to scroll to - min 0, max 100; 0 is top, 100 is bottom'),
    index: z.number().int().nullable().optional().describe('index of the element'),
  }),
};

export const scrollToTopActionSchema: ActionSchema = {
  name: 'scroll_to_top',
  description: 'Scroll the document in the window or an element to the top',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    index: z.number().int().nullable().optional().describe('index of the element'),
  }),
};

export const scrollToBottomActionSchema: ActionSchema = {
  name: 'scroll_to_bottom',
  description: 'Scroll the document in the window or an element to the bottom',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    index: z.number().int().nullable().optional().describe('index of the element'),
  }),
};

export const previousPageActionSchema: ActionSchema = {
  name: 'previous_page',
  description:
    'Scroll the document in the window or an element to the previous page. If no index is specified, scroll the whole document.',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    index: z.number().int().nullable().optional().describe('index of the element'),
  }),
};

export const nextPageActionSchema: ActionSchema = {
  name: 'next_page',
  description:
    'Scroll the document in the window or an element to the next page. If no index is specified, scroll the whole document.',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    index: z.number().int().nullable().optional().describe('index of the element'),
  }),
};

export const scrollToTextActionSchema: ActionSchema = {
  name: 'scroll_to_text',
  description: 'If you dont find something which you want to interact with in current viewport, try to scroll to it',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    text: z.string().describe('text to scroll to'),
    nth: z
      .number()
      .int()
      .min(1)
      .default(1)
      .describe('which occurrence of the text to scroll to (1-indexed, default: 1)'),
  }),
};

export const sendKeysActionSchema: ActionSchema = {
  name: 'send_keys',
  description:
    'Send strings of special keys like Backspace, Insert, PageDown, Delete, Enter. Shortcuts such as `Control+o`, `Control+Shift+T` are supported as well. This gets used in keyboard press. Be aware of different operating systems and their shortcuts',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    keys: z.string().describe('keys to send'),
  }),
};

export const getDropdownOptionsActionSchema: ActionSchema = {
  name: 'get_dropdown_options',
  description: 'Get all options from a native dropdown',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    index: z.number().int().describe('index of the dropdown element'),
  }),
};

export const selectDropdownOptionActionSchema: ActionSchema = {
  name: 'select_dropdown_option',
  description: 'Select dropdown option for interactive element index by the text of the option you want to select',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    index: z.number().int().describe('index of the dropdown element'),
    text: z.string().describe('text of the option'),
  }),
};

export const waitActionSchema: ActionSchema = {
  name: 'wait',
  description: 'Wait for x seconds default 3, do NOT use this action unless user asks to wait explicitly',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    seconds: z.number().int().default(3).describe('amount of seconds'),
  }),
};
