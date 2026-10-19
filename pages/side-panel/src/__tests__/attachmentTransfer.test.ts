import { afterEach, describe, expect, it, vi } from 'vitest';
import { droppedImageUrl, readDroppedImage } from '../attachmentTransfer';

const transfer = (html: string, uri = '') => ({ getData: (type: string) => (type === 'text/html' ? html : uri) });
afterEach(() => vi.unstubAllGlobals());
describe('dragging an image from a website', () => {
  it('reads the image URL without treating page prose as an attachment', () => {
    expect(droppedImageUrl(transfer('<img src="https://images.test/photo?id=1&amp;size=2">'))).toBe(
      'https://images.test/photo?id=1&size=2',
    );
    expect(droppedImageUrl(transfer('', 'https://images.test/photo.png'))).toBe('https://images.test/photo.png');
    expect(droppedImageUrl(transfer('', 'https://site.test/article'))).toBeNull();
    expect(droppedImageUrl(transfer('<img src="file:///secret">'))).toBeNull();
    expect(droppedImageUrl(transfer('<img src="https://user:password@site.test/image">'))).toBeNull();
  });
  it('turns an image response into the same File used by the picker and paste paths', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } })),
    );
    const file = await readDroppedImage('https://images.test/photo.png');
    expect(file.name).toBe('photo.png');
    expect(file.type).toBe('image/png');
    expect(file.size).toBe(4);
  });
  it('rejects HTML responses rather than attaching a login page as a picture', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>Sign in</html>', { headers: { 'content-type': 'text/html' } })),
    );
    await expect(readDroppedImage('https://images.test/photo.png')).rejects.toThrow();
  });
});
