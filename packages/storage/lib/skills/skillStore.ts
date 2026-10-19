import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import { BUILTIN_SKILLS, BUILTIN_SKILL_NAMES } from './builtin';
import type { BaseStorage } from '../base/types';

/**
 * Skills: named playbooks the agent loads when a task calls for them.
 *
 * Two kinds share one list. Built-in skills ship with the extension and can be switched off but not
 * edited (the text is code, and an edit would be silently lost on the next update); the user
 * duplicates one to make their own version. Custom skills are written or imported by the user and
 * live here, on this machine only.
 *
 * Every skill is reachable two ways: the user types `/name` in front of a task, or the agent sees the
 * one-line description in its catalog and loads the skill itself with use_skill.
 */
export interface Skill {
  /** `builtin:<name>` for a shipped skill, `custom:<n>` for one of the user's own. */
  id: string;
  /** Lowercase letters, digits and hyphens; what follows the slash. Unique across both kinds. */
  name: string;
  /** When the skill applies, one sentence. This is what the agent reads to decide. */
  description: string;
  /** The procedure the agent follows once the skill is loaded. */
  instructions: string;
  builtin: boolean;
  enabled: boolean;
  /** Last time a run loaded it; 0 when never. */
  lastUsedAt: number;
  useCount: number;
}

export interface SkillInput {
  /** Present when editing an existing custom skill. */
  id?: string;
  name: string;
  description: string;
  instructions: string;
}

interface CustomSkillRecord {
  id: number;
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number;
  useCount: number;
}

interface SkillUsage {
  lastUsedAt: number;
  useCount: number;
}

export interface SkillStorageState {
  nextId: number;
  custom: CustomSkillRecord[];
  /** Built-ins are on unless named here, so a skill added in an update arrives switched on. */
  disabledBuiltins: string[];
  builtinUsage: Record<string, SkillUsage>;
}

/** Each enabled skill costs one catalog line in every task, so the library is bounded. */
export const MAX_CUSTOM_SKILLS = 50;
export const MAX_SKILL_NAME_LENGTH = 40;
export const MAX_SKILL_DESCRIPTION_LENGTH = 300;
/** A loaded skill is pinned in the context for the rest of the run, so one cannot swallow the window. */
export const MAX_SKILL_INSTRUCTIONS_LENGTH = 8000;

/** Slash commands the side panel already owns; a skill with one of these names could never be called. */
export const RESERVED_SKILL_NAMES: ReadonlySet<string> = new Set(['replay', 'state', 'nohighlight']);

const initialState: SkillStorageState = {
  nextId: 1,
  custom: [],
  disabledBuiltins: [],
  builtinUsage: {},
};

/** Local, like memories: a user's playbooks can describe their accounts and habits. */
const storage: BaseStorage<SkillStorageState> = createStorage('agent-skills', initialState, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

/**
 * Turn whatever the user typed into a callable name: "Price Watch (daily)" becomes `price-watch-daily`.
 * Accents are folded rather than dropped, so "Résumé" is `resume`, not `r-sum`.
 */
export function normalizeSkillName(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SKILL_NAME_LENGTH)
    .replace(/-+$/g, '');
}

/**
 * The first free name at or after `base`: `base`, then `base-2`, `base-3`, ...
 *
 * Saving under a taken name renames the new skill instead of refusing it, because a refusal would
 * throw away a skill the user just wrote over a detail the UI can show and they can change.
 */
