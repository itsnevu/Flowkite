export enum Actors {
  SYSTEM = 'system',
  USER = 'user',
  PLANNER = 'planner',
  NAVIGATOR = 'navigator',
}

export enum EventType {
  /**
   * Type of events that can be subscribed to.
   *
   * For now, only execution events are supported.
   */
  EXECUTION = 'execution',
}

export enum ExecutionState {
  /**
   * States representing different phases in the execution lifecycle.
   *
   * Format: <SCOPE>.<STATUS>
   * Scopes: task, step, act
   * Statuses: start, ok, fail, cancel
   *
   * Examples:
   *     TASK_OK = "task.ok"  // Task completed successfully
   *     STEP_FAIL = "step.fail"  // Step failed
   *     ACT_START = "act.start"  // Action started
   */
  // Task level states
  TASK_START = 'task.start',
  TASK_OK = 'task.ok',
  TASK_FAIL = 'task.fail',
  TASK_PAUSE = 'task.pause',
  TASK_RESUME = 'task.resume',
  TASK_CANCEL = 'task.cancel',
  /** Cumulative token usage for the task so far; payload is a TokenUsagePayload. */
  TASK_USAGE = 'task.usage',
  /** The rows an extraction task collected, emitted once just before the terminal event so the
   * panel can attach them to the message the task leaves behind; payload is a DatasetPayload. */
  TASK_DATASET = 'task.dataset',

  // Plan review states (human-in-the-loop gate before any action runs)
  PLAN_REVIEW = 'plan.review',
  PLAN_APPROVED = 'plan.approved',
  PLAN_REJECTED = 'plan.rejected',

  // Step level states
  STEP_START = 'step.start',
  STEP_OK = 'step.ok',
  STEP_FAIL = 'step.fail',
  STEP_CANCEL = 'step.cancel',
  /** A model call failed transiently and is about to be tried again after a backoff. */
  STEP_RETRY = 'step.retry',

  // Action/Tool level states
  ACT_START = 'act.start',
  ACT_OK = 'act.ok',
  ACT_FAIL = 'act.fail',
  /** The agent is blocked, waiting for the user to allow a sensitive action */
  ACT_CONFIRM = 'act.confirm',
  ACT_DECLINED = 'act.declined',
  /** The agent handed the tab to the user (login, captcha, OTP) and waits for "done" */
  ACT_HANDOFF = 'act.handoff',
}

export interface EventData {
  /** Data associated with an event */
  taskId: string;
  /** step is the step number of the task where the event occurred */
  step: number;
  /** max_steps is the maximum number of steps in the task */
  maxSteps: number;
  /** details is the content of the event */
  details: string;
  /**
   * Structured payload for events that carry more than a message. Which shape it holds is
   * determined by `state`: PLAN_REVIEW carries a plan, ACT_CONFIRM carries an action request.
   */
  payload?: EventPayload;
}

export type EventPayload =
  | PlanReviewPayload
  | ActionConfirmationPayload
  | TokenUsagePayload
  | BudgetPausePayload
  | HandoffPayload
  | DatasetPayload;

/**
 * The table `extract_structured` built over the course of a task.
 *
 * Carried whole exactly once rather than row by row: the rows were kept out of the message history
 * on purpose, and streaming them as they arrive would only put them back on a different wire.
 */
export interface DatasetPayload {
  /** column headers, in the order the extractions introduced them */
  fields: string[];
  /** one array of cells per row, always `fields.length` long */
  rows: string[][];
  /** true when a cap was hit, so the table is a prefix of what the pages held */
  truncated: boolean;
}

/**
 * A step the agent asked the user to do by hand in the tab it is driving — logging in, a captcha,
 * a verification code. Carried on ACT_HANDOFF; the executor is parked until handoff_done arrives.
 * Credentials never pass through the model this way: the user types them straight into the page.
 */
export interface HandoffPayload {
  /** what the user is being asked to do, in the agent's words */
  instruction: string;
  /** the page the handoff happens on */
  url: string;
}

/**
 * The task paused itself because its estimated spend crossed the user's budget. Carried on a
 * TASK_PAUSE event; the panel answers with resume_task or cancel_task, so this needs no gate of
 * its own in the executor.
 */
export interface BudgetPausePayload {
  /** discriminates this payload from the other TASK_PAUSE reasons */
  kind: 'budget';
  /** estimated spend so far, from the user's own price entries */
  spentUsd: number;
  /** the budget it crossed */
  budgetUsd: number;
  /** models that spent tokens without a price entry, making spentUsd a floor */
  unpricedModels: string[];
}

/** A sensitive action the agent wants to run, held for the user to allow or decline. */
export interface ActionConfirmationPayload {
  /** why it was flagged, e.g. `purchase` or `destructive` */
  kind: string;
  /** the agent's own description of what it is about to do */
  description: string;
  /** the element label, URL or field the action targets */
  target: string;
  /** the page the action would run on, so the user can see where this is happening */
  url: string;
}

/** The plan shown to the user for approval before the navigator is allowed to act. */
export interface PlanReviewPayload {
  /** what the planner observed about the current page */
  observation: string;
  /** the steps the agent intends to take */
  nextSteps: string;
  /** risks or blockers the planner flagged */
  challenges: string;
  /** why the planner chose this approach */
  reasoning: string;
}

/** Token counts as reported by the provider. Cached/reasoning stay 0 when a provider omits them. */
export interface TokenUsageTotals {
  inputTokens: number;
  outputTokens: number;
  /** the provider's own total, which for thinking models can exceed input + output */
  totalTokens: number;
  cachedInputTokens: number;
  /**
   * Input tokens written into the prompt cache, billed at a premium by some providers.
   *
   * Optional because sessions stored before it existed do not carry it, and a stored snapshot is
   * read back through this same shape - a required field would make every old session unreadable.
   */
  cacheCreationInputTokens?: number;
  reasoningOutputTokens: number;
}

/** One agent/model pair's share of the task's spend. */
export interface TokenUsageEntry extends TokenUsageTotals {
  /** 'navigator' or 'planner' - the agent id set in the subclass constructor */
  agent: string;
  model: string;
  calls: number;
}

/** What the task has cost so far, in tokens. Cumulative and authoritative: the last one wins. */
export interface TokenUsagePayload {
  total: TokenUsageTotals;
  byModel: TokenUsageEntry[];
  /** calls whose provider reported nothing, which makes `total` a floor rather than the truth */
  unreportedCalls: number;
}

export class AgentEvent {
  /**
   * Represents a state change event in the task execution system.
   * Each event has a type, a specific state that changed,
   * the actor that triggered the change, and associated data.
   */
  constructor(
    public actor: Actors,
    public state: ExecutionState,
    public data: EventData,
    public timestamp: number = Date.now(),
    public type: EventType = EventType.EXECUTION,
  ) {}
}

// The type of callback for event subscribers
export type EventCallback = (event: AgentEvent) => Promise<void>;
