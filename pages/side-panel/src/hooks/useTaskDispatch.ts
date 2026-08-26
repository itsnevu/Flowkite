import { Actors, chatHistoryStore } from '@extension/storage';
import { t } from '@extension/i18n';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { ApprovalMode, Message } from '@extension/storage';
import type { ActionConfirmationPayload, PlanReviewPayload } from '../types/event';
import type { LiveStatus } from '../types/status';

/**
 * Post to the background worker, or throw so the caller's catch can tell the user.
 *
 * The handlers below each wrap their post in a try/catch that appends a system message when the
 * answer does not get through. Optional-chaining the post defeats exactly that: a dropped port
 * makes it a no-op, the catch never runs, and the card disappears as though the answer had been
 * delivered - so the user believes they approved a step that never resumed.
 */
const postToBackground = (port: chrome.runtime.Port | null, message: unknown): void => {
  if (!port) {
    throw new Error(t('errors_conn_serviceWorker'));
  }
  port.postMessage(message);
};

interface TaskDispatchProps {
  /** posted to directly, so a re-render can never swap the port out from under a handler */
  portRef: MutableRefObject<chrome.runtime.Port | null>;
  setupConnection: () => void;
  sendMessage: (message: unknown) => void;
  stopConnection: () => void;
  appendMessage: (newMessage: Message, sessionId?: string | null) => void;
  setLiveStatus: Dispatch<SetStateAction<LiveStatus | null>>;
  replayEnabled: boolean;
  isHistoricalSession: boolean;
  isFollowUpMode: boolean;
  /** whether a task is in flight right now, which is what turns a send into a correction */
  taskRunning: boolean;
  /** mirrors currentSessionId, so a session created mid-handler is visible before re-render */
  sessionIdRef: MutableRefObject<string | null>;
  setMessages: Dispatch<SetStateAction<Message[]>>;
  setCurrentSessionId: Dispatch<SetStateAction<string | null>>;
  setInputEnabled: Dispatch<SetStateAction<boolean>>;
  setShowStopButton: Dispatch<SetStateAction<boolean>>;
  setIsFollowUpMode: Dispatch<SetStateAction<boolean>>;
  setIsHistoricalSession: Dispatch<SetStateAction<boolean>>;
  setIsReplaying: Dispatch<SetStateAction<boolean>>;
  setPendingPlan: Dispatch<SetStateAction<PlanReviewPayload | null>>;
  setPendingAction: Dispatch<SetStateAction<ActionConfirmationPayload | null>>;
  setCanUndo: Dispatch<SetStateAction<boolean>>;
  /**
   * The mode the composer is currently showing, attached to whatever task this dispatch starts.
   *
   * Sent with the task rather than left for the background to read from storage, because the
   * panel's write to chrome.storage is asynchronous: a user who picks a mode and immediately
   * presses Enter would otherwise start the task under the previous value. What the composer
   * visibly says is what the task it launched runs under.
   */
  approvalMode: ApprovalMode;
}

/**
 * Everything the user can ask of a task: start one, replay one, stop one, and answer the two
 * gates the agent can park on (a plan awaiting approval, an action awaiting confirmation).
 *
 * These are deliberately plain functions rather than memoised callbacks. Each one reads state
 * straight out of the current render, which is what keeps decisions like "is this a follow-up?"
 * honest; memoising them would freeze that state at the wrong moment.
 */
