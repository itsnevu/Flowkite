import { useCallback } from 'react';
import { Actors, chatHistoryStore, feedbackPromptStore } from '@extension/storage';
import { t } from '@extension/i18n';
import { ExecutionState } from '../types/event';
import { playTaskChime } from '../chime';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { Message, TrailKind, TrailStep } from '@extension/storage';
import type { LiveStatus } from '../types/status';
import type {
  ActionConfirmationPayload,
  AgentEvent,
  BudgetPausePayload,
  DatasetPayload,
  HandoffPayload,
  PlanReviewPayload,
  TokenUsagePayload,
} from '../types/event';

interface TaskStateHandlerProps {
  /** the one and only message a task is allowed to leave in the transcript */
  finalizeTask: (message: Message) => void;
  setLiveStatus: Dispatch<SetStateAction<LiveStatus | null>>;
  pushTrail: (step: TrailStep) => void;
  resetTrail: () => void;
  /** holds the collected rows until the terminal event attaches them; null clears a stale set */
  captureDataset: (dataset: DatasetPayload | null) => void;
  /** latched by the first terminal event, cleared on TASK_START; see the note on outcomes below */
  taskSettledRef: MutableRefObject<boolean>;
  /** read, never written, so the handler can stay stable while replay state changes */
  isReplayingRef: MutableRefObject<boolean>;
  /**
   * The taskId (= session id) of the run this panel launched, or null when it launched none.
   * Events carry their own taskId; anything that does not match - a scheduled run, a task an
   * earlier panel started - must not touch this panel's state or storage.
   */
  activeTaskIdRef: MutableRefObject<string | null>;
  setCanUndo: Dispatch<SetStateAction<boolean>>;
  setTokenUsage: Dispatch<SetStateAction<TokenUsagePayload | null>>;
  setIsHistoricalSession: Dispatch<SetStateAction<boolean>>;
  setPendingPlan: Dispatch<SetStateAction<PlanReviewPayload | null>>;
  setPendingAction: Dispatch<SetStateAction<ActionConfirmationPayload | null>>;
  setPendingBudget: Dispatch<SetStateAction<BudgetPausePayload | null>>;
  setPendingHandoff: Dispatch<SetStateAction<HandoffPayload | null>>;
  setInputEnabled: Dispatch<SetStateAction<boolean>>;
  setShowStopButton: Dispatch<SetStateAction<boolean>>;
  setIsFollowUpMode: Dispatch<SetStateAction<boolean>>;
  setIsReplaying: Dispatch<SetStateAction<boolean>>;
}

/**
 * Translates one execution event from the background worker into panel state.
 *
 * A task produces one message, not a running commentary. Every event is routed to exactly one of
 * three destinations:
 *
 *   - **status** — overwrites the live status line in place. Never persisted, by construction.
 *   - **trail**  — appended to the running step trail, which is shown collapsed while the task runs
 *                  and then attached to the task's one message, so a bad run stays inspectable.
 *   - **outcome** — the single persisted message. Exactly one per task, enforced by `taskSettledRef`.
 *
 * The latch is not paranoia: rejecting a plan emits PLAN_REJECTED and calls `stop()`, so the loop
 * breaks and emits TASK_CANCEL straight after it. Two terminal events, one task.
 *
 * The returned callback must stay referentially stable: it is captured once by the port's
 * message listener when the connection is opened, so a new identity per render would leave
 * that listener calling a stale copy. Every input above is stable (state setters, refs and
 * memoised callbacks), which is what keeps it that way.
 */
