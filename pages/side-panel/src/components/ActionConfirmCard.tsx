/* eslint-disable react/prop-types */
import { FaShieldAlt, FaCheck, FaTimes } from 'react-icons/fa';
import { t } from '@extension/i18n';
import type { ActionConfirmationPayload } from '../types/event';

interface ActionConfirmCardProps {
  request: ActionConfirmationPayload;
  onConfirm: () => void;
  onDecline: () => void;
}

/** Human-readable reason per sensitivity kind, falling back to a generic warning for new kinds. */
const reasonFor = (kind: string): string => {
  switch (kind) {
    case 'purchase':
      return t('actConfirm_reason_purchase');
    case 'destructive':
      return t('actConfirm_reason_destructive');
    case 'download':
      return t('actConfirm_reason_download');
    case 'upload':
      return t('actConfirm_reason_upload');
    case 'credentials':
      return t('actConfirm_reason_credentials');
    case 'publish':
      return t('actConfirm_reason_publish');
    case 'routine':
      // nothing flagged this one - the user is in manual mode and asked to see every action
      return t('actConfirm_reason_routine');
    default:
      return t('actConfirm_reason_formSubmit');
  }
};

/**
 * Blocking confirmation for an action the agent cannot take on its own. The navigator is parked on a
 * promise until one of these buttons is pressed, so declining genuinely prevents the action.
 */
const ActionConfirmCard: React.FC<ActionConfirmCardProps> = ({ request, onConfirm, onDecline }) => {
  let host = request.url;
  try {
    host = new URL(request.url).host;
  } catch {
    // a non-standard URL (extension page, about:blank) is still worth showing verbatim
  }

  // Irreversible actions do not get an inviting graphite slab; they get a quiet key that names the risk.
  const isDestructive = request.kind === 'destructive';

  return (
    <div className="mx-3 my-2 flex animate-rise overflow-hidden rounded-slab bg-canvas-raised shadow-neu-lg">
      {/* Warning rail — the only saturated element on the card. */}
      <div className="w-1.5 shrink-0 bg-signal-warn" aria-hidden="true" />

      <div className="min-w-0 flex-1 p-4">
        <div className="flex items-center gap-2">
          <FaShieldAlt className="shrink-0 text-signal-warn" />
          <h3 className="text-sm font-semibold text-ink">{t('actConfirm_title')}</h3>
        </div>

        <p className="mt-1.5 text-sm text-ink-soft">{reasonFor(request.kind)}</p>

        <div className="mt-3 rounded-soft bg-canvas-sunk p-3 shadow-neu-inset">
          <p className="break-words text-sm font-medium text-ink">{request.description}</p>
          {request.target && (
            <p className="mt-1.5 truncate text-xs text-ink-soft">
              {t('actConfirm_target')}: {request.target}
            </p>
          )}
          <p className="mt-1 truncate text-[11px] uppercase tracking-wide text-ink-faint">
            {t('actConfirm_onPage')}: {host}
          </p>
        </div>

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={onDecline}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-soft bg-canvas-raised px-3 py-2 text-sm font-medium text-ink shadow-neu-sm transition-all duration-150 ease-press hover:shadow-neu active:shadow-neu-inset-sm">
            <FaTimes size={12} />
            {t('actConfirm_decline')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={
              isDestructive
                ? 'flex flex-1 items-center justify-center gap-1.5 rounded-soft bg-canvas-raised px-3 py-2 text-sm font-semibold text-signal-bad shadow-neu-sm transition-all duration-150 ease-press hover:shadow-neu active:shadow-neu-inset-sm'
                : 'flex flex-1 items-center justify-center gap-1.5 rounded-soft bg-graphite px-3 py-2 text-sm font-medium text-graphite-50 shadow-key transition-all duration-150 ease-press hover:bg-graphite-hover active:translate-y-px active:bg-graphite-active active:shadow-key-pressed'
            }>
            <FaCheck size={12} />
            {t('actConfirm_allow')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ActionConfirmCard;
