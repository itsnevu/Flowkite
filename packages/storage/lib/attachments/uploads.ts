import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';

/**
 * Files the user attached in the composer so the agent can hand them to a page's upload field.
 *
 * Session-scoped, and that is the whole design. A CV, an invoice or an ID photo is exactly the kind
 * of thing that must not still be sitting in the profile next week because a task was abandoned
 * halfway: `chrome.storage.session` is cleared when the browser closes, so the worst case is one
 * browsing session rather than forever.
 *
 * Bytes live here rather than travelling through the task message because the port carries every
 * message to the panel as well, and a multi-megabyte base64 blob in that stream would be paid for
 * on every reconnect. The prompt gets only the file's name; the bytes are read once, at the moment
 * an upload action actually runs.
 */

export interface PendingUpload {
  /** the file name as the user's disk spells it - this is the handle the model uses to pick one */
  name: string;
  /** MIME type as the browser reported it, or a generic fallback when it reported nothing */
  mimeType: string;
  /** file contents, base64, without a data: prefix */
  data: string;
  /** decoded byte length, for display and for enforcing the cap without decoding first */
  size: number;
}

export interface UploadsState {
  files: PendingUpload[];
}

/**
 * Caps. `chrome.storage.session` gets 10 MB in total for the whole extension, and this store is not
 * the only tenant, so it claims well under half of it. A user who needs to attach more than this at
 * once is doing something a browser agent should not be the tool for.
 */
export const MAX_UPLOAD_FILES = 5;
export const MAX_UPLOAD_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_UPLOAD_TOTAL_BYTES = 6 * 1024 * 1024;

export type UploadsStorage = BaseStorage<UploadsState> & {
  /** Replace the whole set, which is what the composer does on send. */
  setFiles: (files: PendingUpload[]) => Promise<void>;
  /** Names only, for the line the prompt shows the agent. */
  listNames: () => Promise<string[]>;
  /**
   * One file by name, matched case-insensitively and ignoring surrounding whitespace, because the
   * name reaches this point via a model that will happily retype it with different casing.
   */
  findByName: (name: string) => Promise<PendingUpload | null>;
  clear: () => Promise<void>;
};

const storage = createStorage<UploadsState>(
  'pending-uploads',
  { files: [] },
  { storageEnum: StorageEnum.Session, liveUpdate: true },
);

/** Whether a set of files fits both caps. Returns the reason it does not, or null when it fits. */
export function rejectionReason(files: PendingUpload[]): 'count' | 'size' | 'total' | null {
  if (files.length > MAX_UPLOAD_FILES) return 'count';
  if (files.some(file => file.size > MAX_UPLOAD_FILE_BYTES)) return 'size';
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_UPLOAD_TOTAL_BYTES) return 'total';
  return null;
}

const normalise = (name: string): string => name.trim().toLowerCase();

export const uploadsStore: UploadsStorage = {
  ...storage,

  async setFiles(files: PendingUpload[]) {
    await storage.set({ files });
  },

  async listNames() {
    const state = await storage.get();
    return state.files.map(file => file.name);
  },

  async findByName(name: string) {
    const state = await storage.get();
    const wanted = normalise(name);
    // Exact match first, always. Only then the loose one, which forgives a path the model glued on
    // the front ("~/Documents/cv.pdf") and a name the user's disk spells with one. Never the other
    // way round: with both "cv.pdf" and "my-cv.pdf" attached, asking for "cv.pdf" must get "cv.pdf".
    const loose = (name: string): boolean => {
      const stored = normalise(name);
      return stored.endsWith(`/${wanted}`) || wanted.endsWith(`/${stored}`);
    };
    return (
      state.files.find(file => normalise(file.name) === wanted) ?? state.files.find(file => loose(file.name)) ?? null
    );
  },

  async clear() {
    await storage.set({ files: [] });
  },
};

export default uploadsStore;
