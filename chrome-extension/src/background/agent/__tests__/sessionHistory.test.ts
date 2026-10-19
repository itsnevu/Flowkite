import { afterEach, describe, expect, it, vi } from 'vitest';
import { SystemMessage } from '@langchain/core/messages';
import { chatHistoryStore } from '@extension/storage/lib/chat';
import { Actors } from '@extension/storage';
import { Executor } from '../executor';
import MessageManager from '../messages/service';
import type { ChatSession, Message } from '@extension/storage';

vi.mock('../../services/analytics', () => ({ analytics: {} }));
vi.mock('webextension-polyfill', () => ({ default: {} }));

const sessionId = 'saved-chat';
const currentTask = 'Continue';

function message(actor: Actors, content: string): Message {
  return { actor, content, timestamp: 1 };
}

function setup(messages: Message[]) {
  vi.spyOn(chatHistoryStore, 'loadCrawlCheckpoint').mockResolvedValue(null);
  vi.spyOn(chatHistoryStore, 'getSession').mockResolvedValue({ id: sessionId, messages } as ChatSession);
  const manager = new MessageManager();
  manager.initTaskMessages(new SystemMessage('System'), currentTask);
  // Exercise real recovery without constructing browser agents or making model calls.
  const executor = Object.assign(Object.create(Executor.prototype), {
    context: { taskId: sessionId, messageManager: manager },
    tasks: [currentTask],
    sessionHistoryInjected: false,
  }) as { injectSessionHistory(): Promise<void> };
  return { executor, manager };
}

afterEach(() => vi.restoreAllMocks());

describe('session history recovery', () => {
  it('restores saved exchanges before the current instruction, once per executor', async () => {
    const { executor, manager } = setup([
      message(Actors.USER, 'Find flights to Lisbon'),
      message(Actors.SYSTEM, 'Found a flight for $120'),
      message(Actors.USER, currentTask),
    ]);
    await executor.injectSessionHistory();
    await executor.injectSessionHistory();
    expect(chatHistoryStore.getSession).toHaveBeenCalledTimes(1);
    expect(chatHistoryStore.getSession).toHaveBeenCalledWith(sessionId);
    const contents = manager.getMessages().map(msg => String(msg.content));
    const restored = contents.findIndex(content => content.includes('Previous outcome: Found a flight'));
    const current = contents.findIndex(content => content.includes('Your ultimate task is:'));
    expect(restored).toBeGreaterThan(0);
    expect(restored).toBeLessThan(current);
  });

  it('keeps previous repeated prompts and legitimate text mentioning Replay', async () => {
    const { executor, manager } = setup([
      message(Actors.USER, currentTask),
      message(Actors.SYSTEM, 'Replay is the name of the product. It costs $20.'),
      message(Actors.USER, currentTask),
    ]);
    await executor.injectSessionHistory();
    const contents = manager.getMessages().map(msg => String(msg.content));
    expect(contents.some(content => content.includes('Previous user prompt in this session:'))).toBe(true);
    expect(contents.some(content => content.includes('Previous outcome: Replay is the name'))).toBe(true);
  });

  it('excludes replay commands and the latest prompt without losing earlier outcomes', async () => {
    const { executor, manager } = setup([
      message(Actors.USER, '/replay old-chat'),
      message(Actors.SYSTEM, 'Previously completed'),
      message(Actors.USER, currentTask),
    ]);
    await executor.injectSessionHistory();
    const contents = manager.getMessages().map(msg => String(msg.content));
    expect(contents.some(content => content.includes('/replay old-chat'))).toBe(false);
    expect(contents.filter(content => content.includes('Previous user prompt'))).toHaveLength(0);
    expect(contents.some(content => content.includes('Previous outcome: Previously completed'))).toBe(true);
  });
});
