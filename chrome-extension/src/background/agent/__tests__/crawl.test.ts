import { describe, expect, it, vi } from 'vitest';
import { runCrawl } from '../crawl';
import { TaskDataset } from '../dataset';
import type { CrawlCheckpoint } from '@extension/storage';

function setup() {
  let saved: CrawlCheckpoint | null = null;
  const dataset = new TaskDataset();
  const visit = vi.fn(async (url: string) => ({
    url,
    text: 'A product',
    requiresLogin: false,
    links: [`${url}#top`, 'https://shop.test/catalog/2', 'https://elsewhere.test/product', 'javascript:alert(1)'],
  }));
  const options = {
    dataset,
    visit,
    extract: vi.fn(async () => [{ name: 'Kite' }]),
    load: async () => saved,
    save: vi.fn(async (value: CrawlCheckpoint) => {
      saved = structuredClone(value);
    }),
    shouldStop: () => false,
  };
  return { options, visit, checkpoint: () => saved };
}
const config = {
  url: 'https://shop.test/catalog',
  goal: 'all products',
  fields: ['name'],
  maxPages: 1,
  maxDepth: 2,
  linkPattern: '/catalog',
};

describe('durable crawl workflow', () => {
  it('keeps an unfinished queue at the page budget and resumes it with collected rows', async () => {
    const { options, checkpoint, visit } = setup();
    const first = await runCrawl(config, options);
    expect(first.complete).toBe(false);
    expect(checkpoint()?.queue.map(item => item.url)).toEqual(['https://shop.test/catalog/2']);
    expect(checkpoint()?.completed).toEqual(['https://shop.test/catalog']);
    const recovered = new TaskDataset();
    const second = await runCrawl({ ...config, maxPages: 2 }, { ...options, dataset: recovered });
    expect(second.complete).toBe(true);
    expect(visit.mock.calls.map(([url]) => url)).toEqual(['https://shop.test/catalog', 'https://shop.test/catalog/2']);
    expect(recovered.rowCount).toBe(2);
    expect(recovered.columns).toContain('source_url');
  });
  it('does not mark a login page as successfully crawled', async () => {
    const { options, visit, checkpoint } = setup();
    visit.mockResolvedValue({ url: config.url, text: 'Sign in', links: [], requiresLogin: true });
    const result = await runCrawl(config, options);
    expect(result.requiresLogin).toBe(true);
    expect(result.complete).toBe(false);
    expect(checkpoint()?.completed).toEqual([]);
    expect(checkpoint()?.queue[0].url).toBe(config.url);
    expect(options.extract).not.toHaveBeenCalled();
  });
  it('keeps the current URL pending when interrupted', async () => {
    const { options, checkpoint } = setup();
    const result = await runCrawl(config, { ...options, shouldStop: () => true });
    expect(result.complete).toBe(false);
    expect(checkpoint()?.queue[0].url).toBe(config.url);
    expect(options.visit).not.toHaveBeenCalled();
  });
  it('records failures without claiming complete coverage', async () => {
    const { options, visit, checkpoint } = setup();
    visit.mockRejectedValue(new Error('Page unavailable'));
    expect((await runCrawl(config, options)).complete).toBe(false);
    expect(checkpoint()?.failed).toEqual([{ url: config.url, error: 'Page unavailable' }]);
  });
  it('refuses credential-bearing and non-web start URLs', async () => {
    const { options } = setup();
    for (const url of ['file:///secret', 'https://user:password@shop.test/']) {
      await expect(runCrawl({ ...config, url }, options)).rejects.toThrow();
    }
    expect(options.visit).not.toHaveBeenCalled();
  });
  it('does not extract a redirect outside the requested site', async () => {
    const { options, visit } = setup();
    visit.mockResolvedValue({ url: 'https://other.test/login', text: 'Other site', links: [], requiresLogin: false });
    expect((await runCrawl(config, options)).complete).toBe(false);
    expect(options.extract).not.toHaveBeenCalled();
  });
});

describe('crawl extraction validation', () => {
  it('distinguishes an empty page from a malformed extraction', async () => {
    const { parseCrawlRecords } = await import('../crawl');
    expect(parseCrawlRecords('[]', ['name'])).toEqual([]);
    expect(() => parseCrawlRecords('not JSON', ['name'])).toThrow();
    expect(() => parseCrawlRecords('{"records":[]}', ['name'])).toThrow();
    expect(parseCrawlRecords('[{"name":"","invented":"value"}]', ['name'])).toEqual([]);
    expect(parseCrawlRecords('[{"name":"Kite","invented":"value"}]', ['name'])).toEqual([{ name: 'Kite' }]);
  });
  it('reports truncated reads as partial coverage', async () => {
    const { options, visit } = setup();
    visit.mockResolvedValue({
      url: config.url,
      text: 'A product',
      links: [],
      requiresLogin: false,
      truncated: true,
    } as never);
    const result = await runCrawl(config, options);
    expect(result.complete).toBe(false);
    expect(result.truncated).toBe(true);
  });
});
