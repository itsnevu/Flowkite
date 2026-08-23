import { useCallback, useEffect, useState } from 'react';
import { t } from '@extension/i18n';
import { analyticsSettingsStore, feedbackPromptStore, shouldPromptForFeedback } from '@extension/storage';
import type { SessionFeedbackRating } from '@extension/storage';

/**
 * Whether this build can report an answer anywhere at all.
 *
 * The same compile-time constant the Analytics settings pane reads. Without a telemetry key the
 * rating has nowhere to go, and a question whose answer is silently dropped is worse than no
 * question: it spends the user's attention and returns nothing. So the strip does not appear.
 */
const TELEMETRY_CONFIGURED = Boolean(import.meta.env.VITE_POSTHOG_API_KEY);

const RATINGS: readonly SessionFeedbackRating[] = ['bad', 'fine', 'good'];

/**
 * Where a "Bad" can turn into something actionable.
 *
 * A three-way rating says the run went badly and nothing about why, which is the least useful half
 * of the feedback. The offer to say more is made only on "Bad" - it is the only answer where the
 * user plausibly has something specific in mind, and asking everyone else would turn a one-tap
 * question into a chore.
 */
const ISSUES_URL = 'https://github.com/itsnevu/Flowkite/issues/new';

const RATING_LABEL: Record<SessionFeedbackRating, string> = {
  bad: 'chat_feedback_bad',
  fine: 'chat_feedback_fine',
  good: 'chat_feedback_good',
};

interface SessionFeedbackBarProps {
  /** Suppressed while the agent is working: mid-task is not the moment to ask how it is going. */
  busy: boolean;
}

const buttonClass =
  'rounded-pill px-2.5 py-1 text-[11px] font-medium text-ink-soft shadow-neu-sm transition-all duration-150 ease-press hover:text-ink hover:shadow-neu active:shadow-neu-inset-sm';

/**
 * "How is Flowkite doing?" - three answers and a dismiss, on the shelf above the composer.
 *
 * Deliberately the smallest possible ask. One tap answers it, the strip never returns for another
 * month either way, and nothing about the task, the page or the prompt travels with the rating -
 * only which of the three words was tapped. See `feedbackPrompt.ts` for the leash and
 * `AnalyticsService.trackSessionFeedback` for what is actually sent.
 */
const SessionFeedbackBar = ({ busy }: SessionFeedbackBarProps) => {
  const [visible, setVisible] = useState(false);
  const [thanked, setThanked] = useState(false);
  const [offerIssue, setOfferIssue] = useState(false);

  useEffect(() => {
    if (!TELEMETRY_CONFIGURED) return;
    let cancelled = false;

    const evaluate = async () => {
      try {
        const [analyticsSettings, state] = await Promise.all([
          analyticsSettingsStore.getSettings(),
          feedbackPromptStore.getState(),
        ]);
        if (cancelled) return;
        setVisible(analyticsSettings.enabled && shouldPromptForFeedback(state, Date.now()));
      } catch (error) {
        console.error('Failed to evaluate the feedback prompt:', error);
      }
    };

    void evaluate();
    // Re-evaluated on every store write, which is how the strip appears the moment the task that
    // crossed the threshold finishes rather than on the next panel open.
    const unsubscribe = feedbackPromptStore.subscribe(() => void evaluate());
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const close = useCallback(async (rating: SessionFeedbackRating | null) => {
    // Recorded before anything is sent: the cooldown must start even if the send fails, or a
    // dropped message turns into the strip asking again on the next render.
    await feedbackPromptStore.recordPrompted(rating).catch(console.error);
    if (rating) {
      chrome.runtime.sendMessage({ type: 'session_feedback', rating }).catch(() => {
        // The worker may be asleep or the message unhandled; the rating is not worth a retry.
      });
    }
  }, []);

  const onRate = useCallback(
    (rating: SessionFeedbackRating) => {
      setThanked(true);
      setOfferIssue(rating === 'bad');
      void close(rating);
      // A plain thanks closes itself; an offer to say more stays until it is taken or dismissed,
      // since closing it out from under a user reaching for the link would be its own small insult.
      if (rating !== 'bad') window.setTimeout(() => setVisible(false), 1400);
    },
    [close],
  );

  const onDismiss = useCallback(() => {
    setVisible(false);
    void close(null);
  }, [close]);

  if (!visible || busy) return null;

  return (
    <div className="shrink-0 px-3 pt-2">
      <div className="flex animate-rise items-center gap-2 rounded-pill bg-canvas-sunk px-3 py-1.5 shadow-neu-inset-sm">
        {thanked ? (
          <>
            <p className="min-w-0 flex-1 truncate text-[11px] text-ink-soft">{t('chat_feedback_thanks')}</p>
            {offerIssue && (
              <>
                <a
                  href={ISSUES_URL}
                  target="_blank"
                  rel="noreferrer"
                  className={buttonClass}
                  onClick={() => setVisible(false)}>
                  {t('chat_feedback_report')}
                </a>
                <button
                  type="button"
                  onClick={() => setVisible(false)}
                  aria-label={t('chat_feedback_dismiss')}
                  className="rounded-pill px-1.5 py-1 text-[11px] text-ink-faint transition-colors duration-150 hover:text-ink-soft">
                  ✕
                </button>
              </>
            )}
          </>
        ) : (
          <>
            <p className="min-w-0 flex-1 truncate text-[11px] text-ink-soft">{t('chat_feedback_question')}</p>
            {RATINGS.map(rating => (
              <button key={rating} type="button" onClick={() => onRate(rating)} className={buttonClass}>
                {t(RATING_LABEL[rating] as Parameters<typeof t>[0])}
              </button>
            ))}
            <button
              type="button"
              onClick={onDismiss}
              aria-label={t('chat_feedback_dismiss')}
              className="rounded-pill px-1.5 py-1 text-[11px] text-ink-faint transition-colors duration-150 hover:text-ink-soft">
              ✕
            </button>
          </>
        )}
      </div>
    </div>
  );
};

export default SessionFeedbackBar;
