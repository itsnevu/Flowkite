import { beforeEach, describe, expect, it } from 'vitest';
import { chatHistoryStore } from '../lib/chat/history';
import type { CrawlCheckpoint } from '../lib/chat/types';

const checkpoint: CrawlCheckpoint = {
  version: 1,
  key: 'catalog',
  queue: [{ url: 'https://shop.test/2', depth: 1 }],
  completed: ['https://shop.test/1'],
  failed: [],
  dataset: { fields: ['name'], rows: [['Kite']], truncated: false },
  updatedAt: 1,
};
beforeEach(async () => chatHistoryStore.clearAllSessions());
describe('crawl checkpoint lifecycle', () => {
  it('recovers progress and records independently for each chat', async () => {
    const a = await chatHistoryStore.createSession('A');
    const b = await chatHistoryStore.createSession('B');
    await chatHistoryStore.storeCrawlCheckpoint(a.id, checkpoint);
    expect(await chatHistoryStore.loadCrawlCheckpoint(a.id)).toEqual(checkpoint);
    expect(await chatHistoryStore.loadCrawlCheckpoint(b.id)).toBeNull();
  });
  it('cannot resurrect checkpoints for a deleted chat', async () => {
    const session = await chatHistoryStore.createSession('A');
    await chatHistoryStore.storeCrawlCheckpoint(session.id, checkpoint);
    await chatHistoryStore.deleteSession(session.id);
    expect(await chatHistoryStore.loadCrawlCheckpoint(session.id)).toBeNull();
    await expect(chatHistoryStore.storeCrawlCheckpoint(session.id, checkpoint)).rejects.toThrow();
  });
});
