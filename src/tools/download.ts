// Shared media downloader: URL -> local assets folder.
// Used by both the Premiere and After Effects tool sets.
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

const MAX_BYTES = 500 * 1024 * 1024; // 500 MB cap per generated/imported clip

/** Download a media URL into assetsDir. Returns the local path. Throws on any safety violation. */
export async function downloadToAssets(url: string, assetsDir: string, filename?: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http(s) URLs are allowed.');
  }
  const safeName = (filename || basename(parsed.pathname) || 'clip.mp4')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 120);
  if (!/\.[a-z0-9]{2,5}$/i.test(safeName)) throw new Error('Filename must include a media extension (e.g. .mp4).');
  await mkdir(assetsDir, { recursive: true });
  const dest = join(assetsDir, `${Date.now()}-${safeName}`);

  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
  const ctype = res.headers.get('content-type') || '';
  if (!/^(video|image|audio)\//.test(ctype) && !/octet-stream/.test(ctype)) {
    throw new Error(`Refusing to import content-type "${ctype}" — expected a media file.`);
  }
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_BYTES) throw new Error(`File too large (${Math.round(len / 1e6)} MB > 500 MB).`);

  let bytes = 0;
  const counting = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > MAX_BYTES) throw new Error('Download exceeded 500 MB cap.');
      controller.enqueue(chunk);
    },
  });
  await pipeline(res.body.pipeThrough(counting), createWriteStream(dest));
  return dest;
}
