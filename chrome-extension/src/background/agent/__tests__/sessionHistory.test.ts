import { describe, it, expect, vi } from 'vitest';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { chatHistoryStore, Actors } from '@extension/storage';
import MessageManager from '../messages/service';

describe('Session History Context', () => {
  const sessionId = 'test-session-history-id';

  it('loads prior user prompts and agent outcomes into message manager', async () => {
    const mockSession = {
      id: sessionId,
      title: 'Test Session',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [
        {
          id: '1',
          actor: Actors.USER,
          content: 'Which city is the capital of France?',
          timestamp: Date.now(),
        },
        {
          id: '2',
          actor: Actors.NAVIGATOR,
          content: 'Paris is the capital of France.',
          timestamp: Date.now(),
        },
      ],
    };

    vi.spyOn(chatHistoryStore, 'getSession').mockResolvedValue(mockSession as any);

    const session = await chatHistoryStore.getSession(sessionId);
    expect(session).not.toBeNull();
    expect(session?.messages).toHaveLength(2);

    const messageManager = new MessageManager();
    const currentTask = 'What is its population?';

    const previousMessages = session!.messages.filter(msg => {
      if (!msg.content) return false;
      const content = msg.content.trim();
      if (content.startsWith('/') || content.startsWith('Replay of') || content.includes('Replay')) return false;
      if (content === currentTask.trim()) return false;
      return (
        msg.actor === Actors.USER ||
        msg.actor === Actors.SYSTEM ||
        msg.actor === Actors.NAVIGATOR ||
        msg.actor === Actors.PLANNER
      );
    });

    for (const msg of previousMessages) {
      if (msg.actor === Actors.USER) {
        messageManager.addMessageWithTokens(new HumanMessage({ content: msg.content }));
      } else {
        messageManager.addMessageWithTokens(new AIMessage({ content: msg.content }));
      }
    }

    expect(messageManager.length()).toBe(2);
  });
});
