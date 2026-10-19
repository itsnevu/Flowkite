import { describe, it, expect, beforeEach } from 'vitest';
import {
  skillStore,
  normalizeSkillName,
  uniqueSkillName,
  parseSkillInvocation,
  parseSkillMarkdown,
  toSkillMarkdown,
  MAX_CUSTOM_SKILLS,
  MAX_SKILL_INSTRUCTIONS_LENGTH,
} from '../lib/skills/skillStore';
import { BUILTIN_SKILLS } from '../lib/skills/builtin';

async function clear() {
  for (const skill of await skillStore.getAll()) {
    if (skill.builtin) await skillStore.setEnabled(skill.id, true);
    else await skillStore.removeCustom(skill.id);
  }
}

describe('skill names', () => {
  it('turns typed titles into callable names', () => {
    expect(normalizeSkillName('Price Watch (daily)')).toBe('price-watch-daily');
    expect(normalizeSkillName('  --Résumé Helper--  ')).toBe('resume-helper');
    expect(normalizeSkillName('!!!')).toBe('');
  });

  it('caps the length without leaving a trailing hyphen', () => {
    const name = normalizeSkillName(`${'a'.repeat(39)} b`);
    expect(name.length).toBeLessThanOrEqual(40);
    expect(name.endsWith('-')).toBe(false);
  });

  // a refusal would throw away a skill the user just wrote over a detail they can change later
  it('suffixes a taken name instead of refusing it', () => {
    expect(uniqueSkillName('web-research', new Set(['web-research']))).toBe('web-research-2');
    expect(uniqueSkillName('x', new Set(['x', 'x-2']))).toBe('x-3');
  });

  it('never hands out a name the side panel already uses as a command', () => {
    expect(uniqueSkillName('replay', new Set())).toBe('replay-2');
  });

  it('falls back to a usable name when nothing survives normalizing', () => {
    expect(uniqueSkillName('???', new Set())).toBe('skill');
  });
});

describe('parseSkillInvocation', () => {
  it('splits the skill from the request', () => {
    expect(parseSkillInvocation('/web-research best e-bikes 2026')).toEqual({
      name: 'web-research',
      rest: 'best e-bikes 2026',
    });
  });

  it('keeps a multi-line request intact', () => {
    expect(parseSkillInvocation('/fill-form\nname: Ana\nemail: a@b.c')?.rest).toBe('name: Ana\nemail: a@b.c');
  });

  it('accepts a bare invocation with no request', () => {
    expect(parseSkillInvocation('/summarize-page')).toEqual({ name: 'summarize-page', rest: '' });
  });

  it('ignores text that is not a slash command', () => {
    expect(parseSkillInvocation('summarize /this')).toBeNull();
    expect(parseSkillInvocation('/usr/bin is a path')).toBeNull();
    expect(parseSkillInvocation('/Upper')).toBeNull();
  });
});

describe('SKILL.md import and export', () => {
  it('reads front matter and body', () => {
    const parsed = parseSkillMarkdown(
      '---\nname: Price Watch\ndescription: "Use when tracking a price."\n---\n\n1. Open the page.\n',
    );
    expect(parsed).toEqual({
      name: 'price-watch',
      description: 'Use when tracking a price.',
      instructions: '1. Open the page.',
    });
  });

  it('takes a file without front matter whole, named after the file', () => {
    expect(parseSkillMarkdown('Just do the thing.', 'My Notes')).toEqual({
      name: 'my-notes',
      description: '',
      instructions: 'Just do the thing.',
    });
  });

  it('returns null when there are no instructions', () => {
    expect(parseSkillMarkdown('---\nname: empty\n---\n   \n')).toBeNull();
  });

  it('round-trips through export', () => {
    const skill = { name: 'a-b', description: 'Use when x.', instructions: 'Step one.\nStep two.' };
    expect(parseSkillMarkdown(toSkillMarkdown(skill))).toEqual(skill);
  });
});

describe('skillStore', () => {
  beforeEach(clear);

  it('ships every built-in switched on', async () => {
    const enabled = await skillStore.getEnabled();
    expect(enabled.filter(skill => skill.builtin).map(skill => skill.name)).toEqual(
      BUILTIN_SKILLS.map(skill => skill.name),
    );
  });

  it('gives every built-in a description and instructions the agent can use', () => {
    for (const skill of BUILTIN_SKILLS) {
      expect(skill.description.startsWith('Use when')).toBe(true);
      expect(skill.instructions.length).toBeGreaterThan(200);
      expect(skill.instructions.length).toBeLessThanOrEqual(MAX_SKILL_INSTRUCTIONS_LENGTH);
      // the answer style bans markdown, and a skill asking for it would contradict that rule
      expect(skill.instructions).not.toMatch(/\*\*|^#|\|---/m);
      expect(skill.instructions).not.toMatch(/[–—]/);
    }
  });

  it('saves a custom skill under a normalized, unique name', async () => {
    const saved = await skillStore.saveCustom({ name: 'Web Research', description: '', instructions: 'Do it my way.' });
    expect(saved?.name).toBe('web-research-2');
    expect(saved?.description).toBe('Do it my way.');
    expect(saved?.enabled).toBe(true);
  });

  it('keeps the name when an edit does not change it', async () => {
    const saved = await skillStore.saveCustom({ name: 'mine', description: 'd', instructions: 'one' });
    const edited = await skillStore.saveCustom({ id: saved!.id, name: 'mine', description: 'd', instructions: 'two' });
    expect(edited?.name).toBe('mine');
    expect(edited?.instructions).toBe('two');
    expect((await skillStore.getAll()).filter(skill => !skill.builtin)).toHaveLength(1);
  });

  it('refuses to save empty instructions', async () => {
    expect(await skillStore.saveCustom({ name: 'x', description: 'y', instructions: '   ' })).toBeNull();
  });

  it('stops at the library cap', async () => {
    for (let i = 0; i < MAX_CUSTOM_SKILLS; i++) {
      await skillStore.saveCustom({ name: `s${i}`, description: '', instructions: 'x' });
    }
    expect(await skillStore.saveCustom({ name: 'one-more', description: '', instructions: 'x' })).toBeNull();
  });

  it('cannot find a switched-off skill by name', async () => {
    await skillStore.setEnabled('builtin:web-research', false);
    expect(await skillStore.findEnabled('web-research')).toBeNull();
    await skillStore.setEnabled('builtin:web-research', true);
    expect((await skillStore.findEnabled('web-research'))?.builtin).toBe(true);
  });

  it('counts uses for built-in and custom skills alike', async () => {
    const saved = await skillStore.saveCustom({ name: 'mine', description: '', instructions: 'x' });
    await skillStore.markUsed('mine');
    await skillStore.markUsed('fill-form');
    await skillStore.markUsed('fill-form');
    const all = await skillStore.getAll();
    expect(all.find(skill => skill.id === saved!.id)?.useCount).toBe(1);
    expect(all.find(skill => skill.name === 'fill-form')?.useCount).toBe(2);
  });

  it('removes only custom skills', async () => {
    const saved = await skillStore.saveCustom({ name: 'mine', description: '', instructions: 'x' });
    await skillStore.removeCustom(saved!.id);
    await skillStore.removeCustom('builtin:fill-form');
    const names = (await skillStore.getAll()).map(skill => skill.name);
    expect(names).not.toContain('mine');
    expect(names).toContain('fill-form');
  });
});
