import 'webextension-polyfill';
import {
  Actors,
  agentModelStore,
  AgentNameEnum,
  chatHistoryStore,
  firewallStore,
  generalSettingsStore,
  llmProviderStore,
  analyticsSettingsStore,
  modelPricingStore,
  SESSION_FEEDBACK_RATINGS,
  schedulesStore,
  APPROVAL_MODES,
  compareRuns,
  describeComparison,
} from '@extension/storage';
import { t } from '@extension/i18n';
import { SCHEDULE_ALARM_PREFIX, scheduleIdFromAlarmName, syncScheduleAlarms } from './services/scheduler';
import { dispatchTaskWebhook } from './services/webhook';
import { FOLLOW_UP_MAX_CHAIN } from './services/webhookContract';
import BrowserContext from './browser/context';
import { Executor } from './agent/executor';
import { undoLastStepSafely } from './agent/undo';
import { createLogger } from './log';
import { ExecutionState } from './agent/event/types';
import { createChatModel, contextWindowFor, OUTPUT_TOKEN_CAP } from './agent/helper';
import { DEFAULT_AGENT_OPTIONS } from './agent/types';
import { SpeechToTextService } from './services/speechToText';
import { injectBuildDomTreeScripts } from './browser/dom/service';
import { analytics } from './services/analytics';
import type { WebhookFollowUp } from './services/webhookContract';
import type { TaskWebhookPayload } from './services/webhook';
import type { ScheduledTask, ApprovalMode, MessageDataset } from '@extension/storage';
import type { AgentEvent, DatasetPayload } from './agent/event/types';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

const logger = createLogger('background');

const browserContext = new BrowserContext({});
let currentExecutor: Executor | null = null;
let currentPort: chrome.runtime.Port | null = null;
const SIDE_PANEL_URL = chrome.runtime.getURL('side-panel/index.html');

/**
 * True while any run (panel-started or scheduled) is inside its execute loop. The scheduler reads
 * it to skip a firing rather than fight the user's live task for the one shared BrowserContext.
 */
let executorBusy = false;

async function withExecutorBusy<T>(run: () => Promise<T>): Promise<T> {
  executorBusy = true;
  try {
    return await run();
  } finally {
    executorBusy = false;
  }
}

/**
 * What the currently-running task is, for the outbound webhook. One executor runs at a time, so
 * one slot is enough; it is nulled after the terminal dispatch so a stray second terminal event
 * cannot fire the webhook twice for the same task.
 */
let currentTaskMeta:
  | (Pick<TaskWebhookPayload, 'source' | 'task' | 'title' | 'startedAt'> & {
      /** how many webhook follow-ups preceded this run; caps the chain */
      chain: number;
      /**
       * The table the run collected, stamped on when TASK_DATASET arrives - which is always before
       * the terminal event that fires the webhook, and which is why this can be read there.
       */
      dataset?: MessageDataset;
    })
  | null = null;

/**
 * Narrow an approval mode arriving over the port.
 *
 * The port is a message boundary, so this is not ceremony: an unvalidated string would land
 * straight in `context.options.approvalMode`, where any value that is not exactly 'auto' reads as
 * "run the gates" and any typo of 'manual' silently downgrades to planner-level checking.
 */
function isApprovalMode(value: unknown): value is ApprovalMode {
  return typeof value === 'string' && (APPROVAL_MODES as readonly string[]).includes(value);
}

/** The same check for optional fields: absent is fine and means "use the stored setting". */
function readApprovalMode(value: unknown): ApprovalMode | undefined {
  return isApprovalMode(value) ? value : undefined;
}

// Setup side panel behavior
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(error => console.error(error));

/**
 * Keyboard shortcut for the panel.
 *
 * `sidePanel.open()` needs a user gesture and a keyboard command counts as one, which is why
 * this opens the panel directly rather than going through the action. Optional-chained because
 * neither namespace exists in a Firefox build.
 */
chrome.commands?.onCommand.addListener(async command => {
  if (command !== 'open-side-panel') return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.windowId === undefined) return;
    await chrome.sidePanel?.open({ windowId: tab.windowId });
  } catch (error) {
    logger.error('Failed to open the side panel from the keyboard shortcut', error);
  }
});

/* -------------------------------------------------------------------------- */
/* Context menu: start a task from the page under the cursor                   */
/* -------------------------------------------------------------------------- */

const CTX_MENU_PAGE = 'flowkite-ctx-page';
const CTX_MENU_SELECTION = 'flowkite-ctx-selection';

/**
 * Longer selections are truncated before they reach the composer: the selection is context for
 * the task, not the task itself, and a whole selected article would drown the input.
 */
const CTX_SELECTION_MAX = 500;

// Recreated from scratch on every install/update: createContextMenu throws on duplicate ids, and
// removeAll is the documented way to make registration idempotent across SW restarts.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: CTX_MENU_PAGE, title: t('bg_ctx_page'), contexts: ['page'] });
    // Chrome substitutes %s in the title with the selected text itself.
    chrome.contextMenus.create({ id: CTX_MENU_SELECTION, title: t('bg_ctx_selection'), contexts: ['selection'] });
  });
  void syncScheduleAlarms();
});

