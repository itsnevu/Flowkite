/**
 * Noticing that a run is busy but getting nowhere.
 *
 * `consecutiveFailures` already ends a run that keeps erroring. It cannot see the other way a task
 * dies: every action returns success and the page never moves. A click on a control that does
 * nothing, a scroll on a pane that does not scroll, a field a script clears again the moment it is
 * filled - all report success, so the failure counter is reset to zero on each one, and the run
 * spends its whole step budget standing still. To the user that reads as an agent hard at work,
 * which is far more confusing than an agent that says it is stuck.
 *
 * The signal is taken from the parse the model was shown at the start of each step, so it costs no
 * extra page read and no extra hashing: comparing the ground before step N with the ground before
 * step N+1 is exactly asking whether step N changed anything.
 *
 * Kept free of imports so the rule can be tested without the extension runtime.
 */

/** What one step's ground looked like, in the few numbers that decide whether it moved. */
export interface StepGround {
  url: string;
  /** how many interactive elements the parse found */
  elementCount: number;
  /**
   * how many of them were new since the previous parse.
   *
   * Null when there was no baseline to compare against - the first read of a page, or a read taken
   * with the marking switched off. Null is treated as progress, never as a stall: an unknown is not
   * evidence of standing still.
   */
  newElementCount: number | null;
  scrollY: number;
}

/**
 * Whether the step between these two grounds changed nothing a further step could build on.
 *
 * Deliberately strict about what counts as "nothing": a different url, a different number of
 * elements, a different scroll position or a single new element all count as movement. It is far
 * better to miss a stall than to accuse a run that is quietly making progress - the escalation this
 * feeds is disruptive, and a false one lands on a task that was working.
 */
export function madeNoProgress(before: StepGround, after: StepGround): boolean {
  if (before.url !== after.url) return false;
  if (before.elementCount !== after.elementCount) return false;
  if (before.scrollY !== after.scrollY) return false;
  // No baseline means the marking could not run this step; that is an unknown, not a stall.
  if (after.newElementCount === null) return false;
  return after.newElementCount === 0;
}

/**
 * Steps of standing still before the agent is told about it, and before the run is ended.
 *
 * Three, not one: a step that reads the page, thinks and caches a finding legitimately leaves the
 * ground untouched, and so does a step spent waiting for something slow. Two of those in a row is
 * ordinary. Three is a pattern.
 *
 * Six, not three, for ending it: being told plainly that nothing has moved - with a screenshot,
 * which is usually what was missing - is often enough for the model to change approach, and killing
 * the run at the first sign of it would throw away tasks that recover.
 */
export const STALL_NUDGE_STEPS = 3;
export const STALL_ABORT_STEPS = 6;

/**
 * Tracks consecutive no-progress steps and says what the run should do about it.
 *
 * A class rather than a counter on the context because the rule and its thresholds belong together:
 * the executor asks what to do, it does not decide when a stall has happened.
 */
export class StallTracker {
  private previous: StepGround | null = null;
  private stalledSteps = 0;

  /** Consecutive steps that changed nothing, as of the last record(). */
  get steps(): number {
    return this.stalledSteps;
  }

  /** Forget everything, for an Executor reused by a follow-up task. */
  reset(): void {
    this.previous = null;
    this.stalledSteps = 0;
  }

  /**
   * Record the ground this step reasoned over.
   *
   * @returns what the run should do now: keep going, tell the model, or give up
   */
  record(ground: StepGround): 'continue' | 'nudge' | 'abort' {
    const previous = this.previous;
    this.previous = ground;

    if (!previous) return 'continue';

    if (madeNoProgress(previous, ground)) {
      this.stalledSteps += 1;
    } else {
      this.stalledSteps = 0;
      return 'continue';
    }

    if (this.stalledSteps >= STALL_ABORT_STEPS) return 'abort';
    // Only on the exact step the threshold is crossed, and every step after it, the nudge repeats -
    // a model that ignored the first one is precisely the one that needs the second.
    if (this.stalledSteps >= STALL_NUDGE_STEPS) return 'nudge';
    return 'continue';
  }
}
