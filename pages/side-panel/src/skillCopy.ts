import { t } from '@extension/i18n';

/**
 * The localised title and one-line summary of a built-in skill, for the picker.
 *
 * The skill's own description is written for the model ("Use when ..."), in English, and reads
 * oddly in a menu; these are written for the person choosing. A custom skill has no entry here and
 * shows its own description instead. Kept in step with pages/options/src/skillCopy.ts.
 */
export function builtinSkillCopy(name: string): { title: string; summary: string } | null {
  switch (name) {
    case 'web-research':
      return {
        title: t('options_skills_builtin_webResearch_title'),
        summary: t('options_skills_builtin_webResearch_desc'),
      };
    case 'compare-options':
      return {
        title: t('options_skills_builtin_compareOptions_title'),
        summary: t('options_skills_builtin_compareOptions_desc'),
      };
    case 'collect-list':
      return {
        title: t('options_skills_builtin_collectList_title'),
        summary: t('options_skills_builtin_collectList_desc'),
      };
    case 'fill-form':
      return { title: t('options_skills_builtin_fillForm_title'), summary: t('options_skills_builtin_fillForm_desc') };
    case 'summarize-page':
      return {
        title: t('options_skills_builtin_summarizePage_title'),
        summary: t('options_skills_builtin_summarizePage_desc'),
      };
    case 'inbox-assistant':
      return {
        title: t('options_skills_builtin_inboxAssistant_title'),
        summary: t('options_skills_builtin_inboxAssistant_desc'),
      };
    case 'travel-search':
      return {
        title: t('options_skills_builtin_travelSearch_title'),
        summary: t('options_skills_builtin_travelSearch_desc'),
      };
    case 'check-status':
      return {
        title: t('options_skills_builtin_checkStatus_title'),
        summary: t('options_skills_builtin_checkStatus_desc'),
      };
    default:
      return null;
  }
}

/**
 * The skills whose names start with what the user typed after the slash, best match first: an exact
 * name, then names that start with the query, in their library order.
 */
export function matchSkills<S extends { name: string }>(skills: readonly S[], query: string): S[] {
  const wanted = query.toLowerCase();
  const matching = skills.filter(skill => skill.name.startsWith(wanted));
  return [...matching.filter(skill => skill.name === wanted), ...matching.filter(skill => skill.name !== wanted)];
}

/** The slash token being typed, when the whole draft is still just that token; otherwise null. */
export function slashQuery(draft: string): string | null {
  const match = /^\/([a-z0-9-]*)$/.exec(draft);
  return match ? match[1] : null;
}
