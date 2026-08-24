import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';

/**
 * A task the background runs on a daily clock, without the user present.
 *
 * The prompt is stored fully resolved — a template with unfilled `{slots}` has nothing to fill it
 * at 7am, so the UI refuses to save one. Unattended runs keep the safety story intact by
 * construction: the plan gate is considered pre-approved (scheduling it was the approval), and
 * sensitive actions are auto-DECLINED, never auto-allowed — a scheduled task can read and report,
 * but the first purchase-shaped click ends it.
 */
export interface ScheduledTask {
  id: number;
  /** Short label, shown in the schedule list, the notification, and the saved session title. */
  title: string;
  /** The full task prompt, with no unfilled template slots. */
  prompt: string;
  /** Local 24h clock. */
  hour: number;
  minute: number;
  enabled: boolean;
  /** When it last actually ran, or null before the first run. */
  lastRunAt: number | null;
  /**
   * Watch mode: notify only when this run's collected rows differ from the previous run's.
   *
   * Off by default, because it changes what silence means - a watched schedule that says nothing
   * has run and found no change, while an unwatched one that says nothing has failed to run at all.
   * Only meaningful for tasks that collect a table; a prose answer is reported every time.
   */
  watch?: boolean;
}

export interface SchedulesConfig {
  nextId: number;
  tasks: ScheduledTask[];
}

const initialState: SchedulesConfig = { nextId: 1, tasks: [] };

const storage = createStorage<SchedulesConfig>('scheduled-tasks', initialState, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export type SchedulesStorage = BaseStorage<SchedulesConfig> & {
  addSchedule: (input: {
    title: string;
    prompt: string;
    hour: number;
    minute: number;
    watch?: boolean;
  }) => Promise<ScheduledTask>;
  updateSchedule: (id: number, patch: Partial<Omit<ScheduledTask, 'id'>>) => Promise<void>;
  removeSchedule: (id: number) => Promise<void>;
  getAllSchedules: () => Promise<ScheduledTask[]>;
  getScheduleById: (id: number) => Promise<ScheduledTask | undefined>;
  /** Stamp a run without touching anything else. */
  markRun: (id: number, at: number) => Promise<void>;
};

const clampInt = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.trunc(Number.isFinite(value) ? value : min)));

export const schedulesStore: SchedulesStorage = {
  ...storage,
  async addSchedule(input) {
    await storage.set(prev => ({
      nextId: prev.nextId + 1,
      tasks: [
        ...prev.tasks,
        {
          id: prev.nextId,
          title: input.title.trim(),
          prompt: input.prompt,
          hour: clampInt(input.hour, 0, 23),
          minute: clampInt(input.minute, 0, 59),
          enabled: true,
          lastRunAt: null,
          watch: input.watch ?? false,
        },
      ],
    }));
    const { tasks } = await storage.get();
    return tasks[tasks.length - 1];
  },
  async updateSchedule(id, patch) {
    await storage.set(prev => ({
      ...prev,
      tasks: prev.tasks.map(task => {
        if (task.id !== id) return task;
        const next = { ...task, ...patch };
        next.hour = clampInt(next.hour, 0, 23);
        next.minute = clampInt(next.minute, 0, 59);
        return next;
      }),
    }));
  },
  async removeSchedule(id) {
    await storage.set(prev => ({ ...prev, tasks: prev.tasks.filter(task => task.id !== id) }));
  },
  async getAllSchedules() {
    return (await storage.get()).tasks;
  },
  async getScheduleById(id) {
    return (await storage.get()).tasks.find(task => task.id === id);
  },
  async markRun(id, at) {
    await this.updateSchedule(id, { lastRunAt: at });
  },
};

/**
 * The next local-time occurrence of hour:minute strictly after `now`, as an epoch timestamp.
 * Built on the local Date so it follows the machine's clock and DST the way an alarm should.
 */
export function nextOccurrence(hour: number, minute: number, now: number): number {
  const candidate = new Date(now);
  candidate.setHours(clampInt(hour, 0, 23), clampInt(minute, 0, 59), 0, 0);
  if (candidate.getTime() <= now) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate.getTime();
}
