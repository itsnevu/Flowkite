import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { FaMicrophone, FaPaperclip, FaArrowUp, FaTimes } from 'react-icons/fa';
import { AiOutlineLoading3Quarters } from 'react-icons/ai';
import { t } from '@extension/i18n';
import { uploadsStore, rejectionReason, MAX_UPLOAD_FILE_BYTES } from '@extension/storage';
import { findPlaceholders, nextPlaceholder } from '../templates';
import ApprovalModePicker from './ApprovalModePicker';
import type { ApprovalMode } from '@extension/storage';
import type { PlaceholderSpan } from '../templates';

interface ChatInputProps {
  onSendMessage: (text: string, displayText?: string) => void;
  onStopTask: () => void;
  onMicClick?: () => void;
  isRecording?: boolean;
  isProcessingSpeech?: boolean;
  disabled: boolean;
  showStopButton: boolean;
  setContent?: (setter: (text: string) => void) => void;
  // Historical session ID - if provided, shows replay button instead of send button
  historicalSessionId?: string | null;
  onReplay?: (sessionId: string) => void;
  /** how much the user signs off on before the agent acts */
  approvalMode: ApprovalMode;
  onApprovalModeSelect: (mode: ApprovalMode) => void;
}

/**
 * One attachment in the composer, in one of two roles.
 *
 * `text` files are read and pasted into the prompt, which is what a note or a CSV of instructions is
 * for. `upload` files are never read into the prompt - a 4 MB PDF as base64 would swamp the context
 * and tell the model nothing - they are parked in session storage for the upload action to hand to a
 * page's file field, and the prompt learns only their names.
 */
interface AttachedFile {
  name: string;
  /** file text for `text`, base64 bytes for `upload` */
  content: string;
  type: string;
  role: 'text' | 'upload';
  /** byte length, for the caps and for the size shown on the chip */
  size: number;
}

/** Extensions read into the prompt as text. Anything else becomes an upload attachment instead. */
const TEXT_EXTENSIONS = ['.txt', '.md', '.markdown', '.json', '.csv', '.log', '.xml', '.yaml', '.yml'];

/** Base64 of an ArrayBuffer, chunked because String.fromCharCode blows the stack on a whole file. */
const toBase64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

// Shared control recipes — graphite keys sit on the pale canvas, light from the top-left.
// Each state string carries exactly one un-prefixed shadow so states never fight.
const ICON_BUTTON =
  'grid size-9 shrink-0 place-items-center rounded-soft bg-canvas-raised transition-all duration-150 ease-press';
const ICON_BUTTON_IDLE = 'text-ink-soft shadow-neu-sm hover:text-ink active:shadow-neu-inset-sm';
const ICON_BUTTON_PRESSED = 'text-signal-bad shadow-neu-inset-sm';
const DISABLED_CONTROL = 'cursor-not-allowed text-ink-faint opacity-45 shadow-none';

const GRAPHITE_KEY = 'bg-graphite text-graphite-50 transition-all duration-150 ease-press';
const GRAPHITE_KEY_IDLE =
  'shadow-key hover:bg-graphite-hover active:translate-y-px active:bg-graphite-active active:shadow-key-pressed';
const GRAPHITE_KEY_DISABLED = 'cursor-not-allowed opacity-45 shadow-none';