// Alarms persist across browser restarts but their `when` may be in the past after a long
// shutdown; a startup resync re-anchors every schedule to its next real occurrence.
chrome.runtime.onStartup.addListener(() => {
  void syncScheduleAlarms();
});

// Any edit in the schedules UI lands here and rebuilds the alarms to match.
schedulesStore.subscribe(() => {
  void syncScheduleAlarms();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CTX_MENU_PAGE && info.menuItemId !== CTX_MENU_SELECTION) return;
  if (!tab?.id) return;

  const url = info.pageUrl ?? tab.url ?? '';
  let text: string;
  if (info.menuItemId === CTX_MENU_SELECTION && info.selectionText) {
    const selection =
      info.selectionText.length > CTX_SELECTION_MAX
        ? `${info.selectionText.slice(0, CTX_SELECTION_MAX)}…`
        : info.selectionText;
    text = `On the current page (${url}), regarding this selected text:\n"${selection}"\n\n{task}`;
  } else {
    text = `On the current page (${url}), {task}`;
  }

  // The composer reads this from session storage, which works in every panel state: already open
  // (its onChanged listener fires), or opened by the call below (it reads the key on mount). A
  // port message would cover neither reliably - the panel only connects once a task runs.
  // storage.session is TRUSTED_CONTEXTS-only, so no web page can plant a prefill here.
  chrome.storage.session
    .set({ pendingPrefill: { text, ts: Date.now() } })
    .catch(error => logger.error('Failed to stash context-menu prefill:', error));

  // Must be called synchronously enough to keep the user gesture; .open() with tabId focuses the
  // panel on the tab the user right-clicked.
  chrome.sidePanel.open({ tabId: tab.id }).catch(error => logger.error('Failed to open side panel:', error));
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Pre-warm only the tabs a task is actually driving. The parse path injects on demand anyway
  // (see _buildDomTree), so this is purely latency - and the extension has no business planting
  // script in every page the user browses on their own.
  if (tabId && changeInfo.status === 'complete' && tab.url?.startsWith('http') && browserContext.isAttachedTab(tabId)) {
    await injectBuildDomTreeScripts(tabId);
  }
});

// Listen for debugger detached event
// if canceled_by_user, remove the tab from the browser context
chrome.debugger.onDetach.addListener(async (source, reason) => {
  logger.debug('Debugger detached:', source, reason);
  if (reason === 'canceled_by_user') {
    if (source.tabId) {
      currentExecutor?.cancel();
      await browserContext.cleanup();
    }
  }
});

// Cleanup when tab is closed
chrome.tabs.onRemoved.addListener(tabId => {
  // Both facts must be read before removeAttachedPage forgets which tab was current.
  const closedByAgent = browserContext.consumeAgentClosedTab(tabId);
  const userClosedTaskTab = !closedByAgent && browserContext.isCurrentTab(tabId);
  browserContext.removeAttachedPage(tabId);
  // The user closing the tab a task is driving is an instruction to stop, not an obstacle to route
  // around: without this the next step attaches to whatever tab the user is looking at and drives
  // that instead.
  if (userClosedTaskTab && executorBusy && currentExecutor) {
    logger.info(`Task tab ${tabId} was closed by the user; stopping the task`);
    void currentExecutor.cancel(t('bg_task_tabClosed'));
  }
});

logger.info('background loaded');

// Initialize analytics
analytics.init().catch(error => {
  logger.error('Failed to initialize analytics:', error);
});

// Listen for analytics settings changes
analyticsSettingsStore.subscribe(() => {
  analytics.updateSettings().catch(error => {
    logger.error('Failed to update analytics settings:', error);
  });
});

// Listen for simple messages (e.g., from options page)
chrome.runtime.onMessage.addListener((message, sender) => {
  // Only this extension's own pages may speak here. A web page cannot reach a runtime listener
  // without an externally_connectable entry, which the manifest does not have, but the check costs
  // nothing and keeps that guarantee local to the listener rather than to a file two levels away.
  if (sender.id !== chrome.runtime.id) return false;

  if (message?.type === 'session_feedback' && SESSION_FEEDBACK_RATINGS.includes(message.rating)) {
    // Best-effort: the strip has already thanked the user, and analytics being off is the normal
    // case rather than a failure. It drops the rating silently there, which is the point.
    void analytics.trackSessionFeedback(message.rating);
  }
  return false;
});

