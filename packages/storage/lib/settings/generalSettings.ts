import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';

/** How much of the agent's work the user signs off on before it happens. */
export type ApprovalMode = 'auto' | 'planner' | 'manual';

export const APPROVAL_MODES: readonly ApprovalMode[] = ['auto', 'planner', 'manual'];

/**
 * Which gates each mode runs. One definition, read by both the background and the UI, so the
 * picker can never disagree with what the agent actually does.
 *
 * `auto` runs no gates at all - not even before money or credentials. That is a deliberate product
 * decision: a mode labelled "no checks" that sometimes checks is one nobody can reason about. It is
 * why choosing it requires an explicit acknowledgement (`autoModeAcknowledged`) the first time.
 */
export const requiresPlanApproval = (mode: ApprovalMode): boolean => mode !== 'auto';
export const confirmsSensitiveActions = (mode: ApprovalMode): boolean => mode !== 'auto';
export const confirmsEveryAction = (mode: ApprovalMode): boolean => mode === 'manual';

/**
 * What grounding the agent draws on the page it is driving.
 *
 * `off` is the default: the page stays exactly as the user would see it themselves. `boxes` is the
 * numbered-overlay grounding that vision mode needs - it is still drawn automatically whenever
 * `useVision` is on, regardless of this setting, because the model reads those numbers off the
 * screenshot.
 *
 * A third mode, `cursor`, was declared here and never read by anything. What it described is now
 * `showActivityOverlay`, which is a separate axis: this setting is about what the *model* needs to
 * see, that one is about what the *user* needs to see.
 */
export type AgentOverlayMode = 'off' | 'boxes';

export const AGENT_OVERLAY_MODES: readonly AgentOverlayMode[] = ['off', 'boxes'];

// Interface for general settings configuration
export interface GeneralSettingsConfig {
  maxSteps: number;
  maxActionsPerStep: number;
  maxFailures: number;
  /** Ceiling on the prompt the agent may build, in estimated tokens. Keep it under the model's context window. */
  maxInputTokens: number;
  useVision: boolean;
  planningInterval: number;
  /** What the agent draws on the page. See {@link AgentOverlayMode}. */
  agentOverlay: AgentOverlayMode;
  minWaitPageLoad: number;
  /** Extra fixed pause after the adaptive load wait between actions in one step, in milliseconds. */
  waitBetweenActions: number;
  /** Ceiling on one retry backoff after a transient model failure, in seconds. */
  retryDelay: number;
  replayHistoricalTasks: boolean;
  /** How much the user signs off on before the agent acts. See {@link ApprovalMode}. */
  approvalMode: ApprovalMode;
  /** Whether the user has been told, once, what `auto` actually switches off. */
  autoModeAcknowledged: boolean;
  /** Collect the tabs a task drives into one labelled Chrome tab group, so automated tabs are obvious. */
  groupTaskTabs: boolean;
  /**
   * Announce the agent on the page it is driving: a white border, a badge naming the action it is
   * taking, the cursor it moves, and a stop button.
   *
   * On by default, and the default is the point. A tab that types on its own with nothing on screen
   * to say why is indistinguishable from a compromised browser, so the honest state is the loud one
   * and turning it off is a choice the user makes deliberately.
   */
  showActivityOverlay: boolean;
  /** Play a short chime when a task reaches a final state. */
  soundOnComplete: boolean;
  /**
   * Pause the task and ask once its estimated model spend reaches this many USD. 0 disables the
   * brake. Only models whose price the user entered (modelPricing) count toward the estimate, so
   * with no prices entered this never fires.
   */
  maxCostUsd: number;
}

export type GeneralSettingsStorage = BaseStorage<GeneralSettingsConfig> & {
  updateSettings: (settings: Partial<GeneralSettingsConfig>) => Promise<void>;
  getSettings: () => Promise<GeneralSettingsConfig>;
  resetToDefaults: () => Promise<void>;
};

// Default settings
export const DEFAULT_GENERAL_SETTINGS: GeneralSettingsConfig = {
  maxSteps: 100,
  maxActionsPerStep: 5,
  maxFailures: 3,
  maxInputTokens: 128000,
  useVision: false,
  planningInterval: 3,
  agentOverlay: 'off',
  minWaitPageLoad: 250,
  waitBetweenActions: 0,
  retryDelay: 10,
  replayHistoricalTasks: false,
  approvalMode: 'planner',
  autoModeAcknowledged: false,
  groupTaskTabs: true,
  showActivityOverlay: true,
  soundOnComplete: true,
  maxCostUsd: 0,
};

