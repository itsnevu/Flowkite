import { useState, useEffect } from 'react';
import { activityLogStore, chatHistoryStore, estimateCostUsd, modelPricingStore } from '@extension/storage';
import { t } from '@extension/i18n';
import { Divider } from './controls';
import type { ActivityLogConfig, ModelPricingConfig } from '@extension/storage';

/** Aggregated spend for one model across every stored session. */
interface ModelAggregate {
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** Only this many of the newest sessions are read; the pane says so instead of implying totality. */
const MAX_SESSIONS_READ = 100;

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const usdFormat = (value: number): string => `$${value.toFixed(value < 0.1 ? 4 : 2)}`;

const clearButtonClass =
  'inline-flex items-center justify-center gap-2 rounded-soft bg-danger px-3 py-2 text-sm font-medium text-graphite-50 shadow-key-sm transition-all duration-150 ease-press hover:bg-danger-hover active:translate-y-px active:bg-danger-active active:shadow-key-pressed';

const tableWellClass = 'mt-3 overflow-x-auto rounded-soft bg-canvas-sunk p-2 shadow-neu-inset';
const thClass = 'whitespace-nowrap px-2 py-1.5 text-left font-semibold text-ink';
const tdClass = 'px-2 py-1.5 text-ink-soft';

/**
 * The privacy dashboard: a checkable answer to "what left this machine?", assembled entirely from
 * local records — token usage stored per chat session, and the agent's own activity log of hosts
 * visited and webhook deliveries. Nothing here is fetched from anywhere; that is the point.
 */
export const PrivacySettings = () => {
  const [aggregates, setAggregates] = useState<ModelAggregate[]>([]);
  const [sessionsRead, setSessionsRead] = useState(0);
  const [prices, setPrices] = useState<ModelPricingConfig>({});
  const [activity, setActivity] = useState<ActivityLogConfig>({ visits: {}, webhooks: [] });

  useEffect(() => {
    const loadActivity = () => activityLogStore.get().then(setActivity).catch(console.error);
    loadActivity();
    const unsubscribeActivity = activityLogStore.subscribe(loadActivity);

    modelPricingStore.getAllPrices().then(setPrices).catch(console.error);

    // Aggregate the stored per-session usage. Sequential reads keep this simple; a hundred small
    // storage reads on an options page is nothing.
    (async () => {
      try {
        const sessions = (await chatHistoryStore.getSessionsMetadata())
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, MAX_SESSIONS_READ);
        const byModel = new Map<string, ModelAggregate>();
        let read = 0;
        for (const session of sessions) {
          const usage = await chatHistoryStore.loadTokenUsage(session.id);
          if (!usage) continue;
          read += 1;
          for (const entry of usage.byModel ?? []) {
            const aggregate = byModel.get(entry.model) ?? {
              model: entry.model,
              calls: 0,
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
            };
            aggregate.calls += entry.calls ?? 0;
            aggregate.inputTokens += entry.inputTokens ?? 0;
            aggregate.outputTokens += entry.outputTokens ?? 0;
            aggregate.totalTokens += entry.totalTokens ?? 0;
            byModel.set(entry.model, aggregate);
          }
        }
        setSessionsRead(read);
        setAggregates([...byModel.values()].sort((a, b) => b.totalTokens - a.totalTokens));
      } catch (error) {
        console.error('Failed to aggregate token usage:', error);
      }
    })();

    return unsubscribeActivity;
  }, []);

  const visits = Object.entries(activity.visits).sort(([, a], [, b]) => b.lastAt - a.lastAt);

