/**
 * Strip markdown out of an answer the user reads, leaving ordinary prose.
 *
 * The answer style rules already ask every model for plain text, but Flowkite runs on whatever
 * provider the user configured and several of them bold and bullet by reflex no matter what the
 * prompt says. The user reads `**` and `- ` as machine-written text, so the rule is enforced here,
 * once, on the two places an answer comes from (the planner's final_answer and the navigator's done
 * text) instead of being trusted to the prompt.
 *
 * What survives on purpose:
 * - Line structure. A section title stays its own line and each item stays its own line; only the
 *   markers in front of them go.
 * - Numbered lines ("1. ", "2) "). A number is ordinary writing, not markup, and steps that must be
 *   followed in order read worse without it.
 * - Pipe tables. The panel renders them as a real table with a CSV download, so the user never sees
 *   the pipes; flattening one would lose the structure the table existed to show.
 * - Anything inside a word: `snake_case`, `2*3`, `a-b`.
 *
 * Em and en dashes are rewritten too. They are banned in answers outright, and like markdown the
 * ban did not hold on every provider.
 */

/** Opening or closing line of a fenced code block; the fence goes, the code inside stays. */
const FENCE = /^\s*(```|~~~)/;
/** A thematic break: three or more of the same -, * or _ and nothing else on the line. */
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const QUOTE = /^\s*>\s?/;
/** A bullet marker. Not `1.`: numbered lines are kept. */
const BULLET = /^\s*[-*+•]\s+/;
const TABLE_ROW = /^\s*\|/;

function stripInline(line: string): string {
  return (
    line
      // images before links, so `![alt](src)` does not leave a stray `!`
      .replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, '$1')
      // a link whose text is its own URL collapses to the URL; otherwise keep both, readable
      .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, label: string, url: string) =>
        label.trim() === url.trim() ? url : `${label} (${url})`,
      )
      .replace(/`([^`\n]+)`/g, '$1')
      .replace(/\*\*([^\n]+?)\*\*/g, '$1')
      // a pair left half-open by the model is still markup, never prose
      .replace(/\*\*/g, '')
      // single-star emphasis only at word edges, so `2*3*4` and `a * b` are left alone
      // (no `__bold__` rule: models rarely write it, and it would eat identifiers like `__init__`)
      .replace(/(^|[\s(["'])\*(?=\S)([^*\n]*?\S)\*(?=$|[\s).,;:!?"'])/g, '$1$2')
  );
}

function stripDashes(line: string): string {
  return (
    line
      // a dash opening a line was a list marker in disguise
      .replace(/^(\s*)[—–]\s*/, '$1')
      // a number range keeps its meaning with a hyphen
      .replace(/(\d)\s*–\s*(\d)/g, '$1-$2')
      .replace(/\s*[—–]\s*/g, ', ')
      .replace(/,\s*,/g, ',')
      .replace(/,\s*([.!?;:])/g, '$1')
  );
}

export function toPlainText(text: string): string {
  if (!text) return text;

  const lines: string[] = [];
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    if (FENCE.test(raw) || RULE.test(raw)) continue;

    let line = raw;
    const heading = HEADING.exec(line);
    if (heading) {
      line = heading[1];
    } else if (!TABLE_ROW.test(line)) {
      line = line.replace(QUOTE, '');
      if (BULLET.test(line)) line = line.replace(BULLET, '');
    }

    lines.push(stripDashes(stripInline(line)).replace(/[ \t]+$/, ''));
  }

  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
