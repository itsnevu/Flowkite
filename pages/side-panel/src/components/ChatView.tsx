import { t } from '@extension/i18n';
import { estimateCostUsd } from '@extension/storage';
import MessageList from './MessageList';
import ChatInput from './ChatInput';
import BookmarkList from './BookmarkList';
import PlanReviewCard from './PlanReviewCard';
import ActionConfirmCard from './ActionConfirmCard';
import AutoModeNotice from './AutoModeNotice';
import BudgetPauseCard from './BudgetPauseCard';
import HandoffCard from './HandoffCard';
import TokenUsageBar from './TokenUsageBar';
import SessionFeedbackBar from './SessionFeedbackBar';
import LiveStatusStrip from './LiveStatusStrip';
import type { RefObject } from 'react';
import type { ApprovalMode, Message, ModelPricingConfig, TrailStep } from '@extension/storage';
import type { FavoritePrompt } from '@extension/storage/lib/prompt/favorites';
import type {
  ActionConfirmationPayload,
  BudgetPausePayload,
  HandoffPayload,
  PlanReviewPayload,
  TokenUsagePayload,
} from '../types/event';
import type { LiveStatus } from '../types/status';

interface ChatViewProps {
  messages: Message[];
  favoritePrompts: FavoritePrompt[];
  inputEnabled: boolean;
  showStopButton: boolean;
  isRecording: boolean;
  isProcessingSpeech: boolean;
  isHistoricalSession: boolean;
  replayEnabled: boolean;
  currentSessionId: string | null;
  pendingPlan: PlanReviewPayload | null;
  pendingAction: ActionConfirmationPayload | null;
  /** the budget brake asking whether to keep spending, or null when it is not */
  pendingBudget: BudgetPausePayload | null;
  /** the step the agent asked the user to do by hand, or null when it did not */
  pendingHandoff: HandoffPayload | null;
  canUndo: boolean;
  /** what the running task is doing right now, or null when nothing is running */
  liveStatus: LiveStatus | null;
  /** the steps the running task has taken so far, shown collapsed under the status line */
  trail: TrailStep[];
  tokenUsage: TokenUsagePayload | null;
  messagesEndRef: RefObject<HTMLDivElement>;
  onSetInputText: (setter: (text: string) => void) => void;
  onSendMessage: (text: string, displayText?: string) => void | boolean | Promise<void | boolean>;
  onStopTask: () => void;
  onMicClick: () => void;
  onReplay: (sessionId: string) => void;
  onBookmarkSelect: (content: string) => void;
  onBookmarkUpdateTitle: (id: number, title: string) => void;
  onBookmarkDelete: (id: number) => void;
  onBookmarkReorder: (draggedId: number, targetId: number) => void;
  onPlanDecision: (approved: boolean) => void;
  onActionDecision: (approved: boolean) => void;
  /** true continues past the budget, false stops the task */
  onBudgetDecision: (keepGoing: boolean) => void;
  /** true means the user finished the hands-on step, false stops the task */
  onHandoffDecision: (done: boolean) => void;
  onUndo: () => void;
  /** the user's own USD-per-MTok price entries, for the $ readouts */
  modelPrices: ModelPricingConfig;
  /** the per-task budget from settings; 0 means none */
  budgetUsd: number;
  /** how much the user signs off on before the agent acts */
  approvalMode: ApprovalMode;
  onApprovalModeSelect: (mode: ApprovalMode) => void;
  /** true while the user is being shown, once, what Auto gives up */
  pendingAutoNotice: boolean;
  onAcknowledgeAuto: () => void;
  onDismissAutoNotice: () => void;
}

/**
 * The chat surface itself, shown once at least one model is configured. An empty transcript
 * leads with the composer and the pinned prompts; once the conversation starts, the transcript
 * takes the space and the composer drops to the bottom.
 */
