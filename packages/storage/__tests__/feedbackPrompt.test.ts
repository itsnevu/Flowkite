import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_FEEDBACK_PROMPT_STATE,
  PROMPT_COOLDOWN_MS,
  TASKS_BEFORE_PROMPT,
  feedbackPromptStore,
  shouldPromptForFeedback,
} from '../lib/settings/feedbackPrompt';

/**
 * The whole value of the feedback strip is that it is rare. These pin the leash: it never asks
 * before the user has run enough tasks to have an opinion, and never asks twice inside a month -
 * whichever way the previous ask ended.
 */
describe('shouldPromptForFeedback', () => {
  const NOW = 1_700_000_000_000;

  it('stays quiet on a fresh install', () => {
    expect(shouldPromptForFeedback(DEFAULT_FEEDBACK_PROMPT_STATE, NOW)).toBe(false);
  });

  it('stays quiet one task short of the threshold', () => {
    expect(
      shouldPromptForFeedback({ ...DEFAULT_FEEDBACK_PROMPT_STATE, completedTasks: TASKS_BEFORE_PROMPT - 1 }, NOW),
    ).toBe(false);
  });

  it('asks once the task count is reached and it has never asked before', () => {
    expect(
      shouldPromptForFeedback({ ...DEFAULT_FEEDBACK_PROMPT_STATE, completedTasks: TASKS_BEFORE_PROMPT }, NOW),
    ).toBe(true);
  });

  it('stays quiet inside the cooldown even with plenty of tasks', () => {
    const state = { completedTasks: 500, lastPromptedAt: NOW - PROMPT_COOLDOWN_MS + 1, lastRating: 'good' as const };
    expect(shouldPromptForFeedback(state, NOW)).toBe(false);
  });

  it('asks again once the cooldown has fully elapsed', () => {
    const state = { completedTasks: TASKS_BEFORE_PROMPT, lastPromptedAt: NOW - PROMPT_COOLDOWN_MS, lastRating: null };
    expect(shouldPromptForFeedback(state, NOW)).toBe(true);
  });

  it('needs the task count again after a cooldown, not just the wait', () => {
    const state = { completedTasks: 0, lastPromptedAt: NOW - PROMPT_COOLDOWN_MS * 2, lastRating: null };
    expect(shouldPromptForFeedback(state, NOW)).toBe(false);
  });
});

describe('feedbackPromptStore', () => {
  beforeEach(async () => {
    await feedbackPromptStore.set(DEFAULT_FEEDBACK_PROMPT_STATE);
  });

  it('counts finished tasks', async () => {
    await feedbackPromptStore.recordTaskCompleted();
    await feedbackPromptStore.recordTaskCompleted();
    expect((await feedbackPromptStore.getState()).completedTasks).toBe(2);
  });

  it('starts the cooldown and clears the count when the strip is answered', async () => {
    await feedbackPromptStore.recordTaskCompleted();
    await feedbackPromptStore.recordPrompted('bad');
    const state = await feedbackPromptStore.getState();
    expect(state.completedTasks).toBe(0);
    expect(state.lastRating).toBe('bad');
    expect(state.lastPromptedAt).toBeGreaterThan(0);
  });

  it('starts the cooldown on a dismissal too, keeping the previous rating', async () => {
    await feedbackPromptStore.recordPrompted('good');
    await feedbackPromptStore.recordTaskCompleted();
    await feedbackPromptStore.recordPrompted(null);
    const state = await feedbackPromptStore.getState();
    expect(state.completedTasks).toBe(0);
    expect(state.lastRating).toBe('good');
  });
});
