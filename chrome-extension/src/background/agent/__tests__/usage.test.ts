import { describe, it, expect } from 'vitest';
import { readUsage, TokenUsageTracker } from '../usage';
import type { UsageMetadata } from '@langchain/core/messages';

/** A provider's usage_metadata, as LangChain normalises it onto the response message. */
function usage(fields: Partial<UsageMetadata> = {}): UsageMetadata {
  return { input_tokens: 0, output_tokens: 0, total_tokens: 0, ...fields } as UsageMetadata;
}

describe('readUsage', () => {
  it('returns null when the provider reported nothing', () => {
    expect(readUsage({})).toBeNull();
    expect(readUsage({ usage_metadata: undefined })).toBeNull();
    expect(readUsage(null)).toBeNull();
    expect(readUsage(undefined)).toBeNull();
  });

  // The Llama adapter defaults missing metrics to 0 and custom OpenAI-compatible endpoints echo an
  // empty usage object. Reporting that as a real, free call would be a claim we cannot make.
  it('treats an all-zero usage object as nothing reported', () => {
    expect(readUsage({ usage_metadata: usage() })).toBeNull();
  });

  it('returns the usage when the provider reported any of the three counts', () => {
    const reported = usage({ input_tokens: 0, output_tokens: 0, total_tokens: 7 });
    expect(readUsage({ usage_metadata: reported })).toBe(reported);
  });

  it('passes the cache and reasoning details straight through', () => {
    const reported = usage({
      input_tokens: 100,
      output_tokens: 20,
      total_tokens: 120,
      input_token_details: { cache_read: 80 },
      output_token_details: { reasoning: 15 },
    });

    const result = readUsage({ usage_metadata: reported });

    expect(result?.input_token_details?.cache_read).toBe(80);
    expect(result?.output_token_details?.reasoning).toBe(15);
  });
});

describe('TokenUsageTracker', () => {
  it('starts with nothing to report', () => {
    const tracker = new TokenUsageTracker();
    expect(tracker.hasData).toBe(false);
    expect(tracker.snapshot()).toEqual({
      total: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningOutputTokens: 0,
      },
      byModel: [],
      unreportedCalls: 0,
    });
  });

  it('counts cache reads and cache writes apart, since they are billed apart', () => {
    const tracker = new TokenUsageTracker();
    tracker.record(
      'navigator',
      'claude-good',
      usage({
        input_tokens: 1000,
        output_tokens: 100,
        total_tokens: 1100,
        input_token_details: { cache_read: 600, cache_creation: 300 },
      }),
    );
    const [entry] = tracker.snapshot().byModel;
    expect(entry.cachedInputTokens).toBe(600);
    expect(entry.cacheCreationInputTokens).toBe(300);
    // Both are carved out of the input the provider already reported, never added on top of it.
    expect(entry.inputTokens).toBe(1000);
  });

  it('accumulates repeated calls to the same model into one row', () => {
    const tracker = new TokenUsageTracker();
    tracker.record('navigator', 'gpt-4o', usage({ input_tokens: 10, output_tokens: 5, total_tokens: 15 }));
    tracker.record('navigator', 'gpt-4o', usage({ input_tokens: 20, output_tokens: 1, total_tokens: 21 }));

    const { byModel, total } = tracker.snapshot();
    expect(byModel).toHaveLength(1);
    expect(byModel[0]).toMatchObject({ agent: 'navigator', model: 'gpt-4o', calls: 2, inputTokens: 30 });
    expect(total.totalTokens).toBe(36);
  });

  // The navigator routes routine steps to a cheaper model, so one agent id genuinely spends on two.
  it('keeps two models of one agent apart', () => {
    const tracker = new TokenUsageTracker();
    tracker.record('navigator', 'gpt-4o', usage({ input_tokens: 10, output_tokens: 5, total_tokens: 15 }));
    tracker.record('navigator', 'gpt-4o-mini', usage({ input_tokens: 8, output_tokens: 2, total_tokens: 10 }));

    const { byModel, total } = tracker.snapshot();
    expect(byModel).toHaveLength(2);
    // Order is not part of the contract - only that both models are reported, separately.
    expect([...byModel.map(entry => entry.model)].sort()).toEqual(['gpt-4o', 'gpt-4o-mini']);
    expect(byModel.every(entry => entry.agent === 'navigator')).toBe(true);
    expect(total.totalTokens).toBe(25);
  });

  it('records cache reads and reasoning tokens separately from the plain counts', () => {
    const tracker = new TokenUsageTracker();
    tracker.record(
      'planner',
      'claude',
      usage({
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 120,
        input_token_details: { cache_read: 80 },
        output_token_details: { reasoning: 15 },
      }),
    );

    const { total } = tracker.snapshot();
    expect(total.cachedInputTokens).toBe(80);
    expect(total.reasoningOutputTokens).toBe(15);
    expect(total.inputTokens).toBe(100);
  });

  // Gemini bills thinking tokens into its own total without adding them to the output count, so a
  // derived input+output would under-report what the user is actually charged for.
  it('trusts the provider own total over input plus output', () => {
    const tracker = new TokenUsageTracker();
    tracker.record('planner', 'gemini', usage({ input_tokens: 10, output_tokens: 5, total_tokens: 100 }));

    expect(tracker.snapshot().total.totalTokens).toBe(100);
  });

  it('derives the total only when the provider omitted it', () => {
    const tracker = new TokenUsageTracker();
    tracker.record('planner', 'custom', usage({ input_tokens: 10, output_tokens: 5, total_tokens: 0 }));

    expect(tracker.snapshot().total.totalTokens).toBe(15);
  });

  it('counts a call the provider said nothing about without inventing totals for it', () => {
    const tracker = new TokenUsageTracker();
    tracker.record('navigator', 'ollama/llama3', usage({ input_tokens: 10, output_tokens: 5, total_tokens: 15 }));
    tracker.record('navigator', 'ollama/llama3', null);

    const { total, byModel, unreportedCalls } = tracker.snapshot();
    expect(unreportedCalls).toBe(1);
    expect(byModel).toHaveLength(1);
    expect(byModel[0].calls).toBe(1);
    expect(total.totalTokens).toBe(15);
    expect(tracker.hasData).toBe(true);
  });

  it('has data as soon as a single call went unreported', () => {
    const tracker = new TokenUsageTracker();
    tracker.record('navigator', 'ollama/llama3', null);
    expect(tracker.hasData).toBe(true);
  });

  describe('snapshot', () => {
    const seeded = () => {
      const tracker = new TokenUsageTracker();
      tracker.record('navigator', 'gpt-4o', usage({ input_tokens: 10, output_tokens: 5, total_tokens: 15 }));
      return tracker;
    };

    // It crosses a chrome.runtime port to the side panel, where a Map would not survive.
    it('is structured-clone safe', () => {
      const snapshot = seeded().snapshot();
      expect(Array.isArray(snapshot.byModel)).toBe(true);
      expect(() => structuredClone(snapshot)).not.toThrow();
      expect(structuredClone(snapshot)).toEqual(snapshot);
    });

    it('hands out copies, so a consumer cannot corrupt the running totals', () => {
      const tracker = seeded();
      const first = tracker.snapshot();

      first.byModel[0].inputTokens = 999_999;
      first.byModel.push({ ...first.byModel[0], model: 'injected' });
      first.total.totalTokens = 999_999;

      const second = tracker.snapshot();
      expect(second.byModel).toHaveLength(1);
      expect(second.byModel[0].inputTokens).toBe(10);
      expect(second.total.totalTokens).toBe(15);
    });
  });
});
