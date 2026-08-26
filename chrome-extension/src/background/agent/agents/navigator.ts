import { z } from 'zod';
import { t } from '@extension/i18n';
import { createLogger } from '@src/background/log';
import { type BaseMessage, HumanMessage } from '@langchain/core/messages';
import { calcBranchPathHashSet, type DOMElementNode } from '@src/background/browser/dom/views';
import { type BrowserState, BrowserStateHistory, URLNotAllowedError } from '@src/background/browser/views';
import { convertZodToJsonSchema, repairJsonString } from '@src/background/utils';
import { HistoryTreeProcessor } from '@src/background/browser/dom/history/service';
import { type DOMHistoryElement } from '@src/background/browser/dom/history/view';
import { AgentStepRecord } from '../history';
import { classifyManualAction, classifySensitiveAction } from '../actions/sensitivity';
import { Actors, ExecutionState } from '../event/types';
import { agentBrainSchema } from '../types';
import { buildDynamicActionSchema } from '../actions/builder';
import { ActionResult, type AgentOutput } from '../types';
import {
  ChatModelAuthError,
  ChatModelBadRequestError,
  ChatModelForbiddenError,
  EXTENSION_CONFLICT_ERROR_MESSAGE,
  ExtensionConflictError,
  isAbortedError,
  isAuthenticationError,
  isBadRequestError,
  isExtensionConflictError,
  isForbiddenError,
  ResponseParseError,
  LLM_FORBIDDEN_ERROR_MESSAGE,
  RequestCancelledError,
  MaxTokensExceededError,
  StaleElementError,
} from './errors';
import { BaseAgent, type BaseAgentOptions, type ExtraAgentOptions } from './base';
import type { Action } from '../actions/builder';

const logger = createLogger('NavigatorAgent');

interface ParsedModelOutput {
  current_state?: {
    next_goal?: string;
  };
  action?: (Record<string, unknown> | null)[] | null;
}

export class NavigatorActionRegistry {
  private actions: Record<string, Action> = {};

  constructor(actions: Action[]) {
    for (const action of actions) {
      this.registerAction(action);
    }
  }

  registerAction(action: Action): void {
    this.actions[action.name()] = action;
  }

  unregisterAction(name: string): void {
    delete this.actions[name];
  }

  getAction(name: string): Action | undefined {
    return this.actions[name];
  }

  setupModelOutputSchema(): z.ZodType {
    const actionSchema = buildDynamicActionSchema(Object.values(this.actions));
    return z.object({
      current_state: agentBrainSchema,
      action: z.array(actionSchema),
    });
  }
}

export interface NavigatorResult {
  done: boolean;
}

/**
 * Whether every member of `subset` is in `superset`.
 *
 * Hand-rolled rather than `Set.prototype.isSubsetOf`: that method only landed in Chrome 122 and
 * Node 22, and this repo's .nvmrc pins 22.12.0 with no .npmrc to enforce it, so a contributor on
 * Node 20 hits a TypeError here the moment anything exercises this path under Vitest.
 */
function isSubsetOf<T>(subset: Set<T>, superset: Set<T>): boolean {
  for (const value of subset) {
    if (!superset.has(value)) return false;
  }
  return true;
}

export class NavigatorAgent extends BaseAgent<z.ZodType, NavigatorResult> {
  private actionRegistry: NavigatorActionRegistry;
  private jsonSchema: Record<string, unknown>;
  private _stateHistory: BrowserStateHistory | null = null;

  constructor(
    actionRegistry: NavigatorActionRegistry,
    options: BaseAgentOptions,
    extraOptions?: Partial<ExtraAgentOptions>,
  ) {
    super(actionRegistry.setupModelOutputSchema(), options, { ...extraOptions, id: 'navigator' });

    this.actionRegistry = actionRegistry;

    // The zod object is too complex to be used directly, so we need to convert it to json schema first for the model to use
    this.jsonSchema = convertZodToJsonSchema(this.modelOutputSchema, 'NavigatorAgentOutput', true);
    // The schema goes out with every navigator call - as `response_format`, or as the tool
    // definition after the tool-calling fallback - and it is nowhere in the message history, so the
    // trimmer cannot see it. It is ~13,000 characters with the default action set.
    this.context.messageManager.reserveTokensForPayload(JSON.stringify(this.jsonSchema));
  }

