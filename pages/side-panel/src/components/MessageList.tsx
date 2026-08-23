import { memo, useMemo, useState } from 'react';
import { t } from '@extension/i18n';
import { ACTOR_PROFILES } from '../types/message';
import { splitMarkdownTables, tableToCsv } from '../markdownTable';
import { hasRichMarkup, parseRichText } from '../markdownRich';
import { datasetFilename, saveTextFile } from '../download';
import ResultDataset, { DownloadKey } from './ResultDataset';
import StepTrail from './StepTrail';
import type { Message } from '@extension/storage';
import type { TableBlock } from '../markdownTable';
import type { InlineSpan } from '../markdownRich';

interface MessageListProps {
  messages: Message[];
}

export default memo(function MessageList({ messages }: MessageListProps) {
  return (
    <div className="flex max-w-full flex-col">
      {messages.map((message, index) => (
        <MessageBlock
          key={`${message.actor}-${message.timestamp}-${index}`}
          message={message}
          isSameActor={index > 0 ? messages[index - 1].actor === message.actor : false}
        />
      ))}
    </div>
  );
});

interface MessageBlockProps {
  message: Message;
  isSameActor: boolean;
}

function MessageBlock({ message, isSameActor }: MessageBlockProps) {
  if (!message.actor) {
    console.error('No actor found');
    return <div />;
  }
  const actor = ACTOR_PROFILES[message.actor as keyof typeof ACTOR_PROFILES];
  const isUser = message.actor === 'user';
  const steps = message.steps ?? [];
  // A task that hit trouble opens its own trail: that is what the reader came for.
  const hasIssue = steps.some(step => step.kind === 'error');
  // The user speaks in graphite keys; every agent answers on a raised pale card.
  const bubble = isUser
    ? 'rounded-slab bg-graphite text-graphite-50 shadow-key'
    : 'rounded-slab bg-canvas-raised text-ink shadow-neu';

  return (
    <div
      className={`flex max-w-full animate-rise flex-col ${isUser ? 'items-end' : 'items-start'} ${
        isSameActor ? 'mt-1.5' : 'mt-5 first:mt-0'
      }`}>
      {!isSameActor && (
        <div className={`mb-1.5 flex items-center gap-2 ${isUser ? 'flex-row-reverse' : ''}`}>
          {/* The actor glyphs are white-on-transparent, so they sit on a graphite puck rather than the pale canvas. */}
          <div className="grid size-7 shrink-0 place-items-center rounded-pill bg-graphite shadow-key-sm">
            <img src={actor.icon} alt={actor.name} className="size-4" />
          </div>
          <span className="text-[11px] uppercase tracking-wide text-ink-faint">{actor.name}</span>
        </div>
      )}

      <div className={`min-w-0 max-w-[85%] px-3.5 py-2.5 text-sm ${bubble}`}>
        <MessageContent content={message.content} timestamp={message.timestamp} />
      </div>

      {message.dataset && (
        <div className="mt-1.5 w-full max-w-[85%]">
          <ResultDataset dataset={message.dataset} timestamp={message.timestamp} />
        </div>
      )}

      {steps.length > 0 && (
        <div className="mt-1.5 w-full max-w-[85%]">
          <StepTrail steps={steps} defaultExpanded={hasIssue} />
        </div>
      )}

      <div className="mt-1 px-1 text-[11px] uppercase tracking-wide text-ink-faint">
        {formatTimestamp(message.timestamp)}
      </div>
    </div>
  );
}

/**
 * Message text, with any pipe tables rendered as real tables.
 *
 * Every other message renders exactly as before (one pre-wrap div); only a strict
 * header/separator/rows sequence is promoted, so prose with a stray pipe stays prose.
 */
function MessageContent({ content, timestamp }: { content: string; timestamp: number }) {
  const blocks = useMemo(() => splitMarkdownTables(content), [content]);

  if (blocks.length === 1 && blocks[0].type === 'text') {
    return <RichText text={content} />;
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {blocks.map((block, index) =>
        block.type === 'text' ? (
          <RichText key={index} text={block.text} />
        ) : (
          <ResultTable key={index} table={block} timestamp={timestamp} />
        ),
      )}
    </div>
  );
}

