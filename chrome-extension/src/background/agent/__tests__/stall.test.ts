import { describe, expect, it } from 'vitest';
import { madeNoProgress, StallTracker, STALL_ABORT_STEPS, STALL_NUDGE_STEPS } from '../stall';
import type { StepGround } from '../stall';

const ground = (over: Partial<StepGround> = {}): StepGround => ({
  url: 'https://example.com/list',
  elementCount: 40,
  newElementCount: 0,
  scrollY: 0,
  ...over,
});

describe('madeNoProgress', () => {
  it('is true when url, element count, scroll and newness all say nothing moved', () => {
    expect(madeNoProgress(ground(), ground())).toBe(true);
  });

  it('is false when the page navigated', () => {
    expect(madeNoProgress(ground(), ground({ url: 'https://example.com/detail' }))).toBe(false);
  });

  it('is false when elements appeared or disappeared', () => {
    expect(madeNoProgress(ground(), ground({ elementCount: 41 }))).toBe(false);
    expect(madeNoProgress(ground(), ground({ elementCount: 39 }))).toBe(false);
  });

  it('is false when the viewport moved', () => {
    expect(madeNoProgress(ground(), ground({ scrollY: 800 }))).toBe(false);
  });

  // A dropdown can open without changing the element count if something else closed at the
  // same time, so a single new element is movement on its own.
  it('is false when even one element is new', () => {
    expect(madeNoProgress(ground(), ground({ newElementCount: 1 }))).toBe(false);
  });

  // No baseline is an unknown, and an unknown must never be read as evidence of standing still.
  it('is false when newness could not be measured', () => {
    expect(madeNoProgress(ground(), ground({ newElementCount: null }))).toBe(false);
  });
});

describe('StallTracker', () => {
  const stallFor = (tracker: StallTracker, times: number): string[] =>
    Array.from({ length: times }, () => tracker.record(ground()));

  it('never reports on the first step, having nothing to compare against', () => {
    expect(new StallTracker().record(ground())).toBe('continue');
  });

  it('stays quiet below the nudge threshold', () => {
    const tracker = new StallTracker();
    const verdicts = stallFor(tracker, STALL_NUDGE_STEPS);
    // The first record only establishes the baseline, so the threshold is crossed one step later.
    expect(verdicts.every(verdict => verdict === 'continue')).toBe(true);
    expect(tracker.steps).toBe(STALL_NUDGE_STEPS - 1);
  });

  it('nudges once the threshold is crossed and keeps nudging after', () => {
    const tracker = new StallTracker();
    stallFor(tracker, STALL_NUDGE_STEPS);
    expect(tracker.record(ground())).toBe('nudge');
    expect(tracker.record(ground())).toBe('nudge');
  });

  it('aborts only after the higher threshold', () => {
    const tracker = new StallTracker();
    const verdicts = stallFor(tracker, STALL_ABORT_STEPS + 1);
    expect(verdicts.filter(verdict => verdict === 'abort')).toHaveLength(1);
    expect(verdicts.at(-1)).toBe('abort');
  });

  it('forgets the run of stalls as soon as anything moves', () => {
    const tracker = new StallTracker();
    stallFor(tracker, STALL_NUDGE_STEPS + 1);
    expect(tracker.record(ground({ url: 'https://example.com/next' }))).toBe('continue');
    expect(tracker.steps).toBe(0);
  });

  it('starts clean after reset, so a follow-up task does not inherit a stall', () => {
    const tracker = new StallTracker();
    stallFor(tracker, STALL_NUDGE_STEPS + 1);
    tracker.reset();
    expect(tracker.record(ground())).toBe('continue');
    expect(tracker.steps).toBe(0);
  });
});
