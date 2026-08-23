/**
 * The small slice of markdown an agent answer actually uses, without a markdown engine.
 *
 * Sibling of ./markdownTable, written under the same constraint and for the same reason: pulling in
 * a markdown library to render four constructs is a dependency this repo has deliberately avoided.
 * So exactly four are recognised - a heading line, a bullet line, a numbered line, and inline
 * emphasis - and anything that does not match stays literal text.
 *
 * The point is not fidelity to CommonMark. It is that the one term the sentence turns on, and the
 * one literal the user has to type or click, stop being invisible in a wall of grey prose.
 *
 * Unparsed markers are left exactly as typed. A sentence about the `**` operator renders the stars,
 * because a half-open marker is far more likely to be prose than to be emphasis the writer meant.
 */

/** A run of inline text, flat by construction: emphasis inside emphasis is not a thing here. */
export interface InlineSpan {
  /** `code` renders as a chip; `strong` as accented weight; `text` as-is */
  kind: 'text' | 'strong' | 'code';
  text: string;
}

export interface RichBlock {
  kind: 'heading' | 'paragraph' | 'bullet' | 'ordered';
  spans: InlineSpan[];
  /** the marker as written, for ordered items, so "3." keeps its number rather than being renumbered */
  marker?: string;
}

/** Heading: one to three hashes, a space, then the text. Deeper levels are not distinguished. */
const HEADING = /^\s{0,3}#{1,3}\s+(.*)$/;
/** Bullet: `-`, `*` or `•` followed by a space. Indentation is allowed but not preserved as nesting. */
const BULLET = /^\s{0,4}[-*•]\s+(.*)$/;
/** Numbered item: digits, then `.` or `)`, then a space. */
const ORDERED = /^\s{0,4}(\d{1,3})[.)]\s+(.*)$/;

/**
 * Split one line into text, `code` and **strong** runs.
 *
 * Code is matched before emphasis, so backticked text containing asterisks survives intact - the
 * usual reason a literal is backticked in the first place. Both markers require a non-empty,
 * non-blank body: `**` on its own, and the `* ` of a bullet that slipped through, are text.
 */
export function parseInlineSpans(line: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  let buffer = '';

  const flush = () => {
    if (buffer) {
      spans.push({ kind: 'text', text: buffer });
      buffer = '';
    }
  };

  let i = 0;
  while (i < line.length) {
    const rest = line.slice(i);

    const code = /^`([^`\n]+)`/.exec(rest);
    if (code) {
      flush();
      spans.push({ kind: 'code', text: code[1] });
      i += code[0].length;
      continue;
    }

    // Non-greedy, and the body may not start or end with whitespace, so "2 ** 3 and 4 ** 5" stays
    // arithmetic rather than becoming one emphasised run spanning the middle of the sentence.
    const strong = /^\*\*(\S(?:[^*\n]*\S)?)\*\*/.exec(rest);
    if (strong) {
      flush();
      spans.push({ kind: 'strong', text: strong[1] });
      i += strong[0].length;
      continue;
    }

    buffer += line[i];
    i += 1;
  }

  flush();
  return spans;
}

/**
 * Split a message into rendered blocks, one per line.
 *
 * Line-per-block rather than paragraph-per-block on purpose: agent answers arrive with meaningful
 * hard breaks (a step per line, a finding per line), and reflowing them into paragraphs would throw
 * that structure away. Blank lines survive as empty paragraphs so vertical rhythm is preserved.
 */
export function parseRichText(text: string): RichBlock[] {
  return text.split('\n').map(line => {
    const heading = HEADING.exec(line);
    if (heading) return { kind: 'heading' as const, spans: parseInlineSpans(heading[1]) };

    const ordered = ORDERED.exec(line);
    if (ordered) return { kind: 'ordered' as const, marker: `${ordered[1]}.`, spans: parseInlineSpans(ordered[2]) };

    const bullet = BULLET.exec(line);
    if (bullet) return { kind: 'bullet' as const, spans: parseInlineSpans(bullet[1]) };

    return { kind: 'paragraph' as const, spans: parseInlineSpans(line) };
  });
}

/**
 * Whether a message carries anything worth the rich path.
 *
 * Most agent messages are one plain sentence, and running them through block rendering would swap a
 * single pre-wrap div for a list of paragraph divs to no visible effect. This keeps the cheap path
 * cheap.
 */
export function hasRichMarkup(text: string): boolean {
  return (
    text.split('\n').some(line => HEADING.test(line) || BULLET.test(line) || ORDERED.test(line)) ||
    /`[^`\n]+`/.test(text) ||
    /\*\*\S/.test(text)
  );
}