  protected override get eventActor(): Actors {
    return Actors.NAVIGATOR;
  }

  async invoke(inputMessages: BaseMessage[]): Promise<this['ModelOutput']> {
    // Use structured output
    if (this.withStructuredOutput) {
      let response = undefined;
      try {
        response = await this.invokeStructured(this.jsonSchema, inputMessages);
        // the navigator burns most of the tokens and never reaches the base class's structured
        // branch, so without this the headline number would miss almost all of the spend
        this.recordUsage(response.raw);

        if (response.parsed) {
          return response.parsed;
        }
      } catch (error) {
        if (isAbortedError(error)) {
          throw error;
        }

        // Try to extract JSON from markdown code blocks if parsing failed
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (
          errorMessage.includes('is not valid JSON') &&
          response?.raw?.content &&
          typeof response.raw.content === 'string'
        ) {
          const parsed = this.manuallyParseResponse(response.raw.content);
          if (parsed) {
            return parsed;
          }
        }
        throw new Error(`Failed to invoke ${this.modelName} with structured output: \n${errorMessage}`);
      }

      // Use type assertion to access the properties
      const rawResponse = response.raw as BaseMessage & {
        tool_calls?: Array<{
          args: {
            currentState: typeof agentBrainSchema._type;
            action: z.infer<ReturnType<typeof buildDynamicActionSchema>>;
          };
        }>;
      };

      // sometimes LLM returns an empty content, but with one or more tool calls, so we need to check the tool calls
      if (rawResponse.tool_calls && rawResponse.tool_calls.length > 0) {
        logger.debug('Navigator structuredLlm tool call with empty content', rawResponse.tool_calls);
        // only use the first tool call
        const toolCall = rawResponse.tool_calls[0];
        return {
          current_state: toolCall.args.currentState,
          action: [...toolCall.args.action],
        };
      }
      throw new ResponseParseError('Could not parse navigator response');
    }

    // Fallback to parent class manual JSON extraction for models without structured output support
    return super.invoke(inputMessages);
  }

