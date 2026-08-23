import { describe, it, expect, beforeEach } from 'vitest';
import { modelPricingStore, estimateCostUsd } from '../lib/settings/modelPricing';
import type { ModelPricingConfig } from '../lib/settings/modelPricing';

/**
 * The cost estimate feeds a brake that pauses real tasks and a $ readout the user trusts, so its
 * two honesty rules are pinned here: an unpriced model is "unknown", never zero — and a garbage
 * price entry (negative, NaN) demotes its model back to unpriced rather than poisoning the sum.
 */
describe('estimateCostUsd', () => {
  const prices: ModelPricingConfig = {
    'gpt-cheap': { inputPerMTok: 0.5, outputPerMTok: 2 },
    'claude-good': { inputPerMTok: 3, outputPerMTok: 15 },
  };

  it('prices a single fully-known entry', () => {
    const { usd, unpricedModels } = estimateCostUsd(
      [{ model: 'gpt-cheap', inputTokens: 1_000_000, outputTokens: 500_000 }],
      prices,
    );
    expect(usd).toBeCloseTo(0.5 + 1.0, 10);
    expect(unpricedModels).toEqual([]);
  });

  it('sums across models and reports the unpriced one instead of pricing it at zero', () => {
    const { usd, unpricedModels } = estimateCostUsd(
      [
        { model: 'claude-good', inputTokens: 100_000, outputTokens: 10_000 },
        { model: 'ollama-local', inputTokens: 2_000_000, outputTokens: 900_000 },
      ],
      prices,
    );
    expect(usd).toBeCloseTo(0.3 + 0.15, 10);
    expect(unpricedModels).toEqual(['ollama-local']);
  });

  it('treats an invalid price entry as unpriced', () => {
    const bad: ModelPricingConfig = {
      negative: { inputPerMTok: -1, outputPerMTok: 2 },
      nan: { inputPerMTok: Number.NaN, outputPerMTok: 2 },
    };
    const { usd, unpricedModels } = estimateCostUsd(
      [
        { model: 'negative', inputTokens: 1000, outputTokens: 1000 },
        { model: 'nan', inputTokens: 1000, outputTokens: 1000 },
      ],
      bad,
    );
    expect(usd).toBe(0);
    expect(unpricedModels).toEqual(['negative', 'nan']);
  });

  it('returns zero-and-empty for no usage at all', () => {
    expect(estimateCostUsd([], prices)).toEqual({ usd: 0, unpricedModels: [] });
  });

  it('bills thinking tokens the provider counted into the total but not into the output', () => {
    // Gemini's shape: totalTokenCount includes thoughts, candidatesTokenCount does not. The
    // thinking is billed as output, so 40k of it has to reach the estimate.
    const { usd } = estimateCostUsd(
      [{ model: 'gpt-cheap', inputTokens: 100_000, outputTokens: 10_000, totalTokens: 150_000 }],
      prices,
    );
    expect(usd).toBeCloseTo(0.05 + (50_000 * 2) / 1_000_000, 10);
  });

  it('never lets a consistent triple bill the output twice', () => {
    const { usd } = estimateCostUsd(
      [{ model: 'gpt-cheap', inputTokens: 100_000, outputTokens: 50_000, totalTokens: 150_000 }],
      prices,
    );
    expect(usd).toBeCloseTo(0.05 + 0.1, 10);
  });

  it('bills cached input at the cache rate once the user enters one', () => {
    const cachePrices: ModelPricingConfig = {
      'claude-good': { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 },
    };
    const { usd } = estimateCostUsd(
      [{ model: 'claude-good', inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 900_000 }],
      cachePrices,
    );
    expect(usd).toBeCloseTo(0.1 * 3 + 0.9 * 0.3, 10);
  });

  it('bills cached input at the full input rate when no cache rate was entered', () => {
    const { usd } = estimateCostUsd(
      [{ model: 'claude-good', inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 900_000 }],
      prices,
    );
    expect(usd).toBeCloseTo(3, 10);
  });

  it('clamps a cached count that exceeds the input it is part of', () => {
    const cachePrices: ModelPricingConfig = {
      'claude-good': { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 },
    };
    const { usd } = estimateCostUsd(
      [{ model: 'claude-good', inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 4_000_000 }],
      cachePrices,
    );
    expect(usd).toBeCloseTo(0.3, 10);
  });

  it('ignores an unusable cache rate rather than demoting the model to unpriced', () => {
    const cachePrices: ModelPricingConfig = {
      'claude-good': { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: -1 },
    };
    const { usd, unpricedModels } = estimateCostUsd(
      [{ model: 'claude-good', inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 1_000_000 }],
      cachePrices,
    );
    expect(usd).toBeCloseTo(3, 10);
    expect(unpricedModels).toEqual([]);
  });

  it('bills cache writes at their own rate, apart from reads and from fresh input', () => {
    const cachePrices: ModelPricingConfig = {
      'claude-good': { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3, cacheWritePerMTok: 3.75 },
    };
    const { usd } = estimateCostUsd(
      [
        {
          model: 'claude-good',
          inputTokens: 1_000_000,
          outputTokens: 0,
          cachedInputTokens: 600_000,
          cacheCreationInputTokens: 300_000,
        },
      ],
      cachePrices,
    );
    expect(usd).toBeCloseTo(0.1 * 3 + 0.6 * 0.3 + 0.3 * 3.75, 10);
  });

  it('bills cache writes at the plain input rate when no write rate was entered', () => {
    const { usd } = estimateCostUsd(
      [{ model: 'claude-good', inputTokens: 1_000_000, outputTokens: 0, cacheCreationInputTokens: 400_000 }],
      prices,
    );
    expect(usd).toBeCloseTo(3, 10);
  });

  it('never lets the two cache figures together outrun the input they came from', () => {
    const cachePrices: ModelPricingConfig = {
      'claude-good': { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0, cacheWritePerMTok: 0 },
    };
    const { usd } = estimateCostUsd(
      [
        {
          model: 'claude-good',
          inputTokens: 1_000_000,
          outputTokens: 0,
          cachedInputTokens: 900_000,
          cacheCreationInputTokens: 900_000,
        },
      ],
      cachePrices,
    );
    // 900k read plus a write clamped to the 100k that is left, both free here: nothing at the
    // plain rate, and above all no negative remainder quietly subtracting from the bill.
    expect(usd).toBe(0);
  });

  it('deduplicates an unpriced model that appears in several entries', () => {
    const { unpricedModels } = estimateCostUsd(
      [
        { model: 'mystery', inputTokens: 1, outputTokens: 1 },
        { model: 'mystery', inputTokens: 2, outputTokens: 2 },
      ],
      {},
    );
    expect(unpricedModels).toEqual(['mystery']);
  });
});

