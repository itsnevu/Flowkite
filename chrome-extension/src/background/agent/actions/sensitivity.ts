import type { DOMElementNode } from '../../browser/dom/views';

/**
 * Why an action was flagged as sensitive. Kept coarse on purpose — it is shown to the user, so it
 * has to describe the risk in a way they can act on, not the rule that matched.
 */
export enum SensitiveActionKind {
  FORM_SUBMIT = 'form_submit',
  PURCHASE = 'purchase',
  DESTRUCTIVE = 'destructive',
  DOWNLOAD = 'download',
  CREDENTIALS = 'credentials',
  UPLOAD = 'upload',
  PUBLISH = 'publish',
}

export interface SensitivityVerdict {
  kind: SensitiveActionKind;
  /** the element text, url or field that triggered the check, for display to the user */
  target: string;
}

/**
 * The kind reported when the `manual` approval mode asks about an action the classifier cleared.
 *
 * Deliberately not a member of {@link SensitiveActionKind}: nothing flagged it, and labelling an
 * ordinary click `form_submit` to reuse an existing kind would put a warning on the card that is
 * simply untrue. The reason the user is being asked is the mode they chose.
 */
export const ROUTINE_ACTION_KIND = 'routine';

/**
 * Keyword groups, matched against the visible label of the element the agent wants to click.
 * Ordered by how much damage a wrong click does: a purchase beats a generic submit.
 */
const KEYWORDS: Array<{ kind: SensitiveActionKind; words: string[] }> = [
  {
    kind: SensitiveActionKind.PURCHASE,
    words: [
      'buy',
      'purchase',
      'checkout',
      'check out',
      'place order',
      'pay',
      'payment',
      'subscribe',
      'donate',
      'transfer',
      'send money',
      'bid',
      'book now',
      'reserve',
      'beli',
      'bayar',
      'pesan',
      'langganan',
    ],
  },
  {
    kind: SensitiveActionKind.DESTRUCTIVE,
    words: [
      'delete',
      'remove',
      'uninstall',
      'deactivate',
      'close account',
      'cancel subscription',
      'unsubscribe',
      'revoke',
      'reset',
      'wipe',
      'hapus',
      'batalkan',
    ],
  },
  {
    kind: SensitiveActionKind.PUBLISH,
    words: ['post', 'publish', 'tweet', 'share', 'send message', 'reply', 'comment', 'invite', 'kirim', 'bagikan'],
  },
  {
    kind: SensitiveActionKind.DOWNLOAD,
    words: ['download', 'export', 'install', 'unduh'],
  },
  {
    kind: SensitiveActionKind.FORM_SUBMIT,
    words: ['submit', 'sign in', 'log in', 'sign up', 'register', 'apply', 'confirm', 'agree', 'accept', 'daftar'],
  },
];

/** File extensions that mean navigating to a URL will start a download rather than show a page. */
const DOWNLOAD_EXTENSIONS = [
  '.pdf',
  '.zip',
  '.exe',
  '.dmg',
  '.pkg',
  '.msi',
  '.apk',
  '.deb',
  '.rpm',
  '.tar',
  '.gz',
  '.7z',
  '.iso',
  '.csv',
  '.xlsx',
  '.docx',
];

/** The visible label of an element, assembled from the signals a screen reader would use. */
function labelOf(element: DOMElementNode): string {
  const parts = [
    element.getAllTextTillNextClickableElement(),
    element.attributes['aria-label'],
    element.attributes.value,
    element.attributes.title,
    element.attributes.name,
    element.attributes.id,
  ];
  return parts.filter(Boolean).join(' ').toLowerCase().trim();
}

