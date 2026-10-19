import { isImageUpload, MAX_UPLOAD_FILE_BYTES } from '@extension/storage';

/** A dragged web image can contain a URL instead of a File. Never fetch dragged page prose. */
export function droppedImageUrl(transfer: Pick<DataTransfer, 'getData'>): string | null {
  const html = transfer.getData('text/html');
  const match = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i.exec(html);
  const raw =
    match?.[1] ??
    transfer
      .getData('text/uri-list')
      .split(/\r?\n/)
      .find(line => line && !line.startsWith('#'));
  if (!raw) return null;
  try {
    const url = new URL(raw.replaceAll('&amp;', '&'));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    if (!match && !/\.(?:png|jpe?g|webp|gif)$/i.test(url.pathname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

export async function readDroppedImage(url: string): Promise<File> {
  const response = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(10_000) });
  const type = response.headers.get('content-type')?.split(';')[0].trim() ?? '';
  if (!response.ok || !isImageUpload({ mimeType: type }) || !response.body)
    throw new Error('Unsupported dropped image');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    let part = await reader.read();
    while (!part.done) {
      size += part.value.byteLength;
      if (size > MAX_UPLOAD_FILE_BYTES) throw new Error('Dropped image exceeds the attachment limit');
      chunks.push(part.value);
      part = await reader.read();
    }
  } finally {
    await reader.cancel();
  }
  const name = new URL(url).pathname.split('/').pop() || `image.${type.split('/')[1]}`;
  return new File(chunks, name, { type });
}
