/* eslint-disable react/prop-types */
import { useMemo, useState } from 'react';
import { FaTrash, FaPen, FaRedo, FaTimes } from 'react-icons/fa';
import { BsBookmark, BsBookmarkFill } from 'react-icons/bs';
import { t } from '@extension/i18n';
import { bookmarkTitleForSession, filterSessionsByQuery } from '../utils';

interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
}

interface ChatHistoryListProps {
  sessions: ChatSession[];
  onSessionSelect: (sessionId: string) => void;
  onSessionDelete: (sessionId: string) => void;
  onSessionBookmark: (sessionId: string) => void;
  /** Rename a session in place, so a run keeps the name its owner gave it rather than its first 50 characters. */
  onSessionRename?: (sessionId: string, title: string) => void;
  /** Load this session's original task back into the composer, ready to edit and run again. */
  onSessionReuse?: (sessionId: string) => void;
  /** Derived titles of the sessions already on the bookmark strip. */
  bookmarkedTitles?: Set<string>;
  visible: boolean;
}

/** A raised card on the sunken well: lifts on hover, sinks while pressed. */
const SESSION_ROW =
  'group relative rounded-soft bg-canvas-raised p-3 shadow-neu-sm transition-all duration-150 ease-press hover:shadow-neu active:shadow-neu-inset-sm';

/**
 * Row action icon-button. Revealed on hover, but opacity-only so it stays in the
 * tab order and re-appears on keyboard focus.
 */
const ROW_ACTION =
  'grid size-7 place-items-center rounded-soft bg-canvas-raised shadow-neu-sm opacity-0 transition-all duration-150 ease-press group-hover:opacity-100 focus-visible:opacity-100 active:shadow-neu-inset-sm';

const ChatHistoryList: React.FC<ChatHistoryListProps> = ({
  sessions,
  onSessionSelect,
  onSessionDelete,
  onSessionBookmark,
  onSessionRename,
  onSessionReuse,
  bookmarkedTitles,
  visible,
}) => {
  const [query, setQuery] = useState('');
  /** The session being renamed, if any, and the draft title in its field. */
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);

  const matches = useMemo(() => filterSessionsByQuery(sessions, query), [sessions, query]);

  if (!visible) return null;

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const commitRename = () => {
    if (!renaming) return;
    const title = renaming.draft.trim();
    // An empty field means "I changed my mind", not "call it nothing": a session with a blank name
    // is unfindable, and there is no undo here.
    if (title) onSessionRename?.(renaming.id, title);
    setRenaming(null);
  };

  return (
    <div className="h-full overflow-y-auto bg-canvas p-4">
      <h2 className="mb-3 text-lg font-semibold text-ink">{t('chat_history_title')}</h2>

      {/* The box appears only once there is enough history for finding to beat scrolling. */}
      {sessions.length > 4 && (
        <div className="relative mb-3">
          <input
            type="search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={t('chat_history_search')}
            aria-label={t('chat_history_search')}
            className="w-full rounded-pill bg-canvas-sunk px-4 py-2 pr-9 text-sm text-ink shadow-neu-inset-sm placeholder:text-ink-faint focus:outline-none"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label={t('chat_history_search_clear')}
              className="absolute right-3 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded-pill text-ink-faint transition-colors duration-150 ease-press hover:text-ink">
              <FaTimes size={11} aria-hidden="true" />
            </button>
          )}
        </div>
      )}

      {sessions.length === 0 ? (
        <div className="rounded-soft bg-canvas-sunk p-6 text-center text-sm text-ink-faint shadow-neu-inset">
          {t('chat_history_empty')}
        </div>
      ) : matches.length === 0 ? (
        <div className="rounded-soft bg-canvas-sunk p-6 text-center text-sm text-ink-faint shadow-neu-inset">
          {t('chat_history_noMatch', [query])}
        </div>
      ) : (
        <div className="space-y-2 rounded-soft bg-canvas-sunk p-2 shadow-neu-inset">
          {matches.map(session => {
            const isBookmarked = bookmarkedTitles?.has(bookmarkTitleForSession(session.title)) ?? false;
            const isRenaming = renaming?.id === session.id;
            return (
              <div key={session.id} className={SESSION_ROW}>
                {isRenaming ? (
                  <input
                    // A callback ref rather than autoFocus: the field appears in response to a
                    // click, so focusing it is following the user, not stealing from them - but the
                    // prop applies on every mount and the linter cannot tell the two apart.
                    ref={node => node?.select()}
                    value={renaming.draft}
                    onChange={event => setRenaming({ id: session.id, draft: event.target.value })}
                    onKeyDown={event => {
                      if (event.key === 'Enter') commitRename();
                      if (event.key === 'Escape') setRenaming(null);
                    }}
                    // Blur commits rather than discards: clicking away from a field you have just
                    // finished typing in reads as "done", not as "throw it away".
                    onBlur={commitRename}
                    aria-label={t('chat_history_rename')}
                    className="w-full rounded-soft bg-canvas-sunk px-2 py-1 text-sm text-ink shadow-neu-inset-sm focus:outline-none"
                  />
                ) : (
                  <button onClick={() => onSessionSelect(session.id)} className="w-full text-left" type="button">
                    <h3 className="truncate pr-24 text-sm font-medium text-ink">{session.title}</h3>
                    <p className="mt-1 text-xs text-ink-faint">{formatDate(session.createdAt)}</p>
                  </button>
                )}

                {!isRenaming && (
                  <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1.5">
                    {/* Run this task again: the prompt lands in the composer, editable before it goes. */}
                    {onSessionReuse && (
                      <button
                        onClick={e => {
                          e.stopPropagation();
                          onSessionReuse(session.id);
                        }}
                        className={`${ROW_ACTION} text-ink-faint hover:text-accent`}
                        aria-label={t('chat_history_reuse')}
                        title={t('chat_history_reuse')}
                        type="button">
                        <FaRedo size={11} aria-hidden="true" />
                      </button>
                    )}

                    {/* Rename this session */}
                    {onSessionRename && (
                      <button
                        onClick={e => {
                          e.stopPropagation();
                          setRenaming({ id: session.id, draft: session.title });
                        }}
                        className={`${ROW_ACTION} text-ink-faint hover:text-ink`}
                        aria-label={t('chat_history_rename')}
                        title={t('chat_history_rename')}
                        type="button">
                        <FaPen size={11} aria-hidden="true" />
                      </button>
                    )}

                    {/* Bookmark this session */}
                    {onSessionBookmark && (
                      <button
                        onClick={e => {
                          e.stopPropagation();
                          onSessionBookmark(session.id);
                        }}
                        className={`${ROW_ACTION} ${isBookmarked ? 'text-ink' : 'text-ink-faint hover:text-ink'}`}
                        aria-label={t('chat_history_bookmark')}
                        aria-pressed={isBookmarked}
                        type="button">
                        {isBookmarked ? <BsBookmarkFill size={13} /> : <BsBookmark size={13} />}
                      </button>
                    )}

                    {/* Delete this session */}
                    <button
                      onClick={e => {
                        e.stopPropagation();
                        onSessionDelete(session.id);
                      }}
                      className={`${ROW_ACTION} text-ink-faint hover:text-signal-bad`}
                      aria-label={t('chat_history_delete')}
                      type="button">
                      <FaTrash size={12} />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default ChatHistoryList;
