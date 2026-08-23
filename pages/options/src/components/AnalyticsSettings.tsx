import { useState, useEffect } from 'react';
import { analyticsSettingsStore } from '@extension/storage';
import { t } from '@extension/i18n';
import { Toggle } from './controls';
import type { AnalyticsSettingsConfig } from '@extension/storage';

/**
 * Whether this build can send telemetry at all.
 *
 * The PostHog key is a build-time secret that is deliberately absent from the repo (see
 * `.env.example`), so a build without one compiles it in as empty and `AnalyticsService.init()`
 * disables itself. Without this check the page shows a live-looking switch and a detailed
 * "what we collect" list describing collection that provably cannot happen - which reads as a
 * false disclosure in the one panel whose entire job is to tell the truth about data.
 *
 * Read at module scope because it is a compile-time constant, not state.
 */
const TELEMETRY_CONFIGURED = Boolean(import.meta.env.VITE_POSTHOG_API_KEY);

/** What a configured build sends, and what it never sends. Both lists are disclosures, so they
 *  live next to each other rather than being inlined into the markup twice over. */
const COLLECTED = [
  'options_analytics_collect_tasks',
  'options_analytics_collect_domains',
  'options_analytics_collect_errors',
  'options_analytics_collect_usage',
  'options_analytics_collect_feedback',
] as const;

const NEVER_COLLECTED = [
  'options_analytics_never_personal',
  'options_analytics_never_urls',
  'options_analytics_never_prompts',
  'options_analytics_never_recordings',
  'options_analytics_never_sensitive',
] as const;

export const AnalyticsSettings = () => {
  const [settings, setSettings] = useState<AnalyticsSettingsConfig | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const currentSettings = await analyticsSettingsStore.getSettings();
        setSettings(currentSettings);
      } catch (error) {
        console.error('Failed to load analytics settings:', error);
      } finally {
        setLoading(false);
      }
    };

    loadSettings();

    // Listen for storage changes
    const unsubscribe = analyticsSettingsStore.subscribe(loadSettings);
    return () => {
      unsubscribe();
    };
  }, []);

  const handleToggleAnalytics = async (enabled: boolean) => {
    if (!settings) return;

    try {
      await analyticsSettingsStore.updateSettings({ enabled });
      setSettings({ ...settings, enabled });
    } catch (error) {
      console.error('Failed to update analytics settings:', error);
    }
  };

  if (loading) {
    return (
      <section className="space-y-6">
        <div className="text-left">
          <h2 className="text-lg font-semibold tracking-tight text-ink">{t('options_analytics_title')}</h2>
          <div className="mt-4 animate-pulse-soft space-y-2">
            <div className="h-4 w-3/4 rounded-pill bg-canvas-sunk shadow-neu-inset-sm" />
            <div className="h-4 w-1/2 rounded-pill bg-canvas-sunk shadow-neu-inset-sm" />
          </div>
        </div>
      </section>
    );
  }

  if (!settings) {
    return (
      <section className="space-y-6">
        <div className="text-left">
          <h2 className="text-lg font-semibold tracking-tight text-ink">{t('options_analytics_title')}</h2>
          <p className="mt-4 text-sm text-signal-bad">{t('options_analytics_loadFail')}</p>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-6">
      <div className="text-left">
        <h2 className="text-lg font-semibold tracking-tight text-ink">{t('options_analytics_title')}</h2>

        {!TELEMETRY_CONFIGURED && (
          <div className="mt-4 flex gap-3 rounded-soft bg-canvas-sunk p-4 shadow-neu-inset-sm">
            <span className="mt-1.5 size-1.5 shrink-0 rounded-pill bg-signal-ok" aria-hidden="true" />
            <p className="text-sm text-ink-soft">
              <span className="font-medium text-ink">{t('options_analytics_unconfigured_lead')}</span>{' '}
              {t('options_analytics_unconfigured_body')}
            </p>
          </div>
        )}

        <div className="mt-6 space-y-6">
          {/* Main toggle */}
          <div className="flex items-start justify-between gap-4">
            <div>
              <label
                htmlFor="analytics-enabled"
                className={`text-base font-medium text-ink ${TELEMETRY_CONFIGURED ? 'cursor-pointer' : ''}`}>
                {t('options_analytics_toggle_label')}
              </label>
              <p className="mt-1 text-sm text-ink-soft">
                {TELEMETRY_CONFIGURED ? t('options_analytics_toggle_desc') : t('options_analytics_toggle_unavailable')}
              </p>
            </div>
            <Toggle
              id="analytics-enabled"
              label={t('options_analytics_toggle_a11y')}
              checked={TELEMETRY_CONFIGURED && settings.enabled}
              disabled={!TELEMETRY_CONFIGURED}
              onChange={handleToggleAnalytics}
            />
          </div>

          <div className="h-px bg-gradient-to-r from-transparent via-black/10 to-transparent" />

          {/* Information about what we collect */}
          <div className="rounded-soft bg-canvas-sunk p-5 shadow-neu-inset">
            <h3 className="text-base font-medium text-ink">
              {TELEMETRY_CONFIGURED
                ? t('options_analytics_collect_title')
                : t('options_analytics_collect_titleUnconfigured')}
            </h3>
            <ul className="mt-3 space-y-2 text-left text-sm text-ink-soft">
              {COLLECTED.map(key => (
                <li key={key} className="flex gap-3">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-pill bg-signal-info" aria-hidden="true" />
                  <span>{t(key)}</span>
                </li>
              ))}
            </ul>

            <div className="my-5 h-px bg-gradient-to-r from-transparent via-black/10 to-transparent" />

            <h3 className="text-base font-medium text-ink">{t('options_analytics_never_title')}</h3>
            <ul className="mt-3 space-y-2 text-left text-sm text-ink-soft">
              {NEVER_COLLECTED.map(key => (
                <li key={key} className="flex gap-3">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-pill bg-signal-bad" aria-hidden="true" />
                  <span>{t(key)}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Opt-out message. Suppressed when the build cannot send anything anyway - telling the
              user they "can re-enable it anytime" would promise a switch that does nothing. */}
          {TELEMETRY_CONFIGURED && !settings.enabled && (
            <div className="flex gap-3 rounded-soft bg-canvas-sunk p-4 shadow-neu-inset-sm">
              <span className="mt-1.5 size-1.5 shrink-0 rounded-pill bg-signal-warn" aria-hidden="true" />
              <p className="text-sm text-signal-warn">{t('options_analytics_optedOut')}</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
};