// Setup connection listener for long-lived connections (e.g., side panel)
chrome.runtime.onConnect.addListener(port => {
  if (port.name === 'side-panel-connection') {
    const senderUrl = port.sender?.url;
    const senderId = port.sender?.id;

    if (!senderUrl || senderId !== chrome.runtime.id || senderUrl !== SIDE_PANEL_URL) {
      logger.warning('Blocked unauthorized side-panel-connection', senderId, senderUrl);
      port.disconnect();
      return;
    }

    currentPort = port;

    port.onMessage.addListener(async message => {
      try {
        switch (message.type) {
          case 'heartbeat':
            // Acknowledge heartbeat
            port.postMessage({ type: 'heartbeat_ack' });
            break;

          case 'new_task': {
            if (!message.task) return port.postMessage({ type: 'error', error: t('bg_cmd_newTask_noTask') });
            if (!message.tabId) return port.postMessage({ type: 'error', error: t('bg_errors_noTabId') });

            logger.info('new_task', message.tabId, message.task);
            currentTaskMeta = { source: 'manual', task: message.task, startedAt: Date.now(), chain: 0 };
            const executor = await setupExecutor(
              message.taskId,
              message.task,
              browserContext,
              readApprovalMode(message.approvalMode),
            );
            currentExecutor = executor;
            subscribeToExecutorEvents(executor);

            const result = await withExecutorBusy(() => executor.execute());
            logger.info('new_task execution result', message.tabId, result);
            break;
          }

          case 'steer': {
            if (!message.task) return port.postMessage({ type: 'error', error: t('bg_cmd_newTask_noTask') });
            // A correction with nothing to correct is a user talking to a run that already ended;
            // saying so is better than silently dropping what they typed.
            if (!currentExecutor || !executorBusy) {
              return port.postMessage({ type: 'error', error: t('bg_cmd_steer_notRunning') });
            }
            logger.info('steer', message.task);
            currentExecutor.steer(message.task);
            break;
          }

          case 'follow_up_task': {
            if (!message.task) return port.postMessage({ type: 'error', error: t('bg_cmd_followUpTask_noTask') });
            if (!message.tabId) return port.postMessage({ type: 'error', error: t('bg_errors_noTabId') });

            logger.info('follow_up_task', message.tabId, message.task);

            // If executor exists, add follow-up task
            if (currentExecutor) {
              const executor = currentExecutor;
              currentTaskMeta = { source: 'manual', task: message.task, startedAt: Date.now(), chain: 0 };
              // The Executor is reused here rather than rebuilt, so it still carries the mode the
              // session started with. Without this the picker would appear to work for the first
              // task and be silently ignored for every follow-up after it.
              const followUpMode = readApprovalMode(message.approvalMode);
              if (followUpMode) executor.setApprovalMode(followUpMode);
              executor.addFollowUpTask(message.task);
              // Re-subscribe to events in case the previous subscription was cleaned up
              subscribeToExecutorEvents(executor);
              const result = await withExecutorBusy(() => executor.execute());
              logger.info('follow_up_task execution result', message.tabId, result);
            } else {
              // executor was cleaned up, can not add follow-up task
              logger.info('follow_up_task: executor was cleaned up, can not add follow-up task');
              return port.postMessage({ type: 'error', error: t('bg_cmd_followUpTask_cleaned') });
            }
            break;
          }

          case 'cancel_task': {
            if (!currentExecutor) return port.postMessage({ type: 'error', error: t('bg_errors_noRunningTask') });
            await currentExecutor.cancel();
            break;
          }

          case 'resume_task': {
            if (!currentExecutor) return port.postMessage({ type: 'error', error: t('bg_cmd_resumeTask_noTask') });
            await currentExecutor.resume();
            return port.postMessage({ type: 'success' });
          }

          case 'approve_plan':
          case 'reject_plan': {
            if (!currentExecutor) return port.postMessage({ type: 'error', error: t('bg_errors_noRunningTask') });
            if (!currentExecutor.isAwaitingPlanReview())
              return port.postMessage({ type: 'error', error: t('bg_cmd_planReview_notPending') });
            await currentExecutor.respondToPlanReview(message.type === 'approve_plan');
            return port.postMessage({ type: 'success' });
          }

          case 'set_approval_mode': {
            if (!isApprovalMode(message.mode))
              return port.postMessage({
                type: 'error',
                error: t('bg_cmd_approvalMode_invalid', [String(message.mode)]),
              });
            // Deliberately no noRunningTask error: moving the picker with nothing running is normal,
            // and the panel has already written the choice to storage, so there is nothing to fail.
            currentExecutor?.setApprovalMode(message.mode);
            return port.postMessage({ type: 'success' });
          }

          case 'confirm_action':
          case 'decline_action': {
            if (!currentExecutor) return port.postMessage({ type: 'error', error: t('bg_errors_noRunningTask') });
            if (!currentExecutor.isAwaitingActionConfirmation())
              return port.postMessage({ type: 'error', error: t('bg_cmd_actionConfirm_notPending') });
            await currentExecutor.respondToActionConfirmation(message.type === 'confirm_action');
            return port.postMessage({ type: 'success' });
          }

          case 'handoff_done': {
            if (!currentExecutor) return port.postMessage({ type: 'error', error: t('bg_errors_noRunningTask') });
            if (!currentExecutor.isAwaitingHandoff())
              return port.postMessage({ type: 'error', error: t('bg_cmd_handoff_notPending') });
            await currentExecutor.respondToHandoff(true);
            return port.postMessage({ type: 'success' });
          }

          case 'undo_last_step': {
            if (!currentExecutor) return port.postMessage({ type: 'error', error: t('bg_errors_noRunningTask') });
            try {
              await undoLastStepSafely(currentExecutor);
              return port.postMessage({ type: 'success' });
            } catch (error) {
              logger.error('Undo failed:', error);
              return port.postMessage({
                type: 'error',
                error: error instanceof Error ? error.message : t('bg_cmd_undo_failed'),
              });
            }
          }

          case 'pause_task': {
            if (!currentExecutor) return port.postMessage({ type: 'error', error: t('bg_errors_noRunningTask') });
            await currentExecutor.pause();
            return port.postMessage({ type: 'success' });
          }

          case 'screenshot': {
            if (!message.tabId) return port.postMessage({ type: 'error', error: t('bg_errors_noTabId') });
            const page = await browserContext.switchTab(message.tabId);
            const screenshot = await page.takeScreenshot();
            logger.info('screenshot', message.tabId, screenshot);
            return port.postMessage({ type: 'success', screenshot });
          }

          case 'state': {
            try {
              // useVision false: this is a read-only dump of the element tree. Passing true would make a
              // debug command draw boxes on the page and take a screenshot nothing here reads.
              const browserState = await browserContext.getState(false);
              const elementsText = browserState.elementTree.clickableElementsToString(
                DEFAULT_AGENT_OPTIONS.includeAttributes,
              );

              logger.info('state', browserState);
              logger.info('interactive elements', elementsText);
              return port.postMessage({ type: 'success', msg: t('bg_cmd_state_printed') });
            } catch (error) {
              logger.error('Failed to get state:', error);
              return port.postMessage({ type: 'error', error: t('bg_cmd_state_failed') });
            }
          }

          case 'nohighlight': {
            const page = await browserContext.getCurrentPage();
            await page.removeHighlight();
            return port.postMessage({ type: 'success', msg: t('bg_cmd_nohighlight_ok') });
          }

          case 'speech_to_text': {
            try {
              if (!message.audio) {
                return port.postMessage({
                  type: 'speech_to_text_error',
                  error: t('bg_cmd_stt_noAudioData'),
                });
              }

              logger.info('Processing speech-to-text request...');

              // Get all providers for speech-to-text service
              const providers = await llmProviderStore.getAllProviders();

              // Create speech-to-text service with all providers
              const speechToTextService = await SpeechToTextService.create(providers);

              // Extract base64 audio data (remove data URL prefix if present)
              let base64Audio = message.audio;
              if (base64Audio.startsWith('data:')) {
                base64Audio = base64Audio.split(',')[1];
              }

              // Transcribe audio
              const transcribedText = await speechToTextService.transcribeAudio(base64Audio);

              logger.info('Speech-to-text completed successfully');
              return port.postMessage({
                type: 'speech_to_text_result',
                text: transcribedText,
              });
            } catch (error) {
              logger.error('Speech-to-text failed:', error);
              return port.postMessage({
                type: 'speech_to_text_error',
                error: error instanceof Error ? error.message : t('bg_cmd_stt_failed'),
              });
            }
          }

          case 'replay': {
            if (!message.tabId) return port.postMessage({ type: 'error', error: t('bg_errors_noTabId') });
            if (!message.taskId) return port.postMessage({ type: 'error', error: t('bg_errors_noTaskId') });
            if (!message.historySessionId)
              return port.postMessage({ type: 'error', error: t('bg_cmd_replay_noHistory') });
            logger.info('replay', message.tabId, message.taskId, message.historySessionId);

            try {
              // Switch to the specified tab
              await browserContext.switchTab(message.tabId);
              // Setup executor with the new taskId and a dummy task description
              const executor = await setupExecutor(message.taskId, message.task, browserContext);
              currentExecutor = executor;
              subscribeToExecutorEvents(executor);

              // Run replayHistory with the history session ID
              const result = await withExecutorBusy(() => executor.replayHistory(message.historySessionId));
              logger.debug('replay execution result', message.tabId, result);
            } catch (error) {
              logger.error('Replay failed:', error);
              return port.postMessage({
                type: 'error',
                error: error instanceof Error ? error.message : t('bg_cmd_replay_failed'),
              });
            }
            break;
          }

          default:
            return port.postMessage({ type: 'error', error: t('errors_cmd_unknown', [message.type]) });
        }
      } catch (error) {
        console.error('Error handling port message:', error);
        port.postMessage({
          type: 'error',
          error: error instanceof Error ? error.message : t('errors_unknown'),
        });
      }
    });

    port.onDisconnect.addListener(() => {
      // this event is also triggered when the side panel is closed, so we need to cancel the task
      logger.debug('Side panel disconnected');
      currentPort = null;
      currentExecutor?.cancel();
    });
  }
});

