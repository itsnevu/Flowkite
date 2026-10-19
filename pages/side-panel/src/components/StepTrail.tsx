import { useState } from 'react';
import { t } from '@extension/i18n';
import { ACTOR_PROFILES } from '../types/message';
import type { TrailKind, TrailStep } from '@extension/storage';

interface StepTrailProps {
  steps: TrailStep[];
  /** a task that ended badly opens its own trail, because that is the first thing to be read */
  defaultExpanded?: boolean;
}

/** Restrained status hues, matching the dot each kind earns. */
const DOT: Record<TrailKind, string> = {
  ok: 'bg-signal-ok',
  error: 'bg-signal-bad',
  note: 'bg-graphite-300',
  page: 'bg-accent',
};

/**
 * The step-by-step record of one task, one click away.
 *
 * A task used to narrate itself into the transcript, one bubble per action. That is now a single
 * message, and this is where the narration went: collapsed by default, expandable during the run
 * and again forever after, since the trail is stored on the message it belongs to.
 *
 * Interaction and tokens are deliberately those of TokenUsageBar - both are strips on the same
 * shelf, and a second visual language for the same gesture would read as a different control.
 */
const StepTrail = ({ steps, defaultExpanded = false }: StepTrailProps) => {
  const [expanded, setExpanded] = useState(defaultExpanded);

  if (steps.length === 0) {
    return null;
  }

  const issues = steps.filter(step => step.kind === 'error').length;

  return (
    <div className="w-full">
      <button
        type="button"
        onClick={() => setExpanded(value => !value)}
        aria-expanded={expanded}
        title={t('chat_trail_details_a11y')}
        className="flex w-full items-center justify-between gap-2 rounded-pill bg-canvas-sunk px-3 py-1.5 text-[11px] text-ink-faint shadow-neu-inset-sm transition-colors duration-150 ease-press hover:text-ink-soft">
        <span className="uppercase tracking-wide">
          {issues > 0
            ? t('chat_trail_summary', [String(steps.length), String(issues)])
            : t('chat_trail_steps', String(steps.length))}
        </span>
        <span aria-hidden="true" className="font-mono text-ink-faint">
          {expanded ? '−' : '+'}
        </span>
      </button>

      {expanded && (
        <ol className="mt-1.5 animate-rise space-y-2 rounded-soft bg-canvas-raised p-3 shadow-neu-sm">
          {steps.map((step, index) => (
            <li key={`${step.timestamp}-${index}`} className="flex items-start gap-2">
              <span className={`mt-1.5 size-1.5 shrink-0 rounded-pill ${DOT[step.kind]}`} />
              <div className="min-w-0">
                <div className="text-[11px] uppercase tracking-wide text-ink-faint">
                  {ACTOR_PROFILES[step.actor as keyof typeof ACTOR_PROFILES]?.name ?? step.actor}
                </div>
                <div className="whitespace-pre-wrap break-words text-xs text-ink">{step.text}</div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
};

export default StepTrail;
