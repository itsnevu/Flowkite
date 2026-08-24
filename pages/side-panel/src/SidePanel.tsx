import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Actors,
  type Message,
  type ModelPricingConfig,
  type TrailStep,
  chatHistoryStore,
  generalSettingsStore,
  modelPricingStore,
} from '@extension/storage';
import { t } from '@extension/i18n';
import ChatHistoryList from './components/ChatHistoryList';
import ChatView from './components/ChatView';
import SetupGuide from './components/SetupGuide';
import SidePanelHeader from './components/SidePanelHeader';
import { bookmarkTitleForSession } from './utils';
import { useApprovalMode } from './hooks/useApprovalMode';
import { useBackgroundConnection } from './hooks/useBackgroundConnection';
import { useFavoritePrompts } from './hooks/useFavoritePrompts';
import { useModelConfigGate } from './hooks/useModelConfigGate';
import { useSpeechInput } from './hooks/useSpeechInput';
import { useTaskDispatch } from './hooks/useTaskDispatch';
import { useTaskStateHandler } from './hooks/useTaskStateHandler';
import type {
  ActionConfirmationPayload,
  BudgetPausePayload,
  DatasetPayload,
  HandoffPayload,
  PlanReviewPayload,
  TokenUsagePayload,
} from './types/event';
import type { LiveStatus } from './types/status';
import './SidePanel.css';

// Declare chrome API types
declare global {
  interface Window {
    chrome: typeof chrome;
  }
}

