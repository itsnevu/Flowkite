import { useState, useEffect } from 'react';
import { schedulesStore } from '@extension/storage';
import { t } from '@extension/i18n';
import { Divider, SettingRow, Toggle } from './controls';
import type { ScheduledTask } from '@extension/storage';

const fieldClass =
  'rounded-soft bg-canvas-sunk px-3 py-2 text-sm text-ink shadow-neu-inset outline-none placeholder:text-ink-faint';

/** Graphite key, as everywhere else on this page. */
const addButtonClass =
  'rounded-soft bg-graphite px-4 py-2 text-sm font-medium text-graphite-50 shadow-key transition-all duration-150 ease-press hover:bg-graphite-hover active:translate-y-px active:bg-graphite-active active:shadow-key-pressed disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none';

/**
 * Keep in sync with the side panel's templates.ts, which owns this grammar: a scheduled prompt
 * runs verbatim with nobody there to fill a slot, so a template must be rejected at save time.
 */
const PLACEHOLDER = new RegExp(String.raw`\{([\p{L}\p{N}][\p{L}\p{N} _-]{0,39})\}`, 'gu');
const hasUnfilledSlots = (prompt: string): boolean => {
  PLACEHOLDER.lastIndex = 0;
  return PLACEHOLDER.test(prompt);
};

const two = (n: number): string => String(n).padStart(2, '0');

/**
 * Daily unattended runs of a saved prompt. The safety contract is stated right on the pane and
 * enforced in the background: scheduling a task pre-approves its plans, and sensitive actions are
 * automatically declined — an unattended task can read and report, never spend.
 */
export const ScheduleSettings = () => {
  const [schedules, setSchedules] = useState<ScheduledTask[]>([]);
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [time, setTime] = useState('07:00');

  useEffect(() => {
    const load = () => schedulesStore.getAllSchedules().then(setSchedules).catch(console.error);
    load();
    return schedulesStore.subscribe(load);
  }, []);

  const promptIsTemplate = hasUnfilledSlots(prompt);
  const canAdd = title.trim() !== '' && prompt.trim() !== '' && !promptIsTemplate && /^\d{2}:\d{2}$/.test(time);

  const handleAdd = async () => {
    const [hour, minute] = time.split(':').map(part => Number.parseInt(part, 10));
    await schedulesStore.addSchedule({ title, prompt: prompt.trim(), hour, minute }).catch(console.error);
    setTitle('');
    setPrompt('');
  };

  return (
    <section className="text-left">
      <h2 className="text-lg font-semibold tracking-tight text-ink">{t('options_sched_header')}</h2>
      <p className="mt-1 text-sm text-ink-soft">{t('options_sched_desc')}</p>

      {/* Create form */}
      <div className="mt-5 flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <label htmlFor="schedTitle" className="sr-only">
            {t('options_sched_title_label')}
          </label>
          <input
            id="schedTitle"
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder={t('options_sched_title_label')}
            className={`${fieldClass} min-w-48 flex-1`}
          />
          <label htmlFor="schedTime" className="text-sm text-ink-soft">
            {t('options_sched_time_label')}
          </label>
          <input
            id="schedTime"
            type="time"
            value={time}
            onChange={e => setTime(e.target.value)}
            className={fieldClass}
          />
        </div>
        <label htmlFor="schedPrompt" className="sr-only">
          {t('options_sched_prompt_label')}
        </label>
        <textarea
          id="schedPrompt"
          rows={3}
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          placeholder={t('options_sched_prompt_label')}
          className={`${fieldClass} resize-y`}
        />
        {promptIsTemplate && <p className="text-xs text-signal-warn">{t('options_sched_hasSlots')}</p>}
        <div>
          <button type="button" onClick={() => void handleAdd()} disabled={!canAdd} className={addButtonClass}>
            {t('options_sched_add')}
          </button>
        </div>
      </div>

      <div className="mt-6">
        <Divider />
        {schedules.length === 0 ? (
          <p className="mt-4 text-sm text-ink-faint">{t('options_sched_empty')}</p>
        ) : (
          schedules.map(schedule => (
            <div key={schedule.id}>
              <SettingRow
                title={`${schedule.title} — ${two(schedule.hour)}:${two(schedule.minute)}`}
                description={`${
                  schedule.lastRunAt
                    ? t('options_sched_lastRun', new Date(schedule.lastRunAt).toLocaleString())
                    : t('options_sched_never')
                }${schedule.watch ? ` — ${t('options_sched_watch_desc')}` : ''}`}>
                <div className="flex items-center gap-3">
                  {/* Watch changes what silence from this schedule means, so it is labelled on the
                      row rather than hidden behind the prompt. */}
                  <Toggle
                    id={`sched-watch-${schedule.id}`}
                    label={t('options_sched_watch')}
                    checked={schedule.watch === true}
                    onChange={checked => void schedulesStore.updateSchedule(schedule.id, { watch: checked })}
                  />
                  <Toggle
                    id={`sched-enabled-${schedule.id}`}
                    label={t('options_sched_enable')}
                    checked={schedule.enabled}
                    onChange={checked => void schedulesStore.updateSchedule(schedule.id, { enabled: checked })}
                  />
                  <button
                    type="button"
                    onClick={() => void schedulesStore.removeSchedule(schedule.id)}
                    className="inline-flex items-center justify-center gap-2 rounded-soft bg-danger px-3 py-2 text-sm font-medium text-graphite-50 shadow-key-sm transition-all duration-150 ease-press hover:bg-danger-hover active:translate-y-px active:bg-danger-active active:shadow-key-pressed">
                    {t('options_sched_delete')}
                  </button>
                </div>
              </SettingRow>
              <p className="-mt-2 mb-2 line-clamp-2 whitespace-pre-wrap break-words pr-6 text-xs text-ink-faint">
                {schedule.prompt}
              </p>
              <Divider />
            </div>
          ))
        )}
      </div>
    </section>
  );
};
