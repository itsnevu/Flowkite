import type { UsageMetadata } from '@langchain/core/messages';
import type { TokenUsageEntry, TokenUsagePayload, TokenUsageTotals } from './event/types';

const emptyTotals = (): TokenUsageTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cachedInputTokens: 0,
  cacheCreationInputTokens: 0,
  reasoningOutputTokens: 0,
});

/**
 * Read the provider's own token counts off a model response.
 *
 * Returns null when the provider reported nothing, and treats all-zero as nothing: the Llama
 * adapter in helper.ts defaults missing metrics to 0, and a custom OpenAI-compatible endpoint may
 * echo an empty usage object. "Free" is a claim we are not entitled to make on their behalf.
 */
export function readUsage(raw: unknown): UsageMetadata | null {
  const usage = (raw as { usage_metadata?: UsageMetadata } | null | undefined)?.usage_metadata;
  if (!usage) return null;
  if (!usage.input_tokens && !usage.output_tokens && !usage.total_tokens) return null;
  return usage;
}

/** Running token totals for one task, split by the model that spent them. */
export class TokenUsageTracker {
  private readonly entries = new Map<string, TokenUsageEntry>();
  private unreportedCalls = 0;

  record(agent: string, model: string, usage: UsageMetadata | null): void {
    if (!usage) {
      this.unreportedCalls += 1;
      return;
    }
    const key = `${agent} ${model}`;
    const entry = this.entries.get(key) ?? { agent, model, calls: 0, ...emptyTotals() };
    entry.calls += 1;
    entry.inputTokens += usage.input_tokens ?? 0;
    entry.outputTokens += usage.output_tokens ?? 0;
    // Gemini bills thinking tokens into totalTokenCount without adding them to candidatesTokenCount,
    // so the provider's own total is the one to trust; only derive it when the provider omits it.
    entry.totalTokens += usage.total_tokens || (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
    entry.cachedInputTokens += usage.input_token_details?.cache_read ?? 0;
    // Anthropic folds both cache figures into input_tokens and then bills the write at a premium,
    // so the write has to be countable separately or it silently costs the plain input rate.
    entry.cacheCreationInputTokens =
      (entry.cacheCreationInputTokens ?? 0) + (usage.input_token_details?.cache_creation ?? 0);
    entry.reasoningOutputTokens += usage.output_token_details?.reasoning ?? 0;
    this.entries.set(key, entry);
  }

  /** Plain arrays only: this snapshot crosses a chrome.runtime port, where a Map would not survive. */
  snapshot(): TokenUsagePayload {
    const total = emptyTotals();
    for (const entry of this.entries.values()) {
      total.inputTokens += entry.inputTokens;
      total.outputTokens += entry.outputTokens;
      total.totalTokens += entry.totalTokens;
      total.cachedInputTokens += entry.cachedInputTokens;
      total.cacheCreationInputTokens = (total.cacheCreationInputTokens ?? 0) + (entry.cacheCreationInputTokens ?? 0);
      total.reasoningOutputTokens += entry.reasoningOutputTokens;
    }
    return {
      total,
      byModel: [...this.entries.values()].map(entry => ({ ...entry })),
      unreportedCalls: this.unreportedCalls,
    };
  }

  get hasData(): boolean {
    return this.entries.size > 0 || this.unreportedCalls > 0;
  }
}
