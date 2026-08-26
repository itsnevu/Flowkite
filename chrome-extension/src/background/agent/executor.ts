import { t } from '@extension/i18n';
import { createLogger } from '@src/background/log';
import { chatHistoryStore } from '@extension/storage/lib/chat';
import {
  memoryStore,
  observedModelsStore,
  requiresPlanApproval,
  skipsPeriodicPlanning,
  estimateCostUsd,
} from '@extension/storage';
import { URLNotAllowedError } from '../browser/views';
import { TabGroupStatus } from '../browser/tabGroup';
import { analytics } from '../services/analytics';
import { type ActionResult, AgentContext, type AgentOptions, type AgentOutput, DEFAULT_AGENT_OPTIONS } from './types';
import { StallTracker, type StepGround } from './stall';
import { NavigatorAgent, NavigatorActionRegistry } from './agents/navigator';
import { PlannerAgent, type PlannerOutput } from './agents/planner';
import { NavigatorPrompt } from './prompts/navigator';
import { PlannerPrompt } from './prompts/planner';
import MessageManager, { MessageManagerSettings } from './messages/service';
import { OUTPUT_TOKEN_CAP } from './helper';
import { ActionBuilder } from './actions/builder';
import { EventManager } from './event/manager';
import { Actors, type EventCallback, EventType, ExecutionState } from './event/types';
import {
  ChatModelAuthError,
  ChatModelBadRequestError,
  ChatModelForbiddenError,
  ExtensionConflictError,
  RequestCancelledError,
  MaxStepsReachedError,
  MaxFailuresReachedError,
  MaxTokensExceededError,
} from './agents/errors';
import { routeStep, ModelTier } from './routing';
import type BrowserContext from '../browser/context';
import type { AgentStepHistory } from './history';
import type { ApprovalMode, GeneralSettingsConfig, ModelPricingConfig } from '@extension/storage';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

const logger = createLogger('Executor');

export interface ExecutorExtraArgs {
  plannerLLM?: BaseChatModel;
  fastLLM?: BaseChatModel;
  extractorLLM?: BaseChatModel;
  /** The name the extractor's tokens should be booked under; defaults to the navigator's model name. */
  extractorModelName?: string;
  agentOptions?: Partial<AgentOptions>;
  generalSettings?: GeneralSettingsConfig;
  /** The user's own USD-per-MTok price entries, snapshotted at task start for the budget brake. */
  modelPricing?: ModelPricingConfig;
  /**
   * Which provider serves each model above.
   *
   * The agents need this and nothing was passing it, so `BaseAgent.provider` was the empty string
   * for every agent in production - silently disabling the "this provider already leads with tool
   * calling" check, so every 400 on Anthropic, Groq, DeepSeek, Cerebras and xAI was answered with a
   * second identical request; disabling the Llama structured-output guard; and collapsing the
   * per-model memo key to `":<model>"`, so two endpoints serving the same model id shared one entry.
   */
  providers?: { navigator?: string; planner?: string; fast?: string };
}

