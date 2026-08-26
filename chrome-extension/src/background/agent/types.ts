import { z } from 'zod';
import { DEFAULT_INCLUDE_ATTRIBUTES, type DOMElementNode } from '../browser/dom/views';
import {
  Actors,
  ExecutionState,
  type ActionConfirmationPayload,
  type EventPayload,
  type HandoffPayload,
  AgentEvent,
} from './event/types';
import { AgentStepHistory } from './history';
import { TokenUsageTracker } from './usage';
import { TaskDataset } from './dataset';
import type BrowserContext from '../browser/context';
import type { BrowserState } from '../browser/views';
import type Page from '../browser/page';
import type { DOMHistoryElement } from '../browser/dom/history/view';
import type MessageManager from './messages/service';
import type { EventManager } from './event/manager';
import type { ApprovalMode } from '@extension/storage';

export interface AgentOptions {
  maxSteps: number;
  maxActionsPerStep: number;
  maxFailures: number;
  /**
   * Ceiling on a single retry backoff, in SECONDS. The wait grows exponentially from
   * LLM_BASE_DELAY_MS and stops here, so 10 means "never sit longer than ten seconds before trying
   * the model again". It is a cap rather than a base on purpose: as a base, the default 10 would
   * mean a first retry 10-20 seconds after a hiccup, which is far too long for an agent the user is
   * watching work.
   */
  retryDelay: number;
  maxInputTokens: number;
  maxErrorLength: number;
  useVision: boolean;
  useVisionForPlanner: boolean;
  includeAttributes: string[];
  planningInterval: number;
  /**
   * How much the user signs off on before the agent acts.
   *
   * Carried as the mode itself rather than as the two booleans it implies, because the four boolean
   * combinations do not map onto three modes — there is no mode for "no plan gate but confirm
   * purchases" — and a pair of flags makes that illegal state representable. It is also the field
   * {@link Executor.setApprovalMode} writes through to mid-task: `AgentContext.options` is a plain
   * mutable object, so the navigator re-reads it before every action with no subscription needed.
   */
  approvalMode: ApprovalMode;
  /**
   * True when nobody is watching — a scheduled run. Changes exactly two behaviours, both fail-safe:
   * the plan gate treats the plan as pre-approved (scheduling the task WAS the approval), and the
   * sensitive-action gate auto-DECLINES instead of parking forever on a question nobody will
   * answer. It never auto-allows: an unattended task can read and report, not spend.
   */
  unattended: boolean;
}

export const DEFAULT_AGENT_OPTIONS: AgentOptions = {
  maxSteps: 100,
  maxActionsPerStep: 10,
  maxFailures: 3,
  retryDelay: 10,
  maxInputTokens: 128000,
  maxErrorLength: 400,
  useVision: false,
  useVisionForPlanner: true,
  includeAttributes: DEFAULT_INCLUDE_ATTRIBUTES,
  planningInterval: 3,
  approvalMode: 'planner',
  unattended: false,
};

export class AgentContext {
  controller: AbortController;
  taskId: string;
  browserContext: BrowserContext;
  messageManager: MessageManager;
  eventManager: EventManager;
  options: AgentOptions;
  paused: boolean;
  stopped: boolean;
  consecutiveFailures: number;
  /**
   * Consecutive steps that changed nothing on the page, as judged by {@link StallTracker}.
   *
   * Separate from `consecutiveFailures`, which counts errors: a stalled run is one where every
   * action succeeded. Non-zero is what escalates the next read to a screenshot.
   */
  stalledSteps: number;
  nSteps: number;
  stepInfo: AgentStepInfo | null;
  actionResults: ActionResult[];
  /**
   * The page state the model reasoned over this step, or null between steps.
   *
   * Recorded where the state message is built, so it is by construction the same parse whose element
   * indices appear in the model's output. Actions resolve those indices against this instead of
   * re-reading the DOM - one parse cheaper, and one renumbering safer.
   */
  stepState: BrowserState | null;
  stateMessageAdded: boolean;
  history: AgentStepHistory;
  /** What this task has spent, as reported by the providers themselves. */
  tokenUsage: TokenUsageTracker;
  /**
   * Rows `extract_structured` has collected, held outside the message history.
   *
   * On the context rather than in the action so a task's rows survive the step loop, and so the
   * executor can hand the finished set to the panel without reaching into the action registry.
   */
  dataset: TaskDataset;
  finalAnswer: string | null;
  /** Resolver for the pending sensitive-action gate, set only while the user is being asked. */
  private actionConfirmationResolver: ((approved: boolean) => void) | null = null;
  /** Resolver for the pending human-handoff gate, set only while the user has the tab. */
  private handoffResolver: ((completed: boolean) => void) | null = null;

