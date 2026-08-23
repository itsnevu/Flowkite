import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';

/**
 * Prices the user entered for the models they use, in USD per one million tokens.
 *
 * Entered, never shipped: a hardcoded price table would be stale the day it shipped, and this
 * extension talks to OpenRouter, custom endpoints and local Ollama, where no table could be right
 * at all (see the same argument in the side panel's TokenUsageBar). A model without an entry here
 * simply has no price, and everything downstream treats its cost as unknown rather than zero.
 */
export interface ModelPrice {
  /** USD per 1M input (prompt) tokens. */
  inputPerMTok: number;
  /** USD per 1M output (completion) tokens. Thinking tokens bill at this rate too. */
  outputPerMTok: number;
  /**
   * USD per 1M input tokens the provider served from its prompt cache, where that is cheaper than a
   * fresh read - roughly a tenth of the input rate on Anthropic and OpenAI.
   *
   * Optional, and its absence is what keeps an unfilled field honest: cached reads then bill at the
   * full input rate, which can only overstate the bill, never understate it.
   */
  cachedInputPerMTok?: number;
  /**
   * USD per 1M input tokens written into the prompt cache, where the provider charges a premium for
   * the write - Anthropic bills these at 1.25x the input rate.
   *
   * Optional, and unlike the read rate its absence is not free: cache writes then bill at the plain
   * input rate, which is 25% short on Anthropic. Filling it in is what makes the total exact rather
   * than close. Nothing is assumed on the user's behalf, because the multiplier is a provider
   * policy that would be as stale as a price table the day it changed.
   */
  cacheWritePerMTok?: number;
}

/** Keyed by the model name exactly as the provider reports it in usage metadata. */
export type ModelPricingConfig = Record<string, ModelPrice>;

export type ModelPricingStorage = BaseStorage<ModelPricingConfig> & {
  /** Set a model's price, or remove it entirely with `null`. */
  setPrice: (model: string, price: ModelPrice | null) => Promise<void>;
  getAllPrices: () => Promise<ModelPricingConfig>;
};

const storage = createStorage<ModelPricingConfig>(
  'model-pricing',
  {},
  {
    storageEnum: StorageEnum.Local,
    liveUpdate: true,
  },
);

export const modelPricingStore: ModelPricingStorage = {
  ...storage,
  async setPrice(model: string, price: ModelPrice | null) {
    await storage.set(prev => {
      const next = { ...prev };
      if (price === null) {
        delete next[model];
      } else {
        next[model] = price;
      }
      return next;
    });
  },
  getAllPrices: () => storage.get(),
};

/** The fields of a usage entry that pricing needs; structural so any payload shape qualifies. */
export interface PricedUsageEntry {
  model: string;
  inputTokens: number;
  outputTokens: number;
  /**
   * The provider's own total. Read only to recover output the provider billed but left out of
   * `outputTokens` - Gemini counts thinking into `totalTokenCount` and not into the candidate
   * count, so without this the most expensive part of a thinking model's answer costs nothing here.
   */
  totalTokens?: number;
  /** How much of `inputTokens` came from the prompt cache. Priced separately only when the user entered a cache rate. */
  cachedInputTokens?: number;
  /** How much of `inputTokens` was written into the prompt cache. Priced separately only when the user entered a write rate. */
  cacheCreationInputTokens?: number;
}

export interface CostEstimate {
  /** Summed cost of every entry whose model has a valid price. */
  usd: number;
  /** Models that spent tokens but have no (valid) price entered. Non-empty means `usd` is a floor. */
  unpricedModels: string[];
}

const isValidRate = (rate: number | undefined): rate is number =>
  typeof rate === 'number' && Number.isFinite(rate) && rate >= 0;

const isValidPrice = (price: ModelPrice | undefined): price is ModelPrice =>
  !!price && isValidRate(price.inputPerMTok) && isValidRate(price.outputPerMTok);

/**
 * What one entry actually bills for, as opposed to what the provider chose to put in each field.
 *
 * Two corrections, both of which only ever move the estimate toward the real invoice:
 *
 * - Output is taken as the larger of the reported output and `total - input`. For every provider
 *   that reports a consistent triple the two are equal; for Gemini the second is larger by exactly
 *   the thinking tokens, which are billed as output.
 * - Cached input is split out of the input at its own rate, but only when the user entered one.
 *   The cached count can exceed the input count on a provider that reports them separately, so it
 *   is clamped rather than trusted, which keeps the full-rate remainder from going negative.
 */
const billableTokens = (entry: PricedUsageEntry) => {
  const input = Math.max(0, entry.inputTokens);
  // Both cache figures are carved out of the same input total, so they are clamped together: a
  // provider that reports them generously must never push the plain-rate remainder negative.
  const cached = Math.min(Math.max(0, entry.cachedInputTokens ?? 0), input);
  const written = Math.min(Math.max(0, entry.cacheCreationInputTokens ?? 0), input - cached);
  const derivedOutput = (entry.totalTokens ?? 0) - input;
  return {
    freshInput: input - cached - written,
    cachedInput: cached,
    writtenInput: written,
    output: Math.max(Math.max(0, entry.outputTokens), derivedOutput),
  };
};

/**
 * What the given usage cost, according to the user's own price entries.
 *
 * Unknown models are reported, not guessed at: a budget brake that silently priced them at zero
 * would claim a task was cheap while an expensive unpriced model burned underneath it.
 */
export function estimateCostUsd(entries: PricedUsageEntry[], prices: ModelPricingConfig): CostEstimate {
  let usd = 0;
  const unpriced = new Set<string>();
  for (const entry of entries) {
    const price = prices[entry.model];
    if (!isValidPrice(price)) {
      unpriced.add(entry.model);
      continue;
    }
    const { freshInput, cachedInput, writtenInput, output } = billableTokens(entry);
    const cachedRate = isValidRate(price.cachedInputPerMTok) ? price.cachedInputPerMTok : price.inputPerMTok;
    const writeRate = isValidRate(price.cacheWritePerMTok) ? price.cacheWritePerMTok : price.inputPerMTok;
    usd +=
      (freshInput * price.inputPerMTok +
        cachedInput * cachedRate +
        writtenInput * writeRate +
        output * price.outputPerMTok) /
      1_000_000;
  }
  return { usd, unpricedModels: [...unpriced] };
}