export default function ChatInput({
  onSendMessage,
  onStopTask,
  onMicClick,
  isRecording = false,
  isProcessingSpeech = false,
  disabled,
  showStopButton,
  setContent,
  historicalSessionId,
  onReplay,
  approvalMode,
  onApprovalModeSelect,
}: ChatInputProps) {
  const [text, setText] = useState('');
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  /** Unfilled template slots in the draft. While any remain, send is held and Tab walks them. */
  const placeholders = useMemo(() => findPlaceholders(text), [text]);
  const isSendButtonDisabled = useMemo(
    () => disabled || placeholders.length > 0 || (text.trim() === '' && attachedFiles.length === 0),
    [disabled, placeholders, text, attachedFiles],
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Handle text changes and resize textarea
  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newText = e.target.value;
    setText(newText);

    // Resize textarea
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 100)}px`;
    }
  };

  /** Select a template slot so the next keystroke types straight over it. */
  const selectSpan = useCallback((span: PlaceholderSpan) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(span.start, span.end);
  }, []);

  /**
   * Text arriving from outside the composer — a pinned prompt, a speech transcript. Unlike a
   * keystroke it never passes through handleTextChange, so the resize is repeated here; and
   * because the user's hands are not in the field yet, focus is placed for them: on the first
   * template slot if the text is a template, at the end if it is not.
   */
  const applyExternalText = useCallback((newText: string) => {
    setText(newText);
    // After React has flushed the new value into the textarea; selection needs the real DOM text.
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 100)}px`;
      textarea.focus();
      const first = findPlaceholders(newText)[0];
      if (first) {
        textarea.setSelectionRange(first.start, first.end);
      } else {
        textarea.setSelectionRange(newText.length, newText.length);
      }
    });
  }, []);

  // Expose a method to set content from outside
  useEffect(() => {
    if (setContent) {
      setContent(applyExternalText);
    }
  }, [setContent, applyExternalText]);

  // Initial resize when component mounts
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 100)}px`;
    }
  }, []);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmedText = text.trim();

      // A template with unfilled slots is not a task yet. Enter lands the user on the first
      // blank instead of sending `{product}` to the agent as literal text.
      if (placeholders.length > 0) {
        selectSpan(placeholders[0]);
        return;
      }

      if (trimmedText || attachedFiles.length > 0) {
        let messageContent = trimmedText;
        let displayContent = trimmedText;

        // Security: Clearly separate user input from file content
        // The background service will sanitize file content using guardrails
        const textFiles = attachedFiles.filter(file => file.role === 'text');
        const uploadFiles = attachedFiles.filter(file => file.role === 'upload');

        // Written before the task is sent, so the action can never race the panel and find the
        // store still empty. Replaces rather than appends: these belong to the task being sent.
        void uploadsStore.setFiles(
          uploadFiles.map(file => ({ name: file.name, mimeType: file.type, data: file.content, size: file.size })),
        );

        if (textFiles.length > 0) {
          const fileContents = textFiles
            .map(file => {
              // Tag file content for background service to identify and sanitize
              return `\n\n<flowkite_file_content type="file" name="${file.name}">\n${file.content}\n</flowkite_file_content>`;
            })
            .join('\n');

          // Combine user message with tagged file content (for background service)
          messageContent = trimmedText
            ? `${trimmedText}\n\n<flowkite_attached_files>${fileContents}</flowkite_attached_files>`
            : `<flowkite_attached_files>${fileContents}</flowkite_attached_files>`;
        }

        // The model is told the names and nothing else. It cannot read these files, and saying so
        // outright is cheaper than letting it discover that by trying.
        if (uploadFiles.length > 0) {
          const names = uploadFiles.map(file => file.name).join(', ');
          messageContent = `${messageContent}\n\n<flowkite_attached_uploads>${names}</flowkite_attached_uploads>`;
        }

        if (attachedFiles.length > 0) {
          const fileList = attachedFiles.map(file => `📎 ${file.name}`).join('\n');
          displayContent = trimmedText ? `${trimmedText}\n\n${fileList}` : fileList;
        }

        onSendMessage(messageContent, displayContent);
        setText('');
        setAttachedFiles([]);
        setAttachError(null);
      }
    },
    [text, placeholders, selectSpan, attachedFiles, onSendMessage],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        handleSubmit(e);
        return;
      }

      // While template slots remain, Tab walks them (Shift+Tab walks back). Only then: an
      // empty or slot-free draft leaves Tab as ordinary focus traversal for keyboard users.
      if (e.key === 'Tab' && !e.altKey && !e.ctrlKey && !e.metaKey && placeholders.length > 0) {
        const textarea = textareaRef.current;
        if (!textarea) return;
        const from = e.shiftKey ? textarea.selectionStart : textarea.selectionEnd;
        const span = nextPlaceholder(text, from, e.shiftKey);
        if (span) {
          e.preventDefault();
          selectSpan(span);
        }
      }
    },
    [handleSubmit, placeholders, text, selectSpan],
  );

  const handleReplay = useCallback(() => {
    if (historicalSessionId && onReplay) {
      onReplay(historicalSessionId);
    }
  }, [historicalSessionId, onReplay]);

  const handleFileSelect = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;

      const newFiles: AttachedFile[] = [];
      const rejected: string[] = [];

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const fileExt = '.' + file.name.split('.').pop()?.toLowerCase();
        const isText = TEXT_EXTENSIONS.includes(fileExt);

        // Text goes into the prompt, so it is held to the old 1 MB line; an upload never enters the
        // context at all, so it is held to the session-storage budget instead.
        const limit = isText ? 1024 * 1024 : MAX_UPLOAD_FILE_BYTES;
        if (file.size > limit) {
          rejected.push(file.name);
          continue;
        }

        try {
          newFiles.push({
            name: file.name,
            content: isText ? await file.text() : toBase64(await file.arrayBuffer()),
            type: file.type || (isText ? 'text/plain' : 'application/octet-stream'),
            role: isText ? 'text' : 'upload',
            size: file.size,
          });
        } catch (error) {
          console.error(`Error reading file ${file.name}:`, error);
          rejected.push(file.name);
        }
      }

      const merged = [...attachedFiles, ...newFiles];
      const uploads = merged.filter(file => file.role === 'upload');
      // Checked against the merged set rather than this batch, or three separate drops of 3 MB each
      // would each pass on their own and together overrun the store.
      const overflow = rejectionReason(
        uploads.map(file => ({ name: file.name, mimeType: file.type, data: file.content, size: file.size })),
      );

      if (overflow) {
        setAttachError(t('chat_attach_tooMuch'));
      } else {
        setAttachedFiles(merged);
        setAttachError(rejected.length ? t('chat_attach_rejected', [rejected.join(', ')]) : null);
      }

      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    },
    [attachedFiles],
  );

  const handleRemoveFile = useCallback((index: number) => {
    setAttachedFiles(prev => prev.filter((_, i) => i !== index));
    setAttachError(null);
  }, []);

  return (
    <>
      {/* The composer is a well pressed into the canvas; focusing it deepens the well. */}
      <form
        onSubmit={handleSubmit}
        className={`rounded-slab bg-canvas-sunk p-2.5 shadow-neu-inset-sm transition-shadow duration-200 ease-press focus-within:shadow-neu-inset ${disabled ? 'cursor-not-allowed' : ''}`}
        aria-label={t('chat_input_form')}>
        <div className="flex flex-col gap-2">
          {attachError && (
            <p className="px-1 text-xs text-signal-bad" role="status">
              {attachError}
            </p>
          )}

          {/* File attachments display */}
          {attachedFiles.length > 0 && (
            <div className="flex flex-wrap gap-2 px-0.5">
              {attachedFiles.map((file, index) => (
                <div
                  key={index}
                  className="flex items-center gap-1.5 rounded-pill bg-canvas-raised px-3 py-1 text-xs text-ink-soft shadow-neu-sm">
                  <FaPaperclip
                    className={`size-2.5 shrink-0 ${file.role === 'upload' ? 'text-accent' : 'text-ink-faint'}`}
                    aria-hidden="true"
                  />
                  <span className="max-w-[150px] truncate">{file.name}</span>
                  {/* Only an upload chip says its size: it is the one the caps apply to. */}
                  {file.role === 'upload' && (
                    <span className="shrink-0 text-ink-faint">{Math.max(1, Math.round(file.size / 1024))} KB</span>
                  )}
                  <button
                    type="button"
                    onClick={() => handleRemoveFile(index)}
                    className="grid size-4 shrink-0 place-items-center rounded-pill text-ink-faint transition-colors duration-150 ease-press hover:text-ink"
                    aria-label={`Remove ${file.name}`}>
                    <FaTimes className="size-2.5" aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleTextChange}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            aria-disabled={disabled}
            rows={5}
            className="w-full resize-none bg-transparent px-1.5 py-1 text-sm leading-relaxed text-ink placeholder:text-ink-faint focus:outline-none disabled:cursor-not-allowed disabled:text-ink-faint"
            placeholder={
              showStopButton
                ? t('chat_input_placeholder_running')
                : attachedFiles.length > 0
                  ? 'Add a message (optional)...'
                  : t('chat_input_placeholder')
            }
            aria-label={t('chat_input_editor')}
          />

          {/* Visible exactly while send is held for unfilled slots, so the hold explains itself. */}
          {placeholders.length > 0 && (
            <p className="px-1.5 text-[10px] leading-tight text-ink-faint" role="note">
              {t('chat_template_hint')}
            </p>
          )}

          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              {/*
                Leads the cluster: the mode is the thing to read first, before deciding what to
                send. Deliberately NOT disabled alongside the rest of the composer — `disabled` is
                true precisely while a task is running, which is exactly when tightening the mode
                matters most, and the background pushes the change into the live Executor. Greying
                it out mid-task would make that whole path unreachable.
              */}
              <ApprovalModePicker mode={approvalMode} onSelect={onApprovalModeSelect} />

              {/* File attachment button */}
              <button
                type="button"
                onClick={handleFileSelect}
                disabled={disabled}
                aria-label={t('chat_attach_a11y')}
                title={t('chat_attach_tooltip')}
                className={`${ICON_BUTTON} ${disabled ? DISABLED_CONTROL : ICON_BUTTON_IDLE}`}>
                <FaPaperclip className="size-4" aria-hidden="true" />
              </button>

              {/* Hidden file input, deliberately unrestricted: a text extension is read into the
                  prompt, anything else becomes a file the agent can hand to a page's upload field. */}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                onChange={handleFileChange}
                className="hidden"
                aria-hidden="true"
              />

              {onMicClick && (
                <button
                  type="button"
                  onClick={onMicClick}
                  disabled={disabled || isProcessingSpeech}
                  aria-label={
                    isProcessingSpeech
                      ? t('chat_stt_processing')
                      : isRecording
                        ? t('chat_stt_recording_stop')
                        : t('chat_stt_input_start')
                  }
                  className={`${ICON_BUTTON} ${
                    disabled || isProcessingSpeech
                      ? DISABLED_CONTROL
                      : isRecording
                        ? ICON_BUTTON_PRESSED
                        : ICON_BUTTON_IDLE
                  }`}>
                  {isProcessingSpeech ? (
                    <AiOutlineLoading3Quarters className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <FaMicrophone className={`size-4 ${isRecording ? 'animate-pulse-soft' : ''}`} aria-hidden="true" />
                  )}
                </button>
              )}
            </div>

            {showStopButton ? (
              // Both keys, because a run in flight now has two answers: correct it, or end it. Send
              // sits first so the cheaper, reversible one is what the thumb reaches.
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="submit"
                  disabled={isSendButtonDisabled}
                  aria-disabled={isSendButtonDisabled}
                  aria-label={t('chat_buttons_steer')}
                  title={t('chat_buttons_steer')}
                  className={`grid size-9 shrink-0 place-items-center rounded-pill ${GRAPHITE_KEY} ${
                    isSendButtonDisabled ? GRAPHITE_KEY_DISABLED : GRAPHITE_KEY_IDLE
                  }`}>
                  <FaArrowUp className="size-3.5" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={onStopTask}
                  className={`flex h-9 shrink-0 items-center gap-2 rounded-pill px-4 text-xs font-medium ${GRAPHITE_KEY} ${GRAPHITE_KEY_IDLE}`}>
                  <span className="size-2 shrink-0 animate-pulse-soft rounded-pill bg-signal-bad" aria-hidden="true" />
                  {t('chat_buttons_stop')}
                </button>
              </div>
            ) : historicalSessionId ? (
              <button
                type="button"
                onClick={handleReplay}
                disabled={!historicalSessionId}
                aria-disabled={!historicalSessionId}
                className={`flex h-9 shrink-0 items-center rounded-pill px-4 text-xs font-medium ${GRAPHITE_KEY} ${
                  !historicalSessionId ? GRAPHITE_KEY_DISABLED : GRAPHITE_KEY_IDLE
                }`}>
                {t('chat_buttons_replay')}
              </button>
            ) : (
              <button
                type="submit"
                disabled={isSendButtonDisabled}
                aria-disabled={isSendButtonDisabled}
                aria-label={t('chat_buttons_send')}
                title={t('chat_buttons_send')}
                className={`grid size-9 shrink-0 place-items-center rounded-pill ${GRAPHITE_KEY} ${
                  isSendButtonDisabled ? GRAPHITE_KEY_DISABLED : GRAPHITE_KEY_IDLE
                }`}>
                <FaArrowUp className="size-3.5" aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </form>
      {/*
      Sits with the composer rather than in ChatView, so it follows the input in both the empty
      state and the conversation state without either call site having to remember it. Not
      aria-hidden: a caveat about reliability is exactly the kind of thing a screen-reader user
      needs, but it is polite so it never interrupts the agent's own status announcements.
    */}
      <p className="px-1 pt-1.5 text-center text-[10px] leading-tight text-ink-faint" role="note">
        {t('chat_disclaimer')}
      </p>
    </>
  );
}