  async execute(): Promise<AgentOutput<NavigatorResult>> {
    const agentOutput: AgentOutput<NavigatorResult> = {
      id: this.id,
    };

    let cancelled = false;
    let modelOutputString: string | null = null;
    let browserStateHistory: BrowserStateHistory | null = null;
    let actionResults: ActionResult[] = [];

    try {
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.STEP_START, 'Navigating...');

      const messageManager = this.context.messageManager;
      // add the browser state message
      await this.addStateMessageToMemory();
      const currentState = await this.context.browserContext.getCachedState();
      browserStateHistory = new BrowserStateHistory(currentState);

      // check if the task is paused or stopped
      if (this.context.paused || this.context.stopped) {
        cancelled = true;
        return agentOutput;
      }

      // call the model to get the actions to take
      const inputMessages = messageManager.getMessages();
      // logger.info('Navigator input message', inputMessages[inputMessages.length - 1]);

      const modelOutput = await this.invoke(inputMessages);

      // check if the task is paused or stopped
      if (this.context.paused || this.context.stopped) {
        cancelled = true;
        return agentOutput;
      }

      const actions = this.fixActions(modelOutput);
      modelOutput.action = actions;
      modelOutputString = JSON.stringify(modelOutput);

      // remove the last state message from memory before adding the model output
      this.removeLastStateMessageFromMemory();
      this.addModelOutputToMemory(modelOutput);

      // take the actions
      actionResults = await this.doMultiAction(actions);
      // logger.info('Action results', JSON.stringify(actionResults, null, 2));

      this.context.actionResults = actionResults;

      // check if the task is paused or stopped
      if (this.context.paused || this.context.stopped) {
        cancelled = true;
        return agentOutput;
      }
      // emit event
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.STEP_OK, 'Navigation done');
      let done = false;
      if (actionResults.length > 0 && actionResults[actionResults.length - 1].isDone) {
        done = true;
      }
      agentOutput.result = { done };
      return agentOutput;
    } catch (error) {
      this.removeLastStateMessageFromMemory();
      const errorMessage = error instanceof Error ? error.message : String(error);
      // Check if this is an authentication error
      if (isAuthenticationError(error)) {
        throw new ChatModelAuthError(errorMessage, error);
      } else if (isBadRequestError(error)) {
        throw new ChatModelBadRequestError(errorMessage, error);
      } else if (isAbortedError(error)) {
        throw new RequestCancelledError(errorMessage);
      } else if (isExtensionConflictError(error)) {
        throw new ExtensionConflictError(EXTENSION_CONFLICT_ERROR_MESSAGE, error);
      } else if (isForbiddenError(error)) {
        throw new ChatModelForbiddenError(LLM_FORBIDDEN_ERROR_MESSAGE, error);
      } else if (error instanceof MaxTokensExceededError || error instanceof URLNotAllowedError) {
        // trimming that cannot converge is a configuration problem, not a step that will succeed on
        // retry, so it propagates instead of burning the failure budget
        throw error;
      }

      const errorString = `Navigation failed: ${errorMessage}`;
      logger.error(errorString);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.STEP_FAIL, errorString);
      agentOutput.error = errorMessage;
      return agentOutput;
    } finally {
      // the step's state describes a page that is now one step old; nothing outside the step may use it
      this.context.stepState = null;
      // if the task is cancelled, remove the last state message from memory and emit event
      if (cancelled) {
        this.removeLastStateMessageFromMemory();
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.STEP_CANCEL, 'Navigation cancelled');
      }
      if (browserStateHistory) {
        // Create a copy of actionResults to store in history
        const actionResultsCopy = actionResults.map(result => {
          return new ActionResult({
            isDone: result.isDone,
            success: result.success,
            extractedContent: result.extractedContent,
            error: result.error,
            includeInMemory: result.includeInMemory,
            interactedElement: result.interactedElement,
          });
        });

        const history = new AgentStepRecord(modelOutputString, actionResultsCopy, browserStateHistory);
        this.context.history.history.push(history);

        // logger.info('All history', JSON.stringify(this.context.history, null, 2));
      }
    }
  }

  /**
   * Add the state message to the memory
   */
  public async addStateMessageToMemory() {
    if (this.context.stateMessageAdded) {
      return;
    }

    const messageManager = this.context.messageManager;
    // Handle results that should be included in memory
    if (this.context.actionResults.length > 0) {
      let index = 0;
      for (const r of this.context.actionResults) {
        if (r.includeInMemory) {
          if (r.extractedContent) {
            const msg = new HumanMessage(`Action result: ${r.extractedContent}`);
            // logger.info('Adding action result to memory', msg.content);
            messageManager.addMessageWithTokens(msg);
          }
          if (r.error) {
            // Get error text and convert to string
            const errorText = r.error.toString().trim();

            // Get only the last line of the error
            const lastLine = errorText.split('\n').pop() || '';

            const msg = new HumanMessage(`Action error: ${lastLine}`);
            logger.info('Adding action error to memory', msg.content);
            messageManager.addMessageWithTokens(msg);
          }
          // reset this action result to empty, we dont want to add it again in the state message
          // NOTE: in python version, all action results are reset to empty, but in ts version, only those included in memory are reset to empty
          this.context.actionResults[index] = new ActionResult();
        }
        index++;
      }
    }

    const state = await this.prompt.getUserMessage(this.context);
    messageManager.addStateMessage(state);
    // the page description is the largest thing the history ever holds, so bound the history here,
    // at the moment it peaks, rather than inside getMessages() where a debug read would mutate it
    messageManager.cutMessages();
    this.context.stateMessageAdded = true;
  }

  /**
   * Remove the last state message from the memory
   */
  protected async removeLastStateMessageFromMemory() {
    if (!this.context.stateMessageAdded) return;
    const messageManager = this.context.messageManager;
    messageManager.removeLastStateMessage();
    this.context.stateMessageAdded = false;
  }

  private async addModelOutputToMemory(modelOutput: this['ModelOutput']) {
    const messageManager = this.context.messageManager;
    messageManager.addModelOutput(modelOutput);
  }

  /**
   * Fix the actions to be an array of objects, sometimes the action is a string or an object
   * @param response
   * @returns
   */
  private fixActions(response: this['ModelOutput']): Record<string, unknown>[] {
    let actions: Record<string, unknown>[] = [];
    if (Array.isArray(response.action)) {
      // if the item is null, skip it
      actions = response.action.filter((item: unknown) => item !== null);
      if (actions.length === 0) {
        logger.warning('No valid actions found', response.action);
      }
    } else if (typeof response.action === 'string') {
      try {
        logger.warning('Unexpected action format', response.action);
        // First try to parse the action string directly
        actions = JSON.parse(response.action);
      } catch (parseError) {
        try {
          // If direct parsing fails, try to fix the JSON first
          const fixedAction = repairJsonString(response.action);
          logger.info('Fixed action string', fixedAction);
          actions = JSON.parse(fixedAction);
        } catch (error) {
          logger.error('Invalid action format even after repair attempt', response.action);
          throw new Error('Invalid action output format');
        }
      }
    } else {
      // if the action is neither an array nor a string, it should be an object
      actions = [response.action];
    }
    return actions;
  }

  /**
   * Gate a single action behind the user's explicit approval when the current mode calls for it.
   *
   * The check reads the element the agent already picked rather than the model's own account of what
   * it is doing, so a page that talks the model into a purchase still has to get past the user.
   *
   * The mode is read from `context.options` at action time, not captured at construction, which is
   * what lets {@link Executor.setApprovalMode} change it in the middle of a running task.
   *
   * @returns an ActionResult to record when the user declined, or null if the action may proceed
   */
  private async confirmBeforeAction(
    actionName: string,
    actionArgs: unknown,
    element: DOMElementNode | undefined,
  ): Promise<ActionResult | null> {
    const mode = this.context.options.approvalMode;
    if (mode === 'auto') return null;

    // Sensitive classification runs first even in manual mode, so a purchase still shows the
    // purchase reason and its specific copy rather than a generic "you asked to confirm
    // everything". The manual classifier only fills the gap the sensitivity rules left.
    const request =
      classifySensitiveAction(actionName, actionArgs, element) ??
      (mode === 'manual' ? classifyManualAction(actionName, element) : null);
    if (!request) return null;

    const intent = (actionArgs as { intent?: string })?.intent ?? actionName;
    const page = await this.context.browserContext.getCurrentPage();
    const approved = await this.context.requestActionConfirmation({
      kind: request.kind,
      description: intent,
      // falls back to the element's own label so a routine confirmation still says what it acts on
      target: request.target || element?.getAllTextTillNextClickableElement(2).trim() || intent,
      url: page.url(),
    });

    if (approved) return null;

    const msg = t('act_declinedByUser', [intent]);
    logger.info(`🚫 ${msg}`);
    this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_DECLINED, msg);
    // fed back to the model so the planner routes around it instead of retrying the same click
    return new ActionResult({ extractedContent: msg, includeInMemory: true });
  }

  private async doMultiAction(actions: Record<string, unknown>[]): Promise<ActionResult[]> {
    const results: ActionResult[] = [];
    let errCount = 0;
    // debug, not info: the action array carries input_text.text, which is where a typed password is.
    // log.ts gates only debug behind import.meta.env.DEV, so info would print it in production.
    logger.debug('Actions', actions);

    const browserContext = this.context.browserContext;
    // The state the model chose these actions from. Re-parsing here would produce a different
    // highlightIndex numbering than the one the model wrote its indices against.
    const browserState = this.context.stepState ?? (await browserContext.getState(this.context.options.useVision));
    // The parse is gone but its load wait is not: the page may have kept loading during the LLM call,
    // and this is also where a click-driven navigation gets its URL allow/deny check.
    await (await browserContext.getCurrentPage()).waitForPageAndFramesLoad();
    const cachedPathHashes = await calcBranchPathHashSet(browserState);

    await browserContext.removeHighlight();

    for (const [i, action] of actions.entries()) {
      const actionName = Object.keys(action)[0];
      const actionArgs = action[actionName];
      try {
        // check if the task is paused or stopped
        if (this.context.paused || this.context.stopped) {
          return results;
        }

        const actionInstance = this.actionRegistry.getAction(actionName);
        if (actionInstance === undefined) {
          throw new Error(`Action ${actionName} not exists`);
        }

        const indexArg = actionInstance.getIndexArg(actionArgs);
        if (i > 0 && indexArg !== null) {
          // Only the selector map is read below, so never pay for a screenshot here.
          const newState = await browserContext.getState(false);
          const newPathHashes = await calcBranchPathHashSet(newState);
          // next action requires index but there are new elements on the page
          if (!isSubsetOf(newPathHashes, cachedPathHashes)) {
            const msg = `Something new appeared after action ${i} / ${actions.length}`;
            logger.info(msg);
            results.push(
              new ActionResult({
                extractedContent: msg,
                includeInMemory: true,
              }),
            );
            break;
          }
        }

        // Human-in-the-loop: money, data loss and credentials never move without an explicit yes,
        // and in manual mode neither does anything else that reaches the page.
        const declined = await this.confirmBeforeAction(
          actionName,
          actionArgs,
          indexArg !== null ? browserState.selectorMap.get(indexArg) : undefined,
        );
        if (declined) {
          results.push(declined);
          break;
        }

        let result = await actionInstance.call(actionArgs);
        if (result === undefined) {
          throw new Error(`Action ${actionName} returned undefined`);
        }

        // A dynamic page can re-render between reading the element list and acting on it, which
        // invalidates the index the model chose. One retry after a short settle covers that race;
        // more than one would just be a loop against a page that genuinely changed.
        //
        // It covers a re-render only. Indices are numbered per parse, so once the page has navigated
        // index N belongs to a different document, and retrying there aims the action at whatever
        // now happens to be numbered N - which the model never chose and, for a sensitive action,
        // the user never approved. Clearing the step state (which is what this used to do) also
        // switched off the page check `ActionBuilder.resolveElement` relies on, so the retry
        // resolved its index against a fresh parse of whatever page was in front of it.
        if (result.error && indexArg !== null) {
          logger.info(`Action ${actionName} failed on a stale element, re-reading the page and retrying once`);
          await new Promise(resolve => setTimeout(resolve, 500));

          const retryPage = await browserContext.getCurrentPage();
          const onSamePage = retryPage.tabId === browserState.tabId && retryPage.url() === browserState.url;
          // `false`: only the selector map, tab and url are read below, and a screenshot on every
          // failed indexed action is pure cost. It also keeps this probe off the vision path.
          const refreshed = onSamePage ? await browserContext.getState(false) : null;

          if (!refreshed || refreshed.tabId !== browserState.tabId || refreshed.url !== browserState.url) {
            logger.info(`The page changed under ${actionName}; leaving the retry to the next step`);
          } else {
            // Same document, so renumbering is meaningful - but only once the index is confirmed to
            // still name the same element. A re-render can move index N onto a different control
            // just as a navigation can, and this is the index the approval was given for.
            const approved = browserState.selectorMap.get(indexArg);
            const candidate = refreshed.selectorMap.get(indexArg);
            const sameElement =
              approved !== undefined &&
              candidate !== undefined &&
              (await HistoryTreeProcessor.compareHistoryElementAndDomElement(
                HistoryTreeProcessor.convertDomElementToHistoryElement(approved),
                candidate,
              ));

            if (!sameElement) {
              logger.info(`Index ${indexArg} no longer names the same element; not retrying`);
            } else {
              this.context.stepState = refreshed;
              try {
                const retried = await actionInstance.call(actionArgs);
                if (retried !== undefined && !retried.error) {
                  result = retried;
                }
              } finally {
                // Scoped to the retry. Leaving the refreshed parse in place would renumber every
                // later action in this same batch, while the confirmation cards and the history
                // record still describe the step's original parse.
                this.context.stepState = browserState;
              }
            }
          }
        }

        // if the action has an index argument, record the interacted element to the result
        if (indexArg !== null) {
          const domElement = browserState.selectorMap.get(indexArg);
          if (domElement) {
            const interactedElement = HistoryTreeProcessor.convertDomElementToHistoryElement(domElement);
            result.interactedElement = interactedElement;
            logger.debug('Interacted element', interactedElement);
            logger.debug('Result', result);
          }
        }
        results.push(result);

        // check if the task is paused or stopped
        if (this.context.paused || this.context.stopped) {
          return results;
        }
        // Let the page settle before the next action resolves its element, and re-check the URL:
        // a click that navigated via the evaluate() fallback has not been through an allow/deny
        // check yet. There is no next action to settle for after the last one.
        //
        // This replaces a flat 1000ms sleep. The load wait is adaptive (~0.6s typically, capped at
        // maximumWaitPageLoadTime), so the extra fixed pad defaults to 0 rather than re-adding a
        // second of latency on top of it - users on pages that need more can raise it.
        if (i < actions.length - 1) {
          await (await browserContext.getCurrentPage()).waitForPageAndFramesLoad();
          const padMs = browserContext.getConfig().waitBetweenActions * 1000;
          if (padMs > 0) {
            await new Promise(resolve => setTimeout(resolve, padMs));
          }
        }
      } catch (error) {
        if (error instanceof URLNotAllowedError) {
          throw error;
        }
        const errorMessage = error instanceof Error ? error.message : String(error);
        // A stale element index is routine and self-healing (the message below sends the model back
        // to re-read the page), so it logs as a warning; everything else here is a real error.
        const logAction = error instanceof StaleElementError ? logger.warning : logger.error;
        logAction(
          'doAction error',
          actionName,
          JSON.stringify(actionArgs, null, 2),
          JSON.stringify(errorMessage, null, 2),
        );
        // unexpected error, emit event
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMessage);
        errCount++;
        if (errCount > 3) {
          throw new Error('Too many errors in actions');
        }
        results.push(
          new ActionResult({
            error: errorMessage,
            isDone: false,
            includeInMemory: true,
          }),
        );
      }
    }
    return results;
  }

  /**
   * Parse and validate model output from history item
   */
  private parseHistoryModelOutput(historyItem: AgentStepRecord): {
    parsedOutput: ParsedModelOutput;
    goal: string;
    actionsToReplay: (Record<string, unknown> | null)[] | null;
  } {
    if (!historyItem.modelOutput) {
      throw new Error('No model output found in history item');
    }

    let parsedOutput: ParsedModelOutput;
    try {
      parsedOutput = JSON.parse(historyItem.modelOutput) as ParsedModelOutput;
    } catch (error) {
      throw new Error(`Could not parse modelOutput: ${error}`);
    }

    // logger.info('Parsed output', JSON.stringify(parsedOutput, null, 2));

    const goal = parsedOutput?.current_state?.next_goal || '';
    const actionsToReplay = parsedOutput?.action;

    // Validate that there are actions to replay
    if (
      !parsedOutput || // No model output string at all
      !actionsToReplay || // 'action' field is missing or null after parsing
      (Array.isArray(actionsToReplay) && actionsToReplay.length === 0) || // 'action' is an empty array
      (Array.isArray(actionsToReplay) && actionsToReplay.length === 1 && actionsToReplay[0] === null) // 'action' is [null]
    ) {
      throw new Error('No action to replay');
    }

    return { parsedOutput, goal, actionsToReplay };
  }

  /**
   * Execute actions from history with element index updates
   */
  private async executeHistoryActions(
    parsedOutput: ParsedModelOutput,
    historyItem: AgentStepRecord,
    delay: number,
  ): Promise<ActionResult[]> {
    const state = await this.context.browserContext.getState(this.context.options.useVision);
    if (!state) {
      throw new Error('Invalid browser state');
    }
    // replay resolves its own indices against this parse, so hand it to the actions too
    this.context.stepState = state;

    const updatedActions: (Record<string, unknown> | null)[] = [];
    for (let i = 0; i < parsedOutput.action!.length; i++) {
      const result = historyItem.result[i];
      if (!result) {
        break;
      }
      const interactedElement = result.interactedElement;
      const currentAction = parsedOutput.action![i];

      // Skip null actions
      if (currentAction === null) {
        updatedActions.push(null);
        continue;
      }

      // If there's no interacted element, just use the action as is
      if (!interactedElement) {
        updatedActions.push(currentAction);
        continue;
      }

      const updatedAction = await this.updateActionIndices(interactedElement, currentAction, state);
      updatedActions.push(updatedAction);

      if (updatedAction === null) {
        throw new Error(`Could not find matching element ${i} in current page`);
      }
    }

    logger.debug('updatedActions', updatedActions);

    // Filter out null values and cast to the expected type
    const validActions = updatedActions.filter((action): action is Record<string, unknown> => action !== null);
    const result = await this.doMultiAction(validActions);

    // Wait for the specified delay
    await new Promise(resolve => setTimeout(resolve, delay));
    return result;
  }

  async executeHistoryStep(
    historyItem: AgentStepRecord,
    stepIndex: number,
    totalSteps: number,
    maxRetries = 3,
    delay = 1000,
    skipFailures = true,
  ): Promise<ActionResult[]> {
    const replayLogger = createLogger('NavigatorAgent:executeHistoryStep');
    const results: ActionResult[] = [];

    // Parse and validate model output
    let parsedData: {
      parsedOutput: ParsedModelOutput;
      goal: string;
      actionsToReplay: (Record<string, unknown> | null)[] | null;
    };
    try {
      parsedData = this.parseHistoryModelOutput(historyItem);
    } catch (error) {
      const errorMsg = `Step ${stepIndex + 1}: ${error instanceof Error ? error.message : String(error)}`;
      replayLogger.warning(errorMsg);
      return [
        new ActionResult({
          error: errorMsg,
          includeInMemory: false,
        }),
      ];
    }

    const { parsedOutput, goal, actionsToReplay } = parsedData;
    replayLogger.info(`Replaying step ${stepIndex + 1}/${totalSteps}: goal: ${goal}`);
    replayLogger.debug(`🔄 Replaying actions:`, actionsToReplay);

    // Try to execute the step with retries
    let retryCount = 0;
    let success = false;

    while (retryCount < maxRetries && !success) {
      try {
        // Check if execution should stop
        if (this.context.stopped) {
          replayLogger.info('Replay stopped by user');
          break;
        }

        // Execute the history actions
        const stepResults = await this.executeHistoryActions(parsedOutput, historyItem, delay);
        results.push(...stepResults);
        success = true;
      } catch (error) {
        retryCount++;
        const errorMessage = error instanceof Error ? error.message : String(error);

        if (retryCount >= maxRetries) {
          const failMsg = `Step ${stepIndex + 1} failed after ${maxRetries} attempts: ${errorMessage}`;
          replayLogger.error(failMsg);

          results.push(
            new ActionResult({
              error: failMsg,
              includeInMemory: true,
            }),
          );

          if (!skipFailures) {
            throw new Error(failMsg);
          }
        } else {
          replayLogger.warning(`Step ${stepIndex + 1} failed (attempt ${retryCount}/${maxRetries}), retrying...`);
          // Wait before retrying
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    return results;
  }

  async updateActionIndices(
    historicalElement: DOMHistoryElement,
    action: Record<string, unknown>,
    currentState: BrowserState,
  ): Promise<Record<string, unknown> | null> {
    // If no historical element or no element tree in current state, return the action unchanged
    if (!historicalElement || !currentState.elementTree) {
      return action;
    }

    // Find the current element in the tree based on the historical element
    const currentElement = await HistoryTreeProcessor.findHistoryElementInTree(
      historicalElement,
      currentState.elementTree,
    );

    // If no current element found or it doesn't have a highlight index, return null
    if (!currentElement || currentElement.highlightIndex === null) {
      return null;
    }

    // Get action name and args
    const actionName = Object.keys(action)[0];
    const actionArgs = action[actionName] as Record<string, unknown>;

    // Get the action instance to access the index
    const actionInstance = this.actionRegistry.getAction(actionName);
    if (!actionInstance) {
      return action;
    }

    // Get the index argument from the action
    const oldIndex = actionInstance.getIndexArg(actionArgs);

    // If the index has changed, update it
    if (oldIndex !== null && oldIndex !== currentElement.highlightIndex) {
      // Create a new action object with the updated index
      const updatedAction: Record<string, unknown> = { [actionName]: { ...actionArgs } };

      // Update the index in the action arguments
      actionInstance.setIndexArg(updatedAction[actionName] as Record<string, unknown>, currentElement.highlightIndex);

      logger.info(`Element moved in DOM, updated index from ${oldIndex} to ${currentElement.highlightIndex}`);
      return updatedAction;
    }

    return action;
  }
}