const SidePanel = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputEnabled, setInputEnabled] = useState(true);
  const [showStopButton, setShowStopButton] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [chatSessions, setChatSessions] = useState<Array<{ id: string; title: string; createdAt: number }>>([]);
  const [isFollowUpMode, setIsFollowUpMode] = useState(false);
  const [isHistoricalSession, setIsHistoricalSession] = useState(false);
  const [isProcessingSpeech, setIsProcessingSpeech] = useState(false);
  const [isReplaying, setIsReplaying] = useState(false);
  const [pendingPlan, setPendingPlan] = useState<PlanReviewPayload | null>(null);
  const [pendingAction, setPendingAction] = useState<ActionConfirmationPayload | null>(null);
  const [pendingBudget, setPendingBudget] = useState<BudgetPausePayload | null>(null);
  const [pendingHandoff, setPendingHandoff] = useState<HandoffPayload | null>(null);
  const [modelPrices, setModelPrices] = useState<ModelPricingConfig>({});
  const [budgetUsd, setBudgetUsd] = useState(0);
  const [canUndo, setCanUndo] = useState(false);
  const [tokenUsage, setTokenUsage] = useState<TokenUsagePayload | null>(null);
  const [liveStatus, setLiveStatus] = useState<LiveStatus | null>(null);
  const [trail, setTrail] = useState<TrailStep[]>([]);
  const sessionIdRef = useRef<string | null>(null);
  const isReplayingRef = useRef<boolean>(false);
  /**
   * The trail is held as a ref as well as state. The event handler is captured once by the port
   * listener, so it can never read the state copy - it would read whatever the trail was when the
   * connection opened. The state copy exists only so React re-renders the live strip.
   */
  const trailRef = useRef<TrailStep[]>([]);
  /**
   * The rows the running task has collected, held for the same reason as the trail: the terminal
   * event is what attaches them to the message, and by then the event that carried them is gone.
   */
  const datasetRef = useRef<DatasetPayload | null>(null);
  /** true once a task has produced its one message, so a second terminal event adds nothing */
  const taskSettledRef = useRef<boolean>(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const setInputTextRef = useRef<((text: string) => void) | null>(null);

  const { hasConfiguredModels, replayEnabled, recheck: recheckModelConfig } = useModelConfigGate();
  const { favoritePrompts, addPrompt, updatePromptTitle, removePrompt, reorderPrompts } = useFavoritePrompts();
  // Bookmarks are keyed by content and sessions by id, and the history list only ever holds
  // metadata - the derived title is the one thing both sides can be compared on without loading
  // every session's messages.
  const bookmarkedTitles = new Set(favoritePrompts.map(prompt => prompt.title));

  useEffect(() => {
    sessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  useEffect(() => {
    isReplayingRef.current = isReplaying;
  }, [isReplaying]);

  const appendMessage = useCallback((newMessage: Message, sessionId?: string | null) => {
    setMessages(prev => [...prev, newMessage]);

    // Use provided sessionId if available, otherwise fall back to sessionIdRef.current
    const effectiveSessionId = sessionId !== undefined ? sessionId : sessionIdRef.current;

    // Save message to storage if we have a session
    if (effectiveSessionId) {
      chatHistoryStore
        .addMessage(effectiveSessionId, newMessage)
        .catch(err => console.error('Failed to save message to history:', err));
    }
  }, []);

  const pushTrail = useCallback((step: TrailStep) => {
    trailRef.current = [...trailRef.current, step];
    setTrail(trailRef.current);
  }, []);

  const resetTrail = useCallback(() => {
    trailRef.current = [];
    setTrail([]);
  }, []);

  const captureDataset = useCallback((dataset: DatasetPayload | null) => {
    datasetRef.current = dataset;
  }, []);

  /**
   * The single message a task is allowed to leave behind, carrying the steps that produced it.
   *
   * Capped at the last 200 entries: a 100-step task would otherwise write a large blob into every
   * session, and the tail is the part that explains how the task ended.
   */
  const finalizeTask = useCallback(
    (message: Message) => {
      const steps = trailRef.current.slice(-200);
      const dataset = datasetRef.current;
      appendMessage({
        ...message,
        ...(steps.length > 0 ? { steps } : {}),
        // Uncapped, unlike the trail: these rows are the result the user asked for, not a record of
        // how it was reached, and the collector already bounds them.
        ...(dataset && dataset.rows.length > 0 ? { dataset } : {}),
      });
      setLiveStatus(null);
    },
    [appendMessage],
  );

  /**
   * A dropped service worker is not a terminal event, so nothing would ever settle the task: the
   * status line would simply freeze. Close the task out with a record that it was cut short.
   */
  const handleConnectionLost = useCallback(() => {
    setLiveStatus(null);
    if (taskSettledRef.current || trailRef.current.length === 0) return;
    taskSettledRef.current = true;
    finalizeTask({ actor: Actors.SYSTEM, content: t('chat_task_interrupted'), timestamp: Date.now() });
  }, [finalizeTask]);

  const handleTaskState = useTaskStateHandler({
    finalizeTask,
    setLiveStatus,
    pushTrail,
    resetTrail,
    captureDataset,
    taskSettledRef,
    isReplayingRef,
    setCanUndo,
    setTokenUsage,
    setIsHistoricalSession,
    setPendingPlan,
    setPendingAction,
    setPendingBudget,
    setPendingHandoff,
    setInputEnabled,
    setShowStopButton,
    setIsFollowUpMode,
    setIsReplaying,
  });

  const { portRef, setupConnection, stopConnection, sendMessage } = useBackgroundConnection({
    onExecutionEvent: handleTaskState,
    onConnectionLost: handleConnectionLost,
    appendMessage,
    setInputEnabled,
    setShowStopButton,
    setIsProcessingSpeech,
    setInputTextRef,
  });

  const {
    mode: approvalMode,
    selectMode,
    pendingAutoNotice,
    acknowledgeAuto,
    dismissAutoNotice,
  } = useApprovalMode({
    portRef,
  });

  const { isRecording, handleMicClick } = useSpeechInput({
    portRef,
    setupConnection,
    appendMessage,
    setIsProcessingSpeech,
  });

  const { handleReplay, handleSendMessage, handleStopTask, handlePlanDecision, handleUndo, handleActionDecision } =
    useTaskDispatch({
      portRef,
      setupConnection,
      sendMessage,
      stopConnection,
      appendMessage,
      setLiveStatus,
      replayEnabled,
      isHistoricalSession,
      isFollowUpMode,
      taskRunning: showStopButton,
      sessionIdRef,
      setMessages,
      setCurrentSessionId,
      setInputEnabled,
      setShowStopButton,
      setIsFollowUpMode,
      setIsHistoricalSession,
      setIsReplaying,
      setPendingPlan,
      setPendingAction,
      setCanUndo,
      approvalMode,
    });

  /**
   * The user's answer to the budget card. Continuing resumes the parked executor — the brake
   * stays released for the rest of the task, which the card said out loud; stopping is the same
   * cancel as the Stop key.
   */
  /**
   * The user's answer to the handoff card. "Done" releases the parked navigator, which re-reads
   * the page on its next step; "Stop" is the same cancel as the Stop key. Input stays disabled on
   * "done" - the task is still running, it was only waiting for the hands-on step.
   */
  const handleHandoffDecision = useCallback(
    (done: boolean) => {
      setPendingHandoff(null);
      if (done) {
        // A real try/catch. `sendMessage` throws synchronously when the port is gone, and the
        // argument is evaluated before `Promise.resolve` ever runs - so wrapping it in a promise
        // caught nothing and let the throw escape the event handler, leaving the card dismissed
        // and the navigator still parked.
        try {
          sendMessage({ type: 'handoff_done' });
        } catch (err) {
          appendMessage({
            actor: Actors.SYSTEM,
            content: err instanceof Error ? err.message : t('errors_conn_serviceWorker'),
            timestamp: Date.now(),
          });
          setInputEnabled(true);
        }
      } else {
        void handleStopTask();
      }
    },
    [sendMessage, handleStopTask],
  );

  const handleBudgetDecision = useCallback(
    (keepGoing: boolean) => {
      setPendingBudget(null);
      if (keepGoing) {
        try {
          sendMessage({ type: 'resume_task' });
        } catch (err) {
          appendMessage({
            actor: Actors.SYSTEM,
            content: err instanceof Error ? err.message : t('errors_conn_serviceWorker'),
            timestamp: Date.now(),
          });
          setInputEnabled(true);
        }
      } else {
        void handleStopTask();
      }
    },
    [sendMessage, handleStopTask],
  );

  // The $ readouts and the plan card's budget line follow settings live, so a price or budget
  // edited in Options lands here without reopening the panel.
  useEffect(() => {
    modelPricingStore.getAllPrices().then(setModelPrices).catch(console.error);
    const unsubscribePrices = modelPricingStore.subscribe(() => {
      modelPricingStore.getAllPrices().then(setModelPrices).catch(console.error);
    });
    generalSettingsStore
      .getSettings()
      .then(s => setBudgetUsd(s.maxCostUsd))
      .catch(console.error);
    const unsubscribeSettings = generalSettingsStore.subscribe(() => {
      generalSettingsStore
        .getSettings()
        .then(s => setBudgetUsd(s.maxCostUsd))
        .catch(console.error);
    });
    return () => {
      unsubscribePrices();
      unsubscribeSettings();
    };
  }, []);

  const handleNewChat = () => {
    // Clear messages and start a new chat
    setMessages([]);
    setCurrentSessionId(null);
    sessionIdRef.current = null;
    setInputEnabled(true);
    setShowStopButton(false);
    setIsFollowUpMode(false);
    setIsHistoricalSession(false);
    setPendingPlan(null);
    setPendingAction(null);
    setPendingBudget(null);
    setPendingHandoff(null);
    setCanUndo(false);
    // New chat is the panel's universal escape hatch, so it clears this too - otherwise a
    // transcription that never came back leaves the mic disabled for the whole session.
    setIsProcessingSpeech(false);
    // the background tracker's lifetime is the Executor's, which stopConnection ends
    setTokenUsage(null);
    setLiveStatus(null);
    resetTrail();
    taskSettledRef.current = false;

    // Disconnect any existing connection
    stopConnection();
  };

  // Persist the running total so reopening this session later still shows what it cost. Kept here
  // rather than in the event handler: the snapshot is cumulative and idempotent, so writing the
  // latest value is always correct and a dropped event costs freshness, never accuracy.
  useEffect(() => {
    if (!tokenUsage || !currentSessionId) return;
    chatHistoryStore
      .storeTokenUsage(currentSessionId, tokenUsage)
      .catch(err => console.error('Failed to save token usage:', err));
  }, [tokenUsage, currentSessionId]);

  const loadChatSessions = useCallback(async () => {
    try {
      const sessions = await chatHistoryStore.getSessionsMetadata();
      setChatSessions(sessions.sort((a, b) => b.createdAt - a.createdAt));
    } catch (error) {
      console.error('Failed to load chat sessions:', error);
    }
  }, []);

  const handleLoadHistory = async () => {
    await loadChatSessions();
    setShowHistory(true);
  };

  const handleBackToChat = (reset = false) => {
    setShowHistory(false);
    if (reset) {
      setCurrentSessionId(null);
      setMessages([]);
      setIsFollowUpMode(false);
      setIsHistoricalSession(false);
    }
  };

  const handleSessionSelect = async (sessionId: string) => {
    try {
      const fullSession = await chatHistoryStore.getSession(sessionId);
      if (fullSession && fullSession.messages.length > 0) {
        setCurrentSessionId(fullSession.id);
        setMessages(fullSession.messages);
        setIsFollowUpMode(false);
        setIsHistoricalSession(true); // Mark this as a historical session
        // show what THIS session spent, not whatever the last live task happened to leave on screen
        setTokenUsage(await chatHistoryStore.loadTokenUsage(sessionId));
        // whatever the previous task was doing is not what this stored session shows
        setLiveStatus(null);
        resetTrail();
        taskSettledRef.current = false;
      }
      setShowHistory(false);
    } catch (error) {
      console.error('Failed to load session:', error);
    }
  };

  const handleSessionDelete = async (sessionId: string) => {
    try {
      await chatHistoryStore.deleteSession(sessionId);
      await loadChatSessions();
      if (sessionId === currentSessionId) {
        setMessages([]);
        setCurrentSessionId(null);
      }
    } catch (error) {
      console.error('Failed to delete session:', error);
    }
  };

  const handleSessionRename = async (sessionId: string, title: string) => {
    try {
      await chatHistoryStore.updateTitle(sessionId, title);
      await loadChatSessions();
    } catch (error) {
      console.error('Failed to rename session:', error);
    }
  };

  /**
   * Send a past task back to the composer.
   *
   * Deliberately a prefill rather than an immediate re-run. A task usually comes back here because
   * it went wrong, and the fix is nearly always a word or two in the prompt - re-running it
   * untouched would just reproduce the failure, at the user's expense. It also lands the user back
   * in the chat, because a composer they cannot see is a button that appears to do nothing.
   */
  const handleSessionReuse = async (sessionId: string) => {
    try {
      const fullSession = await chatHistoryStore.getSession(sessionId);
      if (!fullSession) return;
      // Same rule as bookmarking: the first message is the task the user typed, and the title
      // stands in for a session whose messages were never stored.
      const taskContent = fullSession.messages[0]?.content || fullSession.title;
      handleBackToChat(true);
      setInputTextRef.current?.(taskContent);
    } catch (error) {
      console.error('Failed to reuse session prompt:', error);
    }
  };

  /**
   * Pin a past session to the bookmark strip.
   *
   * Two things this deliberately does not do. It does not bail when the session has no stored
   * messages - a task that died on its first step still has a title worth keeping, and bailing
   * showed the user nothing at all, which is indistinguishable from the button being broken. And
   * it does not navigate back to the chat: bookmarking is not leaving, and being thrown out of the
   * list was the only feedback the action had. The filled icon is the feedback now.
   */
  const handleSessionBookmark = async (sessionId: string) => {
    try {
      const fullSession = await chatHistoryStore.getSession(sessionId);
      if (!fullSession) return;

      const title = bookmarkTitleForSession(fullSession.title);
      // The first message is the task the user typed; the title stands in when nothing was stored.
      const taskContent = fullSession.messages[0]?.content || fullSession.title;

      await addPrompt(title, taskContent);
    } catch (error) {
      console.error('Failed to pin session to favorites:', error);
    }
  };

  const handleBookmarkSelect = (content: string) => {
    if (setInputTextRef.current) {
      setInputTextRef.current(content);
    }
  };

  /**
   * Prefill handed over by the background's context menu. Session storage is the hand-off point
   * because it works in every panel state: a panel this click just opened reads the key on mount,
   * a panel that was already sitting open hears the onChanged event. Gated on the model check so
   * the composer (and with it setInputTextRef) actually exists before the text is spent - the key
   * is only cleared once it has landed in the input.
   */
  useEffect(() => {
    if (hasConfiguredModels !== true) return undefined;

    const applyPendingPrefill = async () => {
      try {
        const { pendingPrefill } = await chrome.storage.session.get('pendingPrefill');
        const text = (pendingPrefill as { text?: unknown } | undefined)?.text;
        if (typeof text === 'string' && text && setInputTextRef.current) {
          setInputTextRef.current(text);
          await chrome.storage.session.remove('pendingPrefill');
        }
      } catch (error) {
        console.error('Failed to read context-menu prefill:', error);
      }
    };

    const onSessionChanged = (changes: { [key: string]: chrome.storage.StorageChange }) => {
      if (changes.pendingPrefill?.newValue) void applyPendingPrefill();
    };

    void applyPendingPrefill();
    chrome.storage.session.onChanged.addListener(onSessionChanged);
    return () => chrome.storage.session.onChanged.removeListener(onSessionChanged);
  }, [hasConfiguredModels]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopConnection();
    };
  }, [stopConnection]);

  // Scroll to bottom when new messages arrive
  // biome-ignore lint/correctness/useExhaustiveDependencies: <explanation>
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-canvas">
      <SidePanelHeader
        showHistory={showHistory}
        onBack={() => handleBackToChat(false)}
        onNewChat={handleNewChat}
        onLoadHistory={handleLoadHistory}
      />
      {showHistory ? (
        <div className="flex-1 overflow-hidden">
          <ChatHistoryList
            sessions={chatSessions}
            onSessionSelect={handleSessionSelect}
            onSessionDelete={handleSessionDelete}
            onSessionBookmark={handleSessionBookmark}
            onSessionRename={handleSessionRename}
            onSessionReuse={handleSessionReuse}
            bookmarkedTitles={bookmarkedTitles}
            visible={true}
          />
        </div>
      ) : (
        <>
          {/* Show loading state while checking model configuration */}
          {hasConfiguredModels === null && (
            <div className="flex flex-1 items-center justify-center p-6">
              <div className="flex flex-col items-center rounded-slab bg-canvas-raised px-8 py-7 text-center shadow-neu">
                <div className="mb-4 size-8 animate-spin rounded-pill border-2 border-graphite-200 border-t-graphite-800" />
                <p className="text-sm text-ink-soft">{t('status_checkingConfig')}</p>
              </div>
            </div>
          )}

          {/* Show setup message when no models are configured */}
          {hasConfiguredModels === false && <SetupGuide onConfigured={recheckModelConfig} />}

          {/* Show normal chat interface when models are configured */}
          {hasConfiguredModels === true && (
            <ChatView
              messages={messages}
              favoritePrompts={favoritePrompts}
              inputEnabled={inputEnabled}
              showStopButton={showStopButton}
              isRecording={isRecording}
              isProcessingSpeech={isProcessingSpeech}
              isHistoricalSession={isHistoricalSession}
              replayEnabled={replayEnabled}
              currentSessionId={currentSessionId}
              pendingPlan={pendingPlan}
              pendingAction={pendingAction}
              pendingBudget={pendingBudget}
              pendingHandoff={pendingHandoff}
              canUndo={canUndo}
              liveStatus={liveStatus}
              trail={trail}
              tokenUsage={tokenUsage}
              messagesEndRef={messagesEndRef}
              onSetInputText={setter => {
                setInputTextRef.current = setter;
              }}
              onSendMessage={handleSendMessage}
              onStopTask={handleStopTask}
              onMicClick={handleMicClick}
              onReplay={handleReplay}
              onBookmarkSelect={handleBookmarkSelect}
              onBookmarkUpdateTitle={updatePromptTitle}
              onBookmarkDelete={removePrompt}
              onBookmarkReorder={reorderPrompts}
              onPlanDecision={handlePlanDecision}
              onActionDecision={handleActionDecision}
              onBudgetDecision={handleBudgetDecision}
              onHandoffDecision={handleHandoffDecision}
              onUndo={handleUndo}
              modelPrices={modelPrices}
              budgetUsd={budgetUsd}
              approvalMode={approvalMode}
              onApprovalModeSelect={selectMode}
              pendingAutoNotice={pendingAutoNotice}
              onAcknowledgeAuto={acknowledgeAuto}
              onDismissAutoNotice={dismissAutoNotice}
            />
          )}
        </>
      )}
    </div>
  );
};

export default SidePanel;