/** Escape a keyword so it can be embedded in a RegExp, since some contain spaces but none are patterns. */
function escapeRegExp(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Match on word boundaries, not substrings — "post" must not fire on "postcode" and "bid" must not
 * fire on "forbidden", or the confirmation prompt becomes noise the user learns to click through.
 */
function matchKeywords(label: string): SensitiveActionKind | null {
  for (const group of KEYWORDS) {
    if (group.words.some(word => new RegExp(`\\b${escapeRegExp(word)}\\b`).test(label))) {
      return group.kind;
    }
  }
  return null;
}

function isSubmitControl(element: DOMElementNode): boolean {
  const type = (element.attributes.type ?? '').toLowerCase();
  const tag = (element.tagName ?? '').toLowerCase();
  if (type === 'submit') return true;
  // a bare <button> inside a form defaults to type=submit
  return tag === 'button' && type === '';
}

/**
 * Decide whether an action needs the user's explicit go-ahead before it runs.
 *
 * This is deliberately biased toward false positives: an unnecessary prompt costs the user a click,
 * while a missed one can cost them money or data. It reads only the element the agent already chose,
 * so a page cannot talk its way out of a check the way it could through the prompt.
 *
 * @param actionName the registered action being invoked, e.g. `click_element`
 * @param actionArgs the arguments the model produced for it
 * @param element the DOM element the action targets, when the action takes an index
 * @returns the reason to ask the user, or null if the action may run unattended
 */
export function classifySensitiveAction(
  actionName: string,
  actionArgs: unknown,
  element: DOMElementNode | undefined,
): SensitivityVerdict | null {
  const args = (actionArgs ?? {}) as Record<string, unknown>;

  if (actionName === 'send_keys') {
    const keys = String(args.keys ?? '').toLowerCase();
    // Enter in a field is how most forms are submitted without ever touching a button
    if (keys.includes('enter') || keys.includes('return')) {
      return { kind: SensitiveActionKind.FORM_SUBMIT, target: String(args.keys) };
    }
    return null;
  }

  if (actionName === 'go_to_url' || actionName === 'open_tab') {
    const url = String(args.url ?? '').toLowerCase();
    if (DOWNLOAD_EXTENSIONS.some(ext => url.split('?')[0].endsWith(ext))) {
      return { kind: SensitiveActionKind.DOWNLOAD, target: String(args.url) };
    }
    return null;
  }

  // Always asked about, never keyword-matched: the file leaves the user's machine for a site the
  // moment this runs, and no label on the page tells you whether that is what they wanted.
  if (actionName === 'upload_file') {
    return { kind: SensitiveActionKind.UPLOAD, target: String(args.file_name ?? 'file') };
  }

  if (actionName === 'input_text' && element) {
    if ((element.attributes.type ?? '').toLowerCase() === 'password') {
      return { kind: SensitiveActionKind.CREDENTIALS, target: labelOf(element) || 'password field' };
    }
    return null;
  }

  if (actionName === 'click_element' && element) {
    const label = labelOf(element);
    const kind = matchKeywords(label);
    if (kind) return { kind, target: label };
    if (isSubmitControl(element)) {
      return { kind: SensitiveActionKind.FORM_SUBMIT, target: label || (element.tagName ?? 'button') };
    }
    return null;
  }

  return null;
}

/**
 * Actions that change nothing a user would want to veto: they read, wait, or move the viewport.
 *
 * Deliberately NOT `READ_ONLY_ACTION_NAMES` from ./readOnlyActions, even though the two overlap.
 * That set answers "can a background subtask with no user attached run this without changing the
 * world?", and so it contains `go_to_url`, `search_google` and `go_back` — navigation changes no
 * state, so it is safe there. This set answers a different question: "can this happen in front of a
 * user who asked to see everything, without asking?" Navigation is precisely what such a user wants
 * to see coming, because it is how an agent ends up somewhere unexpected. So those three are absent
 * here and gated.
 *
 * Two sets, two jobs. Keeping them separate is what stops a later addition to one silently
 * widening the other — adding a read-only action for subtasks must not also make it un-gateable.
 */
export const SILENT_ACTION_NAMES: ReadonlySet<string> = new Set([
  'done',
  'cache_content',
  'remember',
  'wait',
  'scroll_to_percent',
  'scroll_to_top',
  'scroll_to_bottom',
  'previous_page',
  'next_page',
  'scroll_to_text',
  'get_dropdown_options',
]);

/**
 * Manual mode's gate: everything that reaches the page needs a yes, not just the risky things.
 *
 * Scrolls, reads and waits are excluded on purpose. A prompt the user always says yes to is a
 * prompt that teaches them to say yes to the one that mattered, and manual mode's whole value
 * depends on each card corresponding to something that actually touched the page.
 *
 * Returns the {@link ROUTINE_ACTION_KIND} rather than one of the sensitivity kinds: nothing flagged
 * this action, and the honest reason the user is being asked is the mode they chose.
 *
 * @param actionName the registered action being invoked, e.g. `click_element`
 * @param element the DOM element the action targets, when the action takes an index
 * @returns the reason to ask the user, or null if the action may run silently
 */
export function classifyManualAction(
  actionName: string,
  element: DOMElementNode | undefined,
): { kind: typeof ROUTINE_ACTION_KIND; target: string } | null {
  if (SILENT_ACTION_NAMES.has(actionName)) return null;
  return { kind: ROUTINE_ACTION_KIND, target: element ? labelOf(element) : actionName };
}