/**
 * @param approvalModeOverride the mode the panel is currently showing, when it sent one.
 *
 * Takes precedence over the stored setting to close a real race: the panel writes the mode to
 * chrome.storage asynchronously, so a user who picks a mode and immediately presses Enter would
 * otherwise start the task under the previous value. Whatever the composer visibly says is what
 * the task it launched runs under.
 */
async function setupExecutor(
  taskId: string,
  task: string,
  browserContext: BrowserContext,
  approvalModeOverride?: ApprovalMode,
  /** Scheduled runs: plan gate pre-approved, sensitive actions auto-declined. See AgentOptions.unattended. */
  unattended = false,
) {
  const providers = await llmProviderStore.getAllProviders();
  // if no providers, need to display the options page
  if (Object.keys(providers).length === 0) {
    throw new Error(t('bg_setup_noApiKeys'));
  }

  // Clean up any legacy validator settings for backward compatibility
  await agentModelStore.cleanupLegacyValidatorSettings();

  const agentModels = await agentModelStore.getAllAgentModels();
  // verify if every provider used in the agent models exists in the providers
  for (const agentModel of Object.values(agentModels)) {
    if (!providers[agentModel.provider]) {
      throw new Error(t('bg_setup_noProvider', [agentModel.provider]));
    }
  }

  const navigatorModel = agentModels[AgentNameEnum.Navigator];
  if (!navigatorModel) {
    throw new Error(t('bg_setup_noNavigatorModel'));
  }
  // Log the provider config being used for the navigator
  const navigatorProviderConfig = providers[navigatorModel.provider];
  const navigatorLLM = createChatModel(navigatorProviderConfig, navigatorModel);

  let plannerLLM: BaseChatModel | null = null;
  const plannerModel = agentModels[AgentNameEnum.Planner];
  if (plannerModel) {
    // Log the provider config being used for the planner
    const plannerProviderConfig = providers[plannerModel.provider];
    plannerLLM = createChatModel(plannerProviderConfig, plannerModel);
  }

  // Apply firewall settings to browser context
  const firewall = await firewallStore.getFirewall();
  if (firewall.enabled) {
    browserContext.updateConfig({
      allowedUrls: firewall.allowList,
      deniedUrls: firewall.denyList,
    });
  } else {
    browserContext.updateConfig({
      allowedUrls: [],
      deniedUrls: [],
    });
  }

  const generalSettings = await generalSettingsStore.getSettings();
  const approvalMode = approvalModeOverride ?? generalSettings.approvalMode;
  browserContext.updateConfig({
    minimumWaitPageLoadTime: generalSettings.minWaitPageLoad / 1000.0,
    waitBetweenActions: generalSettings.waitBetweenActions / 1000.0,
    agentOverlay: generalSettings.agentOverlay,
    showActivityOverlay: generalSettings.showActivityOverlay,
    groupTabs: generalSettings.groupTaskTabs,
  });

  // Optional cheap model for routine steps. Absent config simply means no hybrid routing.
  let fastLLM: BaseChatModel | null = null;
  const fastModel = agentModels[AgentNameEnum.Fast];
  if (fastModel) {
    const fastProviderConfig = providers[fastModel.provider];
    fastLLM = createChatModel(fastProviderConfig, fastModel);
  }

  // Bring the input budget down to the smallest window any configured model actually has.
  //
  // Only Ollama declares one here, and it is the case that matters: it does not reject an
  // over-length prompt, it truncates it from the front and answers anyway. The front holds the
  // system prompt and the pinned task, so the agent loses its instructions mid-run with nothing to
  // say why - and the trimmer never fires, because by its own number it is comfortably under.
  const configuredWindows = [navigatorModel, plannerModel, fastModel]
    .filter((model): model is NonNullable<typeof model> => Boolean(model))
    .map(model => contextWindowFor(model.provider))
    .filter((window): window is number => window !== undefined);
  const effectiveMaxInputTokens = configuredWindows.length
    ? Math.min(generalSettings.maxInputTokens, Math.min(...configuredWindows) - OUTPUT_TOKEN_CAP)
    : generalSettings.maxInputTokens;
  if (effectiveMaxInputTokens < generalSettings.maxInputTokens) {
    logger.info(
      `Input budget capped at ${effectiveMaxInputTokens} by a configured model's context window ` +
        `(setting is ${generalSettings.maxInputTokens})`,
    );
  }

  const executor = new Executor(task, taskId, browserContext, navigatorLLM, {
    plannerLLM: plannerLLM ?? navigatorLLM,
    fastLLM: fastLLM ?? undefined,
    providers: {
      navigator: navigatorModel.provider,
      planner: (plannerModel ?? navigatorModel).provider,
      fast: fastModel?.provider,
    },
    // Snapshotted at task start, like every other setting: a price edited mid-run applies to the
    // next task, not retroactively to a brake that may already have fired.
    modelPricing: await modelPricingStore.getAllPrices(),
    // The extractor runs on the navigator's model unless configured otherwise, and its tokens have
    // to be booked under the name the user priced rather than a name read off the adapter.
    extractorModelName: navigatorModel.modelName,
    agentOptions: {
      maxSteps: generalSettings.maxSteps,
      maxFailures: generalSettings.maxFailures,
      maxInputTokens: effectiveMaxInputTokens,
      retryDelay: generalSettings.retryDelay,
      maxActionsPerStep: generalSettings.maxActionsPerStep,
      useVision: generalSettings.useVision,
      // Pinned, not stored: the planner grounds its reading of the page on the same screenshot the
      // navigator sees, so switching it off while vision is on gives the planner a worse view than
      // the agent it is directing. There is no setting behind this on purpose.
      useVisionForPlanner: true,
      planningInterval: generalSettings.planningInterval,
      approvalMode,
      unattended,
    },
    // The override has to reach both readers, or the plan gate would run the stored mode while the
    // navigator's action gate ran the picked one.
    generalSettings: { ...generalSettings, approvalMode },
  });

  return executor;
}