/** The fields the current shape replaced, still sitting in storage on existing installs. */
interface LegacySettings {
  requirePlanApproval?: boolean;
  confirmSensitiveActions?: boolean;
  displayHighlights?: boolean;
  /**
   * Never had a control and was never read: the executor pinned the planner's vision on. Dropped
   * rather than wired up, because honouring a stored `false` nobody chose would have silently taken
   * the screenshot away from the planner on every install that had ever saved a setting.
   */
  useVisionForPlanner?: boolean;
}

type StoredSettings = Partial<GeneralSettingsConfig> & LegacySettings;

/**
 * The mode an existing install should land on.
 *
 * Only "both gates off" unambiguously means the user wanted no gates; every other legacy
 * combination resolves to `planner`, because guessing too safe costs one extra click and guessing
 * too loose costs a purchase.
 */
function deriveApprovalMode(stored: StoredSettings | null): {
  approvalMode: ApprovalMode;
  autoModeAcknowledged: boolean;
} {
  if (stored?.approvalMode) {
    // Validated rather than trusted. The background fails closed on an unknown value (everything
    // that is not exactly 'auto' is gated), but the Options page indexes a Record<ApprovalMode, ...>
    // with it and would call undefined. Storage is user-writable, so this is a real boundary.
    const mode = APPROVAL_MODES.includes(stored.approvalMode)
      ? stored.approvalMode
      : DEFAULT_GENERAL_SETTINGS.approvalMode;
    return { approvalMode: mode, autoModeAcknowledged: stored.autoModeAcknowledged ?? false };
  }
  if (stored?.requirePlanApproval === false && stored?.confirmSensitiveActions === false) {
    // they already chose to run ungated; do not make them acknowledge a choice they made once
    return { approvalMode: 'auto', autoModeAcknowledged: true };
  }
  return { approvalMode: DEFAULT_GENERAL_SETTINGS.approvalMode, autoModeAcknowledged: false };
}

/**
 * The overlay an existing install should land on.
 *
 * The absence of `agentOverlay` is itself the migration marker, which is why this needs no schema
 * version. A stored `displayHighlights: true` is not treated as a deliberate choice: it was the old
 * default, so nearly everyone carrying it never chose it - and the whole point of the change is
 * that the page is clean without anyone having to find a setting.
 */
function deriveOverlay(stored: StoredSettings | null): AgentOverlayMode {
  const overlay = stored?.agentOverlay;
  return overlay && AGENT_OVERLAY_MODES.includes(overlay) ? overlay : DEFAULT_GENERAL_SETTINGS.agentOverlay;
}

/** The keys the current shape replaced. Stripped on read so the value matches its declared type. */
const LEGACY_KEYS = [
  'requirePlanApproval',
  'confirmSensitiveActions',
  'displayHighlights',
  'useVisionForPlanner',
] as const satisfies readonly (keyof LegacySettings)[];

async function readSettings(): Promise<GeneralSettingsConfig> {
  const stored = ((await storage.get()) ?? null) as StoredSettings | null;

  // Derivation reads the legacy keys, so it gets the raw object; the spread below gets a copy with
  // them removed. Without the strip, getSettings() returned fields GeneralSettingsConfig says do not
  // exist, right up until the user happened to save an unrelated setting.
  const carried = { ...(stored ?? {}) } as Record<string, unknown>;
  for (const key of LEGACY_KEYS) delete carried[key];

  return {
    ...DEFAULT_GENERAL_SETTINGS,
    ...(carried as Partial<GeneralSettingsConfig>),
    ...deriveApprovalMode(stored),
    agentOverlay: deriveOverlay(stored),
  };
}

const storage = createStorage<GeneralSettingsConfig>('general-settings', DEFAULT_GENERAL_SETTINGS, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export const generalSettingsStore: GeneralSettingsStorage = {
  ...storage,
  async updateSettings(settings: Partial<GeneralSettingsConfig>) {
    // Rebased on readSettings rather than the raw store: writing back a legacy object would leave
    // it without `approvalMode`, so the derivation would silently re-run on every read forever.
    const updatedSettings: StoredSettings = {
      ...(await readSettings()),
      ...settings,
    };

    // readSettings already strips these, so this only matters for a caller passing one in.
    for (const key of LEGACY_KEYS) delete (updatedSettings as Record<string, unknown>)[key];

    await storage.set(updatedSettings as GeneralSettingsConfig);
  },
  getSettings: readSettings,
  async resetToDefaults() {
    await storage.set(DEFAULT_GENERAL_SETTINGS);
  },
};