export class Executor {
  private readonly navigator: NavigatorAgent;
  /**
   * A second navigator wired to the cheap model. Both share one AgentContext and one action
   * registry, so routing a step to it changes which model thinks, not what the agent knows.
   * Null when no Fast model is configured, which is also how hybrid routing stays opt-in.
   */
  private readonly fastNavigator: NavigatorAgent | null;
  private readonly planner: PlannerAgent;
  private readonly context: AgentContext;
  private readonly plannerPrompt: PlannerPrompt;
  private readonly navigatorPrompt: NavigatorPrompt;
  private readonly generalSettings: GeneralSettingsConfig | undefined;
  /**
   * How much the user signs off on before the agent acts.
   *
   * Held apart from `generalSettings` because it is the one setting that can change after
   * construction — the composer's mode picker pushes it through {@link setApprovalMode} while a
   * task is running, and follow-up tasks reuse this same Executor instance rather than building a
   * new one. Everything else in `generalSettings` is snapshotted once and stays snapshotted.
   */
  private approvalMode: ApprovalMode;
  private tasks: string[] = [];
  /** Resolver for the pending plan-approval gate, set only while the user is being asked. */
  private planApprovalResolver: ((approved: boolean) => void) | null = null;
  /** Whether the user already approved a plan for the task currently being worked on. */
  private planApproved = false;
  /** Whether remembered preferences were already loaded for the task currently being worked on. */
  private memoriesInjected = false;
  /** Price entries snapshotted at construction; empty means nothing is priced and the brake stays off. */
  private readonly modelPricing: ModelPricingConfig;
  /**
   * Latched once the budget pause has been shown. Resuming past it is an explicit "keep going"
   * from the user, so the brake does not re-fire every step after that for the rest of the run.
   */
  private budgetPauseIssued = false;
  /**
   * Corrections the user typed while the run was in flight, waiting for the top of the next step.
   *
   * A queue rather than a single slot: a user watching the agent go wrong types in bursts, and the
   * second sentence is usually the one that explains the first. Applied at a step boundary rather
   * than the moment they arrive, because the alternative is mutating the message history underneath
   * a model call that is already in flight.
   */
  private pendingSteers: string[] = [];
  /**
   * Why the run was cancelled, when the canceller said. TASK_CANCEL's detail is the one line the
   * user keeps, and "Task cancelled" explains nothing when it was the closed tab that ended it.
   */
  private cancelReason: string | null = null;
  /**
   * Watches for the run that is busy and going nowhere - every action succeeding, the page never
   * moving. Per-Executor and reset per task, like the failure counter it complements.
   */
  private readonly stall = new StallTracker();
  constructor(
    task: string,
    taskId: string,
    browserContext: BrowserContext,
    navigatorLLM: BaseChatModel,
    extraArgs?: Partial<ExecutorExtraArgs>,
  ) {
    // Resolved before the MessageManager because the manager needs the token budget and is built
    // first; AgentContext re-merges over the same defaults, so this is idempotent.
    const agentOptions: AgentOptions = { ...DEFAULT_AGENT_OPTIONS, ...(extraArgs?.agentOptions ?? {}) };

    // One value, two readers: the plan gate below reads `this.approvalMode`, the navigator's action
    // gate reads `context.options.approvalMode`. Reconciled here rather than left to the caller to
    // set twice, because two independently-set copies of the same policy are how a picker ends up
    // showing one thing while the agent does another. `generalSettings` wins when present since it
    // is what the user actually chose; agentOptions carries the fallback for callers without it.
    // Absent both, this lands on DEFAULT_AGENT_OPTIONS.approvalMode ('planner') — fail closed, so a
    // caller that forgets to pass settings gets a visible stall rather than silent ungated spending.
    this.approvalMode = extraArgs?.generalSettings?.approvalMode ?? agentOptions.approvalMode;
    agentOptions.approvalMode = this.approvalMode;

    const messageManager = new MessageManager(
      new MessageManagerSettings({
        maxInputTokens: agentOptions.maxInputTokens,
        // The window has to cover what the model writes back too, and the trimmer only sees
        // messages - so with maxInputTokens set to the model's full window, every request was over
        // by the size of the completion before a single message was counted.
        reservedTokens: OUTPUT_TOKEN_CAP,
      }),
    );

    const plannerLLM = extraArgs?.plannerLLM ?? navigatorLLM;
    const extractorLLM = extraArgs?.extractorLLM ?? navigatorLLM;
    const eventManager = new EventManager();
    const context = new AgentContext(taskId, browserContext, messageManager, eventManager, agentOptions);

    this.generalSettings = extraArgs?.generalSettings;
    this.modelPricing = extraArgs?.modelPricing ?? {};
    this.tasks.push(task);
    this.navigatorPrompt = new NavigatorPrompt(context.options.maxActionsPerStep);
    this.plannerPrompt = new PlannerPrompt();

    // Subtasks reuse the navigator's model and the parent's browser config, so they obey the same
    // firewall and timing rules as the main agent rather than quietly getting their own.
    const actionBuilder = new ActionBuilder(
      context,
      extractorLLM,
      {
        navigatorLLM,
        agentOptions: context.options,
        getBrowserConfig: () => browserContext.getConfig(),
        // subtasks spend on the parent's behalf, so their tokens belong in the parent's total
        usage: context.tokenUsage,
        // and they collect on the parent's behalf, so their rows belong in the parent's table
        dataset: context.dataset,
        provider: extraArgs?.providers?.navigator,
        // and they stop when the parent stops, rather than running out their step budget in tabs
        // nobody is watching
        getParentSignal: () => context.controller.signal,
      },
      // The name the caller configured, so the extractor's tokens land under the key the pricing
      // page is keyed by. Absent it, ActionBuilder falls back to whatever the adapter exposes.
      extraArgs?.extractorModelName,
    );
    const navigatorActionRegistry = new NavigatorActionRegistry(actionBuilder.buildDefaultActions());

    // Initialize agents with their respective prompts
    this.navigator = new NavigatorAgent(navigatorActionRegistry, {
      chatLLM: navigatorLLM,
      context: context,
      prompt: this.navigatorPrompt,
      provider: extraArgs?.providers?.navigator,
    });

    this.fastNavigator = extraArgs?.fastLLM
      ? new NavigatorAgent(navigatorActionRegistry, {
          chatLLM: extraArgs.fastLLM,
          context: context,
          prompt: this.navigatorPrompt,
          provider: extraArgs.providers?.fast,
        })
      : null;

    this.planner = new PlannerAgent({
      chatLLM: plannerLLM,
      context: context,
      prompt: this.plannerPrompt,
      provider: extraArgs?.providers?.planner,
    });

    this.context = context;
    // Initialize message history
    this.context.messageManager.initTaskMessages(this.navigatorPrompt.getSystemMessage(), task);
  }

