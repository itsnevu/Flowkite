import { createStorage } from '../base/base';
import { StorageEnum } from '../base/enums';
import type {
  ChatSession,
  ChatMessage,
  ChatHistoryStorage,
  Message,
  ChatSessionMetadata,
  ChatAgentStepHistory,
  ChatTokenUsage,
} from './types';

// Key for storing chat session metadata
const CHAT_SESSIONS_META_KEY = 'chat_sessions_meta';

// Create storage for session metadata
const chatSessionsMetaStorage = createStorage<ChatSessionMetadata[]>(CHAT_SESSIONS_META_KEY, [], {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

// Helper function to get storage key for a specific session's messages
const getSessionMessagesKey = (sessionId: string) => `chat_messages_${sessionId}`;

/**
 * One storage instance per session key, reused for the life of this JS context.
 *
 * `createStorage` with `liveUpdate` registers a permanent `chrome.storage.onChanged` listener per
 * instance and there is no dispose - so building a fresh instance per operation, as this file used
 * to, leaked a listener (plus a cached copy of the value) on every single message write. A long
 * task accumulated hundreds, each dispatched on every storage change. Reuse also closes a write
 * race: two fresh instances for the same key could prime their caches on either side of each
 * other's write and silently drop a message; one instance per key serializes through one cache.
 */
const sessionStorageCache = new Map<string, unknown>();

const cached = <T>(key: string, build: () => T): T => {
  let storage = sessionStorageCache.get(key) as T | undefined;
  if (!storage) {
    storage = build();
    sessionStorageCache.set(key, storage);
  }
  return storage;
};

const getSessionMessagesStorage = (sessionId: string) =>
  cached(getSessionMessagesKey(sessionId), () =>
    createStorage<ChatMessage[]>(getSessionMessagesKey(sessionId), [], {
      storageEnum: StorageEnum.Local,
      liveUpdate: true,
    }),
  );

// Helper function to get storage key for a specific session's token usage
const getSessionTokenUsageKey = (sessionId: string) => `chat_usage_${sessionId}`;

// Token usage is stored per session rather than on the metadata record, so listing sessions in the
// history panel does not have to read every session's spend.
const getSessionTokenUsageStorage = (sessionId: string) =>
  cached(getSessionTokenUsageKey(sessionId), () =>
    createStorage<ChatTokenUsage | null>(getSessionTokenUsageKey(sessionId), null, {
      storageEnum: StorageEnum.Local,
      liveUpdate: true,
    }),
  );

// Helper function to get storage key for a specific session's agent state history
const getSessionAgentStepHistoryKey = (sessionId: string) => `chat_agent_step_${sessionId}`;

// Helper function to get storage for a specific session's agent state history
const getSessionAgentStepHistoryStorage = (sessionId: string) =>
  cached(getSessionAgentStepHistoryKey(sessionId), () =>
    createStorage<ChatAgentStepHistory>(
      getSessionAgentStepHistoryKey(sessionId),
      {
        task: '',
        history: '',
        timestamp: 0,
      },
      {
        storageEnum: StorageEnum.Local,
        liveUpdate: true,
      },
    ),
  );

/**
 * Physically remove a session's satellite keys.
 *
 * Writing empties, as deletion used to, left one orphan key per deleted session in
 * chrome.storage.local forever. The cache entries go too - their instances hold the dead value.
 * (Their onChanged listeners are unremovable, but that cost is one per deleted session, not one
 * per write.)
 */
const removeSessionKeys = async (sessionId: string): Promise<void> => {
  const keys = [
    getSessionMessagesKey(sessionId),
    getSessionTokenUsageKey(sessionId),
    getSessionAgentStepHistoryKey(sessionId),
  ];
  for (const key of keys) {
    sessionStorageCache.delete(key);
  }
  await globalThis.chrome?.storage?.local?.remove(keys);
};

// Helper function to get current timestamp in milliseconds
const getCurrentTimestamp = (): number => Date.now();

/**
 * Creates a chat history storage instance with optimized operations
 */
export function createChatHistoryStorage(): ChatHistoryStorage {
  return {
    getAllSessions: async (): Promise<ChatSession[]> => {
      const sessionsMeta = await chatSessionsMetaStorage.get();

      // For listing purposes, we can return sessions without loading messages
      // This makes the list view very fast
      return sessionsMeta.map(meta => ({
        ...meta,
        messages: [], // Empty array as we don't load messages for listing
      }));
    },

    clearAllSessions: async (): Promise<void> => {
      const sessionsMeta = await chatSessionsMetaStorage.get();
      for (const sessionMeta of sessionsMeta) {
        await removeSessionKeys(sessionMeta.id);
      }
      await chatSessionsMetaStorage.set([]);
    },

    // Get session metadata without messages (for UI listing)
    getSessionsMetadata: async (): Promise<ChatSessionMetadata[]> => {
      return await chatSessionsMetaStorage.get();
    },

    getSession: async (sessionId: string): Promise<ChatSession | null> => {
      const sessionsMeta = await chatSessionsMetaStorage.get();
      const sessionMeta = sessionsMeta.find(session => session.id === sessionId);

      if (!sessionMeta) return null;

      // Load messages only when a specific session is requested
      const messagesStorage = getSessionMessagesStorage(sessionId);
      const messages = await messagesStorage.get();

      return {
        ...sessionMeta,
        messages,
      };
    },

    createSession: async (title: string, scheduleId?: number): Promise<ChatSession> => {
      const newSessionId = crypto.randomUUID();
      const currentTime = getCurrentTimestamp();
      const newSessionMeta: ChatSessionMetadata = {
        id: newSessionId,
        title,
        createdAt: currentTime,
        updatedAt: currentTime,
        messageCount: 0,
        ...(scheduleId === undefined ? {} : { scheduleId }),
      };

      // Create empty messages array for the new session
      const messagesStorage = getSessionMessagesStorage(newSessionId);
      await messagesStorage.set([]);

      // Add session metadata to the index
      await chatSessionsMetaStorage.set(prevSessions => [...prevSessions, newSessionMeta]);

      return {
        ...newSessionMeta,
        messages: [],
      };
    },

    getSessionsForSchedule: async (scheduleId: number): Promise<ChatSessionMetadata[]> => {
      const sessions = await chatSessionsMetaStorage.get();
      return sessions.filter(session => session.scheduleId === scheduleId).sort((a, b) => b.createdAt - a.createdAt);
    },

    updateTitle: async (sessionId: string, title: string): Promise<ChatSessionMetadata> => {
      let updatedSessionMeta: ChatSessionMetadata | undefined;

      // Update the title and capture the updated session in a single pass
      await chatSessionsMetaStorage.set(prevSessions => {
        return prevSessions.map(session => {
          if (session.id === sessionId) {
            // Create the updated session
            const updated = {
              ...session,
              title,
              updatedAt: getCurrentTimestamp(),
            };

            // Capture it for return value
            updatedSessionMeta = updated;

            return updated;
          }
          return session;
        });
      });

      // Check if we found and updated the session
      if (!updatedSessionMeta) {
        throw new Error('Session not found');
      }

      // Return the already captured metadata
      return updatedSessionMeta;
    },

    deleteSession: async (sessionId: string): Promise<void> => {
      // Remove session from metadata
      await chatSessionsMetaStorage.set(prevSessions => prevSessions.filter(session => session.id !== sessionId));

      // ...and everything keyed by the session id, physically. Written-empty keys outlived the
      // session forever; removed keys do not.
      await removeSessionKeys(sessionId);
    },

    addMessage: async (sessionId: string, message: Message): Promise<ChatMessage> => {
      const newMessage: ChatMessage = {
        ...message,
        id: crypto.randomUUID(),
      };

      // First check if session exists and update metadata in a single operation
      let sessionFound = false;

      await chatSessionsMetaStorage.set(prevSessions => {
        return prevSessions.map(session => {
          if (session.id === sessionId) {
            sessionFound = true;
            return {
              ...session,
              updatedAt: getCurrentTimestamp(),
              messageCount: session.messageCount + 1,
            };
          }
          return session;
        });
      });

      // Throw error if session wasn't found
      if (!sessionFound) {
        throw new Error(`Session with ID ${sessionId} not found`);
      }

      // Only add the message if the session exists
      const messagesStorage = getSessionMessagesStorage(sessionId);
      await messagesStorage.set(prevMessages => [...prevMessages, newMessage]);

      return newMessage;
    },

    deleteMessage: async (sessionId: string, messageId: string): Promise<void> => {
      // Get the messages storage for this session
      const messagesStorage = getSessionMessagesStorage(sessionId);

      // Get current messages to calculate the new count
      const currentMessages = await messagesStorage.get();
      const messageToDelete = currentMessages.find(msg => msg.id === messageId);

      if (!messageToDelete) return; // Message not found

      // Remove the message directly from the messages storage
      await messagesStorage.set(prevMessages => prevMessages.filter(msg => msg.id !== messageId));

      // Update the session's metadata (updatedAt timestamp and messageCount)
      await chatSessionsMetaStorage.set(prevSessions => {
        return prevSessions.map(session => {
          if (session.id === sessionId) {
            return {
              ...session,
              updatedAt: getCurrentTimestamp(),
              messageCount: Math.max(0, session.messageCount - 1),
            };
          }
          return session;
        });
      });
    },

    storeTokenUsage: async (sessionId: string, usage: ChatTokenUsage): Promise<void> => {
      await getSessionTokenUsageStorage(sessionId).set(usage);
    },

    loadTokenUsage: async (sessionId: string): Promise<ChatTokenUsage | null> => {
      const usage = await getSessionTokenUsageStorage(sessionId).get();
      // a session that never made a reporting model call has nothing worth showing
      return usage && usage.byModel.length > 0 ? usage : null;
    },

    storeAgentStepHistory: async (sessionId: string, task: string, history: string): Promise<void> => {
      // Check if session exists
      const sessionsMeta = await chatSessionsMetaStorage.get();
      const sessionMeta = sessionsMeta.find(session => session.id === sessionId);
      if (!sessionMeta) {
        throw new Error(`Session with ID ${sessionId} not found`);
      }

      const agentStepHistoryStorage = getSessionAgentStepHistoryStorage(sessionId);
      await agentStepHistoryStorage.set({
        task,
        history,
        timestamp: getCurrentTimestamp(),
      });
    },

    loadAgentStepHistory: async (sessionId: string): Promise<ChatAgentStepHistory | null> => {
      const agentStepHistoryStorage = getSessionAgentStepHistoryStorage(sessionId);
      const history = await agentStepHistoryStorage.get();
      if (!history || !history.task || !history.timestamp || history.history === '' || history.history === '[]')
        return null;
      return history;
    },
  };
}

// Export the storage instance for direct use
export const chatHistoryStore = createChatHistoryStorage();
