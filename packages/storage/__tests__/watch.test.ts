import { describe, expect, it } from 'vitest';
import { compareRuns, describeComparison } from '../lib/chat/watch';
import type { MessageDataset } from '../lib/chat/types';

const table = (rows: string[][]): MessageDataset => ({ fields: ['item', 'price'], rows, truncated: false });

describe('compareRuns', () => {
  it('reports the first run as the baseline rather than as a change to something', () => {
    const result = compareRuns(undefined, table([['Kite', '10']]));
    expect(result).toMatchObject({ changed: true, added: 1, reason: 'no-previous' });
  });

  it('reports a run that lost every row as removals, not as something that cannot be compared', () => {
    expect(compareRuns(table([['Kite', '10']]), undefined)).toMatchObject({ changed: true, added: 0, removed: 1 });
    expect(compareRuns(table([['Kite', '10']]), table([]))).toMatchObject({ changed: true, added: 0, removed: 1 });
  });

  it('stays silent when two runs in a row found nothing', () => {
    expect(compareRuns(table([]), table([]))).toMatchObject({ changed: false });
    expect(compareRuns(table([]), undefined)).toMatchObject({ changed: false });
  });

  it('says a run with no rows and no baseline at all cannot be compared', () => {
    expect(compareRuns(undefined, undefined)).toMatchObject({ changed: true, reason: 'not-tabular' });
  });

  it('treats an empty baseline as real: every current row reads as added, not as a first run', () => {
    const result = compareRuns(table([]), table([['Kite', '10']]));
    expect(result).toMatchObject({ changed: true, added: 1, removed: 0 });
    expect(result.reason).toBeUndefined();
  });

  it('is silent when the rows are identical', () => {
    const rows = [
      ['Kite', '10'],
      ['String', '3'],
    ];
    expect(compareRuns(table(rows), table(rows))).toMatchObject({ changed: false, added: 0, removed: 0, modified: 0 });
  });

  // Row order is not information: a listing page can reorder itself without anything having changed.
  it('ignores the order the rows came back in', () => {
    const before = table([
      ['Kite', '10'],
      ['String', '3'],
    ]);
    const after = table([
      ['String', '3'],
      ['Kite', '10'],
    ]);
    expect(compareRuns(before, after).changed).toBe(false);
  });

  it('counts a genuinely new row as added', () => {
    const result = compareRuns(
      table([['Kite', '10']]),
      table([
        ['Kite', '10'],
        ['Sail', '25'],
      ]),
    );
    expect(result).toMatchObject({ changed: true, added: 1, removed: 0, modified: 0 });
  });

  it('counts a vanished row as removed', () => {
    const result = compareRuns(
      table([
        ['Kite', '10'],
        ['Sail', '25'],
      ]),
      table([['Kite', '10']]),
    );
    expect(result).toMatchObject({ changed: true, added: 0, removed: 1, modified: 0 });
  });

  // The thing watches are actually set up for: a price moved. Reporting it as one deletion plus one
  // insertion would be true but useless.
  it('reads a changed value as one modified row, not an add and a remove', () => {
    const result = compareRuns(table([['Kite', '10']]), table([['Kite', '12']]));
    expect(result).toMatchObject({ changed: true, added: 0, removed: 0, modified: 1 });
  });

  it('separates a modification from a genuine addition in the same run', () => {
    const before = table([['Kite', '10']]);
    const after = table([
      ['Kite', '12'],
      ['Sail', '25'],
    ]);
    expect(compareRuns(before, after)).toMatchObject({ changed: true, added: 1, removed: 0, modified: 1 });
  });

  it('ignores whitespace a page renders differently between runs', () => {
    expect(compareRuns(table([['Kite', '10']]), table([['Kite', ' 10 ']])).changed).toBe(false);
  });
});

describe('describeComparison', () => {
  it('names only what actually happened', () => {
    expect(describeComparison({ changed: true, added: 2, removed: 0, modified: 1 })).toBe('2 new, 1 changed');
    expect(describeComparison({ changed: true, added: 0, removed: 3, modified: 0 })).toBe('3 gone');
  });

  it('is empty when nothing moved', () => {
    expect(describeComparison({ changed: false, added: 0, removed: 0, modified: 0 })).toBe('');
  });
});
