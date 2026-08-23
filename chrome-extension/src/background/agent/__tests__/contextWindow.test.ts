import { describe, it, expect } from 'vitest';
import { ProviderTypeEnum } from '@extension/storage';
import { contextWindowFor, OLLAMA_CONTEXT_TOKENS, OUTPUT_TOKEN_CAP } from '../helper';

/**
 * A budget above a provider's real window is not a soft overrun on Ollama: it does not answer with
 * an error, it truncates the prompt from the front - where the system prompt and the pinned task
 * live - and answers anyway. So the budget has to come down to the window rather than the other way
 * round, and `num_ctx` is deliberately not raised to meet the budget.
 */
describe('contextWindowFor', () => {
  it('reports the window Ollama is actually told to allocate', () => {
    expect(contextWindowFor(ProviderTypeEnum.Ollama)).toBe(OLLAMA_CONTEXT_TOKENS);
  });

  it.each([ProviderTypeEnum.OpenAI, ProviderTypeEnum.Anthropic, ProviderTypeEnum.Gemini, ProviderTypeEnum.OpenRouter])(
    'states no window for %s, whose window belongs to the model',
    provider => {
      // Deliberately not a per-model table: a stale one would refuse budgets that are in fact fine.
      expect(contextWindowFor(provider)).toBeUndefined();
    },
  );

  it('states no window for a custom provider id', () => {
    expect(contextWindowFor('custom_openai_1')).toBeUndefined();
  });

  it('leaves room for the completion inside the window', () => {
    // What the clamp in setupExecutor computes; a window smaller than the output cap would leave
    // nothing for input at all.
    expect(OLLAMA_CONTEXT_TOKENS - OUTPUT_TOKEN_CAP).toBeGreaterThan(0);
  });
});
