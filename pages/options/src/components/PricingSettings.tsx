import { useState, useEffect, useCallback } from 'react';
import { agentModelStore, modelPricingStore, observedModelsStore } from '@extension/storage';
import { t } from '@extension/i18n';
import type { ModelPricingConfig } from '@extension/storage';

/** Same milled-in field as the number inputs above, sized for a price. */
const priceFieldClass =
  'w-24 rounded-soft bg-canvas-sunk px-2.5 py-1.5 text-right text-sm text-ink shadow-neu-inset placeholder:text-ink-faint';

/** One editable row of drafts; strings, so half-typed decimals survive re-renders. */
interface PriceDraft {
  input: string;
  output: string;
  /** Optional: left blank, cached reads bill at the full input rate. */
  cached: string;
  /** Optional: left blank, cache writes bill at the full input rate - 25% short on Anthropic. */
  cacheWrite: string;
}

/**
 * The price list behind every $ readout and the budget brake: USD per 1M tokens, entered by the
 * user for the models they actually use. Entered, never shipped — see modelPricing.ts for why a
 * built-in table is refused on principle.
 *
 * Rows appear for every model currently assigned to an agent, every model that already has a price
 * (so unassigning a model does not orphan its entry invisibly), and - the one that matters most -
 * every model a provider actually reported spending tokens under. That last list is what closes the
 * gap that made totals read as zero: pricing is keyed by the name in the usage metadata, and a
 * provider answering under a different string than the one assigned had no row to fill in and no
 * way to say so. Rows for names only seen in usage are marked, since they are the ones a user would
 * not think to look for. Clearing the in and out
 * fields removes the entry, returning that model to "unpriced". The cache field is separate and
 * optional: without it cached reads bill at the full input rate, so an unfilled row overstates the
 * bill rather than understating it.
 */