export const useTaskStateHandler = ({
  finalizeTask,
  setLiveStatus,
  pushTrail,
  resetTrail,
  captureDataset,
  taskSettledRef,
  isReplayingRef,
  activeTaskIdRef,
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
}: TaskStateHandlerProps) =>
  useCallback(
    (event: AgentEvent) => {
      const { actor, state, timestamp, data } = event;
      const content = data?.details;
      // The port forwards every run's events, not just ours: a scheduled run, or a task started by
      // a panel in another window. Applying those here would splice a stranger's outcome, spend and
      // status into whatever session this panel happens to have open - so anything this panel did
      // not launch is dropped whole. The background persists those runs' outcomes itself.
      if (typeof data?.taskId === 'string' && data.taskId !== activeTaskIdRef.current) {
        return;
      }
      // any step that reached the browser is a step the user may want to roll back
      if (state === ExecutionState.ACT_OK) {
        setCanUndo(true);
      }
      // Handled before the actor switch, whose default arm would log it as an invalid state. The
      // early return also keeps this per-call telemetry out of the persisted chat history.
      if (state === ExecutionState.TASK_USAGE) {
        const usage = (data?.payload as TokenUsagePayload) ?? null;
        setTokenUsage(usage);
        // Persisted here, keyed by the event's own taskId, rather than from a SidePanel effect
        // keyed by the session on screen: the user may be reading an old session while this task
        // spends, and its numbers must never overwrite that session's stored spend.
        if (usage && typeof data?.taskId === 'string') {
          void chatHistoryStore.storeTokenUsage(data.taskId, usage).catch(() => undefined);
        }
        return;
      }
      // Also handled before the actor switch, and for the same reason. It is not an outcome either:
      // the terminal event follows immediately and carries the rows out on the task's one message.
      if (state === ExecutionState.TASK_DATASET) {
        captureDataset((data?.payload as DatasetPayload) ?? null);
        return;
      }

      /** text for the live status line, or null to leave the current one standing */
      let status: string | null = null;
      /** how this event reads in the trail, or null to keep it out of the trail entirely */
      let trailKind: TrailKind | null = null;
      /** the task's outcome text — set only by terminal events, and only one of them wins */
      let outcome: string | null = null;

      switch (actor) {
        case Actors.SYSTEM:
          switch (state) {
            case ExecutionState.TASK_START:
              // Reset historical session flag when a new task starts
              setIsHistoricalSession(false);
              setCanUndo(false);
              // A fresh task gets a fresh trail, a fresh table, and a fresh right to produce an
              // outcome message.
              resetTrail();
              captureDataset(null);
              taskSettledRef.current = false;
              status = t('chat_status_working');
              break;
            case ExecutionState.PLAN_REVIEW:
              // the executor is blocked until the user answers, so take over the input area
              setPendingPlan((data?.payload as PlanReviewPayload) ?? null);
              setInputEnabled(false);
              return;
            case ExecutionState.PLAN_APPROVED:
              setPendingPlan(null);
              // Approval is not a result, it is the run continuing. It belongs on the status line.
              status = content || t('chat_status_working');
              break;
            case ExecutionState.PLAN_REJECTED:
              setPendingPlan(null);
              setPendingAction(null);
              setPendingBudget(null);
              setPendingHandoff(null);
              setInputEnabled(true);
              setShowStopButton(false);
              outcome = content || '';
              break;
            case ExecutionState.TASK_OK:
              setPendingPlan(null);
              setPendingAction(null);
              setPendingBudget(null);
              setPendingHandoff(null);
              setIsFollowUpMode(true);
              setInputEnabled(true);
              setShowStopButton(false);
              setIsReplaying(false);
              // Not awaited: the chime is an ornament and must not delay rendering the result.
              // Replays are silent - they are the user re-reading a task, not one finishing.
              if (!isReplayingRef.current) {
                void playTaskChime('ok');
              }
              // The executor falls back to the task id when the planner returned no final answer,
              // and a raw UUID is not an answer. Say plainly that the task finished instead.
              outcome = !content || content === data?.taskId ? t('chat_result_completed') : content;
              break;
            case ExecutionState.TASK_FAIL:
              setPendingPlan(null);
              setPendingAction(null);
              setPendingBudget(null);
              setPendingHandoff(null);
              setIsFollowUpMode(true);
              setInputEnabled(true);
              setShowStopButton(false);
              setIsReplaying(false);
              if (!isReplayingRef.current) {
                void playTaskChime('fail');
              }
              outcome = content || '';
              break;
            case ExecutionState.TASK_CANCEL:
              setPendingPlan(null);
              setPendingAction(null);
              setPendingBudget(null);
              setPendingHandoff(null);
              setIsFollowUpMode(false);
              setInputEnabled(true);
              setShowStopButton(false);
              setIsReplaying(false);
              outcome = content || '';
              break;
            case ExecutionState.TASK_PAUSE: {
              // carries the pause reason, e.g. the confirmation that a step was undone. A pause is
              // not an outcome - the task can still be resumed - so it only updates the status.
              // A budget pause additionally carries its numbers and raises the continue/stop card.
              const pausePayload = data?.payload as BudgetPausePayload | undefined;
              if (pausePayload?.kind === 'budget') {
                setPendingBudget(pausePayload);
              }
              status = content || null;
              break;
            }
            case ExecutionState.TASK_RESUME:
              setPendingBudget(null);
              break;
            default:
              console.error('Invalid task state', state);
              return;
          }
          break;
        case Actors.USER:
          break;
        case Actors.PLANNER:
          switch (state) {
            case ExecutionState.STEP_START:
              // The background's own detail here is a hardcoded English 'Planning...', so the panel
              // supplies its own localized wording rather than echoing it.
              status = t('chat_status_planning');
              break;
            case ExecutionState.STEP_OK:
              // The plan, including the final answer on the last run. Never persisted: TASK_OK
              // carries the identical answer moments later, and that is the message the user keeps.
              status = firstLine(content);
              trailKind = 'note';
              break;
            case ExecutionState.STEP_FAIL:
              // A failed plan neither throws nor counts against the failure budget, so the task can
              // still succeed. The trail is the only place that keeps the fact that it happened.
              status = content || null;
              trailKind = 'error';
              break;
            case ExecutionState.STEP_CANCEL:
              break;
            case ExecutionState.STEP_RETRY:
              status = content || null;
              trailKind = 'note';
              break;
            default:
              console.error('Invalid step state', state);
              return;
          }
          break;
        case Actors.NAVIGATOR:
          switch (state) {
            case ExecutionState.STEP_START:
              status = t('chat_status_acting');
              break;
            case ExecutionState.STEP_OK:
              break;
            case ExecutionState.STEP_FAIL:
              // The executor either retries or gives up into TASK_FAIL, which is the message.
              trailKind = 'error';
              break;
            case ExecutionState.STEP_CANCEL:
              break;
            case ExecutionState.STEP_RETRY:
              // a retry can take tens of seconds, so it has to reach the status line or the panel
              // reads as hung
              status = content || null;
              trailKind = 'note';
              break;
            case ExecutionState.ACT_START:
              // What the agent is about to do. `cache_content` is internal bookkeeping and `done` is
              // a raw schema name rather than a sentence - neither is something the user asked for.
              if (content && content !== 'cache_content' && content !== 'done') {
                status = content;
                trailKind = 'note';
              }
              break;
            case ExecutionState.ACT_OK:
              trailKind = 'ok';
              break;
            case ExecutionState.ACT_FAIL:
              status = content || null;
              trailKind = 'error';
              break;
            case ExecutionState.ACT_CONFIRM:
              // the navigator is blocked until the user answers, so take over the input area
              setPendingAction((data?.payload as ActionConfirmationPayload) ?? null);
              setInputEnabled(false);
              return;
            case ExecutionState.ACT_HANDOFF:
              // the navigator parked itself and handed the tab to the user; the card takes the input
              setPendingHandoff((data?.payload as HandoffPayload) ?? null);
              setInputEnabled(false);
              return;
            case ExecutionState.ACT_DECLINED:
              // The run continues after a decline, so this is a step, not an outcome.
              setPendingAction(null);
              setPendingHandoff(null);
              status = content || null;
              trailKind = 'error';
              break;
            default:
              console.error('Invalid action', state);
              return;
          }
          break;
        case Actors.VALIDATOR:
          // Handle legacy validator events from historical messages
          switch (state) {
            case ExecutionState.STEP_START:
              status = t('chat_status_acting');
              break;
            case ExecutionState.STEP_OK:
              status = firstLine(content);
              trailKind = 'note';
              break;
            case ExecutionState.STEP_FAIL:
              status = content || null;
              trailKind = 'error';
              break;
            default:
              console.error('Invalid validation', state);
              return;
          }
          break;
        default:
          console.error('Unknown actor', actor);
          return;
      }

      if (status) {
        setLiveStatus({ actor, text: status, step: data?.step, maxSteps: data?.maxSteps });
      }

      if (trailKind && content) {
        pushTrail({ actor, text: content, kind: trailKind, timestamp });
      }

      if (outcome !== null) {
        // The status line dies with the task either way, settled or not.
        setLiveStatus(null);
        if (!taskSettledRef.current) {
          taskSettledRef.current = true;
          finalizeTask({ actor, content: outcome, timestamp });
          // One tick toward the next "how is this going?". Counted on the same branch that writes
          // the outcome, so a task that emits two terminal events still counts once, and a replay
          // of a stored session - which never reaches here - counts not at all.
          void feedbackPromptStore.recordTaskCompleted().catch(() => undefined);
        }
      }
    },
    [
      finalizeTask,
      setLiveStatus,
      pushTrail,
      resetTrail,
      captureDataset,
      taskSettledRef,
      isReplayingRef,
      activeTaskIdRef,
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
    ],
  );

/**
 * The status line is one row tall. A plan arrives as a numbered list, so show its opening line
 * there and leave the whole thing to the trail.
 */
function firstLine(text: string | undefined): string | null {
  if (!text) return null;
  const line = text.split('\n').find(candidate => candidate.trim() !== '');
  return line ? line.trim() : null;
}
