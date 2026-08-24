export enum Actors {
  SYSTEM = 'system',
  USER = 'user',
  PLANNER = 'planner',
  NAVIGATOR = 'navigator',
  VALIDATOR = 'validator',
}

/** How one trail entry reads: a step that worked, one that did not, or plain narration. */
export type TrailKind = 'ok' | 'error' | 'note';

/**
 * One line of the step-by-step trail a task leaves behind.
 *
 * The panel shows these live and then attaches the accumulated list to the single message it
 * persists for the task, so a run that finished badly is still inspectable after a reload.
 */
export interface TrailStep {
  actor: Actors;
  text: string;
  kind: TrailKind;
  timestamp: number; // Unix timestamp in milliseconds
}

/**
 * A table an extraction task collected, attached to the message that task left behind.
 *
 * Stored with the message rather than derived from it: the rows never appeared in the message text
 * in the first place - keeping them out of the model's context is the whole point of collecting
 * them - so reopening the session is the only way the user gets them back.
 *
 * Structurally mirrors the side panel's DatasetPayload so a payload can be attached without a
 * conversion; storage deliberately does not import from the extension workspace.
 */
export interface MessageDataset {
  /** column headers, in the order the extractions introduced them */
  fields: string[];
  /** one array of cells per row, always `fields.length` long */
  rows: string[][];
  /** true when a cap was hit, so the table is a prefix of what the pages held */
  truncated: boolean;
}

export interface Message {
  actor: Actors;
  content: string;
  timestamp: number; // Unix timestamp in milliseconds
  /**
   * The steps that led to this message, present only on a task's outcome message. Optional so
   * every message stored by an earlier build stays valid and needs no migration.
   */
  steps?: TrailStep[];
  /**
   * The rows the task collected, present only when it used `extract_structured`. Optional for the
   * same reason as `steps`: every message stored by an earlier build stays valid without migration.
   */
  dataset?: MessageDataset;
}

export interface ChatMessage extends Message {
  id: string; // Unique ID for each message
}

export interface ChatSessionMetadata {
  id: string;
  title: string;
  createdAt: number; // Unix timestamp in milliseconds
  updatedAt: number; // Unix timestamp in milliseconds
  messageCount: number;
  /**
   * The schedule this session came from, when it was not started by hand.
   *
   * Stored as an id rather than matched on the title, which was the only join available before:
   * titles are editable from two places now (the schedule's name and the history list's rename), and
   * a comparison that silently stops matching is worse than no comparison at all.
   */
  scheduleId?: number;
}

// ChatSession is the full conversation history displayed in the Sidepanel
export interface ChatSession extends ChatSessionMetadata {
  messages: ChatMessage[];
}

// ChatAgentStepHistory is the history of the every step of the agent
export interface ChatAgentStepHistory {
  task: string;
  history: string;
  timestamp: number; // Unix timestamp in milliseconds
}

/**
 * Token spend for one session, as reported by the providers themselves.
 *
 * Structurally mirrors the side panel's TokenUsagePayload so a snapshot can be stored and read back
 * without a conversion; storage deliberately does not import from the extension workspace.
 */
export interface ChatTokenUsage {
  total: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cachedInputTokens: number;
    /** absent on sessions stored before cache writes were counted separately */
    cacheCreationInputTokens?: number;
    reasoningOutputTokens: number;
  };
  byModel: Array<{
    agent: string;
    model: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cachedInputTokens: number;
    /** absent on sessions stored before cache writes were counted separately */
    cacheCreationInputTokens?: number;
    reasoningOutputTokens: number;
  }>;
  /** calls whose provider reported nothing, which makes `total` a floor rather than the truth */
  unreportedCalls: number;
}

export interface ChatHistoryStorage {
  // Get all chat sessions (with empty message arrays for listing)
  getAllSessions: () => Promise<ChatSession[]>;

  // Clear all chat sessions and messages
  clearAllSessions: () => Promise<void>;

  // Get only session metadata (for efficient listing)
  getSessionsMetadata: () => Promise<ChatSessionMetadata[]>;

  // Get a specific chat session with its messages
  getSession: (sessionId: string) => Promise<ChatSession | null>;

  // Create a new chat session; scheduleId marks the schedule an unattended run came from
  createSession: (title: string, scheduleId?: number) => Promise<ChatSession>;

  /**
   * Sessions produced by one schedule, newest first, metadata only.
   *
   * Metadata only because the caller that needs this - the watch comparison - wants the most recent
   * one and nothing else; loading every session's messages to find it would read the whole history.
   */
  getSessionsForSchedule: (scheduleId: number) => Promise<ChatSessionMetadata[]>;

  // Update an existing chat session
  updateTitle: (sessionId: string, title: string) => Promise<ChatSessionMetadata>;

  // Delete a chat session
  deleteSession: (sessionId: string) => Promise<void>;

  // Add a message to a chat session
  addMessage: (sessionId: string, message: Message) => Promise<ChatMessage>;

  // Delete a message from a chat session
  deleteMessage: (sessionId: string, messageId: string) => Promise<void>;

  // Store what a session spent, so reopening it can still show the number
  storeTokenUsage: (sessionId: string, usage: ChatTokenUsage) => Promise<void>;

  // Read back a session's spend, or null when it was never recorded
  loadTokenUsage: (sessionId: string) => Promise<ChatTokenUsage | null>;

  // Store the history of the agent's state
  storeAgentStepHistory: (sessionId: string, task: string, history: string) => Promise<void>;

  // Load the history of the agent's state
  loadAgentStepHistory: (sessionId: string) => Promise<ChatAgentStepHistory | null>;
}
