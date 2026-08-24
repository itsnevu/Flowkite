import { describe, it, expect, vi, afterEach } from 'vitest';
import { generateNewTaskId, getCurrentTimestampStr, bookmarkTitleForSession, filterSessionsByQuery } from '../utils';

afterEach(() => {
  vi.useRealTimers();
});

describe('generateNewTaskId', () => {
  it('is a timestamp and a six-digit suffix', () => {
    expect(generateNewTaskId()).toMatch(/^\d+-\d{6}$/);
  });

  // Ids are used as chat session keys, so two tasks started in the same millisecond must not
  // collide — which is the only job the random suffix has.
  it('does not repeat within a single millisecond', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-12T10:00:00Z'));
    const ids = new Set(Array.from({ length: 200 }, generateNewTaskId));
    expect(ids.size).toBeGreaterThan(190);
  });

  it('leads with the current time, so ids sort chronologically', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-12T10:00:00Z'));
    const earlier = generateNewTaskId();
    vi.setSystemTime(new Date('2026-08-12T10:00:01Z'));
    const later = generateNewTaskId();
    expect(Number(earlier.split('-')[0])).toBeLessThan(Number(later.split('-')[0]));
  });
});

describe('getCurrentTimestampStr', () => {
  it('is yyyy-MM-dd HH:mm:ss shaped', () => {
    expect(getCurrentTimestampStr()).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/);
  });

  // 24-hour clock: an AM/PM suffix would break the fixed width the format promises.
  it('uses a 24-hour clock with no meridiem', () => {
    const formatted = getCurrentTimestampStr();
    expect(formatted).not.toMatch(/[AP]M/i);
  });

  it('carries no comma between the date and the time', () => {
    expect(getCurrentTimestampStr()).not.toContain(',');
  });
});

describe('bookmarkTitleForSession', () => {
  // The history list can only tell whether a session is already pinned by deriving the same title
  // the pin action stores, so the two have to agree exactly - that is the whole reason it is shared.
  it('keeps the first eight words', () => {
    expect(bookmarkTitleForSession('one two three four five six seven eight nine ten')).toBe(
      'one two three four five six seven eight',
    );
  });

  it('leaves a short title alone', () => {
    expect(bookmarkTitleForSession('halo')).toBe('halo');
  });

  it('round-trips: a stored title derives to itself, so an already-pinned session matches', () => {
    const stored = bookmarkTitleForSession('Compare the M4 Air reviews on three sites and give me the consensus');
    expect(bookmarkTitleForSession(stored)).toBe(stored);
  });
});

describe('filterSessionsByQuery', () => {
  const sessions = [
    { title: 'Download the invoice from Gmail' },
    { title: 'Compare laptop prices on Tokopedia' },
    { title: 'Check GitHub issues' },
  ];

  it('returns everything for an empty or blank query', () => {
    expect(filterSessionsByQuery(sessions, '')).toHaveLength(3);
    expect(filterSessionsByQuery(sessions, '   ')).toHaveLength(3);
  });

  it('matches case-insensitively', () => {
    expect(filterSessionsByQuery(sessions, 'GITHUB')).toEqual([{ title: 'Check GitHub issues' }]);
  });

  // How people actually remember a run: two words from it, in whatever order they come to mind.
  it('requires every term but not their order', () => {
    expect(filterSessionsByQuery(sessions, 'gmail invoice')).toEqual([{ title: 'Download the invoice from Gmail' }]);
    expect(filterSessionsByQuery(sessions, 'invoice gmail')).toEqual([{ title: 'Download the invoice from Gmail' }]);
  });

  it('returns nothing when one term is absent', () => {
    expect(filterSessionsByQuery(sessions, 'gmail tokopedia')).toEqual([]);
  });
});
