import type { CrawlCheckpoint } from '@extension/storage';
import type { TaskDataset, DatasetRecord } from './dataset';

export interface CrawlConfig {
  url: string;
  goal: string;
  fields: string[];
  maxPages: number;
  maxDepth: number;
  linkPattern: string;
}
export interface CrawlPage {
  url: string;
  text: string;
  links: string[];
  requiresLogin: boolean;
  truncated?: boolean;
  linksTruncated?: boolean;
}
export interface CrawlDependencies {
  dataset: TaskDataset;
  visit: (url: string) => Promise<CrawlPage>;
  extract: (page: CrawlPage) => Promise<DatasetRecord[]>;
  load: () => Promise<CrawlCheckpoint | null>;
  save: (state: CrawlCheckpoint) => Promise<void>;
  shouldStop: () => boolean;
  beforePage?: () => Promise<void>;
}

/** A malformed extractor reply is a failed page, never evidence that the page had no records. */
export function parseCrawlRecords(raw: string, fields: string[]): DatasetRecord[] {
  const text = raw
    .trim()
    .replace(/^```(?:json)?\s*\n?/, '')
    .replace(/\n?```$/, '');
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value)) throw new Error('The extractor did not return a record array');
  return value
    .map(record => {
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Invalid extracted record');
      return Object.fromEntries(
        fields.map(field => {
          const cell = Object.prototype.hasOwnProperty.call(record, field) ? record[field] : '';
          if (cell !== null && typeof cell === 'object') throw new Error('Invalid extracted cell');
          return [field, cell === null || cell === undefined ? '' : String(cell)];
        }),
      );
    })
    .filter(record => Object.values(record).some(value => value.trim() !== ''));
}

function webUrl(raw: string, base?: string): string {
  const url = new URL(raw, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Crawling requires an HTTP(S) URL without embedded credentials');
  }
  url.hash = '';
  return url.href;
}

/** A bounded queue owns progress; the model extracts records, never invents completion counts. */
export async function runCrawl(config: CrawlConfig, deps: CrawlDependencies) {
  const start = webUrl(config.url);
  const origin = new URL(start).origin;
  const maxPages = Math.max(1, Math.min(50, Math.floor(config.maxPages)));
  const maxDepth = Math.max(0, Math.min(3, Math.floor(config.maxDepth)));
  if (!Number.isFinite(maxPages) || !Number.isFinite(maxDepth)) throw new Error('Invalid crawl limits');
  const key = JSON.stringify([start, config.goal, config.fields, config.linkPattern, maxDepth]);
  const previous = await deps.load();
  const state: CrawlCheckpoint =
    previous?.version === 1 && previous.key === key
      ? structuredClone(previous)
      : {
          version: 1,
          key,
          queue: [{ url: start, depth: 0 }],
          completed: [],
          failed: [],
          dataset: { fields: [], rows: [], truncated: false },
          updatedAt: Date.now(),
        };
  deps.dataset.restore(state.dataset);
  // Failed pages are retried only on a subsequent invocation, never in an unbounded inner loop.
  for (const failure of state.failed) {
    if (!state.queue.some(item => item.url === failure.url)) state.queue.push({ url: failure.url, depth: maxDepth });
  }
  state.failed = [];
  const known = new Set([...state.completed, ...state.queue.map(item => item.url)]);
  const persist = async () => {
    state.dataset = deps.dataset.snapshot();
    state.updatedAt = Date.now();
    await deps.save(structuredClone(state));
  };
  await persist();
  let requiresLogin = false;
  while (state.queue.length > 0 && state.completed.length + state.failed.length < maxPages) {
    if (deps.shouldStop() || deps.dataset.snapshot().truncated) break;
    await deps.beforePage?.();
    if (deps.shouldStop()) break;
    const item = state.queue[0];
    let page: CrawlPage;
    try {
      page = await deps.visit(item.url);
      if (deps.shouldStop()) break;
      page.url = webUrl(page.url);
      if (new URL(page.url).origin !== origin) throw new Error('Redirect left the requested site');
      if (page.requiresLogin) {
        requiresLogin = true;
        break;
      }
      if (page.linksTruncated) state.discoveryTruncated = true;
      const records = await deps.extract(page);
      if (deps.shouldStop()) break;
      deps.dataset.add(records.map(record => ({ ...record, source_url: page.url })));
      if (page.truncated) {
        const snapshot = deps.dataset.snapshot();
        deps.dataset.restore({ ...snapshot, truncated: true });
      }
      state.completed.push(item.url);
      if (item.depth < maxDepth) {
        for (const raw of page.links) {
          if (known.size >= 500) {
            state.discoveryTruncated = true;
            break;
          }
          try {
            const url = webUrl(raw, page.url);
            if (
              known.has(url) ||
              new URL(url).origin !== origin ||
              (config.linkPattern && !url.includes(config.linkPattern)) ||
              /\/(?:log[-_]?out|sign[-_]?out)(?:[/?#]|$)/i.test(url)
            )
              continue;
            known.add(url);
            state.queue.push({ url, depth: item.depth + 1 });
          } catch {
            // Mail, script and download links are not crawl destinations.
          }
        }
      }
    } catch (error) {
      if (deps.shouldStop()) break;
      state.failed.push({
        url: item.url,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      });
    }
    state.queue.shift();
    // Saving errors must propagate: a crawl with no durable progress is not resumable.
    await persist();
  }
  await persist();
  return {
    complete:
      state.queue.length === 0 && state.failed.length === 0 && !state.dataset.truncated && !state.discoveryTruncated,
    requiresLogin,
    pages: state.completed.length,
    pending: state.queue.length,
    failed: state.failed,
    rows: deps.dataset.rowCount,
    truncated: state.dataset.truncated || Boolean(state.discoveryTruncated),
  };
}