  constructor(
    taskId: string,
    browserContext: BrowserContext,
    messageManager: MessageManager,
    eventManager: EventManager,
    options: Partial<AgentOptions>,
  ) {
    this.controller = new AbortController();
    this.taskId = taskId;
    this.browserContext = browserContext;
    this.messageManager = messageManager;
    this.eventManager = eventManager;
    this.options = { ...DEFAULT_AGENT_OPTIONS, ...options };

    this.paused = false;
    this.stopped = false;
    this.nSteps = 0;
    this.consecutiveFailures = 0;
    this.stalledSteps = 0;
    this.stepInfo = null;
    this.actionResults = [];
    this.stepState = null;
    this.stateMessageAdded = false;
    this.history = new AgentStepHistory();
    this.tokenUsage = new TokenUsageTracker();
    this.dataset = new TaskDataset();
    this.finalAnswer = null;
  }

  /**
   * The element the model meant by `index`, or null when the step's state no longer describes the
   * page in front of us - a mid-step navigation or tab switch. Callers read null as "re-read the page".
   */
  resolveStepElement(index: number, page: Page): DOMElementNode | null {
    const state = this.stepState;
    if (!state || state.tabId !== page.tabId || state.url !== page.url()) {
      return null;
    }
    return state.selectorMap.get(index) ?? null;
  }

  /**
   * Return this context to the state a fresh task expects.
   *
   * The Executor is reused across follow-ups, so anything a run latches has to be cleared here or
   * the next task inherits it - and every one of these is load-bearing:
   *
   * - `consecutiveFailures` left at the ceiling makes `shouldStop()` fire before step 0, so the
   *   follow-up runs no steps and ends on a TASK_PAUSE the panel does not treat as terminal.
   * - `controller` is aborted 300ms after a cancel and was never replaced, so an Executor that was
   *   stopped once aborted every model call it would ever make again.
   * - `stopped` / `paused` survive the run that set them, cancelling or parking the next task.
   * - `stateMessageAdded` left true makes the follow-up's first plan read the previous task's page.
   *
   * Fields the constructor sets and a run never mutates are deliberately left alone, as is
   * `history`, which spans the whole conversation by design.
   */
  resetForTask(): void {
    this.controller = new AbortController();
    this.stopped = false;
    this.paused = false;
    this.consecutiveFailures = 0;
    this.stalledSteps = 0;
    this.stateMessageAdded = false;
    this.stepState = null;
    this.nSteps = 0;
  }

  async emitEvent(actor: Actors, state: ExecutionState, eventDetails: string, payload?: EventPayload) {
    // The same sentence the side panel is about to show goes onto the page the agent is driving, so
    // a user watching the tab rather than the panel sees what it is doing. Only the navigator's
    // "about to act" line: it is the one event that describes something happening to the page in
    // front of them, and it is already localised. Not awaited - the banner is for the user, and a
    // slow or unreachable tab must not hold up the action it is describing.
    if (actor === Actors.NAVIGATOR && state === ExecutionState.ACT_START) {
      void this.browserContext.showActivity(eventDetails).catch(() => undefined);
    }
    const event = new AgentEvent(actor, state, {
      taskId: this.taskId,
      step: this.nSteps,
      maxSteps: this.options.maxSteps,
      details: eventDetails,
      payload,
    });
    await this.eventManager.emit(event);
  }