describe('modelPricingStore', () => {
  beforeEach(async () => {
    await chrome.storage.local.remove('model-pricing');
  });

  it('stores and returns a price', async () => {
    await modelPricingStore.setPrice('gpt-cheap', { inputPerMTok: 0.5, outputPerMTok: 2 });
    expect(await modelPricingStore.getAllPrices()).toEqual({
      'gpt-cheap': { inputPerMTok: 0.5, outputPerMTok: 2 },
    });
  });

  it('removes a price when set to null', async () => {
    await modelPricingStore.setPrice('gpt-cheap', { inputPerMTok: 0.5, outputPerMTok: 2 });
    await modelPricingStore.setPrice('gpt-cheap', null);
    expect(await modelPricingStore.getAllPrices()).toEqual({});
  });

  it('keeps other models untouched when one is edited', async () => {
    await modelPricingStore.setPrice('a', { inputPerMTok: 1, outputPerMTok: 2 });
    await modelPricingStore.setPrice('b', { inputPerMTok: 3, outputPerMTok: 4 });
    await modelPricingStore.setPrice('a', null);
    expect(await modelPricingStore.getAllPrices()).toEqual({ b: { inputPerMTok: 3, outputPerMTok: 4 } });
  });

  // Asserts on its own key rather than the whole map: the store keeps an in-memory copy that the
  // storage-level reset in beforeEach does not reach, so entries written by earlier cases are still
  // there.
  it('round-trips an optional cache rate', async () => {
    await modelPricingStore.setPrice('claude-good', { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 });
    const stored = await modelPricingStore.getAllPrices();
    expect(stored['claude-good']).toEqual({ inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 });
  });
});
