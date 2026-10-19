import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { FaMicrophone, FaPaperclip, FaArrowUp, FaTimes } from 'react-icons/fa';
import { AiOutlineLoading3Quarters } from 'react-icons/ai';
import { t } from '@extension/i18n';
import {
  uploadsStore,
  rejectionReason,
  MAX_UPLOAD_FILE_BYTES,
  MAX_UPLOAD_FILES,
  isImageUpload,
  skillStore,
  parseSkillInvocation,
} from '@extension/storage';
import { findPlaceholders, nextPlaceholder } from '../templates';
import { builtinSkillCopy, matchSkills, slashQuery } from '../skillCopy';
import { droppedImageUrl, readDroppedImage } from '../attachmentTransfer';
import ApprovalModePicker from './ApprovalModePicker';
import type { ApprovalMode, PendingUpload, Skill } from '@extension/storage';
import type { PlaceholderSpan } from '../templates';

interface ChatInputProps {
  /** false (sync or async) means the text was refused and the composer must keep the draft */
  onSendMessage: (
    text: string,
    displayText?: string,
    images?: PendingUpload[],
  ) => void | boolean | Promise<void | boolean>;
  onStopTask: () => void;
  onMicClick?: () => void;
  isRecording?: boolean;
  isProcessingSpeech?: boolean;
  disabled: boolean;
  showStopButton: boolean;
  setContent?: (setter: (text: string) => void) => void;
  /** true while a stored chat is on screen; a send there continues it as a new task, and a note says so */
  isHistoricalSession?: boolean;
  // Historical session ID - if provided, shows the replay button next to send
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
  isHistoricalSession = false,
  historicalSessionId,
  onReplay,
  approvalMode,
  onApprovalModeSelect,
}: ChatInputProps) {
  const inputDisabled = disabled && !showStopButton;
  const [readingFiles, setReadingFiles] = useState(false);
  const [sending, setSending] = useState(false);
  const attachmentQueue = useRef<Promise<void>>(Promise.resolve());
  const attachedFilesRef = useRef<AttachedFile[]>([]);
  const submitting = useRef(false);
  const pendingReads = useRef(0);
  const draftVersion = useRef(0);
  const [text, setText] = useState('');
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  /** Unfilled template slots in the draft. While any remain, send is held and Tab walks them. */
  const placeholders = useMemo(() => findPlaceholders(text), [text]);
  const isSendButtonDisabled = useMemo(
    () =>
      inputDisabled ||
      readingFiles ||
      sending ||
      placeholders.length > 0 ||
      (text.trim() === '' && attachedFiles.length === 0),
    [inputDisabled, readingFiles, sending, placeholders, text, attachedFiles],
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /**
   * The skill picker: typing `/` at the start of an empty draft lists the enabled skills, filtered as
   * the name is typed. Live from storage, so a skill switched on in Settings shows up without
   * reopening the panel. Hidden while a task runs: a mid-run message is a correction, and a skill
   * can only shape a task from its start.
   */
  const [skills, setSkills] = useState<Skill[]>([]);
  const [pickerIndex, setPickerIndex] = useState(0);
  /** The draft the user dismissed the picker on with Esc; typing anything else brings it back. */
  const [pickerDismissedAt, setPickerDismissedAt] = useState<string | null>(null);
  useEffect(() => {
    const load = () =>
      skillStore
        .getEnabled()
        .then(setSkills)
        .catch(() => setSkills([]));
    void load();
    return skillStore.subscribe(() => void load());
  }, []);
  const skillQuery = showStopButton || inputDisabled ? null : slashQuery(text);
  const pickerOpen = skillQuery !== null && pickerDismissedAt !== text;
  const pickerItems = useMemo(() => (skillQuery === null ? [] : matchSkills(skills, skillQuery)), [skills, skillQuery]);
  useEffect(() => setPickerIndex(0), [skillQuery]);
  /** The skill this draft will run with, for the one-line confirmation under the composer. */
  const chosenSkill = useMemo(() => {
    const invocation = parseSkillInvocation(text);
    return invocation ? (skills.find(skill => skill.name === invocation.name) ?? null) : null;
  }, [text, skills]);

  // Handle text changes and resize textarea
  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    draftVersion.current += 1;
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
    draftVersion.current += 1;
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

  const pickSkill = useCallback(
    (name: string) => {
      setPickerDismissedAt(null);
      applyExternalText(`/${name} `);
    },
    [applyExternalText],
  );

  const openSkillSettings = useCallback(() => {
    void chrome.tabs.create({ url: chrome.runtime.getURL('options/index.html#skills') });
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
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (inputDisabled || submitting.current || readingFiles) return;
      const trimmedText = text.trim();

      // A template with unfilled slots is not a task yet. Enter lands the user on the first
      // blank instead of sending `{product}` to the agent as literal text.
      if (placeholders.length > 0) {
        selectSpan(placeholders[0]);
        return;
      }

      if (trimmedText || attachedFiles.length > 0) {
        const submittedVersion = draftVersion.current;
        submitting.current = true;
        setSending(true);
        try {
          let messageContent = trimmedText;
          let displayContent = trimmedText;

          // Security: Clearly separate user input from file content
          // The background service will sanitize file content using guardrails
          const textFiles = attachedFiles.filter(file => file.role === 'text');
          const uploadFiles = attachedFiles.filter(file => file.role === 'upload');

          // Written before the task is sent, so the action can never race the panel and find the
          // store still empty. Replaces rather than appends: these belong to the task being sent.
          // Skipped for an attachment-less send while a task runs - that is a steering correction,
          // and wiping the store there took away the very file the running task was about to upload.
          if (uploadFiles.length > 0 || !showStopButton) {
            await (showStopButton ? uploadsStore.appendFiles : uploadsStore.setFiles)(
              uploadFiles.map(file => ({ name: file.name, mimeType: file.type, data: file.content, size: file.size })),
            );
          }

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

          const images = uploadFiles
            .map(file => ({ name: file.name, mimeType: file.type, data: file.content, size: file.size }))
            .filter(isImageUpload);
          if (!trimmedText && textFiles.length === 0 && images.length > 0) {
            messageContent = `${t('chat_attach_imagePrompt')}\n\n${messageContent}`;
          }

          // The draft is cleared only once the send is accepted: a refusal (a task still running in
          // a stored chat, a dead connection) must hand the user their text back, not eat it.
          const accepted = await onSendMessage(messageContent, displayContent, images);

          if (accepted === false) return;
          if (draftVersion.current === submittedVersion) setText('');
          attachedFilesRef.current = [];
          setAttachedFiles([]);
          setAttachError(null);
        } catch {
          setAttachError(t('chat_attach_sendFailed'));
        } finally {
          submitting.current = false;
          setSending(false);
        }
      }
    },
    [text, placeholders, selectSpan, attachedFiles, onSendMessage, showStopButton, inputDisabled, readingFiles],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // The picker owns the arrow keys, Enter and Tab while it has something to offer; Esc closes it
      // for this draft. With no match, Enter falls through and sends, and the panel explains.
      if (pickerOpen && pickerItems.length > 0 && !e.nativeEvent.isComposing) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const step = e.key === 'ArrowDown' ? 1 : -1;
          setPickerIndex(index => (index + step + pickerItems.length) % pickerItems.length);
          return;
        }
        if ((e.key === 'Enter' && !e.shiftKey) || (e.key === 'Tab' && !e.shiftKey)) {
          e.preventDefault();
          pickSkill(pickerItems[Math.min(pickerIndex, pickerItems.length - 1)].name);
          return;
        }
      }
      if (pickerOpen && e.key === 'Escape') {
        e.preventDefault();
        setPickerDismissedAt(text);
        return;
      }

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
    [handleSubmit, placeholders, text, selectSpan, pickerOpen, pickerItems, pickerIndex, pickSkill],
  );

  const handleReplay = useCallback(() => {
    if (historicalSessionId && onReplay) {
      onReplay(historicalSessionId);
    }
  }, [historicalSessionId, onReplay]);

  const handleFileSelect = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const addFiles = useCallback(
    (files: File[]) => {
      if (inputDisabled || files.length === 0 || submitting.current) return Promise.resolve();
      if (files.length + attachedFilesRef.current.length > MAX_UPLOAD_FILES) {
        setAttachError(t('chat_attach_tooMuch'));
        return Promise.resolve();
      }
      pendingReads.current += 1;
      setReadingFiles(true);
      const read = attachmentQueue.current.then(async () => {
        const newFiles: AttachedFile[] = [];
        const rejected: string[] = [];

        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const fileExt = '.' + file.name.split('.').pop()?.toLowerCase();
          const isText = TEXT_EXTENSIONS.includes(fileExt);

          // Text goes into the prompt, so it is held to the old 1 MB line; an upload never enters the
          // context at all, so it is held to the session-storage budget instead.
          const limit = isText ? 1024 * 1024 : MAX_UPLOAD_FILE_BYTES;
          if (file.size === 0 || file.size > limit) {
            rejected.push(file.name);
            continue;
          }

          try {
            newFiles.push({
              name: file.name,
              content: isText ? await file.text() : toBase64(await file.arrayBuffer()),
              type:
                file.type ||
                ({
                  '.png': 'image/png',
                  '.jpg': 'image/jpeg',
                  '.jpeg': 'image/jpeg',
                  '.webp': 'image/webp',
                  '.gif': 'image/gif',
                }[fileExt] ??
                  (isText ? 'text/plain' : 'application/octet-stream')),
              role: isText ? 'text' : 'upload',
              size: file.size,
            });
          } catch (error) {
            console.error(`Error reading file ${file.name}:`, error);
            rejected.push(file.name);
          }
        }

        const merged = [...attachedFilesRef.current, ...newFiles];
        const uploads = merged;
        // Checked against the merged set rather than this batch, or three separate drops of 3 MB each
        // would each pass on their own and together overrun the store.
        const overflow = rejectionReason(
          uploads.map(file => ({ name: file.name, mimeType: file.type, data: file.content, size: file.size })),
        );

        if (overflow) {
          setAttachError(t('chat_attach_tooMuch'));
        } else {
          attachedFilesRef.current = merged;
          setAttachedFiles(merged);
          setAttachError(rejected.length ? t('chat_attach_rejected', [rejected.join(', ')]) : null);
        }
      });
      attachmentQueue.current = read.catch(() => setAttachError(t('chat_attach_sendFailed')));
      return attachmentQueue.current.finally(() => {
        pendingReads.current -= 1;
        setReadingFiles(pendingReads.current > 0);
      });
    },
    [inputDisabled],
  );

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      e.target.value = '';
      await addFiles(files);
    },
    [addFiles],
  );

  const handlePaste = useCallback(
    async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files = Array.from(e.clipboardData.files);
      if (files.length === 0) {
        for (const item of Array.from(e.clipboardData.items)) {
          const file = item.kind === 'file' ? item.getAsFile() : null;
          if (file) files.push(file);
        }
      }
      if (files.length === 0) return;
      e.preventDefault();
      await addFiles(files);
    },
    [addFiles],
  );

  const handleDrop = useCallback(
    async (e: React.DragEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (inputDisabled || submitting.current) return;
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) return addFiles(files);
      const url = droppedImageUrl(e.dataTransfer);
      if (!url) return;
      pendingReads.current += 1;
      setReadingFiles(true);
      try {
        await addFiles([await readDroppedImage(url)]);
      } catch {
        setAttachError(t('chat_attach_sendFailed'));
      } finally {
        pendingReads.current -= 1;
        setReadingFiles(pendingReads.current > 0);
      }
    },
    [addFiles, inputDisabled],
  );

  const handleRemoveFile = useCallback((index: number) => {
    attachedFilesRef.current = attachedFilesRef.current.filter((_, i) => i !== index);
    setAttachedFiles(attachedFilesRef.current);
    setAttachError(null);
  }, []);

  return (
    <>
      {/* The composer is a well pressed into the canvas; focusing it deepens the well. */}
      <form
        onSubmit={handleSubmit}
        onDragOver={e => {
          e.preventDefault();
          e.dataTransfer.dropEffect = inputDisabled ? 'none' : 'copy';
        }}
        onDrop={handleDrop}
        className={`rounded-slab bg-canvas-sunk p-2.5 shadow-neu-inset-sm transition-shadow duration-200 ease-press focus-within:shadow-neu-inset ${inputDisabled ? 'cursor-not-allowed' : ''}`}
        aria-busy={readingFiles || sending}
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
                  {isImageUpload({ mimeType: file.type }) && (
                    <img
                      src={`data:${file.type};base64,${file.content}`}
                      alt={file.name}
                      className="size-9 rounded-soft object-cover"
                    />
                  )}
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

          {pickerOpen && (
            <div className="animate-rise rounded-soft bg-canvas-raised p-1.5 shadow-neu-sm">
              <div
                id="flowkite-skill-picker"
                role="listbox"
                aria-label={t('chat_skills_picker_label')}
                className="max-h-52 space-y-0.5 overflow-y-auto">
                {pickerItems.length === 0 ? (
                  <p className="px-2.5 py-1.5 text-xs text-ink-faint">
                    {t('chat_skills_picker_empty', [skillQuery ?? ''])}
                  </p>
                ) : (
                  pickerItems.map((skill, index) => {
                    const copy = builtinSkillCopy(skill.name);
                    const active = index === pickerIndex;
                    return (
                      <button
                        key={skill.id}
                        id={`flowkite-skill-${skill.name}`}
                        type="button"
                        role="option"
                        aria-selected={active}
                        // Keeps focus in the textarea, so the keyboard flow is never broken by a click.
                        onMouseDown={e => e.preventDefault()}
                        onMouseEnter={() => setPickerIndex(index)}
                        onClick={() => pickSkill(skill.name)}
                        className={`flex w-full flex-col items-start gap-0.5 rounded-soft px-2.5 py-1.5 text-left transition-shadow duration-150 ease-press ${
                          active ? 'bg-canvas-sunk shadow-neu-inset-sm' : ''
                        }`}>
                        <span className="flex w-full min-w-0 items-baseline gap-2">
                          <span className="shrink-0 font-mono text-xs font-medium text-ink">/{skill.name}</span>
                          {copy && <span className="truncate text-[11px] text-ink-soft">{copy.title}</span>}
                        </span>
                        <span className="line-clamp-1 text-[11px] text-ink-faint">
                          {copy?.summary ?? skill.description}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
              <div className="mt-1 flex items-center justify-between gap-2 px-2.5 pt-1">
                <span className="truncate text-[10px] text-ink-faint">{t('chat_skills_picker_hint')}</span>
                <button
                  type="button"
                  onMouseDown={e => e.preventDefault()}
                  onClick={openSkillSettings}
                  className="shrink-0 text-[10px] font-medium text-ink-soft transition-colors duration-150 ease-press hover:text-ink">
                  {t('chat_skills_picker_manage')}
                </button>
              </div>
            </div>
          )}

          <textarea
            ref={textareaRef}
            aria-controls={pickerOpen ? 'flowkite-skill-picker' : undefined}
            aria-activedescendant={
              pickerOpen && pickerItems[pickerIndex] ? `flowkite-skill-${pickerItems[pickerIndex].name}` : undefined
            }
            value={text}
            onChange={handleTextChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            disabled={inputDisabled}
            aria-disabled={inputDisabled}
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

          <p className="px-1.5 text-[10px] leading-tight text-ink-faint" role="note">
            {readingFiles
              ? t('chat_attach_reading')
              : showStopButton
                ? t('chat_input_steerHint')
                : t('chat_attach_hint')}
          </p>

          {/* Says which playbook the task will follow, so `/name` is visibly more than text. */}
          {chosenSkill && !pickerOpen && !showStopButton && (
            <p className="px-1.5 text-[10px] leading-tight text-ink-soft" role="note">
              {t('chat_skills_selected', [chosenSkill.name])}
            </p>
          )}

          {/* Visible exactly while send is held for unfilled slots, so the hold explains itself. */}
          {placeholders.length > 0 && (
            <p className="px-1.5 text-[10px] leading-tight text-ink-faint" role="note">
              {t('chat_template_hint')}
            </p>
          )}

          {/* Continuing a saved conversation restores its persisted context. */}
          {isHistoricalSession && !showStopButton && (
            <p className="px-1.5 text-[10px] leading-tight text-ink-faint" role="note">
              {t('chat_history_continueNote')}
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
                disabled={inputDisabled}
                aria-label={t('chat_attach_a11y')}
                title={t('chat_attach_tooltip')}
                className={`${ICON_BUTTON} ${inputDisabled ? DISABLED_CONTROL : ICON_BUTTON_IDLE}`}>
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
                  disabled={inputDisabled || isProcessingSpeech}
                  aria-label={
                    isProcessingSpeech
                      ? t('chat_stt_processing')
                      : isRecording
                        ? t('chat_stt_recording_stop')
                        : t('chat_stt_input_start')
                  }
                  className={`${ICON_BUTTON} ${
                    inputDisabled || isProcessingSpeech
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
              // A stored chat answers to both keys: replay the old run, or send to continue it.
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={handleReplay}
                  className={`flex h-9 shrink-0 items-center rounded-pill px-4 text-xs font-medium ${GRAPHITE_KEY} ${GRAPHITE_KEY_IDLE}`}>
                  {t('chat_buttons_replay')}
                </button>
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
              </div>
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