  return (
    <section className="text-left">
      <h2 className="text-lg font-semibold tracking-tight text-ink">{t('options_privacy_header')}</h2>
      <p className="mt-1 text-sm text-ink-soft">{t('options_privacy_desc')}</p>

      {/* What went to model providers */}
      <div className="mt-6">
        <h3 className="text-sm font-semibold tracking-tight text-ink">{t('options_privacy_models_header')}</h3>
        <p className="mt-0.5 text-sm text-ink-soft">{t('options_privacy_models_desc', String(sessionsRead))}</p>
        {aggregates.length === 0 ? (
          <p className="mt-3 text-sm text-ink-faint">{t('options_privacy_models_empty')}</p>
        ) : (
          <div className={tableWellClass}>
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr>
                  <th className={thClass}>{t('options_privacy_col_model')}</th>
                  <th className={thClass}>{t('options_privacy_col_calls')}</th>
                  <th className={thClass}>{t('options_privacy_col_tokens')}</th>
                  <th className={thClass}>{t('options_privacy_col_cost')}</th>
                </tr>
              </thead>
              <tbody>
                {aggregates.map(aggregate => {
                  const line = estimateCostUsd([aggregate], prices);
                  return (
                    <tr key={aggregate.model} className="border-t border-black/5">
                      <td className={`${tdClass} font-mono`}>{aggregate.model}</td>
                      <td className={tdClass}>{aggregate.calls}</td>
                      <td className={tdClass}>
                        {compact.format(aggregate.inputTokens)} in · {compact.format(aggregate.outputTokens)} out
                      </td>
                      <td className={tdClass}>
                        {line.unpricedModels.length === 0 ? usdFormat(line.usd) : t('options_privacy_noPrice')}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="mt-6">
        <Divider />
      </div>

      {/* Hosts the agent visited */}
      <div className="mt-6">
        <h3 className="text-sm font-semibold tracking-tight text-ink">{t('options_privacy_visits_header')}</h3>
        <p className="mt-0.5 text-sm text-ink-soft">{t('options_privacy_visits_desc')}</p>
        {visits.length === 0 ? (
          <p className="mt-3 text-sm text-ink-faint">{t('options_privacy_visits_empty')}</p>
        ) : (
          <div className={tableWellClass}>
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr>
                  <th className={thClass}>{t('options_privacy_col_host')}</th>
                  <th className={thClass}>{t('options_privacy_col_visits')}</th>
                  <th className={thClass}>{t('options_privacy_col_last')}</th>
                </tr>
              </thead>
              <tbody>
                {visits.map(([host, visit]) => (
                  <tr key={host} className="border-t border-black/5">
                    <td className={`${tdClass} font-mono`}>{host}</td>
                    <td className={tdClass}>{visit.count}</td>
                    <td className={tdClass}>{new Date(visit.lastAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Webhook deliveries */}
      <div className="mt-6">
        <h3 className="text-sm font-semibold tracking-tight text-ink">{t('options_privacy_webhooks_header')}</h3>
        {activity.webhooks.length === 0 ? (
          <p className="mt-3 text-sm text-ink-faint">{t('options_privacy_webhooks_empty')}</p>
        ) : (
          <div className={tableWellClass}>
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr>
                  <th className={thClass}>{t('options_privacy_col_when')}</th>
                  <th className={thClass}>{t('options_privacy_col_host')}</th>
                  <th className={thClass}>{t('options_privacy_col_source')}</th>
                  <th className={thClass}>{t('options_privacy_col_status')}</th>
                </tr>
              </thead>
              <tbody>
                {activity.webhooks.map((delivery, index) => (
                  <tr key={`${delivery.ts}-${index}`} className="border-t border-black/5">
                    <td className={tdClass}>{new Date(delivery.ts).toLocaleString()}</td>
                    <td className={`${tdClass} font-mono`}>{delivery.host}</td>
                    <td className={tdClass}>{delivery.source}</td>
                    <td className={delivery.ok ? `${tdClass} text-signal-ok` : `${tdClass} text-signal-bad`}>
                      {delivery.ok ? t('options_privacy_delivered') : t('options_privacy_failed')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="mt-6 flex items-center justify-between gap-4">
        <p className="text-xs text-ink-faint">{t('options_privacy_note')}</p>
        <button type="button" onClick={() => void activityLogStore.clearAll()} className={clearButtonClass}>
          {t('options_privacy_clear')}
        </button>
      </div>
    </section>
  );
};
