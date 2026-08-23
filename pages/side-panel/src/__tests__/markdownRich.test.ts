import { describe, expect, it } from 'vitest';
import { hasRichMarkup, parseInlineSpans, parseRichText } from '../markdownRich';

describe('parseInlineSpans', () => {
  it('leaves plain prose as a single span', () => {
    expect(parseInlineSpans('nothing to see here')).toEqual([{ kind: 'text', text: 'nothing to see here' }]);
  });

  it('splits emphasis out of the surrounding text', () => {
    expect(parseInlineSpans('the **login** button')).toEqual([
      { kind: 'text', text: 'the ' },
      { kind: 'strong', text: 'login' },
      { kind: 'text', text: ' button' },
    ]);
  });

  it('reads a backticked literal as code', () => {
    expect(parseInlineSpans('open `index.html` now')).toEqual([
      { kind: 'text', text: 'open ' },
      { kind: 'code', text: 'index.html' },
      { kind: 'text', text: ' now' },
    ]);
  });

  it('keeps asterisks inside code literal', () => {
    expect(parseInlineSpans('run `a ** b` twice')).toEqual([
      { kind: 'text', text: 'run ' },
      { kind: 'code', text: 'a ** b' },
      { kind: 'text', text: ' twice' },
    ]);
  });

  // A half-open marker is far more likely to be prose than emphasis, so it stays literal.
  it('leaves an unclosed marker as text', () => {
    expect(parseInlineSpans('a **b and c')).toEqual([{ kind: 'text', text: 'a **b and c' }]);
    expect(parseInlineSpans('use `code here')).toEqual([{ kind: 'text', text: 'use `code here' }]);
  });

  // "2 ** 3 and 4 ** 5" must stay arithmetic rather than emphasising the middle of the sentence.
  it('does not emphasise across whitespace-padded markers', () => {
    expect(parseInlineSpans('2 ** 3 and 4 ** 5')).toEqual([{ kind: 'text', text: '2 ** 3 and 4 ** 5' }]);
  });

  it('handles several runs in one line', () => {
    expect(parseInlineSpans('**a** then `b` then **c**')).toEqual([
      { kind: 'strong', text: 'a' },
      { kind: 'text', text: ' then ' },
      { kind: 'code', text: 'b' },
      { kind: 'text', text: ' then ' },
      { kind: 'strong', text: 'c' },
    ]);
  });
});

describe('parseRichText', () => {
  it('recognises headings up to three hashes and no further', () => {
    expect(parseRichText('## Hasil').at(0)).toEqual({ kind: 'heading', spans: [{ kind: 'text', text: 'Hasil' }] });
    expect(parseRichText('#### Hasil').at(0)?.kind).toBe('paragraph');
  });

  it('needs a space after the hash, so a hashtag stays prose', () => {
    expect(parseRichText('#flowkite is trending').at(0)?.kind).toBe('paragraph');
  });

  it('reads bullets and keeps the written number on ordered items', () => {
    const blocks = parseRichText('- first\n3. third');
    expect(blocks[0]).toEqual({ kind: 'bullet', spans: [{ kind: 'text', text: 'first' }] });
    expect(blocks[1]).toEqual({ kind: 'ordered', marker: '3.', spans: [{ kind: 'text', text: 'third' }] });
  });

  it('parses emphasis inside a bullet', () => {
    expect(parseRichText('- the **fast** one')).toEqual([
      {
        kind: 'bullet',
        spans: [
          { kind: 'text', text: 'the ' },
          { kind: 'strong', text: 'fast' },
          { kind: 'text', text: ' one' },
        ],
      },
    ]);
  });

  // Blank lines are real vertical rhythm in agent prose, so they survive as empty blocks.
  it('keeps blank lines as blocks with no spans', () => {
    const blocks = parseRichText('one\n\ntwo');
    expect(blocks).toHaveLength(3);
    expect(blocks[1].spans).toEqual([]);
  });

  it('does not mistake a bare asterisk bullet for emphasis', () => {
    expect(parseRichText('* item')).toEqual([{ kind: 'bullet', spans: [{ kind: 'text', text: 'item' }] }]);
  });
});

describe('hasRichMarkup', () => {
  it('is false for ordinary status prose', () => {
    expect(hasRichMarkup('Navigating to the search page')).toBe(false);
    expect(hasRichMarkup('cost me 2 * 3 dollars')).toBe(false);
  });

  it('is true once any recognised construct appears', () => {
    expect(hasRichMarkup('a **b**')).toBe(true);
    expect(hasRichMarkup('run `x`')).toBe(true);
    expect(hasRichMarkup('## Title')).toBe(true);
    expect(hasRichMarkup('- one\n- two')).toBe(true);
    expect(hasRichMarkup('1. one')).toBe(true);
  });
});
