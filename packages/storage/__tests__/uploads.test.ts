import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_UPLOAD_FILE_BYTES,
  MAX_UPLOAD_FILES,
  MAX_UPLOAD_TOTAL_BYTES,
  rejectionReason,
  uploadsStore,
} from '../lib/attachments/uploads';
import type { PendingUpload } from '../lib/attachments/uploads';

const file = (name: string, size = 10): PendingUpload => ({ name, mimeType: 'application/pdf', data: 'AAAA', size });

describe('rejectionReason', () => {
  it('accepts a set inside every cap', () => {
    expect(rejectionReason([file('a.pdf'), file('b.png')])).toBeNull();
  });

  it('rejects too many files', () => {
    const many = Array.from({ length: MAX_UPLOAD_FILES + 1 }, (_, i) => file(`f${i}.pdf`));
    expect(rejectionReason(many)).toBe('count');
  });

  it('rejects one oversized file', () => {
    expect(rejectionReason([file('big.pdf', MAX_UPLOAD_FILE_BYTES + 1)])).toBe('size');
  });

  // Each file can pass on its own while the set still overruns the session-storage budget.
  it('rejects a set that overruns the total even when each file fits', () => {
    const each = MAX_UPLOAD_FILE_BYTES;
    const count = Math.floor(MAX_UPLOAD_TOTAL_BYTES / each) + 1;
    const files = Array.from({ length: count }, (_, i) => file(`f${i}.pdf`, each));
    expect(rejectionReason(files)).toBe('total');
  });
});

describe('uploadsStore', () => {
  beforeEach(async () => {
    await uploadsStore.clear();
  });

  it('replaces the set rather than appending, so files belong to one task', async () => {
    await uploadsStore.setFiles([file('first.pdf')]);
    await uploadsStore.setFiles([file('second.pdf')]);
    expect(await uploadsStore.listNames()).toEqual(['second.pdf']);
  });

  it('finds a file however the model retypes its case', async () => {
    await uploadsStore.setFiles([file('Resume Final.PDF')]);
    expect((await uploadsStore.findByName('resume final.pdf'))?.name).toBe('Resume Final.PDF');
    expect((await uploadsStore.findByName('  Resume Final.PDF  '))?.name).toBe('Resume Final.PDF');
  });

  it('matches a name the model prefixed with a directory', async () => {
    await uploadsStore.setFiles([file('cv.pdf')]);
    expect((await uploadsStore.findByName('~/Documents/cv.pdf'))?.name).toBe('cv.pdf');
  });

  // The loose suffix match must never win over a file whose name is exactly what was asked for.
  it('prefers the exact name over a suffix match', async () => {
    await uploadsStore.setFiles([file('my-cv.pdf'), file('cv.pdf')]);
    expect((await uploadsStore.findByName('cv.pdf'))?.name).toBe('cv.pdf');
  });

  it('returns null for a name nobody attached', async () => {
    await uploadsStore.setFiles([file('cv.pdf')]);
    expect(await uploadsStore.findByName('invoice.pdf')).toBeNull();
  });

  it('clears everything', async () => {
    await uploadsStore.setFiles([file('cv.pdf')]);
    await uploadsStore.clear();
    expect(await uploadsStore.listNames()).toEqual([]);
  });
});
