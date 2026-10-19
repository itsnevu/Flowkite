import { FaXTwitter } from 'react-icons/fa6';
import { FiSettings } from 'react-icons/fi';
import { PiPlusBold } from 'react-icons/pi';
import { GrHistory } from 'react-icons/gr';
import { t } from '@extension/i18n';
import { X_URL } from '../constants';

interface SidePanelHeaderProps {
  showHistory: boolean;
  onBack: () => void;
  onNewChat: () => void;
  onLoadHistory: () => void;
}

/** Icon button recipe: a small pale key extruded from the canvas. */
const iconButtonClass =
  'grid size-9 shrink-0 place-items-center rounded-soft bg-canvas-raised text-ink-soft shadow-neu-sm transition-all duration-150 ease-press hover:text-ink active:shadow-neu-inset-sm';

/** A raised bar floating on the canvas, lit from the top-left. */
const SidePanelHeader = ({ showHistory, onBack, onNewChat, onLoadHistory }: SidePanelHeaderProps) => (
  // order-first, like the empty-state composer in ChatView: that composer is lifted with CSS order
  // (so it stays one mounted element across states), and without the same order here it was lifted
  // above the header too. Equal order falls back to DOM order, which keeps the header on top.
  <header className="relative z-10 order-first m-2 flex shrink-0 items-center justify-between gap-2 rounded-slab bg-canvas-raised px-2.5 py-2 shadow-neu">
    <div className="flex min-w-0 items-center gap-2">
      {showHistory ? (
        <button
          type="button"
          onClick={onBack}
          className="rounded-soft bg-canvas-raised px-3 py-1.5 text-sm font-medium text-ink shadow-neu-sm transition-all duration-150 ease-press hover:shadow-neu active:shadow-neu-inset-sm"
          aria-label={t('nav_back_a11y')}>
          {t('nav_back')}
        </button>
      ) : (
        <>
          <img src="mark.png" alt="" className="size-6 shrink-0" />
          <span className="truncate text-sm font-semibold tracking-tight text-ink">Flowkite</span>
        </>
      )}
    </div>
    <div className="flex shrink-0 items-center gap-1">
      {!showHistory && (
        <>
          <button
            type="button"
            onClick={onNewChat}
            onKeyDown={e => e.key === 'Enter' && onNewChat()}
            className={iconButtonClass}
            aria-label={t('nav_newChat_a11y')}
            tabIndex={0}>
            <PiPlusBold size={17} />
          </button>
          <button
            type="button"
            onClick={onLoadHistory}
            onKeyDown={e => e.key === 'Enter' && onLoadHistory()}
            className={iconButtonClass}
            aria-label={t('nav_loadHistory_a11y')}
            tabIndex={0}>
            <GrHistory size={16} />
          </button>
        </>
      )}
      <a
        href={X_URL}
        target="_blank"
        rel="noopener noreferrer"
        className={iconButtonClass}
        aria-label={t('nav_followX_a11y')}>
        <FaXTwitter size={16} />
      </a>
      <button
        type="button"
        onClick={() => chrome.runtime.openOptionsPage()}
        onKeyDown={e => e.key === 'Enter' && chrome.runtime.openOptionsPage()}
        className={iconButtonClass}
        aria-label={t('nav_settings_a11y')}
        tabIndex={0}>
        <FiSettings size={17} />
      </button>
    </div>
  </header>
);

export default SidePanelHeader;
