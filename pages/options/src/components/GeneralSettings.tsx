import { useState, useEffect } from 'react';
import {
  type ApprovalMode,
  type GeneralSettingsConfig,
  generalSettingsStore,
  DEFAULT_GENERAL_SETTINGS,
} from '@extension/storage';
import { t } from '@extension/i18n';
import { Divider, SettingRow, Toggle } from './controls';
import { PricingSettings } from './PricingSettings';
import { WebhookSettings } from './WebhookSettings';

/** Number fields are milled into the card: a sunken well, no border anywhere. */
const numberFieldClass =
  'w-24 rounded-soft bg-canvas-sunk px-3 py-2 text-right text-sm font-semibold text-ink shadow-neu-inset';

const APPROVAL_MODE_LABELS: Record<ApprovalMode, () => string> = {
  auto: () => t('chat_mode_auto'),
  planner: () => t('chat_mode_planner'),
  manual: () => t('chat_mode_manual'),
};

export const GeneralSettings = () => {
  const [settings, setSettings] = useState<GeneralSettingsConfig>(DEFAULT_GENERAL_SETTINGS);

  useEffect(() => {
    // Load initial settings
    generalSettingsStore.getSettings().then(setSettings);

    // The mode is now set from the side panel, which is a different document. Without following
    // the store this row would show whatever the mode was when Options was opened.
    return generalSettingsStore.subscribe(() => {
      generalSettingsStore.getSettings().then(setSettings);
    });
  }, []);

  const updateSetting = async <K extends keyof GeneralSettingsConfig>(key: K, value: GeneralSettingsConfig[K]) => {
    // Optimistically update the local state for responsiveness
    setSettings(prevSettings => ({ ...prevSettings, [key]: value }));

    // Call the store to update the setting
    await generalSettingsStore.updateSettings({
      [key]: value,
    } as Partial<GeneralSettingsConfig>);

    // Re-read rather than trust the optimistic write: the store derives some fields on read (legacy
    // approval flags collapsing into approvalMode, for one), so what came back is what is actually stored.
    const latestSettings = await generalSettingsStore.getSettings();
    setSettings(latestSettings);
  };

  return (
    <section className="text-left">
      <h2 className="text-lg font-semibold tracking-tight text-ink">{t('options_general_header')}</h2>

      <div className="mt-4">
        <SettingRow title={t('options_general_maxSteps')} description={t('options_general_maxSteps_desc')}>
          <label htmlFor="maxSteps" className="sr-only">
            {t('options_general_maxSteps')}
          </label>
          <input
            id="maxSteps"
            type="number"
            min={1}
            max={50}
            value={settings.maxSteps}
            onChange={e => updateSetting('maxSteps', Number.parseInt(e.target.value, 10))}
            className={numberFieldClass}
          />
        </SettingRow>

        <Divider />

        <SettingRow title={t('options_general_maxActions')} description={t('options_general_maxActions_desc')}>
          <label htmlFor="maxActionsPerStep" className="sr-only">
            {t('options_general_maxActions')}
          </label>
          <input
            id="maxActionsPerStep"
            type="number"
            min={1}
            max={50}
            value={settings.maxActionsPerStep}
            onChange={e => updateSetting('maxActionsPerStep', Number.parseInt(e.target.value, 10))}
            className={numberFieldClass}
          />
        </SettingRow>

        <Divider />

        <SettingRow title={t('options_general_maxFailures')} description={t('options_general_maxFailures_desc')}>
          <label htmlFor="maxFailures" className="sr-only">
            {t('options_general_maxFailures')}
          </label>
          <input
            id="maxFailures"
            type="number"
            min={1}
            max={10}
            value={settings.maxFailures}
            onChange={e => updateSetting('maxFailures', Number.parseInt(e.target.value, 10))}
            className={numberFieldClass}
          />
        </SettingRow>

        <Divider />

        <SettingRow title={t('options_general_maxInputTokens')} description={t('options_general_maxInputTokens_desc')}>
          <label htmlFor="maxInputTokens" className="sr-only">
            {t('options_general_maxInputTokens')}
          </label>
          <input
            id="maxInputTokens"
            type="number"
            min={8000}
            max={1000000}
            step={1000}
            value={settings.maxInputTokens}
            onChange={e => updateSetting('maxInputTokens', Number.parseInt(e.target.value, 10))}
            className={numberFieldClass}
          />
        </SettingRow>

        <Divider />

        <SettingRow title={t('options_general_enableVision')} description={t('options_general_enableVision_desc')}>
          <Toggle
            id="useVision"
            label={t('options_general_enableVision')}
            checked={settings.useVision}
            onChange={checked => updateSetting('useVision', checked)}
          />
        </SettingRow>

        {/*
          There is no highlight toggle here on purpose. The page the agent drives now stays clean by
          default, and the numbered boxes are drawn automatically whenever vision is on because the
          model grounds its element indices on them - which is not a decision worth handing the user
          a switch for.
        */}

        <Divider />

        <SettingRow
          title={t('options_general_activityOverlay')}
          description={t('options_general_activityOverlay_desc')}>
          <Toggle
            id="showActivityOverlay"
            label={t('options_general_activityOverlay')}
            checked={settings.showActivityOverlay}
            onChange={checked => updateSetting('showActivityOverlay', checked)}
          />
        </SettingRow>

        <Divider />

        <SettingRow title={t('options_general_groupTaskTabs')} description={t('options_general_groupTaskTabs_desc')}>
          <Toggle
            id="groupTaskTabs"
            label={t('options_general_groupTaskTabs')}
            checked={settings.groupTaskTabs}
            onChange={checked => updateSetting('groupTaskTabs', checked)}
          />
        </SettingRow>

        <Divider />

        <SettingRow
          title={t('options_general_soundOnComplete')}
          description={t('options_general_soundOnComplete_desc')}>
          <Toggle
            id="soundOnComplete"
            label={t('options_general_soundOnComplete')}
            checked={settings.soundOnComplete}
            onChange={checked => updateSetting('soundOnComplete', checked)}
          />
        </SettingRow>

        <Divider />

        <SettingRow title={t('options_general_maxCostUsd')} description={t('options_general_maxCostUsd_desc')}>
          <label htmlFor="maxCostUsd" className="sr-only">
            {t('options_general_maxCostUsd')}
          </label>
          <input
            id="maxCostUsd"
            type="number"
            min={0}
            step={0.05}
            value={settings.maxCostUsd}
            onChange={e => {
              const value = Number.parseFloat(e.target.value);
              updateSetting('maxCostUsd', Number.isFinite(value) && value >= 0 ? value : 0);
            }}
            className={numberFieldClass}
          />
        </SettingRow>

        <PricingSettings />

        <Divider />

        <WebhookSettings />

        <Divider />

        <SettingRow
          title={t('options_general_planningInterval')}
          description={t('options_general_planningInterval_desc')}>
          <label htmlFor="planningInterval" className="sr-only">
            {t('options_general_planningInterval')}
          </label>
          <input
            id="planningInterval"
            type="number"
            min={1}
            max={20}
            value={settings.planningInterval}
            onChange={e => updateSetting('planningInterval', Number.parseInt(e.target.value, 10))}
            className={numberFieldClass}
          />
        </SettingRow>

        <Divider />

        <SettingRow
          title={t('options_general_minWaitPageLoad')}
          description={t('options_general_minWaitPageLoad_desc')}>
          <label htmlFor="minWaitPageLoad" className="sr-only">
            {t('options_general_minWaitPageLoad')}
          </label>
          <input
            id="minWaitPageLoad"
            type="number"
            min={250}
            max={5000}
            step={50}
            value={settings.minWaitPageLoad}
            onChange={e => updateSetting('minWaitPageLoad', Number.parseInt(e.target.value, 10))}
            className={numberFieldClass}
          />
        </SettingRow>

        <Divider />

        <SettingRow
          title={t('options_general_waitBetweenActions')}
          description={t('options_general_waitBetweenActions_desc')}>
          <label htmlFor="waitBetweenActions" className="sr-only">
            {t('options_general_waitBetweenActions')}
          </label>
          <input
            id="waitBetweenActions"
            type="number"
            min={0}
            max={5000}
            step={50}
            value={settings.waitBetweenActions}
            onChange={e => updateSetting('waitBetweenActions', Number.parseInt(e.target.value, 10))}
            className={numberFieldClass}
          />
        </SettingRow>

        <Divider />

        <SettingRow title={t('options_general_retryDelay')} description={t('options_general_retryDelay_desc')}>
          <label htmlFor="retryDelay" className="sr-only">
            {t('options_general_retryDelay')}
          </label>
          <input
            id="retryDelay"
            type="number"
            min={1}
            max={60}
            value={settings.retryDelay}
            onChange={e => updateSetting('retryDelay', Number.parseInt(e.target.value, 10))}
            className={numberFieldClass}
          />
        </SettingRow>

        <Divider />

        {/*
          Read-only on purpose. The mode has to be pushable into a *running* executor to be honest,
          and this page has no port to one - an editable copy here could only ever write to storage
          and be ignored for the rest of the session, which is precisely the split-brain that made
          the two old booleans confusing. The row stays visible rather than vanishing because
          Options is where people look for settings, and a pointer is cheaper than a support
          question - hence a description that names where the real control lives.
        */}
        <SettingRow
          title={t('options_general_approvalMode')}
          description={t('options_general_approvalMode_desc', [APPROVAL_MODE_LABELS[settings.approvalMode]()])}>
          <span
            className={`rounded-pill bg-canvas-sunk px-3 py-1 text-xs font-medium shadow-neu-inset-sm ${
              settings.approvalMode === 'auto' ? 'text-signal-warn' : 'text-ink'
            }`}>
            {APPROVAL_MODE_LABELS[settings.approvalMode]()}
          </span>
        </SettingRow>

        <Divider />

        <SettingRow
          title={t('options_general_replayHistoricalTasks')}
          description={t('options_general_replayHistoricalTasks_desc')}>
          <Toggle
            id="replayHistoricalTasks"
            label={t('options_general_replayHistoricalTasks')}
            checked={settings.replayHistoricalTasks}
            onChange={checked => updateSetting('replayHistoricalTasks', checked)}
          />
        </SettingRow>
      </div>
    </section>
  );
};