export const PricingSettings = () => {
  const [assignedModels, setAssignedModels] = useState<string[]>([]);
  const [observedModels, setObservedModels] = useState<string[]>([]);
  const [prices, setPrices] = useState<ModelPricingConfig>({});
  const [drafts, setDrafts] = useState<Record<string, PriceDraft>>({});

  useEffect(() => {
    const loadAssigned = () =>
      agentModelStore
        .getAllAgentModels()
        .then(records => {
          const names = Object.values(records)
            .map(record => record?.modelName)
            .filter((name): name is string => typeof name === 'string' && name.length > 0);
          setAssignedModels([...new Set(names)]);
        })
        .catch(console.error);
    const loadPrices = () => modelPricingStore.getAllPrices().then(setPrices).catch(console.error);
    const loadObserved = () => observedModelsStore.list().then(setObservedModels).catch(console.error);

    loadAssigned();
    loadPrices();
    loadObserved();
    const unsubscribeModels = agentModelStore.subscribe(loadAssigned);
    const unsubscribePrices = modelPricingStore.subscribe(loadPrices);
    const unsubscribeObserved = observedModelsStore.subscribe(loadObserved);
    return () => {
      unsubscribeModels();
      unsubscribePrices();
      unsubscribeObserved();
    };
  }, []);

  const models = [...new Set([...assignedModels, ...Object.keys(prices), ...observedModels])].sort();
  /** Names the provider reported that nothing else in the settings knows about. */
  const unexpected = new Set(observedModels.filter(model => !assignedModels.includes(model)));

  const draftFor = (model: string): PriceDraft => {
    const existing = drafts[model];
    if (existing) return existing;
    const price = prices[model];
    return {
      input: price ? String(price.inputPerMTok) : '',
      output: price ? String(price.outputPerMTok) : '',
      cached: price?.cachedInputPerMTok !== undefined ? String(price.cachedInputPerMTok) : '',
      cacheWrite: price?.cacheWritePerMTok !== undefined ? String(price.cacheWritePerMTok) : '',
    };
  };

  const setDraft = (model: string, patch: Partial<PriceDraft>) => {
    setDrafts(prev => ({ ...prev, [model]: { ...draftFor(model), ...patch } }));
  };

  /** Commit a row: in and out both valid saves, both empty deletes, anything else stays a draft. */
  const commit = useCallback(async (model: string, draft: PriceDraft) => {
    const inputText = draft.input.trim();
    const outputText = draft.output.trim();
    if (inputText === '' && outputText === '') {
      await modelPricingStore.setPrice(model, null).catch(console.error);
      return;
    }
    const inputPerMTok = Number.parseFloat(inputText);
    const outputPerMTok = Number.parseFloat(outputText);
    if (!Number.isFinite(inputPerMTok) || inputPerMTok < 0 || !Number.isFinite(outputPerMTok) || outputPerMTok < 0) {
      return;
    }
    // A blank or unusable cache field is stored as no cache rate at all, which bills cached reads
    // at the full input rate. Saving a half-typed number there would quietly discount the total.
    const optionalRate = (text: string): number => (text.trim() === '' ? Number.NaN : Number.parseFloat(text));
    const cachedInputPerMTok = optionalRate(draft.cached);
    const cacheWritePerMTok = optionalRate(draft.cacheWrite);
    await modelPricingStore
      .setPrice(model, {
        inputPerMTok,
        outputPerMTok,
        ...(Number.isFinite(cachedInputPerMTok) && cachedInputPerMTok >= 0 ? { cachedInputPerMTok } : {}),
        ...(Number.isFinite(cacheWritePerMTok) && cacheWritePerMTok >= 0 ? { cacheWritePerMTok } : {}),
      })
      .catch(console.error);
  }, []);

  return (
    <div className="py-4">
      <h3 className="text-sm font-semibold tracking-tight text-ink">{t('options_pricing_header')}</h3>
      <p className="mt-0.5 text-sm font-normal text-ink-soft">{t('options_pricing_desc')}</p>

      {models.length === 0 ? (
        <p className="mt-3 text-sm text-ink-faint">{t('options_pricing_empty')}</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {models.map(model => {
            const draft = draftFor(model);
            return (
              <li key={model} className="flex flex-wrap items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate font-mono text-xs text-ink">{model}</span>
                  {unexpected.has(model) && (
                    <span
                      className="shrink-0 rounded-pill bg-canvas-sunk px-2 py-0.5 text-[10px] uppercase tracking-wide text-ink-faint shadow-neu-inset-sm"
                      title={t('options_pricing_seenHint')}>
                      {t('options_pricing_seen')}
                    </span>
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <label className="text-[11px] uppercase tracking-wide text-ink-faint" htmlFor={`price-in-${model}`}>
                    {t('options_pricing_input')}
                  </label>
                  <input
                    id={`price-in-${model}`}
                    type="number"
                    min={0}
                    step={0.01}
                    placeholder="—"
                    value={draft.input}
                    onChange={e => setDraft(model, { input: e.target.value })}
                    onBlur={() => void commit(model, draftFor(model))}
                    className={priceFieldClass}
                  />
                  <label className="text-[11px] uppercase tracking-wide text-ink-faint" htmlFor={`price-out-${model}`}>
                    {t('options_pricing_output')}
                  </label>
                  <input
                    id={`price-out-${model}`}
                    type="number"
                    min={0}
                    step={0.01}
                    placeholder="—"
                    value={draft.output}
                    onChange={e => setDraft(model, { output: e.target.value })}
                    onBlur={() => void commit(model, draftFor(model))}
                    className={priceFieldClass}
                  />
                  <label
                    className="text-[11px] uppercase tracking-wide text-ink-faint"
                    htmlFor={`price-cache-${model}`}>
                    {t('options_pricing_cached')}
                  </label>
                  <input
                    id={`price-cache-${model}`}
                    type="number"
                    min={0}
                    step={0.01}
                    placeholder="—"
                    value={draft.cached}
                    onChange={e => setDraft(model, { cached: e.target.value })}
                    onBlur={() => void commit(model, draftFor(model))}
                    className={priceFieldClass}
                  />
                  <label
                    className="text-[11px] uppercase tracking-wide text-ink-faint"
                    htmlFor={`price-cachew-${model}`}>
                    {t('options_pricing_cacheWrite')}
                  </label>
                  <input
                    id={`price-cachew-${model}`}
                    type="number"
                    min={0}
                    step={0.01}
                    placeholder="—"
                    value={draft.cacheWrite}
                    onChange={e => setDraft(model, { cacheWrite: e.target.value })}
                    onBlur={() => void commit(model, draftFor(model))}
                    className={priceFieldClass}
                  />
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
