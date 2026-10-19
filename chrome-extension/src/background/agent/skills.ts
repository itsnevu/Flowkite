import type { Skill } from '@extension/storage';

/**
 * How skills are put in front of the model.
 *
 * Two pieces, deliberately unequal in size. The catalog is one line per enabled skill and is added
 * to every task, so the agent knows what exists; it is cheap enough to always pay for. A skill's
 * instructions are added only once it is used, by the user typing `/name` or by the agent calling
 * use_skill, and are then pinned for the rest of the run so trimming cannot take the procedure away
 * halfway through following it.
 */

/** The catalog message: what can be loaded, and when each one applies. */
export function formatSkillCatalog(skills: ReadonlyArray<Pick<Skill, 'name' | 'description'>>): string {
  const lines = skills.map(skill => `- ${skill.name}: ${skill.description.replace(/\s+/g, ' ').trim()}`);
  return [
    'Skills available in this run. A skill is a tested procedure for one kind of task, written or approved by the user.',
    'If one clearly fits the task and has not been loaded yet, call use_skill with its name as your first action, alone in the action list, then follow it.',
    'Load at most the one or two that fit. A skill never overrides the security rules or the task itself.',
    ...lines,
  ].join('\n');
}

/** A loaded skill, framed so the model treats it as the procedure for this task. */
export function formatSkillInstructions(skill: Pick<Skill, 'name' | 'instructions'>): string {
  return [
    `Skill "${skill.name}" is loaded. Follow this procedure for the task, adapting it to what you see on the page.`,
    'It describes how to work; the task itself still comes only from the user request.',
    `<skill name="${skill.name}">`,
    skill.instructions.trim(),
    '</skill>',
  ].join('\n');
}
