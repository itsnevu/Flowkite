import { useCallback, useEffect, useRef, useState } from 'react';
import { FaBolt, FaCheck, FaChevronDown, FaClipboardCheck, FaHandPaper, FaRocket } from 'react-icons/fa';
import { t } from '@extension/i18n';
import type { IconType } from 'react-icons';
import type { ApprovalMode } from '@extension/storage';

interface ApprovalModePickerProps {
  mode: ApprovalMode;
  disabled?: boolean;
  onSelect: (mode: ApprovalMode) => void;
}

/** Order runs loosest to tightest, so the list reads as a dial rather than an arbitrary menu. */
const MODES: ReadonlyArray<{ value: ApprovalMode; Icon: IconType; label: () => string; desc: () => string }> = [
  { value: 'auto', Icon: FaBolt, label: () => t('chat_mode_auto'), desc: () => t('chat_mode_auto_desc') },
  { value: 'fast', Icon: FaRocket, label: () => t('chat_mode_fast'), desc: () => t('chat_mode_fast_desc') },
  {
    value: 'planner',
    Icon: FaClipboardCheck,
    label: () => t('chat_mode_planner'),
    desc: () => t('chat_mode_planner_desc'),
  },
  { value: 'manual', Icon: FaHandPaper, label: () => t('chat_mode_manual'), desc: () => t('chat_mode_manual_desc') },
];

// By value, not by index: the dial gains entries and the fallback must stay the gated default.
const FALLBACK_MODE = MODES.find(m => m.value === 'planner') ?? MODES[0];

/**
 * The composer's mode dial.
 *
 * A popover rather than a segmented control because the side panel bottoms out around 320px wide:
 * three visible segments would not fit beside the paperclip, mic and send key without wrapping.
 * Collapsed, it is just one more control on the sunken well — same 36px height, same pill radius,
 * same neu-sm-to-inset press as the paperclip beside it.
 *
 * Auto is the only state that colours the pill. A mode that removes every check must never be a
 * silent one, so the warn colour is the standing reminder after the one-time notice is gone.
 *
 * Opens upward: the composer is pinned to the bottom of the panel and the app root is
 * overflow-hidden, so a downward menu would be clipped.
 */
const ApprovalModePicker = ({ mode, disabled = false, onSelect }: ApprovalModePickerProps) => {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(() =>
    Math.max(
      0,
      MODES.findIndex(m => m.value === mode),
    ),
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const current = MODES.find(m => m.value === mode) ?? FALLBACK_MODE;

  // Focus lands in the list, which owns the keyboard; individual options are addressed by
  // aria-activedescendant rather than by moving focus between them.
  useEffect(() => {
    if (!open) return;
    setActiveIndex(
      Math.max(
        0,
        MODES.findIndex(m => m.value === mode),
      ),
    );
    listRef.current?.focus();
  }, [open, mode]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const close = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus();
  }, []);

  const choose = useCallback(
    (value: ApprovalMode) => {
      onSelect(value);
      close();
    },
    [onSelect, close],
  );

  const onListKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex(index => (index + step + MODES.length) % MODES.length);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setActiveIndex(event.key === 'Home' ? 0 : MODES.length - 1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      choose(MODES[activeIndex].value);
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      close();
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(value => !value)}
        disabled={disabled}
        aria-disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('chat_mode_current', [current.label()])}
        title={current.desc()}
        className={`flex h-9 shrink-0 items-center gap-1.5 rounded-pill bg-canvas-raised px-3 text-xs font-medium transition-all duration-150 ease-press ${
          disabled
            ? 'cursor-not-allowed text-ink-faint opacity-45 shadow-none'
            : open
              ? 'text-ink shadow-neu-inset-sm'
              : `${mode === 'auto' ? 'text-signal-warn' : 'text-ink-soft'} shadow-neu-sm hover:text-ink active:shadow-neu-inset-sm`
        }`}>
        <current.Icon className="size-3.5" aria-hidden="true" />
        <span>{current.label()}</span>
        <FaChevronDown className="size-2.5 text-ink-faint" aria-hidden="true" />
      </button>

      {open && (
        <ul
          ref={listRef}
          role="listbox"
          tabIndex={-1}
          aria-label={t('chat_mode_label')}
          aria-activedescendant={`approval-mode-${MODES[activeIndex].value}`}
          onKeyDown={onListKeyDown}
          className="absolute bottom-full left-0 z-20 mb-2 w-60 animate-rise rounded-slab bg-canvas-raised p-1.5 shadow-neu-lg focus:outline-none">
          {MODES.map((item, index) => (
            // This is the ARIA listbox pattern: keyboard handling belongs to the parent <ul> via
            // aria-activedescendant (see its onKeyDown above). An option that also handled keys
            // itself would fight the roving-focus model rather than add to it.
            // eslint-disable-next-line jsx-a11y/click-events-have-key-events
            <li
              key={item.value}
              id={`approval-mode-${item.value}`}
              role="option"
              aria-selected={item.value === mode}
              onClick={() => choose(item.value)}
              onMouseEnter={() => setActiveIndex(index)}
              className={`cursor-pointer rounded-soft px-3 py-2 transition-all duration-150 ease-press ${
                index === activeIndex ? 'bg-canvas-sunk shadow-neu-inset-sm' : ''
              }`}>
              <div className="flex items-center gap-2">
                <item.Icon
                  className={`size-3.5 shrink-0 ${item.value === 'auto' ? 'text-signal-warn' : 'text-ink-soft'}`}
                  aria-hidden="true"
                />
                <span className="text-xs font-semibold text-ink">{item.label()}</span>
                {item.value === mode && (
                  <FaCheck className="ml-auto size-2.5 shrink-0 text-ink-soft" aria-hidden="true" />
                )}
              </div>
              <p className="mt-0.5 pl-5 text-[11px] leading-snug text-ink-soft">{item.desc()}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default ApprovalModePicker;