/** The emphasised runs inside one line: accented weight for a key term, a chip for a literal. */
function InlineSpans({ spans }: { spans: InlineSpan[] }) {
  return (
    <>
      {spans.map((span, index) => {
        if (span.kind === 'strong') {
          return (
            <strong key={index} className="font-semibold text-accent-strong">
              {span.text}
            </strong>
          );
        }
        if (span.kind === 'code') {
          // Sunk rather than raised: a literal is something the page already contains, not a
          // control the user can press, and the inset well says that without a border.
          return (
            <code
              key={index}
              className="rounded-[5px] bg-accent-soft px-1 py-px font-mono text-[0.92em] text-accent shadow-neu-inset-sm">
              {span.text}
            </code>
          );
        }
        return <span key={index}>{span.text}</span>;
      })}
    </>
  );
}

/**
 * Message text with headings, lists and inline emphasis rendered.
 *
 * A message with none of those keeps the original single pre-wrap div, so the overwhelmingly common
 * one-sentence status line costs exactly what it did before.
 */
function RichText({ text }: { text: string }) {
  const blocks = useMemo(() => (hasRichMarkup(text) ? parseRichText(text) : null), [text]);

  if (!blocks) {
    return <div className="whitespace-pre-wrap break-words">{text}</div>;
  }

  return (
    <div className="flex min-w-0 flex-col break-words">
      {blocks.map((block, index) => {
        if (block.kind === 'heading') {
          // First heading sits flush; later ones get air above, so sections separate without rules.
          return (
            <h3 key={index} className={`text-[0.95rem] font-semibold text-ink ${index === 0 ? '' : 'mt-2.5'}`}>
              <InlineSpans spans={block.spans} />
            </h3>
          );
        }

        if (block.kind === 'bullet' || block.kind === 'ordered') {
          return (
            <div key={index} className="flex gap-1.5 pl-1">
              <span aria-hidden className="shrink-0 select-none text-accent">
                {block.kind === 'ordered' ? block.marker : '•'}
              </span>
              <span className="min-w-0 flex-1">
                <InlineSpans spans={block.spans} />
              </span>
            </div>
          );
        }

        // A blank line is real vertical space in agent prose, not noise to collapse.
        if (block.spans.length === 0) return <div key={index} className="h-2" />;

        return (
          <div key={index} className="whitespace-pre-wrap">
            <InlineSpans spans={block.spans} />
          </div>
        );
      })}
    </div>
  );
}

/** One extracted table: scrolls inside its own well, with copy and save keys underneath. */
function ResultTable({ table, timestamp }: { table: TableBlock; timestamp: number }) {
  const [copied, setCopied] = useState(false);

  // Same keys a collected dataset carries, for the same reason: a table the user can only look at
  // is a table they still have to retype.
  const handleDownloadCsv = () => {
    void saveTextFile(tableToCsv(table), datasetFilename(timestamp, 'csv'), 'csv').catch(() => undefined);
  };

  const handleCopyCsv = () => {
    navigator.clipboard
      ?.writeText(tableToCsv(table))
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1800);
      })
      .catch(() => setCopied(false));
  };

  return (
    <div className="min-w-0">
      <div className="overflow-x-auto rounded-soft bg-canvas-sunk p-2 shadow-neu-inset-sm">
        <table className="w-full border-collapse text-left text-xs">
          <thead>
            <tr>
              {table.header.map((cell, i) => (
                <th key={i} className="whitespace-nowrap px-2 py-1.5 font-semibold text-ink">
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, r) => (
              <tr key={r} className="border-t border-black/5">
                {row.map((cell, c) => (
                  <td key={c} className="px-2 py-1.5 align-top text-ink-soft">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <DownloadKey label={copied ? t('chat_table_copied') : t('chat_table_copyCsv')} onClick={handleCopyCsv} />
        <DownloadKey label={t('chat_dataset_downloadCsv')} onClick={handleDownloadCsv} />
      </div>
    </div>
  );
}

/**
 * Formats a timestamp (in milliseconds) to a readable time string
 * @param timestamp Unix timestamp in milliseconds
 * @returns Formatted time string
 */
function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();

  // Check if the message is from today
  const isToday = date.toDateString() === now.toDateString();

  // Check if the message is from yesterday
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();

  // Check if the message is from this year
  const isThisYear = date.getFullYear() === now.getFullYear();

  // Format the time (HH:MM)
  const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (isToday) {
    return timeStr; // Just show the time for today's messages
  }

  if (isYesterday) {
    return `Yesterday, ${timeStr}`;
  }

  if (isThisYear) {
    // Show month and day for this year
    return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${timeStr}`;
  }

  // Show full date for older messages
  return `${date.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })}, ${timeStr}`;
}