  /**
   * Change how much the user wants to sign off on, mid-task.
   *
   * Both readers of the mode are updated together: this instance's plan gate, and
   * `context.options`, which the navigator re-reads before every action. That second write is what
   * makes the change take effect with no subscription and no restart — `AgentContext.options` is a
   * plain mutable object shared with both navigators.
   *
   * Tightening applies at the next gate. An action already dispatched to the page is not
   * retro-gated, and a plan already approved for the current task stays approved.
   *
   * Loosening deliberately does NOT resolve a gate the user is currently looking at: silently
   * auto-approving a pending purchase because a menu changed is the exact failure this feature
   * exists to prevent. The user answers the card in front of them; the new mode starts at the next
   * one. Do not "helpfully" resolve `planApprovalResolver` here.
   */
  setApprovalMode(mode: ApprovalMode): void {
    this.approvalMode = mode;
    this.context.options.approvalMode = mode;
  }

  subscribeExecutionEvents(callback: EventCallback): void {
    this.context.eventManager.subscribe(EventType.EXECUTION, callback);
  }

  clearExecutionEvents(): void {
    // Clear all execution event listeners
    this.context.eventManager.clearSubscribers(EventType.EXECUTION);
  }

  /**
   * Take a correction from the user while the task is still running.
   *
   * Deliberately not addFollowUpTask: that resets the plan gate, the final answer and the collected
   * table because a follow-up is a new intent. A steer is the opposite - the intent is unchanged,
   * and everything gathered so far stays. Nothing is applied here; the run picks it up at its next
   * step boundary.
   */
  steer(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.pendingSteers.push(trimmed);
    logger.info(`Steer queued: ${trimmed}`);
  }

  /**
   * Fold any queued corrections into the conversation, at a step boundary.
   *
   * @returns whether anything was applied, which the loop uses to force a re-plan
   */
  private applyPendingSteers(): boolean {
    if (this.pendingSteers.length === 0) return false;
    const steers = this.pendingSteers;
    this.pendingSteers = [];
    for (const steer of steers) {
      this.context.messageManager.addSteer(steer);
      this.context.emitEvent(Actors.SYSTEM, ExecutionState.STEP_OK, t('exec_steer_applied', [steer]));
    }
    return true;
  }

  addFollowUpTask(task: string): void {
    this.tasks.push(task);
    this.context.messageManager.addNewTask(task);
    // a follow-up is a new intent, so it needs its own approval, and it may be on a different site
    this.planApproved = false;
    this.memoriesInjected = false;
    // ...and it needs its own answer. The Executor is reused across follow-ups, and TASK_OK falls
    // back to `finalAnswer` whenever the planner returns an empty one - so leaving the previous
    // task's answer here makes the next task report a result it never produced.
    this.context.finalAnswer = null;
    // ...and its own table. The rows of the previous task were already delivered with its message;
    // carrying them forward would make the follow-up hand the user the same table a second time.
    this.context.dataset.clear();

    // need to reset previous action results that are not included in memory
    this.context.actionResults = this.context.actionResults.filter(result => result.includeInMemory);
  }

  /**
   * Check if task is complete based on planner output and handle completion
   */
  private checkTaskCompletion(planOutput: AgentOutput<PlannerOutput> | null): boolean {
    if (planOutput?.result?.done) {
      logger.info('✅ Planner confirms task completion');
      if (planOutput.result.final_answer) {
        this.context.finalAnswer = planOutput.result.final_answer;
      }
      return true;
    }
    return false;
  }