const ChatView = ({
  messages,
  favoritePrompts,
  inputEnabled,
  showStopButton,
  isRecording,
  isProcessingSpeech,
  isHistoricalSession,
  replayEnabled,
  currentSessionId,
  pendingPlan,
  pendingAction,
  pendingBudget,
  pendingHandoff,
  canUndo,
  liveStatus,
  trail,
  tokenUsage,
  messagesEndRef,
  onSetInputText,
  onSendMessage,
  onStopTask,
  onMicClick,
  onReplay,
  onBookmarkSelect,
  onBookmarkUpdateTitle,
  onBookmarkDelete,
  onBookmarkReorder,
  onPlanDecision,
  onActionDecision,
  onBudgetDecision,
  onHandoffDecision,
  onUndo,
  modelPrices,
  budgetUsd,
  approvalMode,
  onApprovalModeSelect,
  pendingAutoNotice,
  onAcknowledgeAuto,
  onDismissAutoNotice,
}: ChatViewProps) => (
  <>
    {messages.length === 0 && (
      <>
        <div className="shrink-0 px-3 pb-2">
          <ChatInput
            onSendMessage={onSendMessage}
            onStopTask={onStopTask}
            onMicClick={onMicClick}
            isRecording={isRecording}
            isProcessingSpeech={isProcessingSpeech}
            // A run in flight keeps the composer live: what is typed there becomes a correction
            // rather than a task, which is the point of steering. A stored session keeps it live
            // too - a send there continues the conversation as a new task.
            disabled={!inputEnabled && !showStopButton}
            showStopButton={showStopButton}
            setContent={onSetInputText}
            isHistoricalSession={isHistoricalSession}
            historicalSessionId={isHistoricalSession && replayEnabled ? currentSessionId : null}
            onReplay={onReplay}
            approvalMode={approvalMode}
            onApprovalModeSelect={onApprovalModeSelect}
          />
        </div>
        <div className="flex-1 overflow-y-auto px-1 pb-2">
          <BookmarkList
            bookmarks={favoritePrompts}
            onBookmarkSelect={onBookmarkSelect}
            onBookmarkUpdateTitle={onBookmarkUpdateTitle}
            onBookmarkDelete={onBookmarkDelete}
            onBookmarkReorder={onBookmarkReorder}
          />
        </div>
      </>
    )}
    {messages.length > 0 && (
      <div className="scrollbar-gutter-stable flex-1 overflow-x-hidden overflow-y-scroll scroll-smooth px-3 py-1">
        <MessageList messages={messages} />
        <div ref={messagesEndRef} />
      </div>
    )}
    {pendingAutoNotice && <AutoModeNotice onConfirm={onAcknowledgeAuto} onDismiss={onDismissAutoNotice} />}
    {pendingPlan && (
      <PlanReviewCard
        plan={pendingPlan}
        onApprove={() => onPlanDecision(true)}
        onReject={() => onPlanDecision(false)}
        spentUsd={tokenUsage ? estimateCostUsd(tokenUsage.byModel, modelPrices).usd : null}
        spentIsFloor={tokenUsage ? estimateCostUsd(tokenUsage.byModel, modelPrices).unpricedModels.length > 0 : false}
        budgetUsd={budgetUsd}
      />
    )}
    {pendingAction && (
      <ActionConfirmCard
        request={pendingAction}
        onConfirm={() => onActionDecision(true)}
        onDecline={() => onActionDecision(false)}
      />
    )}
    {pendingBudget && !pendingPlan && !pendingAction && (
      <BudgetPauseCard
        pause={pendingBudget}
        onContinue={() => onBudgetDecision(true)}
        onStop={() => onBudgetDecision(false)}
      />
    )}
    {pendingHandoff && !pendingPlan && !pendingAction && !pendingBudget && (
      <HandoffCard
        request={pendingHandoff}
        onDone={() => onHandoffDecision(true)}
        onStop={() => onHandoffDecision(false)}
      />
    )}
    {canUndo && !pendingPlan && !pendingAction && !pendingBudget && !pendingHandoff && !isHistoricalSession && (
      <div className="shrink-0 px-3 pb-1 pt-2">
        <button
          type="button"
          onClick={onUndo}
          className="w-full rounded-soft bg-canvas-raised px-3 py-2 text-xs font-medium text-ink-soft shadow-neu-sm transition-all duration-150 ease-press hover:text-ink hover:shadow-neu active:shadow-neu-inset-sm">
          ↩ {t('chat_undo')}
        </button>
      </div>
    )}
    {liveStatus && !pendingPlan && !pendingAction && !pendingBudget && !pendingHandoff && (
      <LiveStatusStrip status={liveStatus} trail={trail} />
    )}
    {/* Stays visible under the budget card on purpose: the spend it shows is that card's context. */}
    {tokenUsage && messages.length > 0 && !pendingPlan && !pendingAction && (
      <TokenUsageBar usage={tokenUsage} prices={modelPrices} />
    )}
    {/* Below the spend, above the composer: the last thing read before typing, and never during a
        run or while a card is waiting on an answer. */}
    {messages.length > 0 && !pendingPlan && !pendingAction && !pendingBudget && !pendingHandoff && (
      <SessionFeedbackBar busy={showStopButton} />
    )}
    {messages.length > 0 && (
      <div className="shrink-0 px-3 pb-3 pt-2">
        <ChatInput
          onSendMessage={onSendMessage}
          onStopTask={onStopTask}
          onMicClick={onMicClick}
          isRecording={isRecording}
          isProcessingSpeech={isProcessingSpeech}
          // A run in flight keeps the composer live: what is typed there becomes a correction
          // rather than a task, which is the point of steering. A stored session keeps it live
          // too - a send there continues the conversation as a new task.
          disabled={!inputEnabled && !showStopButton}
          showStopButton={showStopButton}
          setContent={onSetInputText}
          isHistoricalSession={isHistoricalSession}
          historicalSessionId={isHistoricalSession && replayEnabled ? currentSessionId : null}
          onReplay={onReplay}
          approvalMode={approvalMode}
          onApprovalModeSelect={onApprovalModeSelect}
        />
      </div>
    )}
  </>
);

export default ChatView;