  /**
   * Block until the user explicitly allows a sensitive action, or declines it.
   *
   * The agent is genuinely parked here — nothing reaches the page until an answer comes back — so a
   * page that manages to steer the model still cannot spend money or delete data on its own.
   */
  async requestActionConfirmation(request: ActionConfirmationPayload): Promise<boolean> {
    // Unattended: there is nobody to ask, and parking forever would hang the scheduled run. The
    // fail-safe answer is the one a cautious user gives to a question they did not see: no.
    if (this.options.unattended) {
      await this.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_DECLINED, request.description, request);
      return false;
    }
    // A cancel can land between the navigator deciding to ask and this gate arming. cancel()
    // releases the resolvers that exist at that moment; a gate created after it would park a run
    // that is already stopped, forever. Declining is the answer a stop means.
    if (this.stopped) {
      return false;
    }
    await this.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_CONFIRM, request.description, request);
    const approved = await new Promise<boolean>(resolve => {
      this.actionConfirmationResolver = resolve;
    });
    this.actionConfirmationResolver = null;
    return approved;
  }

  /** Resolve a pending sensitive-action gate. No-op if the agent is not waiting on one. */
  resolveActionConfirmation(approved: boolean): void {
    this.actionConfirmationResolver?.(approved);
  }

  /** Whether the agent is currently blocked waiting for the user to confirm an action. */
  isAwaitingActionConfirmation(): boolean {
    return this.actionConfirmationResolver !== null;
  }

  /**
   * Hand the tab to the user for one step they must do themselves — logging in, a captcha, a
   * verification code — and block until they say they are done. The other direction of the
   * asks-first contract: instead of the user approving the agent's action, the agent requests the
   * user's. Credentials typed during a handoff go straight into the page and never pass through
   * the model or the transcript.
   */
  async requestHumanHandoff(request: HandoffPayload): Promise<boolean> {
    // Unattended: there is nobody to hand the tab to. Fail the request rather than park forever;
    // the ask_user action emits the decline event, so none is emitted here.
    if (this.options.unattended) {
      return false;
    }
    // Same race as the confirmation gate: a handoff requested after a cancel must not park a run
    // that is already stopped.
    if (this.stopped) {
      return false;
    }
    await this.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_HANDOFF, request.instruction, request);
    const completed = await new Promise<boolean>(resolve => {
      this.handoffResolver = resolve;
    });
    this.handoffResolver = null;
    return completed;
  }

  /** Resolve a pending human-handoff gate. No-op if the agent is not waiting on one. */
  resolveHandoff(completed: boolean): void {
    this.handoffResolver?.(completed);
  }

  /** Whether the agent is currently parked waiting for the user to finish a handoff. */
  isAwaitingHandoff(): boolean {
    return this.handoffResolver !== null;
  }

  async pause() {
    this.paused = true;
  }

  async resume() {
    this.paused = false;
  }

  async stop() {
    this.stopped = true;
    // release any pending gate, otherwise the navigator stays parked on it forever
    this.actionConfirmationResolver?.(false);
    this.handoffResolver?.(false);
    setTimeout(() => this.controller.abort(), 300);
  }
}

export class AgentStepInfo {
  stepNumber: number;
  maxSteps: number;

  constructor(params: { stepNumber: number; maxSteps: number }) {
    this.stepNumber = params.stepNumber;
    this.maxSteps = params.maxSteps;
  }
}

export class ActionResult {
  isDone: boolean;
  success: boolean;
  extractedContent: string | null;
  error: string | null;
  includeInMemory: boolean;
  interactedElement: DOMHistoryElement | null;

  constructor(params: Partial<ActionResult> = {}) {
    this.isDone = params.isDone ?? false;
    this.success = params.success ?? false;
    this.interactedElement = params.interactedElement ?? null;
    this.extractedContent = params.extractedContent ?? null;
    this.error = params.error ?? null;
    this.includeInMemory = params.includeInMemory ?? false;
  }
}

export type WrappedActionResult = ActionResult & {
  toolCallId: string;
};

export class StepMetadata {
  stepStartTime: number;
  stepEndTime: number;
  inputTokens: number;
  stepNumber: number;

  constructor(stepStartTime: number, stepEndTime: number, inputTokens: number, stepNumber: number) {
    this.stepStartTime = stepStartTime;
    this.stepEndTime = stepEndTime;
    this.inputTokens = inputTokens;
    this.stepNumber = stepNumber;
  }

  /**
   * Calculate step duration in seconds
   */
  get durationSeconds(): number {
    return this.stepEndTime - this.stepStartTime;
  }
}

export const agentBrainSchema = z
  .object({
    evaluation_previous_goal: z.string(),
    memory: z.string(),
    next_goal: z.string(),
  })
  .describe('Current state of the agent');

export type AgentBrain = z.infer<typeof agentBrainSchema>;

// Make AgentOutput generic with Zod schema
export interface AgentOutput<T = unknown> {
  /**
   * The unique identifier for the agent
   */
  id: string;

  /**
   * The result of the agent's step
   */
  result?: T;
  /**
   * The error that occurred during the agent's action
   */
  error?: string;
}