  /**
   * Execute the task
   *
   * @returns {Promise<void>}
   */
  async execute(): Promise<void> {
    logger.info(`🚀 Executing task: ${this.tasks[this.tasks.length - 1]}`);
    const context = this.context;
    // Clear everything the previous run latched. This used to reset only the step counter, so a
    // second task on the same Executor inherited its predecessor's failure count, cancellation and
    // abort signal.
    context.resetForTask();
    this.stall.reset();
    // a follow-up on this Executor must not inherit the reason the previous run was cancelled
    this.cancelReason = null;
    // Per-Executor rather than per-context, but per-task all the same: the brake is latched so it
    // asks once, and leaving it latched meant a follow-up spent with no ceiling at all.
    this.budgetPauseIssued = false;
    const allowedMaxSteps = this.context.options.maxSteps;

    let tabGroupStatus = TabGroupStatus.Paused;

    try {
      this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_START, this.context.taskId);
      // Announce the agent on the page before it touches anything: the whole point of the banner is
      // that a tab typing on its own is never a surprise. The stop button on it reaches this
      // Executor, which is the same cancel the side panel's button calls.
      this.context.browserContext.setActivityStopHandler(() => {
        void this.cancel();
      });
      void this.context.browserContext.showActivity('').catch(() => undefined);
      // Label the group with the task the user typed, not the generated task id, which means
      // nothing to them. Follow-up tasks re-label the group they are continuing.
      this.context.browserContext.startTaskGroup(this.tasks[this.tasks.length - 1]);

      await this.injectMemories();

      // Track task start
      void analytics.trackTaskStart(this.context.taskId);

      let step = 0;
      let latestPlanOutput: AgentOutput<PlannerOutput> | null = null;
      let navigatorDone = false;
      // the first step after planning carries the most ambiguity, so it is never routed to the cheap model
      let justPlanned = false;

      for (step = 0; step < allowedMaxSteps; step++) {
        context.stepInfo = {
          stepNumber: context.nSteps,
          maxSteps: context.options.maxSteps,
        };

        logger.info(`🔄 Step ${step + 1} / ${allowedMaxSteps}`);
        // Before shouldStop, whose pause-wait is what actually parks the loop when this fires.
        this.checkBudget();
        if (await this.shouldStop()) {
          break;
        }

        // After shouldStop, so a correction typed during a pause lands on the step that actually
        // runs rather than being spent on one the user then cancelled.
        const steered = this.applyPendingSteers();

        // Run planner periodically for guidance, and always right after a correction: next_steps is
        // where the old direction is written down, so leaving it stale means the navigator reads
        // the correction and the plan contradicting it in the same breath. Fast mode keeps the
        // first plan - it aims the whole run - and drops the periodic re-plans between it and the
        // finish: those model calls are most of what "fast" saves.
        const planningDue =
          context.nSteps % context.options.planningInterval === 0 &&
          (context.nSteps === 0 || !skipsPeriodicPlanning(this.approvalMode));
        if (this.planner && (steered || planningDue || navigatorDone)) {
          navigatorDone = false;
          justPlanned = true;
          latestPlanOutput = await this.runPlanner();

          // Check if task is complete after planner run
          if (this.checkTaskCompletion(latestPlanOutput)) {
            break;
          }

          // Human-in-the-loop: show the plan and wait for approval before any action runs
          if (!(await this.ensurePlanApproved(latestPlanOutput))) {
            break;
          }
        }

        // Execute navigator
        navigatorDone = await this.navigate(justPlanned);
        justPlanned = false;

        // Read from the parse the model was shown this step, so noticing a stall costs no extra
        // page read. Skipped once the navigator says it is done: the last step of a successful task
        // legitimately leaves the page exactly as it found it.
        if (!navigatorDone && !(await this.handleStall())) {
          break;
        }

        // If navigator indicates completion, the next periodic planner run will validate it
        if (navigatorDone) {
          logger.info('🔄 Navigator indicates completion - will be validated by next planner run');
        }
      }

      this.emitDataset();

      // Determine task completion status
      const isCompleted = latestPlanOutput?.result?.done === true;

      if (isCompleted) {
        // Emit final answer if available, otherwise use task ID
        const finalMessage = this.context.finalAnswer || this.context.taskId;
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_OK, finalMessage);
        tabGroupStatus = TabGroupStatus.Done;

        // Track task completion
        void analytics.trackTaskComplete(this.context.taskId);
      } else if (step >= allowedMaxSteps) {
        logger.error('❌ Task failed: Max steps reached');
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, t('exec_errors_maxStepsReached'));
        tabGroupStatus = TabGroupStatus.Failed;

