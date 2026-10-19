import { useState, useEffect, useMemo, useRef } from 'react';
import { FiPlus, FiUpload, FiDownload, FiCopy, FiEdit2, FiTrash2 } from 'react-icons/fi';
import {
  skillStore,
  normalizeSkillName,
  uniqueSkillName,
  parseSkillMarkdown,
  toSkillMarkdown,
  MAX_CUSTOM_SKILLS,
  MAX_SKILL_INSTRUCTIONS_LENGTH,
  MAX_SKILL_DESCRIPTION_LENGTH,
  type Skill,
} from '@extension/storage';
import { t } from '@extension/i18n';
import { builtinSkillCopy } from '../skillCopy';
import { Divider, Toggle } from './controls';

const fieldClass =
  'w-full rounded-soft bg-canvas-sunk px-3 py-2 text-sm text-ink shadow-neu-inset outline-none placeholder:text-ink-faint';

/** Graphite key, as everywhere else on this page. */
const primaryButtonClass =
  'inline-flex items-center justify-center gap-2 rounded-soft bg-graphite px-4 py-2 text-sm font-medium text-graphite-50 shadow-key transition-all duration-150 ease-press hover:bg-graphite-hover active:translate-y-px active:bg-graphite-active active:shadow-key-pressed disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none';

/** A pale secondary key. */
const secondaryButtonClass =
  'inline-flex items-center justify-center gap-1.5 rounded-soft bg-canvas-raised px-3 py-1.5 text-xs font-medium text-ink shadow-neu-sm transition-all duration-150 ease-press hover:shadow-neu active:shadow-neu-inset-sm';

const dangerButtonClass =
  'inline-flex items-center justify-center gap-1.5 rounded-soft bg-canvas-raised px-3 py-1.5 text-xs font-medium text-ink-soft shadow-neu-sm transition-all duration-150 ease-press hover:text-signal-bad active:shadow-neu-inset-sm';

interface Draft {
  /** Present when editing one of the user's own skills. */
  id?: string;
  name: string;
  description: string;
  instructions: string;
}

const EMPTY_DRAFT: Draft = { name: '', description: '', instructions: '' };

function usageLine(skill: Skill): string {
  return skill.useCount > 0
    ? t('options_skills_usage', [String(skill.useCount), new Date(skill.lastUsedAt).toLocaleDateString()])
    : t('options_skills_neverUsed');
}