export const useTaskDispatch = ({
  portRef,
  setupConnection,
  sendMessage,
  stopConnection,
  appendMessage,
  setLiveStatus,
  replayEnabled,
  isHistoricalSession,
  isFollowUpMode,
  taskRunning,
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
}: TaskDispatchProps) => {
  // Handle replay command
  const handleReplay = async (historySessionId: string): Promise<void> => {
    try {
      // Check if replay is enabled in settings
      if (!replayEnabled) {
        appendMessage({
          actor: Actors.SYSTEM,
          content: t('chat_replay_disabled'),
          timestamp: Date.now(),
        });
        return;
      }

      // Check if history exists using loadAgentStepHistory
      const historyData = await chatHistoryStore.loadAgentStepHistory(historySessionId);
      if (!historyData) {
        appendMessage({
          actor: Actors.SYSTEM,
          content: t('chat_replay_noHistory', historySessionId.substring(0, 20)),
          timestamp: Date.now(),
        });
        return;
      }

      // Get current tab ID
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId = tabs[0]?.id;
      if (!tabId) {
        throw new Error('No active tab found');
      }

      // Clear messages if we're in a historical session
      if (isHistoricalSession) {
        setMessages([]);
      }

      // Create a new chat session for this replay task
      const newSession = await chatHistoryStore.createSession(`Replay of ${historySessionId.substring(0, 20)}...`);

      // Store the new session ID in both state and ref
      const newTaskId = newSession.id;
      setCurrentSessionId(newTaskId);
      sessionIdRef.current = newTaskId;

      // Send replay command to background
      setInputEnabled(false);
      setShowStopButton(true);

      // Reset follow-up mode and historical session flags
      setIsFollowUpMode(false);
      setIsHistoricalSession(false);

      const userMessage = {
        actor: Actors.USER,
        content: `/replay ${historySessionId}`,
        timestamp: Date.now(),
      };

      // Add the user message to the new session
      appendMessage(userMessage, sessionIdRef.current);

      // Setup connection if not exists
      if (!portRef.current) {
        setupConnection();
      }

      // Send replay command to background with the task from history
      portRef.current?.postMessage({
        type: 'replay',
        taskId: newTaskId,
        tabId: tabId,
        historySessionId: historySessionId,
        task: historyData.task, // Add the task from history
      });

      // Progress, not a result: it belongs on the status line the replay is about to drive.
      setLiveStatus({ actor: Actors.SYSTEM, text: t('chat_replay_starting', historyData.task) });
      setIsReplaying(true);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      appendMessage({
        actor: Actors.SYSTEM,
        content: t('chat_replay_failed', errorMessage),
        timestamp: Date.now(),
      });
    }
  };

  // Handle chat commands that start with /
  const handleCommand = async (command: string): Promise<boolean> => {
    try {
      // Setup connection if not exists
      if (!portRef.current) {
        setupConnection();
      }

      // Handle different commands
      if (command === '/state') {
        portRef.current?.postMessage({
          type: 'state',
        });
        return true;
      }

      if (command === '/nohighlight') {
        portRef.current?.postMessage({
          type: 'nohighlight',
        });
        return true;
      }

      if (command.startsWith('/replay ')) {
        // Parse replay command: /replay <historySessionId>
        // Handle multiple spaces by filtering out empty strings
        const parts = command.split(' ').filter(part => part.trim() !== '');
        if (parts.length !== 2) {
          appendMessage({
            actor: Actors.SYSTEM,
            content: t('chat_replay_invalidArgs'),
            timestamp: Date.now(),
          });
          return true;
        }

        const historySessionId = parts[1];
        await handleReplay(historySessionId);
        return true;
      }

      // Unsupported command
      appendMessage({
        actor: Actors.SYSTEM,
        content: t('errors_cmd_unknown', command),
        timestamp: Date.now(),
      });
      return true;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error('Command error', errorMessage);
      appendMessage({
        actor: Actors.SYSTEM,
        content: errorMessage,
        timestamp: Date.now(),
      });
      return true;
    }
  };

  const handleSendMessage = async (text: string, displayText?: string) => {
    // Trim the input text first
    const trimmedText = text.trim();

    if (!trimmedText) return;

    // Check if the input is a command (starts with /)
    if (trimmedText.startsWith('/')) {
      // Process command and return if it was handled
      const wasHandled = await handleCommand(trimmedText);
      if (wasHandled) return;
    }

    // A stored chat on screen while another task runs live: a send here can neither steer that
    // task legibly nor start a second one, so explain and redirect rather than dropping the text.
    // Shown, not persisted - the notice is about this moment, not part of the stored conversation.
    if (isHistoricalSession && taskRunning) {
      appendMessage({ actor: Actors.SYSTEM, content: t('chat_history_taskStillRunning'), timestamp: Date.now() }, null);
      return;
    }

    // A send while the agent is working is a correction, not a new task. It keeps everything the
    // run has already achieved, which is the whole reason for not making the user press Stop.
    if (taskRunning) {
      appendMessage({ actor: Actors.USER, content: displayText || text, timestamp: Date.now() }, sessionIdRef.current);
      try {
        await sendMessage({ type: 'steer', task: text, taskId: sessionIdRef.current });
      } catch (err) {
        appendMessage({
          actor: Actors.SYSTEM,
          content: err instanceof Error ? err.message : String(err),
          timestamp: Date.now(),
        });
      }
      return;
    }

    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId = tabs[0]?.id;
      if (!tabId) {
        throw new Error('No active tab found');
      }

      setInputEnabled(false);
      setShowStopButton(true);

      if (isHistoricalSession) {
        // Continuing a stored chat: keep its session so the new task's messages land in the same
        // conversation, and let the panel treat it as live again. The executor starts fresh - it
        // does not remember the stored run - which the composer's note says out loud.
        setIsHistoricalSession(false);
      } else if (!isFollowUpMode) {
        // Create a new chat session for this task
        // Use display text for session title if available, otherwise use full text
        const titleText = displayText || text;
        const newSession = await chatHistoryStore.createSession(
          titleText.substring(0, 50) + (titleText.length > 50 ? '...' : ''),
        );

        // Store the session ID in both state and ref
        const sessionId = newSession.id;
        setCurrentSessionId(sessionId);
        sessionIdRef.current = sessionId;
      }

      const userMessage = {
        actor: Actors.USER,
        content: displayText || text, // Use display text for chat UI, full text for background service
        timestamp: Date.now(),
      };

      // Pass the sessionId directly to appendMessage
      appendMessage(userMessage, sessionIdRef.current);

      // Setup connection if not exists
      if (!portRef.current) {
        setupConnection();
      }

      // Send message using the utility function
      if (isFollowUpMode) {
        // Send as follow-up task
        await sendMessage({
          type: 'follow_up_task',
          task: text,
          taskId: sessionIdRef.current,
          tabId,
          approvalMode,
        });
      } else {
        // Send as new task
        await sendMessage({
          type: 'new_task',
          task: text,
          taskId: sessionIdRef.current,
          tabId,
          approvalMode,
        });
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error('Task error', errorMessage);
      appendMessage({
        actor: Actors.SYSTEM,
        content: errorMessage,
        timestamp: Date.now(),
      });
      setInputEnabled(true);
      setShowStopButton(false);
      stopConnection();
    }
  };

  const handleStopTask = async () => {
    try {
      portRef.current?.postMessage({
        type: 'cancel_task',
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error('cancel_task error', errorMessage);
      appendMessage({
        actor: Actors.SYSTEM,
        content: errorMessage,
        timestamp: Date.now(),
      });
    }
    setInputEnabled(true);
    setShowStopButton(false);
  };

  const handlePlanDecision = (approved: boolean) => {
    setPendingPlan(null);
    try {
      postToBackground(portRef.current, {
        type: approved ? 'approve_plan' : 'reject_plan',
      });
      if (approved) {
        setInputEnabled(false);
        setShowStopButton(true);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error('plan review error', errorMessage);
      appendMessage({
        actor: Actors.SYSTEM,
        content: errorMessage,
        timestamp: Date.now(),
      });
      setInputEnabled(true);
    }
  };

  const handleUndo = () => {
    setCanUndo(false);
    try {
      postToBackground(portRef.current, { type: 'undo_last_step' });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error('undo_last_step error', errorMessage);
      appendMessage({
        actor: Actors.SYSTEM,
        content: errorMessage,
        timestamp: Date.now(),
      });
    }
  };

  const handleActionDecision = (approved: boolean) => {
    setPendingAction(null);
    try {
      postToBackground(portRef.current, { type: approved ? 'confirm_action' : 'decline_action' });
      setInputEnabled(false);
      setShowStopButton(true);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error('action confirmation error', errorMessage);
      appendMessage({ actor: Actors.SYSTEM, content: errorMessage, timestamp: Date.now() });
      setInputEnabled(true);
    }
  };

  return { handleReplay, handleSendMessage, handleStopTask, handlePlanDecision, handleUndo, handleActionDecision };
};
