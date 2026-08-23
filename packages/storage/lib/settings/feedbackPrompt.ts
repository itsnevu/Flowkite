import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';

/** What the user answered when asked how the session was going. */
export type SessionFeedbackRating = 'bad' | 'fine' | 'good';

export const SESSION_FEEDBACK_RATINGS: readonly SessionFeedbackRating[] = ['bad', 'fine', 'good'];

/**
 * When it is fair to ask the user how things are going.
 *
 * The question is worth asking and cheap to answer, which is exactly why it needs a hard leash:
 * a prompt that reappears is a prompt people learn to dismiss without reading, and the answers stop
 * meaning anything. Two conditions, both required, and the counter resets whichever way the strip
 * goes away - answered or dismissed. Declining to answer is an answer about being asked.
 */
export interface FeedbackPromptState {
  /** Tasks that reached a final state since the last time the strip was shown. */
  completedTasks: number;
  /** Epoch ms of the last time the strip was shown, or 0 if it never has been. */
  lastPromptedAt: number;
  /** The last rating given, kept so the panel can avoid re-asking a user who just answered. */
  lastRating: SessionFeedbackRating | null;
}

/** Enough of a run to have an opinion, and not so many that the first ask lands after the user has left. */
export const TASKS_BEFORE_PROMPT = 5;

/** A month between asks. Long enough that the strip is never part of the furniture. */
export const PROMPT_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

export const DEFAULT_FEEDBACK_PROMPT_STATE: FeedbackPromptState = {
  completedTasks: 0,
  lastPromptedAt: 0,
  lastRating: null,
};

/**
 * Whether the strip has earned its place on screen right now.
 *
 * A never-prompted install still has to clear the task count: `lastPromptedAt` of 0 puts the
 * cooldown comfortably in the past, so the count is the only gate on the first ask.
 */
export function shouldPromptForFeedback(state: FeedbackPromptState, now: number): boolean {
  return state.completedTasks >= TASKS_BEFORE_PROMPT && now - state.lastPromptedAt >= PROMPT_COOLDOWN_MS;
}

export type FeedbackPromptStorage = BaseStorage<FeedbackPromptState> & {
  /** Count one finished task toward the next ask. */
  recordTaskCompleted: () => Promise<void>;
  /** The strip was shown and then answered or dismissed: start the cooldown and reset the count. */
  recordPrompted: (rating: SessionFeedbackRating | null) => Promise<void>;
  getState: () => Promise<FeedbackPromptState>;
};

const storage = createStorage<FeedbackPromptState>('feedback-prompt', DEFAULT_FEEDBACK_PROMPT_STATE, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export const feedbackPromptStore: FeedbackPromptStorage = {
  ...storage,
  async recordTaskCompleted() {
    await storage.set(prev => ({
      ...DEFAULT_FEEDBACK_PROMPT_STATE,
      ...prev,
      completedTasks: (prev?.completedTasks ?? 0) + 1,
    }));
  },
  async recordPrompted(rating: SessionFeedbackRating | null) {
    await storage.set(prev => ({
      ...DEFAULT_FEEDBACK_PROMPT_STATE,
      ...prev,
      completedTasks: 0,
      lastPromptedAt: Date.now(),
      lastRating: rating ?? prev?.lastRating ?? null,
    }));
  },
  getState: () => storage.get(),
};