function downloadSkill(skill: Skill): void {
  const blob = new Blob([toSkillMarkdown(skill)], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${skill.name}.md`;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * The skills library: what ships with Flowkite, what the user wrote, and the editor for both.
 *
 * Built-ins are read-only on purpose (their text is code and would be overwritten by the next
 * update), so "Duplicate" is the way to make one your own. Names are never refused: a taken name is
 * suffixed and the pane says so before saving, because throwing away a skill someone just wrote over
 * its name is the wrong trade.
 */
export const SkillSettings = () => {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const load = () => skillStore.getAll().then(setSkills).catch(console.error);
    void load();
    return skillStore.subscribe(() => void load());
  }, []);

  const builtins = skills.filter(skill => skill.builtin);
  const custom = skills.filter(skill => !skill.builtin);

  /** The name the draft will actually be saved under, and the name the user asked for. */
  const naming = useMemo(() => {
    if (!draft) return null;
    const wanted = normalizeSkillName(draft.name) || 'skill';
    const taken = new Set(skills.filter(skill => skill.id !== draft.id).map(skill => skill.name));
    return { wanted, saved: uniqueSkillName(draft.name, taken) };
  }, [draft, skills]);

  const openEditor = (next: Draft, message: string | null = null) => {
    setDraft(next);
    setNotice(message);
    requestAnimationFrame(() => editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  };

  const handleSave = async () => {
    if (!draft) return;
    const saved = await skillStore.saveCustom(draft).catch(() => null);
    if (!saved) {
      setNotice(t('options_skills_full', [String(MAX_CUSTOM_SKILLS)]));
      return;
    }
    setDraft(null);
    setNotice(t('options_skills_saved', [saved.name]));
  };

  const handleImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const parsed = parseSkillMarkdown(await file.text(), file.name.replace(/\.(md|markdown|txt)$/i, ''));
    if (!parsed) {
      setNotice(t('options_skills_import_failed', [file.name]));
      return;
    }
    openEditor(parsed, t('options_skills_import_review'));
  };

  const atCapacity = custom.length >= MAX_CUSTOM_SKILLS;

  const renderSteps = (skill: Skill) =>
    expanded === skill.id && (
      <pre className="mt-3 max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-soft bg-canvas-sunk p-4 font-sans text-xs leading-relaxed text-ink-soft shadow-neu-inset">
        {skill.instructions}
      </pre>
    );

  const stepsButton = (skill: Skill) => (
    <button
      type="button"
      onClick={() => setExpanded(current => (current === skill.id ? null : skill.id))}
      aria-expanded={expanded === skill.id}
      className={secondaryButtonClass}>
      {expanded === skill.id ? t('options_skills_hideSteps') : t('options_skills_showSteps')}
    </button>
  );

  return (
    <section className="space-y-6 text-left">
      <div>
        <h2 className="text-lg font-semibold tracking-tight text-ink">{t('options_skills_header')}</h2>
        <p className="mt-1 text-sm text-ink-soft">{t('options_skills_desc')}</p>
      </div>

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          disabled={atCapacity}
          onClick={() => openEditor(EMPTY_DRAFT)}
          className={primaryButtonClass}>
          <FiPlus size={14} aria-hidden="true" />
          {t('options_skills_new')}
        </button>
        <button type="button" onClick={() => importRef.current?.click()} className={secondaryButtonClass}>
          <FiUpload size={13} aria-hidden="true" />
          {t('options_skills_import')}
        </button>
        <input
          ref={importRef}
          type="file"
          accept=".md,.markdown,.txt,text/markdown,text/plain"
          onChange={event => void handleImport(event)}
          className="hidden"
          aria-hidden="true"
        />
      </div>

      {notice && (
        <p className="rounded-soft bg-canvas-sunk px-4 py-2.5 text-sm text-ink-soft shadow-neu-inset-sm" role="status">
          {notice}
        </p>
      )}

      {draft && naming && (
        <div ref={editorRef} className="space-y-4 rounded-soft bg-canvas-raised p-5 shadow-neu">
          <h3 className="text-base font-semibold text-ink">
            {draft.id ? t('options_skills_form_edit') : t('options_skills_form_new')}
          </h3>

          <div className="space-y-1.5">
            <label htmlFor="skillName" className="text-sm font-medium text-ink">
              {t('options_skills_name')}
            </label>
            <input
              id="skillName"
              type="text"
              value={draft.name}
              onChange={event => setDraft({ ...draft, name: event.target.value })}
              placeholder={t('options_skills_name_placeholder')}
              className={fieldClass}
            />
            {/* Said before saving, not after: the name is how the skill is called, so a rename is
                something to know while there is still a chance to pick another one. */}
            <p className="text-xs text-ink-faint">
              {naming.saved === naming.wanted
                ? t('options_skills_call', [naming.saved])
                : t('options_skills_renamed', [naming.wanted, naming.saved])}
            </p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="skillDescription" className="text-sm font-medium text-ink">
              {t('options_skills_description')}
            </label>
            <input
              id="skillDescription"
              type="text"
              maxLength={MAX_SKILL_DESCRIPTION_LENGTH}
              value={draft.description}
              onChange={event => setDraft({ ...draft, description: event.target.value })}
              placeholder={t('options_skills_description_placeholder')}
              className={fieldClass}
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="skillInstructions" className="text-sm font-medium text-ink">
              {t('options_skills_instructions')}
            </label>
            <textarea
              id="skillInstructions"
              rows={12}
              maxLength={MAX_SKILL_INSTRUCTIONS_LENGTH}
              value={draft.instructions}
              onChange={event => setDraft({ ...draft, instructions: event.target.value })}
              placeholder={t('options_skills_instructions_placeholder')}
              className={`${fieldClass} resize-y font-mono text-xs leading-relaxed`}
            />
            <p className="text-right text-xs text-ink-faint">
              {t('options_skills_count', [String(draft.instructions.length), String(MAX_SKILL_INSTRUCTIONS_LENGTH)])}
            </p>
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              disabled={draft.instructions.trim() === ''}
              onClick={() => void handleSave()}
              className={primaryButtonClass}>
              {t('options_skills_save')}
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(null);
                setNotice(null);
              }}
              className={secondaryButtonClass}>
              {t('options_skills_cancel')}
            </button>
          </div>
        </div>
      )}

      <div>
        <h3 className="text-base font-medium text-ink">
          {t('options_skills_custom')} ({custom.length}/{MAX_CUSTOM_SKILLS})
        </h3>
        {custom.length === 0 ? (
          <div className="mt-3 rounded-soft bg-canvas-sunk p-5 shadow-neu-inset">
            <p className="text-center text-sm text-ink-faint">{t('options_skills_custom_empty')}</p>
          </div>
        ) : (
          <ul className="mt-3 space-y-3">
            {custom.map(skill => (
              <li key={skill.id} className="rounded-soft bg-canvas-raised p-4 shadow-neu-sm">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="font-mono text-sm font-medium text-ink">/{skill.name}</p>
                    <p className="mt-1 break-words text-sm text-ink-soft">{skill.description}</p>
                    <p className="mt-1.5 text-xs text-ink-faint">{usageLine(skill)}</p>
                  </div>
                  <Toggle
                    id={`skill-${skill.id}`}
                    label={t('options_skills_enable')}
                    checked={skill.enabled}
                    onChange={checked => void skillStore.setEnabled(skill.id, checked)}
                  />
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {stepsButton(skill)}
                  <button
                    type="button"
                    onClick={() =>
                      openEditor({
                        id: skill.id,
                        name: skill.name,
                        description: skill.description,
                        instructions: skill.instructions,
                      })
                    }
                    className={secondaryButtonClass}>
                    <FiEdit2 size={12} aria-hidden="true" />
                    {t('options_skills_edit')}
                  </button>
                  <button type="button" onClick={() => downloadSkill(skill)} className={secondaryButtonClass}>
                    <FiDownload size={12} aria-hidden="true" />
                    {t('options_skills_export')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void skillStore.removeCustom(skill.id)}
                    className={dangerButtonClass}>
                    <FiTrash2 size={12} aria-hidden="true" />
                    {t('options_skills_delete')}
                  </button>
                </div>
                {renderSteps(skill)}
              </li>
            ))}
          </ul>
        )}
      </div>

      <Divider />

      <div>
        <h3 className="text-base font-medium text-ink">{t('options_skills_builtin')}</h3>
        <p className="mt-1 text-sm text-ink-soft">{t('options_skills_builtin_note')}</p>
        <ul className="mt-3 space-y-3">
          {builtins.map(skill => {
            const copy = builtinSkillCopy(skill.name);
            return (
              <li key={skill.id} className="rounded-soft bg-canvas-raised p-4 shadow-neu-sm">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-sm font-semibold text-ink">{copy?.title ?? skill.name}</span>
                      <span className="font-mono text-xs text-ink-faint">/{skill.name}</span>
                    </p>
                    <p className="mt-1 text-sm text-ink-soft">{copy?.summary ?? skill.description}</p>
                    <p className="mt-1.5 text-xs text-ink-faint">{usageLine(skill)}</p>
                  </div>
                  <Toggle
                    id={`skill-${skill.id}`}
                    label={t('options_skills_enable')}
                    checked={skill.enabled}
                    onChange={checked => void skillStore.setEnabled(skill.id, checked)}
                  />
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {stepsButton(skill)}
                  <button
                    type="button"
                    disabled={atCapacity}
                    onClick={() =>
                      openEditor({
                        name: skill.name,
                        description: skill.description,
                        instructions: skill.instructions,
                      })
                    }
                    className={secondaryButtonClass}>
                    <FiCopy size={12} aria-hidden="true" />
                    {t('options_skills_duplicate')}
                  </button>
                </div>
                {renderSteps(skill)}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
};