/* -------------------------------------------------------------------------- */
/* Scheduled tasks                                                             */
/* -------------------------------------------------------------------------- */

const SCHED_NOTIFICATION_PREFIX = 'flowkite-sched-';

function notifySchedule(title: string, message: string): void {
  chrome.notifications.create(`${SCHED_NOTIFICATION_PREFIX}${Date.now()}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icon-128.png'),
    title,
    // Notification bodies clip anyway; a hard cap keeps a long final answer from being rejected.
    message: message.length > 300 ? `${message.slice(0, 300)}…` : message,
  });
}

chrome.notifications.onClicked.addListener(notificationId => {
  if (!notificationId.startsWith(SCHED_NOTIFICATION_PREFIX)) return;
  chrome.notifications.clear(notificationId);
  // A notification click is a user gesture, which sidePanel.open requires; the result itself is
  // waiting in the panel's chat history.
  chrome.windows.getLastFocused().then(window => {
    if (window?.id !== undefined) {
      chrome.sidePanel.open({ windowId: window.id }).catch(error => logger.error('Failed to open panel:', error));
    }
  });
});

chrome.alarms.onAlarm.addListener(alarm => {
  const scheduleId = scheduleIdFromAlarmName(alarm.name);
  if (scheduleId === null) return;
  void handleScheduleAlarm(scheduleId);
});

async function handleScheduleAlarm(scheduleId: number): Promise<void> {
  try {
    const schedule = await schedulesStore.getScheduleById(scheduleId);
    if (!schedule || !schedule.enabled) {
      // Deleted or switched off after the alarm was laid; make the alarm agree.
      await chrome.alarms.clear(`${SCHEDULE_ALARM_PREFIX}${scheduleId}`);
      return;
    }
    await runScheduledTask(schedule);
  } catch (error) {
    logger.error(`Scheduled task ${scheduleId} failed to run:`, error);
  }
}

/**
 * One unattended run of a schedule: its own background tab, the plan gate pre-approved, sensitive
 * actions auto-declined (see AgentOptions.unattended), and the outcome left where every other
 * task's outcome lives — a chat-history session — plus a notification that links back to it.
 */
async function runScheduledTask(schedule: ScheduledTask): Promise<void> {
  if (executorBusy) {
    // Never fight a live task for the one shared BrowserContext; skipping is the honest move.
    logger.info(`Schedule "${schedule.title}" skipped: another task is running`);
    notifySchedule(t('bg_sched_skipped_title'), t('bg_sched_skipped_body', [schedule.title]));
    return;
  }
  await schedulesStore.markRun(schedule.id, Date.now());
  await runUnattendedTask({
    prompt: schedule.prompt,
    title: schedule.title,
    source: 'scheduled',
    chain: 0,
    scheduleId: schedule.id,
    watch: schedule.watch === true,
  });
}

/**
 * A follow-up task the webhook's response asked for. Same unattended machinery as a schedule,
 * with two extra guards: the chain cap (a receiver that always answers with a follow-up must
 * terminate), and the same busy-skip a schedule gets.
 */
async function runWebhookFollowUp(followUp: WebhookFollowUp, chain: number): Promise<void> {
  const title = followUp.title ?? t('bg_followup_title');
  if (chain > FOLLOW_UP_MAX_CHAIN) {
    logger.warning(`Webhook follow-up chain cap (${FOLLOW_UP_MAX_CHAIN}) reached; "${title}" not run`);
    notifySchedule(t('bg_followup_chainCap_title'), t('bg_followup_chainCap_body', [String(FOLLOW_UP_MAX_CHAIN)]));
    return;
  }
  if (executorBusy) {
    logger.info(`Webhook follow-up "${title}" skipped: another task is running`);
    notifySchedule(t('bg_sched_skipped_title'), t('bg_sched_skipped_body', [title]));
    return;
  }
  await runUnattendedTask({ prompt: followUp.task, title, source: 'followup', chain });
}

/**
 * One unattended run: its own background tab, the plan gate pre-approved, sensitive actions
 * auto-declined (see AgentOptions.unattended), and the outcome left where every other task's
 * outcome lives — a chat-history session — plus a notification that links back to it.
 */
/**
 * Alarm that exists only to wake the worker while an unattended run is in flight. Never carries a
 * schedule id, so the schedule dispatcher ignores it by construction.
 */
const UNATTENDED_KEEPALIVE_ALARM = 'flowkite-unattended-keepalive';

async function runUnattendedTask(input: {
  prompt: string;
  title: string;
  source: 'scheduled' | 'followup';
  /** webhook follow-ups completed before this run; 0 for a fresh schedule */
  chain: number;
  /** the schedule this run belongs to, so its sessions can be compared with each other */
  scheduleId?: number;
  /** watch mode: stay silent unless the collected rows differ from the previous run's */
  watch?: boolean;
}): Promise<void> {
  logger.info(`Running unattended task "${input.title}" (${input.source})`);

  const startedAt = Date.now();
  let outcome = { ok: false, text: t('bg_sched_noResult') };
  /** Rows the run collected, so a scheduled scrape is still a table when the user opens it later. */
  let collected: MessageDataset | undefined;
  let runTabId: number | null = null;

  // Hold the service worker up for the length of the run.
  //
  // A panel task is kept alive by the side panel's heartbeat; an unattended run has no panel. The
  // agent makes extension API calls constantly *between* steps, but a single model call makes none,
  // and it can outlast the ~30s idle window on its own. Losing the worker there is silent and total:
  // the tab is orphaned, the tab-group chip stays on its running glyph forever, and no webhook, no
  // notification and no history session are ever written, because all three come after the await.
  // An alarm event is what resets the idle timer, so the handler can be a no-op - the wake is the
  // whole point.
  await chrome.alarms.create(UNATTENDED_KEEPALIVE_ALARM, { periodInMinutes: 0.5 });

  try {
    // Its own inactive tab, then pinned as the context's current tab, so the run never touches
    // whatever the user happens to have focused.
    const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
    if (!tab.id) throw new Error('Could not open a tab for the unattended task');
    runTabId = tab.id;
    await browserContext.switchTab(tab.id, { activate: false });

    const taskId = `unattended-${startedAt}`;
    currentTaskMeta = {
      source: input.source,
      task: input.prompt,
      title: input.title,
      startedAt,
      chain: input.chain,
    };
    const executor = await setupExecutor(taskId, input.prompt, browserContext, 'planner', true);
    currentExecutor = executor;
    // Port forwarding first (it clears old listeners), so an open panel watches the run live...
    subscribeToExecutorEvents(executor);
    // ...then a second subscriber captures the terminal event for the notification and history.
    executor.subscribeExecutionEvents(async event => {
      const details = event.data?.details ?? '';
      if (event.state === ExecutionState.TASK_OK) {
        outcome = { ok: true, text: details && details !== taskId ? details : t('bg_sched_done') };
      } else if (event.state === ExecutionState.TASK_FAIL) {
        outcome = { ok: false, text: details || t('bg_sched_noResult') };
      } else if (event.state === ExecutionState.TASK_CANCEL) {
        outcome = { ok: false, text: t('bg_sched_cancelled') };
      } else if (event.state === ExecutionState.TASK_DATASET) {
        collected = event.data?.payload as DatasetPayload | undefined;
      }
    });

    await withExecutorBusy(() => executor.execute());
  } catch (error) {
    outcome = { ok: false, text: error instanceof Error ? error.message : String(error) };
    logger.error('Unattended task failed:', error);
  } finally {
    await chrome.alarms.clear(UNATTENDED_KEEPALIVE_ALARM).catch(() => {});
    // Nobody is watching this tab, and nothing else closes it: the executor's cleanup detaches the
    // debugger but never removes tabs, and the task group is deliberately left in place for a task
    // the user can see. One tab per scheduled run, every run, was accumulating forever.
    if (runTabId !== null) {
      try {
        await browserContext.cleanup();
      } catch (cleanupError) {
        logger.error('Failed to clean up the unattended browser context:', cleanupError);
      }
      try {
        await chrome.tabs.remove(runTabId);
      } catch (removeError) {
        logger.error(`Failed to close the unattended tab ${runTabId}:`, removeError);
      }
    }
  }

  // Read BEFORE this run's session is written, or the comparison finds itself.
  const previousRun =
    input.watch && input.scheduleId !== undefined ? await previousScheduledDataset(input.scheduleId) : undefined;

  // The result lands in chat history so the side panel can show the full session later.
  try {
    const session = await chatHistoryStore.createSession(input.title || input.prompt.slice(0, 60), input.scheduleId);
    await chatHistoryStore.addMessage(session.id, {
      actor: Actors.USER,
      content: input.prompt,
      timestamp: startedAt,
    });
    await chatHistoryStore.addMessage(session.id, {
      actor: Actors.SYSTEM,
      content: outcome.text,
      timestamp: Date.now(),
      // Nobody was watching this run, so the stored message is the only copy of what it collected.
      ...(collected && collected.rows.length > 0 ? { dataset: collected } : {}),
    });
  } catch (error) {
    logger.error('Failed to save unattended task result:', error);
  }

  if (input.watch && outcome.ok) {
    const comparison = compareRuns(previousRun, collected);
    if (!comparison.changed) {
      // The point of a watch: silence means "ran, nothing moved". The session is still written, so
      // the user can open the history and see that it ran.
      logger.info(`Watch "${input.title}" found no change; no notification sent`);
      return;
    }
    if (comparison.reason === 'not-tabular') {
      // Prose is never compared - a model words the same fact differently every day - so say
      // outright that this watch cannot stay silent rather than notifying as though it had changed.
      notifySchedule(t('bg_watch_notTabular_title', [input.title]), t('bg_watch_notTabular_body'));
      return;
    }
    notifySchedule(
      t('bg_watch_changed_title', [input.title]),
      comparison.reason === 'no-previous'
        ? t('bg_watch_first_body', [String(comparison.added)])
        : t('bg_watch_changed_body', [describeComparison(comparison)]),
    );
    return;
  }

  notifySchedule(
    outcome.ok ? t('bg_sched_ok_title', [input.title]) : t('bg_sched_fail_title', [input.title]),
    outcome.text,
  );
}

/**
 * The rows the previous run of this schedule collected, or undefined when there was none.
 *
 * Only the most recent session is loaded, and only its messages: a watch compares against the run
 * before it, not against the whole history, and reading every session to find one would grow with
 * the user's history forever.
 */
async function previousScheduledDataset(scheduleId: number): Promise<MessageDataset | undefined> {
  try {
    const [mostRecent] = await chatHistoryStore.getSessionsForSchedule(scheduleId);
    if (!mostRecent) return undefined;
    const session = await chatHistoryStore.getSession(mostRecent.id);
    return session?.messages.find(message => message.dataset)?.dataset;
  } catch (error) {
    logger.error('Failed to read the previous run of this schedule:', error);
    return undefined;
  }
}

// Update subscribeToExecutorEvents to use port
async function subscribeToExecutorEvents(executor: Executor) {
  // Clear previous event listeners to prevent multiple subscriptions
  executor.clearExecutionEvents();

  // Subscribe to new events
  executor.subscribeExecutionEvents(async event => {
    try {
      if (currentPort) {
        currentPort.postMessage(event);
      }
    } catch (error) {
      logger.error('Failed to send message to side panel:', error);
    }

    if (event.state === ExecutionState.TASK_DATASET && currentTaskMeta) {
      currentTaskMeta.dataset = event.data?.payload as DatasetPayload | undefined;
    }

    if (
      event.state === ExecutionState.TASK_OK ||
      event.state === ExecutionState.TASK_FAIL ||
      event.state === ExecutionState.TASK_CANCEL
    ) {
      // The panel writes chat history while it is connected; with no port listening the outcome
      // would otherwise vanish and the session keep only the user's prompt.
      if (!currentPort) {
        void persistOutcomeWithoutPanel(event);
      }
      // One webhook per task: the meta slot is consumed by the first terminal event. The response
      // may carry a follow-up task (opt-in, chain-capped) - the two-way half of the webhook.
      if (currentTaskMeta) {
        const meta = currentTaskMeta;
        const outcome =
          event.state === ExecutionState.TASK_OK ? 'ok' : event.state === ExecutionState.TASK_FAIL ? 'fail' : 'cancel';
        void dispatchTaskWebhook({
          source: meta.source,
          task: meta.task,
          title: meta.title,
          startedAt: meta.startedAt,
          outcome,
          result: event.data?.details ?? '',
          finishedAt: Date.now(),
          // Passed unconditionally; dispatchTaskWebhook decides whether the user allowed it out.
          dataset: meta.dataset,
        }).then(followUp => {
          if (followUp) void runWebhookFollowUp(followUp, meta.chain + 1);
        });
        currentTaskMeta = null;
      }
      await currentExecutor?.cleanup();
    }
  });
}

/**
 * Write a task's outcome into its chat session when no panel was connected to hear it.
 *
 * The side panel is normally the writer of chat history, but it only writes what reaches it over
 * the port: a task that ended after the panel closed - including the cancel that closing the panel
 * itself triggers, and the cancel for a closed task tab - left the session holding the user's
 * prompt and nothing else.
 */
async function persistOutcomeWithoutPanel(event: AgentEvent): Promise<void> {
  const taskId = event.data?.taskId;
  // Unattended runs write their own session, dataset included; this path is only for sessions the
  // panel created and then stopped watching.
  if (!taskId || typeof taskId !== 'string' || taskId.startsWith('unattended-')) return;
  const details = event.data?.details ?? '';
  // Same fallback the panel applies: the executor reports the task id when the planner returned no
  // final answer, and a raw UUID is not an answer.
  const content =
    event.state === ExecutionState.TASK_OK && (!details || details === taskId) ? t('chat_result_completed') : details;
  // Read synchronously, before the terminal handler hands the meta slot to the webhook.
  const dataset = currentTaskMeta?.dataset;
  try {
    await chatHistoryStore.addMessage(taskId, {
      actor: Actors.SYSTEM,
      content,
      timestamp: event.timestamp,
      ...(dataset && dataset.rows.length > 0 ? { dataset } : {}),
    });
  } catch (error) {
    logger.error('Failed to save the task outcome to chat history:', error);
  }
}
