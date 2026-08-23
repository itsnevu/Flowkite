import { useState, useMemo } from 'react';
import { t } from '@extension/i18n';
import { estimateCostUsd } from '@extension/storage';
import type { ModelPricingConfig } from '@extension/storage';
import type { TokenUsagePayload } from '../types/event';

interface TokenUsageBarProps {
  usage: TokenUsagePayload;
  /** The user's own USD-per-MTok price entries; empty means costs stay in tokens only. */
  prices?: ModelPricingConfig;
}

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
/** The pill is too narrow for full counts, so they live in the tooltip and in the expanded panel. */
const exact = new Intl.NumberFormat();

/**
 * Small dollar amounts need more precision than a whole-cent format can show, and one case needs
 * more than precision: a real but sub-hundredth-of-a-cent spend rounds to "$0.0000", which reads as
 * "this was free" when it is not. That one is written as a bound instead.
 */
export const usdFormat = (value: number): string => {
  if (!(value > 0)) return '$0.00';
  if (value < 0.0001) return '<$0.0001';
  if (value < 0.1) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
};

/**
 * What the task cost. Tokens are the ground truth — the providers' own reported counts — and
 * dollars appear only for models whose price the user entered themselves in settings. No shipped
 * price table: it would be stale the day it shipped, and this extension talks to OpenRouter,
 * custom endpoints and local Ollama, where no table could be right at all. A model without an
 * entry is counted as "unknown", never as zero, and the totals say so.
 */
const TokenUsageBar = ({ usage, prices }: TokenUsageBarProps) => {
  const [expanded, setExpanded] = useState(false);
  const { total, byModel, unreportedCalls } = usage;

  const estimate = useMemo(() => estimateCostUsd(byModel, prices ?? {}), [byModel, prices]);
  const anyPriced = byModel.length > estimate.unpricedModels.length;
  /** The floor marker: unreported calls or unpriced models both mean "at least this much". */
  const isFloor = unreportedCalls > 0 || estimate.unpricedModels.length > 0;

  return (
    <div className="shrink-0 px-3 pt-2">
      <button
        type="button"
        onClick={() => setExpanded(value => !value)}
        aria-expanded={expanded}
        aria-label={t('chat_usage_details_a11y')}
        title={`${exact.format(total.totalTokens)} tokens`}
        className="flex w-full items-center justify-between gap-2 rounded-pill bg-canvas-sunk px-3 py-1.5 text-[11px] text-ink-faint shadow-neu-inset-sm transition-colors duration-150 ease-press hover:text-ink-soft">
        <span className="uppercase tracking-wide">{t('chat_usage_label')}</span>
        <span className="font-mono text-ink-soft">
          {unreportedCalls > 0 ? '≥ ' : ''}
          {compact.format(total.totalTokens)}
          {' · '}
          {/* The money always has a place on the strip, even unknown. Showing tokens alone when
              nothing is priced left the one number the user came for silently absent, which reads
              as "this was free" rather than "nobody told me the price". */}
          <span className={anyPriced ? '' : 'text-ink-faint'}>
            {anyPriced ? `${isFloor ? '≥ ' : '≈ '}${usdFormat(estimate.usd)}` : '$ —'}
          </span>
        </span>
      </button>

      {expanded && (
        <div className="mt-1.5 animate-rise rounded-soft bg-canvas-raised p-3 shadow-neu-sm">
          {/* The headline answer: what these tokens cost in credit. Everything below it is the
              breakdown that explains the number. */}
          <p className="text-sm font-medium text-ink">
            {anyPriced
              ? t('chat_usage_credit', [
                  `${isFloor ? '≥ ' : '≈ '}${usdFormat(estimate.usd)}`,
                  exact.format(total.totalTokens),
                ])
              : t('chat_usage_creditUnknown', [exact.format(total.totalTokens)])}
          </p>
          <p className="mt-1 text-[11px] text-ink-soft">
            {t('chat_usage_inOut', [exact.format(total.inputTokens), exact.format(total.outputTokens)])}
          </p>
          <ul className="mt-2 space-y-1.5">
            {byModel.map(entry => {
              const line = estimateCostUsd([entry], prices ?? {});
              const priced = line.unpricedModels.length === 0;
              return (
                <li key={`${entry.agent}-${entry.model}`} className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate text-xs text-ink">{entry.model}</span>
                  <span className="shrink-0 font-mono text-[11px] text-ink-faint">
                    {t('chat_usage_calls', String(entry.calls))} · {exact.format(entry.totalTokens)}
                    {priced ? ` · ${usdFormat(line.usd)}` : ` · ${t('chat_usage_rowNoPrice')}`}
                  </span>
                </li>
              );
            })}
          </ul>
          {(total.cachedInputTokens > 0 ||
            (total.cacheCreationInputTokens ?? 0) > 0 ||
            total.reasoningOutputTokens > 0) && (
            <p className="mt-2 text-[11px] text-ink-faint">
              {total.cachedInputTokens > 0 && t('chat_usage_cached', exact.format(total.cachedInputTokens))}
              {total.cachedInputTokens > 0 && total.reasoningOutputTokens > 0 && ' · '}
              {total.reasoningOutputTokens > 0 && t('chat_usage_reasoning', exact.format(total.reasoningOutputTokens))}
            </p>
          )}
          <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
            {unreportedCalls > 0 ? `${t('chat_usage_partial')} ` : ''}
            {anyPriced
              ? estimate.unpricedModels.length > 0
                ? t('chat_usage_unpriced', [estimate.unpricedModels.join(', ')])
                : t('chat_usage_priced')
              : t('chat_usage_noPrice')}
          </p>
        </div>
      )}
    </div>
  );
};

export default TokenUsageBar;
