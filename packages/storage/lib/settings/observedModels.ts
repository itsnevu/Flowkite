import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';

/**
 * The model names the providers actually reported spending tokens under.
 *
 * This exists because of one silent failure: pricing is keyed by the name in the usage metadata,
 * while the settings page only knew the names assigned to agents. When a provider answers under a
 * different string - an OpenRouter slug, a deployment alias, a router that substitutes a model -
 * there is no row to price, no error, and a dollar total that reads as zero while real money is
 * being spent. Recording what came back turns that into a row the user can fill in.
 *
 * Names only. No counts, no timestamps beyond "when last seen", nothing about the task.
 */
export type ObservedModels = Record<string, number>;

/** Enough to keep the page useful without letting a router's churn grow the list without end. */
export const MAX_OBSERVED_MODELS = 50;

export type ObservedModelsStorage = BaseStorage<ObservedModels> & {
  /** Note that these model names reported usage just now. */
  record: (models: string[]) => Promise<void>;
  /** Every name seen, most recently seen first. */
  list: () => Promise<string[]>;
  forget: (model: string) => Promise<void>;
};

const storage = createStorage<ObservedModels>(
  'observed-models',
  {},
  { storageEnum: StorageEnum.Local, liveUpdate: true },
);

export const observedModelsStore: ObservedModelsStorage = {
  ...storage,
  async record(models: string[]) {
    const named = models.filter(model => typeof model === 'string' && model.length > 0);
    if (named.length === 0) return;
    const now = Date.now();
    await storage.set(prev => {
      const next: ObservedModels = { ...prev };
      for (const model of named) next[model] = now;
      // Oldest sightings drop out first, so the list stays the models the user is actually using.
      const ordered = Object.entries(next).sort((a, b) => b[1] - a[1]);
      return Object.fromEntries(ordered.slice(0, MAX_OBSERVED_MODELS));
    });
  },
  async list() {
    const all = await storage.get();
    return Object.entries(all ?? {})
      .sort((a, b) => b[1] - a[1])
      .map(([model]) => model);
  },
  async forget(model: string) {
    await storage.set(prev => {
      const next = { ...prev };
      delete next[model];
      return next;
    });
  },
};