export function uniqueSkillName(base: string, taken: ReadonlySet<string>): string {
  const root = normalizeSkillName(base) || 'skill';
  const isFree = (name: string) => !taken.has(name) && !RESERVED_SKILL_NAMES.has(name);
  if (isFree(root)) return root;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${root.slice(0, MAX_SKILL_NAME_LENGTH - suffix.length).replace(/-+$/g, '')}${suffix}`;
    if (isFree(candidate)) return candidate;
  }
}

/** Matches `/name` at the very start of a task, optionally followed by the rest of the request. */
const INVOCATION = /^\/([a-z0-9][a-z0-9-]{0,39})(?:\s+([\s\S]*))?$/;

/**
 * Split `/name rest of the task` into the skill name and the request.
 *
 * Purely syntactic: whether `name` is a skill is for the caller to look up. Returns null for anything
 * that does not start with a slash command, including a bare URL path like `/usr/bin`, which fails
 * the name grammar on its second slash.
 */
export function parseSkillInvocation(text: string): { name: string; rest: string } | null {
  const match = INVOCATION.exec(text.trim());
  if (!match) return null;
  return { name: match[1], rest: (match[2] ?? '').trim() };
}

/** A description to fall back on when the user left theirs empty: the opening of the procedure. */
function fallbackDescription(instructions: string): string {
  const firstLine = instructions.split('\n').find(line => line.trim() !== '') ?? '';
  return firstLine.trim().slice(0, MAX_SKILL_DESCRIPTION_LENGTH);
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && /^(["']).*\1$/.test(trimmed)) return trimmed.slice(1, -1);
  return trimmed;
}

/**
 * Read a skill from a SKILL.md-style file: YAML-ish front matter with `name` and `description`,
 * then the instructions as the body. The same shape Claude skills use, so a skill written for one
 * can be dropped into the other. A file with no front matter is taken whole as the instructions,
 * named after `fallbackName` (usually the file name).
 *
 * @returns null when there is nothing to use as instructions
 */
export function parseSkillMarkdown(text: string, fallbackName = ''): Omit<SkillInput, 'id'> | null {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const front = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);

  let name = fallbackName;
  let description = '';
  let body = normalized;

  if (front) {
    body = front[2];
    for (const line of front[1].split('\n')) {
      const field = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line);
      if (!field) continue;
      const key = field[1].toLowerCase();
      if (key === 'name') name = unquote(field[2]);
      if (key === 'description') description = unquote(field[2]);
    }
  }

  const instructions = body.trim();
  if (!instructions) return null;
  return { name: normalizeSkillName(name) || 'skill', description, instructions };
}

/** The inverse of parseSkillMarkdown, for exporting a skill the user can share or re-import. */
export function toSkillMarkdown(skill: Pick<Skill, 'name' | 'description' | 'instructions'>): string {
  const description = skill.description.replace(/\n/g, ' ').trim();
  return `---\nname: ${skill.name}\ndescription: ${description}\n---\n\n${skill.instructions.trim()}\n`;
}

async function read(): Promise<SkillStorageState> {
  const state = (await storage.get()) ?? initialState;
  // Older or hand-edited state may lack a field; default rather than crash every task on it.
  return {
    nextId: state.nextId ?? 1,
    custom: state.custom ?? [],
    disabledBuiltins: state.disabledBuiltins ?? [],
    builtinUsage: state.builtinUsage ?? {},
  };
}

function materialize(state: SkillStorageState): Skill[] {
  const builtins: Skill[] = BUILTIN_SKILLS.map(skill => ({
    id: `builtin:${skill.name}`,
    name: skill.name,
    description: skill.description,
    instructions: skill.instructions,
    builtin: true,
    enabled: !state.disabledBuiltins.includes(skill.name),
    lastUsedAt: state.builtinUsage[skill.name]?.lastUsedAt ?? 0,
    useCount: state.builtinUsage[skill.name]?.useCount ?? 0,
  }));
  const custom: Skill[] = [...state.custom]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(record => ({
      id: `custom:${record.id}`,
      name: record.name,
      description: record.description,
      instructions: record.instructions,
      builtin: false,
      enabled: record.enabled,
      lastUsedAt: record.lastUsedAt,
      useCount: record.useCount,
    }));
  return [...builtins, ...custom];
}

function customIdOf(id: string | undefined): number | null {
  const match = /^custom:(\d+)$/.exec(id ?? '');
  return match ? Number(match[1]) : null;
}

export interface SkillStore {
  /** Built-ins first, in their shipped order, then the user's own by name. */
  getAll: () => Promise<Skill[]>;
  getEnabled: () => Promise<Skill[]>;
  /** The enabled skill called `name`, or null. Disabled skills cannot be called, by slash or by the agent. */
  findEnabled: (name: string) => Promise<Skill | null>;
  /**
   * Create or update a custom skill. The name is normalized and, when taken, suffixed; the returned
   * skill carries the name it was actually saved under.
   *
   * @returns null when the library is full or there are no instructions to save
   */
  saveCustom: (input: SkillInput) => Promise<Skill | null>;
  removeCustom: (id: string) => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  /** Record that a run loaded the skill, for the "last used" line in settings. */
  markUsed: (name: string) => Promise<void>;
  subscribe: (listener: () => void) => () => void;
}

export const skillStore: SkillStore = {
  async getAll() {
    return materialize(await read());
  },

  async getEnabled() {
    return materialize(await read()).filter(skill => skill.enabled);
  },

  async findEnabled(name: string) {
    const wanted = name.trim().toLowerCase();
    return (await this.getEnabled()).find(skill => skill.name === wanted) ?? null;
  },

  async saveCustom(input: SkillInput) {
    const instructions = input.instructions.trim().slice(0, MAX_SKILL_INSTRUCTIONS_LENGTH);
    if (!instructions) return null;
    const description = (input.description.trim() || fallbackDescription(instructions)).slice(
      0,
      MAX_SKILL_DESCRIPTION_LENGTH,
    );

    const state = await read();
    const editingId = customIdOf(input.id);
    const existing = editingId === null ? undefined : state.custom.find(record => record.id === editingId);
    if (!existing && state.custom.length >= MAX_CUSTOM_SKILLS) return null;

    const taken = new Set<string>([
      ...BUILTIN_SKILL_NAMES,
      ...state.custom.filter(record => record.id !== existing?.id).map(record => record.name),
    ]);
    const name = uniqueSkillName(input.name, taken);
    const now = Date.now();

    let saved: CustomSkillRecord;
    let custom: CustomSkillRecord[];
    let nextId = state.nextId;
    if (existing) {
      saved = { ...existing, name, description, instructions, updatedAt: now };
      custom = state.custom.map(record => (record.id === existing.id ? saved : record));
    } else {
      saved = {
        id: state.nextId,
        name,
        description,
        instructions,
        enabled: true,
        createdAt: now,
        updatedAt: now,
        lastUsedAt: 0,
        useCount: 0,
      };
      custom = [...state.custom, saved];
      nextId += 1;
    }

    await storage.set({ ...state, nextId, custom });
    return materialize({ ...state, nextId, custom }).find(skill => skill.id === `custom:${saved.id}`) ?? null;
  },

  async removeCustom(id: string) {
    const customId = customIdOf(id);
    if (customId === null) return;
    const state = await read();
    await storage.set({ ...state, custom: state.custom.filter(record => record.id !== customId) });
  },

  async setEnabled(id: string, enabled: boolean) {
    const state = await read();
    if (id.startsWith('builtin:')) {
      const name = id.slice('builtin:'.length);
      if (!BUILTIN_SKILL_NAMES.has(name)) return;
      const others = state.disabledBuiltins.filter(entry => entry !== name);
      await storage.set({ ...state, disabledBuiltins: enabled ? others : [...others, name] });
      return;
    }
    const customId = customIdOf(id);
    if (customId === null) return;
    await storage.set({
      ...state,
      custom: state.custom.map(record => (record.id === customId ? { ...record, enabled } : record)),
    });
  },

  async markUsed(name: string) {
    const state = await read();
    const now = Date.now();
    if (BUILTIN_SKILL_NAMES.has(name)) {
      const usage = state.builtinUsage[name] ?? { lastUsedAt: 0, useCount: 0 };
      await storage.set({
        ...state,
        builtinUsage: { ...state.builtinUsage, [name]: { lastUsedAt: now, useCount: usage.useCount + 1 } },
      });
      return;
    }
    await storage.set({
      ...state,
      custom: state.custom.map(record =>
        record.name === name ? { ...record, lastUsedAt: now, useCount: record.useCount + 1 } : record,
      ),
    });
  },

  subscribe(listener: () => void) {
    return storage.subscribe(listener);
  },
};

export default skillStore;