        // Track task failure with specific error category
        const maxStepsError = new MaxStepsReachedError(t('exec_errors_maxStepsReached'));
        const errorCategory = analytics.categorizeError(maxStepsError);
        void analytics.trackTaskFailed(this.context.taskId, errorCategory);
      } else if (this.context.stopped) {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, this.cancelReason ?? t('exec_task_cancel'));
        tabGroupStatus = TabGroupStatus.Cancelled;

        // Track task cancellation
        void analytics.trackTaskCancelled(this.context.taskId);
      } else {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_PAUSE, t('exec_task_pause'));
        tabGroupStatus = TabGroupStatus.Paused;
        // Note: We don't track pause as it's not a final state
      }
    } catch (error) {
      // Rows collected before the failure are still rows the user asked for.
      this.emitDataset();
      if (error instanceof RequestCancelledError) {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, this.cancelReason ?? t('exec_task_cancel'));
        tabGroupStatus = TabGroupStatus.Cancelled;

        // Track task cancellation
        void analytics.trackTaskCancelled(this.context.taskId);
      } else {
        tabGroupStatus = TabGroupStatus.Failed;
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, t('exec_task_fail', [errorMessage]));

        // Track task failure with detailed error categorization
        const errorCategory = analytics.categorizeError(error instanceof Error ? error : errorMessage);
        void analytics.trackTaskFailed(this.context.taskId, errorCategory);
      }
    } finally {
      // Record which model names the providers actually answered under, so the pricing page can
      // offer a row for each of them. Without this a name that differs from the assigned one has no
      // row, no price, and contributes nothing to the dollar total while spending real money.
      const spentUnder = this.context.tokenUsage.snapshot().byModel.map(entry => entry.model);
      void observedModelsStore.record(spentUnder).catch(() => undefined);

      // The run is over however it ended, so the page stops claiming otherwise. Before the tab-group
      // stamp, because that one can await a Chrome call that outlives the user's attention.
      await this.context.browserContext.hideActivity();
      this.context.browserContext.setActivityStopHandler(null);

      // Stamp the outcome on the tab-group chip whichever way execute() ended, including the throw
      // paths above, so a group is never left reading "in progress" after the run is over.
      await this.context.browserContext.finishTaskGroup(tabGroupStatus);

      if (import.meta.env.DEV) {
        logger.debug('Executor history', JSON.stringify(this.context.history, null, 2));
      }
      // store the history only if replay is enabled
      if (this.generalSettings?.replayHistoricalTasks) {
        const historyString = JSON.stringify(this.context.history);
        logger.info(`Executor history size: ${historyString.length}`);
        await chatHistoryStore.storeAgentStepHistory(this.context.taskId, this.tasks[0], historyString);
      } else {
        logger.info('Replay historical tasks is disabled, skipping history storage');
      }
    }
  }

  /**
   * Load what the agent remembers about this user into the task's context.
   *
   * Recall is scoped to the site the task starts on, so a store that grows over time does not keep
   * inflating the prompt of every unrelated task. Failures here are never fatal: a task that cannot
   * read memory should still run, just without personalisation.
   */
  private async injectMemories(): Promise<void> {
    if (this.memoriesInjected) return;
    this.memoriesInjected = true;

    try {
      let host = '';
      try {
        const page = await this.context.browserContext.getCurrentPage();
        host = new URL(page.url()).host;
      } catch {
        // no parseable current page, so only global memories apply
      }

      const memories = await memoryStore.recall(host);
      if (memories.length === 0) return;

      this.context.messageManager.addMemories(memories.map(memory => memory.content));
      await memoryStore.markUsed(memories.map(memory => memory.id));
      logger.info(`🧠 Loaded ${memories.length} remembered preference(s)`);
    } catch (error) {
      logger.error(`Failed to load memories, continuing without them: ${error}`);
    }
  }

  /**
   * Human-in-the-loop gate. Presents the plan to the user and blocks until they approve or
   * reject it. Only the first plan of each user task is gated — once approved, the periodic
   * re-planning that follows runs without interrupting the user again.
   *
   * @returns true if execution may continue, false if the user rejected the plan
   */
  private async ensurePlanApproved(planOutput: AgentOutput<PlannerOutput> | null): Promise<boolean> {
    // Unattended runs pre-approved their plan when the user scheduled the task; parking on a
    // review card nobody will answer would just hang the run. The sensitive-action gate is the one
    // that stays armed for them (auto-decline), so "pre-approved" never extends to spending.
    if (this.context.options.unattended) return true;
    // Read from the mutable field, not from the settings snapshot: the user may have moved the
    // picker since this Executor was built, and a follow-up task runs on this same instance.
    if (!requiresPlanApproval(this.approvalMode)) return true;
    if (this.planApproved) return true;
    // nothing actionable to review
    if (!planOutput?.result || planOutput.result.web_task === false) return true;

    const plan = planOutput.result;
    this.context.emitEvent(Actors.SYSTEM, ExecutionState.PLAN_REVIEW, plan.next_steps, {
      observation: plan.observation,
      nextSteps: plan.next_steps,
      challenges: plan.challenges,
      reasoning: plan.reasoning,
    });

    const approved = await new Promise<boolean>(resolve => {
      this.planApprovalResolver = resolve;
    });
    this.planApprovalResolver = null;

    if (!approved) {
      logger.info('🚫 Plan rejected by user');
      this.context.emitEvent(Actors.SYSTEM, ExecutionState.PLAN_REJECTED, t('exec_plan_rejected'));
      await this.context.stop();
      return false;
    }

    logger.info('👍 Plan approved by user');
    this.planApproved = true;
    this.context.emitEvent(Actors.SYSTEM, ExecutionState.PLAN_APPROVED, t('exec_plan_approved'));
    return true;
  }

  /** Resolve a pending sensitive-action gate. No-op if the agent is not waiting on one. */
  async respondToActionConfirmation(approved: boolean): Promise<void> {
    this.context.resolveActionConfirmation(approved);
  }

  /** Resolve a pending human-handoff gate. No-op if the agent is not waiting on one. */
  async respondToHandoff(completed: boolean): Promise<void> {
    this.context.resolveHandoff(completed);
  }

  /** Whether the agent is currently parked waiting for the user to finish a handoff. */
  isAwaitingHandoff(): boolean {
    return this.context.isAwaitingHandoff();
  }

  /** Whether the agent is currently blocked waiting for the user to confirm an action. */
  isAwaitingActionConfirmation(): boolean {
    return this.context.isAwaitingActionConfirmation();
  }

  /** Resolve a pending plan-approval gate. No-op if the agent is not waiting on one. */
  async respondToPlanReview(approved: boolean): Promise<void> {
    this.planApprovalResolver?.(approved);
  }

  /** Whether the agent is currently blocked waiting for the user to review a plan. */
  isAwaitingPlanReview(): boolean {
    return this.planApprovalResolver !== null;
  }

  /**
   * Helper method to run planner and store its output
   */
  private async runPlanner(): Promise<AgentOutput<PlannerOutput> | null> {
    const context = this.context;
    try {
      // Add current browser state to memory
      let positionForPlan = 0;
      if (this.tasks.length > 1 || this.context.nSteps > 0) {
        await this.navigator.addStateMessageToMemory();
        positionForPlan = this.context.messageManager.length() - 1;
      } else {
        positionForPlan = this.context.messageManager.length();
      }

      // Execute planner
      const planOutput = await this.planner.execute();
      if (planOutput.result) {
        this.context.messageManager.addPlan(JSON.stringify(planOutput.result), positionForPlan);
      }
      return planOutput;
    } catch (error) {
      logger.error(`Failed to execute planner: ${error}`);
      if (
        error instanceof ChatModelAuthError ||
        error instanceof ChatModelBadRequestError ||
        error instanceof ChatModelForbiddenError ||
        error instanceof URLNotAllowedError ||
        error instanceof RequestCancelledError ||
        error instanceof ExtensionConflictError ||
        error instanceof MaxTokensExceededError
      ) {
        throw error;
      }
      context.consecutiveFailures++;
      logger.error(`Failed to execute planner: ${error}`);
      if (context.consecutiveFailures >= context.options.maxFailures) {
        throw new MaxFailuresReachedError(t('exec_errors_maxFailuresReached'));
      }
      return null;
    }
  }

  /**
   * Choose which navigator runs this step. Falls back to the primary navigator whenever no cheap
   * model is configured, so a missing Fast model degrades to the previous behaviour rather than an
   * error.
   */
  private async pickNavigator(justPlanned: boolean): Promise<NavigatorAgent> {
    if (!this.fastNavigator) return this.navigator;

    const context = this.context;
    let interactiveElementCount = 0;
    let visionFallback = false;
    try {
      const cachedState = await context.browserContext.getCachedState();
      interactiveElementCount = cachedState?.selectorMap.size ?? 0;
      visionFallback = cachedState?.domGroundingFailed ?? false;
    } catch (error) {
      // without a readable state we cannot judge the page, so do not economise on this step
      logger.debug(`Could not read cached state for routing: ${error}`);
      return this.navigator;
    }

    const decision = routeStep({
      consecutiveFailures: context.consecutiveFailures,
      lastStepErrored: context.actionResults.some(result => Boolean(result.error)),
      interactiveElementCount,
      usesVision: context.options.useVision || visionFallback,
      startingNewPlan: justPlanned,
    });

    logger.info(`🔀 Routed step to ${decision.tier} model: ${decision.reason}`);
    return decision.tier === ModelTier.FAST ? this.fastNavigator : this.navigator;
  }

  /**
   * Fold this step's ground into the stall tracker and act on the verdict.
   *
   * @returns whether the run should continue
   */
  private async handleStall(): Promise<boolean> {
    const context = this.context;
    const state = context.stepState;
    if (!state) return true;

    const elements = Array.from(state.selectorMap.values());
    const ground: StepGround = {
      url: state.url,
      elementCount: elements.length,
      // Null when the marking had no baseline this step, which the tracker reads as "unknown",
      // never as "nothing new".
      newElementCount: elements.some(element => element.isNew === null)
        ? null
        : elements.filter(element => element.isNew).length,
      scrollY: state.scrollY,
    };

    const verdict = this.stall.record(ground);
    // Read by the state-message builder, which attaches a screenshot while this is non-zero even
    // with vision off. A page the DOM under-describes is the most common reason a run stalls, and
    // that is exactly the case a screenshot answers.
    context.stalledSteps = this.stall.steps;
    if (verdict === 'continue') return true;

    if (verdict === 'abort') {
      logger.error(`Ending the run: ${this.stall.steps} steps changed nothing on the page`);
      this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, t('exec_stall_abort'));
      return false;
    }

    // Say it in the conversation, not just the log: the model is the one that has to change course,
    // and it never sees the log. The screenshot that comes with the next read is usually what was
    // missing - a page whose DOM under-describes it is the most common reason for this.
    logger.warning(`${this.stall.steps} steps have changed nothing; nudging the navigator`);
    this.context.messageManager.addRuntimeNote(t('exec_stall_nudge', [String(this.stall.steps)]));
    this.context.emitEvent(Actors.SYSTEM, ExecutionState.STEP_OK, t('exec_stall_notice'));
    return true;
  }

  private async navigate(justPlanned = false): Promise<boolean> {
    const context = this.context;
    try {
      // Get and execute navigation action
      // check if the task is paused or stopped
      if (context.paused || context.stopped) {
        return false;
      }
      const navigator = await this.pickNavigator(justPlanned);
      const navOutput = await navigator.execute();
      // check if the task is paused or stopped
      if (context.paused || context.stopped) {
        return false;
      }
      context.nSteps++;
      if (navOutput.error) {
        throw new Error(navOutput.error);
      }
      context.consecutiveFailures = 0;
      if (navOutput.result?.done) {
        return true;
      }
    } catch (error) {
      logger.error(`Failed to execute step: ${error}`);
      if (
        error instanceof ChatModelAuthError ||
        error instanceof ChatModelBadRequestError ||
        error instanceof ChatModelForbiddenError ||
        error instanceof URLNotAllowedError ||
        error instanceof RequestCancelledError ||
        error instanceof ExtensionConflictError ||
        error instanceof MaxTokensExceededError
      ) {
        throw error;
      }
      context.consecutiveFailures++;
      logger.error(`Failed to execute step: ${error}`);
      if (context.consecutiveFailures >= context.options.maxFailures) {
        throw new MaxFailuresReachedError(t('exec_errors_maxFailuresReached'));
      }
    }
    return false;
  }

  /**
   * The budget brake: pause the task, once, when its estimated spend reaches the user's cap.
   *
   * A pause and not a stop — the answer may be two steps away, and killing the task at $0.51 of a
   * $0.50 budget helps nobody. The panel shows the numbers with resume/cancel keys; resuming is an
   * explicit decision to keep spending, so the latch keeps the brake released for the rest of the
   * run. Only models the user priced count toward the estimate (an unpriced model costs "unknown",
   * not zero), and with no budget set or no prices entered this is inert.
   */
  /**
   * Hand the collected rows to the panel, if there are any.
   *
   * Called from every path that ends a run rather than from the terminal emits themselves: the
   * panel attaches this to the single message a task leaves behind, and a message is finalised by
   * the terminal event, so arriving after one would be arriving too late.
   */
  private emitDataset(): void {
    if (this.context.dataset.isEmpty()) return;
    const snapshot = this.context.dataset.snapshot();
    this.context.emitEvent(
      Actors.SYSTEM,
      ExecutionState.TASK_DATASET,
      t('exec_dataset_collected', [String(snapshot.rows.length)]),
      snapshot,
    );
  }

  private checkBudget(): void {
    if (this.budgetPauseIssued) return;
    const budgetUsd = this.generalSettings?.maxCostUsd ?? 0;
    if (!(budgetUsd > 0)) return;

    const snapshot = this.context.tokenUsage.snapshot();
    const { usd, unpricedModels } = estimateCostUsd(snapshot.byModel, this.modelPricing);
    if (usd < budgetUsd) return;

    this.budgetPauseIssued = true;
    this.context.emitEvent(
      Actors.SYSTEM,
      ExecutionState.TASK_PAUSE,
      t('exec_budget_reached', [usd.toFixed(2), budgetUsd.toFixed(2)]),
      { kind: 'budget', spentUsd: usd, budgetUsd, unpricedModels },
    );
    this.context.pause();
  }

  private async shouldStop(): Promise<boolean> {
    if (this.context.stopped) {
      logger.info('Agent stopped');
      return true;
    }

    while (this.context.paused) {
      await new Promise(resolve => setTimeout(resolve, 200));
      if (this.context.stopped) {
        return true;
      }
    }

    if (this.context.consecutiveFailures >= this.context.options.maxFailures) {
      logger.error(`Stopping due to ${this.context.options.maxFailures} consecutive failures`);
      return true;
    }

    return false;
  }

  async cancel(reason?: string): Promise<void> {
    this.cancelReason = reason ?? null;
    // release the plan-approval gate first, otherwise execute() stays blocked on it forever
    this.planApprovalResolver?.(false);
    this.context.stop();
  }

  /**
   * Undo the most recent step: navigate the page back and forget the step ever happened, so the
   * agent re-plans from the restored state instead of building on an action the user rejected.
   * Only safe while the agent is paused or idle — the caller is responsible for that.
   */
  async undoLastStep(): Promise<void> {
    const context = this.context;

    const page = await context.browserContext.getCurrentPage();
    await page.goBack();

    // drop the step from the agent's memory so it does not treat it as done
    context.messageManager.removeLastStateMessage();
    context.history.history.pop();
    context.actionResults = [];
    context.stateMessageAdded = false;
    if (context.nSteps > 0) context.nSteps--;

    // the plan that produced the undone step is no longer trusted — re-plan and re-approve
    this.planApproved = false;

    context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_PAUSE, t('exec_undo_ok'));
    logger.info('↩️ Last step undone by user');
  }

  async resume(): Promise<void> {
    this.context.resume();
  }

  async pause(): Promise<void> {
    this.context.pause();
  }

  /**
   * Whether the agent loop is currently parked. Callers that pause the agent to do something to
   * the page underneath it need this to know whether releasing it afterwards is theirs to do, or
   * whether the user had already paused it and expects it to stay that way.
   */
  isPaused(): boolean {
    return this.context.paused;
  }

  async cleanup(): Promise<void> {
    try {
      await this.context.browserContext.cleanup();
    } catch (error) {
      logger.error(`Failed to cleanup browser context: ${error}`);
    }
  }

  async getCurrentTaskId(): Promise<string> {
    return this.context.taskId;
  }

  /**
   * Replays a saved history of actions with error handling and retry logic.
   *
   * @param history - The history to replay
   * @param maxRetries - Maximum number of retries per action
   * @param skipFailures - Whether to skip failed actions or stop execution
   * @param delayBetweenActions - Delay between actions in seconds
   * @returns List of action results
   */
  async replayHistory(
    sessionId: string,
    maxRetries = 3,
    skipFailures = true,
    delayBetweenActions = 2.0,
  ): Promise<ActionResult[]> {
    const results: ActionResult[] = [];
    const replayLogger = createLogger('Executor:replayHistory');

    logger.info('replay task', this.tasks[0]);
    // A replay collects its own rows: the recorded extract_structured steps run for real against
    // today's pages. Carrying the previous run's table in would hand the user a mix of the two.
    this.context.dataset.clear();

    try {
      const historyFromStorage = await chatHistoryStore.loadAgentStepHistory(sessionId);
      if (!historyFromStorage) {
        throw new Error(t('exec_replay_historyNotFound'));
      }

      const history = JSON.parse(historyFromStorage.history) as AgentStepHistory;
      if (history.history.length === 0) {
        throw new Error(t('exec_replay_historyEmpty'));
      }
      logger.debug(`🔄 Replaying history: ${JSON.stringify(history, null, 2)}`);
      this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_START, this.context.taskId);

      for (let i = 0; i < history.history.length; i++) {
        const historyItem = history.history[i];

        // Check if execution should stop
        if (this.context.stopped) {
          replayLogger.info('Replay stopped by user');
          break;
        }

        // Execute the history step with enhanced method that handles all the logic
        const stepResults = await this.navigator.executeHistoryStep(
          historyItem,
          i,
          history.history.length,
          maxRetries,
          delayBetweenActions * 1000,
          skipFailures,
        );

        results.push(...stepResults);

        // If stopped during execution, break the loop
        if (this.context.stopped) {
          break;
        }
      }

      this.emitDataset();
      if (this.context.stopped) {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, t('exec_replay_cancel'));
      } else {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_OK, t('exec_replay_ok'));
      }
    } catch (error) {
      // Same as the live path: rows collected before the failure are still rows the user asked for.
      this.emitDataset();
      const errorMessage = error instanceof Error ? error.message : String(error);
      replayLogger.error(`Replay failed: ${errorMessage}`);
      this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, t('exec_replay_fail', [errorMessage]));
    }

    return results;
  }
}
