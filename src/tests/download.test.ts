import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadToAssets } from '../tools/download.js';

function mockFetch(opts: { status?: number; contentType?: string; body?: string; contentLength?: number }) {
  const { status = 200, contentType = 'video/mp4', body = 'fake-video-bytes', contentLength } = opts;
  const bytes = new TextEncoder().encode(body);
  (globalThis as any).fetch = async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers({
        'content-type': contentType,
        ...(contentLength !== undefined ? { 'content-length': String(contentLength) } : {}),
      }),
      body: new ReadableStream({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      }),
    } as unknown as Response);
}

describe('import_media_from_url download', () => {
  let dir: string;
  let realFetch: typeof fetch;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcp-dl-test-'));
    realFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    await rm(dir, { recursive: true, force: true });
  });

  it('downloads a video file into the assets dir', async () => {
    mockFetch({});
    const dest = await downloadToAssets('https://example.com/clip.mp4', dir);
    const st = await stat(dest);
    assert.ok(st.size > 0);
    assert.ok(dest.startsWith(dir));
    assert.ok(dest.endsWith('.mp4'));
  });

  it('sanitizes hostile filenames', async () => {
    mockFetch({});
    const dest = await downloadToAssets('https://example.com/x.mp4', dir, '../../evil.mp4');
    const { relative, resolve } = await import('node:path');
    const rel = relative(dir, resolve(dest));
    assert.ok(!rel.startsWith('..'), `path traversal escaped the assets dir: ${dest}`);
  });

  it('rejects non-http(s) URLs', async () => {
    mockFetch({});
    await assert.rejects(
      downloadToAssets('ftp://example.com/clip.mp4', dir),
      /Only http\(s\) URLs/
    );
  });

  it('rejects non-media content types', async () => {
    mockFetch({ contentType: 'text/html' });
    await assert.rejects(downloadToAssets('https://example.com/page', dir, 'page.mp4'), /content-type/);
  });

  it('rejects oversized files via content-length', async () => {
    mockFetch({ contentLength: 600 * 1024 * 1024 });
    await assert.rejects(downloadToAssets('https://example.com/big.mp4', dir), /too large/i);
  });

  it('requires a media extension in the filename', async () => {
    mockFetch({});
    await assert.rejects(downloadToAssets('https://example.com/noext', dir, 'noext'), /extension/);
  });
});
