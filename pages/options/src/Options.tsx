import { useState } from 'react';
import '@src/Options.css';
import { withErrorBoundary, withSuspense } from '@extension/shared';
import { t } from '@extension/i18n';
import {
  FiSettings,
  FiCpu,
  FiShield,
  FiTrendingUp,
  FiHelpCircle,
  FiDatabase,
  FiClock,
  FiEye,
  FiZap,
} from 'react-icons/fi';
import { GeneralSettings } from './components/GeneralSettings';
import { ModelSettings } from './components/ModelSettings';
import { FirewallSettings } from './components/FirewallSettings';
import { AnalyticsSettings } from './components/AnalyticsSettings';
import { MemorySettings } from './components/MemorySettings';
import { ScheduleSettings } from './components/ScheduleSettings';
import { PrivacySettings } from './components/PrivacySettings';
import { SkillSettings } from './components/SkillSettings';

type TabTypes =
  | 'general'
  | 'models'
  | 'firewall'
  | 'skills'
  | 'schedules'
  | 'memory'
  | 'privacy'
  | 'analytics'
  | 'help';

const TABS: { id: TabTypes; icon: React.ComponentType<{ className?: string }>; label: string }[] = [
  { id: 'general', icon: FiSettings, label: t('options_tabs_general') },
  { id: 'models', icon: FiCpu, label: t('options_tabs_models') },
  { id: 'firewall', icon: FiShield, label: t('options_tabs_firewall') },
  { id: 'skills', icon: FiZap, label: t('options_tabs_skills') },
  { id: 'schedules', icon: FiClock, label: t('options_tabs_schedules') },
  { id: 'memory', icon: FiDatabase, label: t('options_tabs_memory') },
  { id: 'privacy', icon: FiEye, label: t('options_tabs_privacy') },
  { id: 'analytics', icon: FiTrendingUp, label: t('options_tabs_analytics') },
  { id: 'help', icon: FiHelpCircle, label: t('options_tabs_help') },
];

/** Shared geometry for every rail tab; only the surface treatment differs by state. */
const TAB_BASE =
  'flex w-full items-center gap-2.5 rounded-soft px-4 py-2.5 text-left text-sm font-medium transition-all duration-150 ease-press';

/** The selected pane is the graphite key: dark, lit rim, sitting proud of the canvas — and still pressable. */
const TAB_ACTIVE =
  'bg-graphite text-graphite-50 shadow-key hover:bg-graphite-hover active:translate-y-px active:bg-graphite-active active:shadow-key-pressed';

/** Everything else is a secondary key — pale, flush, ready to be pushed. */
const TAB_IDLE = 'bg-canvas-raised text-ink shadow-neu-sm hover:shadow-neu active:shadow-neu-inset-sm';

/**
 * The pane to open on: `#skills` and the like, so the side panel can link straight to one pane.
 * Anything unknown, and the external help link, fall back to the model settings as before.
 */
function initialTab(): TabTypes {
  const wanted = window.location.hash.replace(/^#/, '');
  const match = TABS.find(tab => tab.id === wanted && tab.id !== 'help');
  return match ? match.id : 'models';
}

const Options = () => {
  const [activeTab, setActiveTab] = useState<TabTypes>(initialTab);

  const handleTabClick = (tabId: TabTypes) => {
    if (tabId === 'help') {
      window.open('https://www.flowkite.xyz/support/', '_blank');
    } else {
      setActiveTab(tabId);
    }
  };

  const renderTabContent = () => {
    switch (activeTab) {
      case 'general':
        return <GeneralSettings />;
      case 'models':
        return <ModelSettings />;
      case 'firewall':
        return <FirewallSettings />;
      case 'skills':
        return <SkillSettings />;
      case 'schedules':
        return <ScheduleSettings />;
      case 'memory':
        return <MemorySettings />;
      case 'privacy':
        return <PrivacySettings />;
      case 'analytics':
        return <AnalyticsSettings />;
      default:
        return null;
    }
  };

  return (
    <div className="min-h-screen bg-canvas text-ink">
      <div className="mx-auto w-full max-w-screen-xl px-6 py-8 lg:px-10 lg:py-12">
        {/* Masthead — mark and wordmark sit directly on the canvas, nothing under them. */}
        <header className="mb-8 flex items-center gap-3">
          <img src="mark.png" alt="" className="size-8 shrink-0" />
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight text-ink">Flowkite</h1>
            <p className="text-sm text-ink-soft">{t('options_masthead_subtitle')}</p>
          </div>
        </header>

        <div className="flex flex-col gap-6 lg:flex-row lg:gap-8">
          {/* Pane rail: a column of keys on wide screens, a wrapped row when space is tight. */}
          <nav aria-label={t('options_nav_header')} className="lg:w-52 lg:shrink-0">
            <h2 className="mb-3 px-1 text-xs font-semibold uppercase tracking-[0.14em] text-ink-faint">
              {t('options_nav_header')}
            </h2>
            <ul className="flex flex-row flex-wrap gap-2 lg:flex-col">
              {TABS.map(item => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => handleTabClick(item.id)}
                    aria-current={activeTab === item.id ? 'page' : undefined}
                    className={`${TAB_BASE} ${activeTab === item.id ? TAB_ACTIVE : TAB_IDLE}`}>
                    <item.icon className="size-4 shrink-0" />
                    <span>{item.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          {/* Content area: one large slab extruded from the canvas. */}
          <main className="min-w-0 flex-1 rounded-slab bg-canvas-raised p-6 shadow-neu-lg lg:p-8">
            {renderTabContent()}
          </main>
        </div>
      </div>
    </div>
  );
};

export default withErrorBoundary(
  withSuspense(
    Options,
    <div className="grid min-h-screen place-items-center bg-canvas text-sm text-ink-soft">
      {t('options_state_loading')}
    </div>,
  ),
  <div className="grid min-h-screen place-items-center bg-canvas text-sm text-ink-soft">
    {t('options_state_error')}
  </div>,
);
