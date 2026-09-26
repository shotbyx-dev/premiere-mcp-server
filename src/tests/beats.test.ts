/**
 * Beat-detection tests: synthesize click-track WAVs in-test (no fixtures),
 * run the pure-TS detector through real ffmpeg, and assert BPM / beat times.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectBeats } from '../tools/beats.js';

const SR = 22050;

/**
 * Write a 16-bit mono WAV of `beats` decaying 2 kHz clicks at `bpm`,
 * starting after `leadInSec`. Returns ground-truth beat times (seconds).
 */
function writeClickTrack(
  path: string,
  bpm: number,
  beats: number,
  leadInSec = 0.5
): number[] {
  const period = 60 / bpm;
  const groundTruth: number[] = [];
  const dur = leadInSec + period * (beats - 1) + 0.75;
  const n = Math.ceil(dur * SR);
  const pcm = new Int16Array(n);
  const clickLen = Math.floor(0.03 * SR); // 30 ms burst
  for (let b = 0; b < beats; b++) {
    const t = leadInSec + b * period;
    groundTruth.push(Math.round(t * 1000) / 1000);
    const t0 = Math.floor(t * SR);
    for (let i = 0; i < clickLen && t0 + i < n; i++) {
      const env = Math.exp(-i / (clickLen * 0.2));
      const v = pcm[t0 + i] + Math.round(22000 * env * Math.sin((2 * Math.PI * 2000 * i) / SR));
      pcm[t0 + i] = Math.max(-32768, Math.min(32767, v));
    }
  }
  const dataLen = n * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(pcm[i], 44 + i * 2);
  writeFileSync(path, buf);
  return groundTruth;
}

/** Every ground-truth beat must have a detected beat within 60 ms. */
function assertBeatsClose(detected: number[], truth: number[]): void {
  assert.ok(detected.length > 0, 'expected at least one detected beat');
  for (let i = 1; i < detected.length; i++)
    assert.ok(detected[i] > detected[i - 1], 'beats must be ascending');
  for (const t of truth) {
    let nearest = Infinity;
    for (const d of detected) nearest = Math.min(nearest, Math.abs(d - t));
    assert.ok(
      nearest <= 0.06,
      `no detected beat within 60 ms of ground-truth beat ${t}s (nearest=${nearest.toFixed(3)}s)`
    );
  }
}

describe('beat detection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'beats-test-'));

  it('detects 120 BPM click track (±2 BPM, beats ±60 ms)', async () => {
    const p = join(dir, 'click120.wav');
    const truth = writeClickTrack(p, 120, 8);
    const det = await detectBeats(p, {});
    assert.ok(Math.abs(det.bpm - 120) <= 2, `expected ~120 BPM, got ${det.bpm}`);
    assert.equal(det.beatCount, det.beats.length);
    assertBeatsClose(det.beats, truth);
    assert.ok(det.confidence > 0.5, `expected decent confidence, got ${det.confidence}`);
    // ms precision
    for (const b of det.beats) assert.equal(Math.round(b * 1000) / 1000, b);
  });

  it('detects 96 BPM click track (±2 BPM, beats ±60 ms)', async () => {
    const p = join(dir, 'click96.wav');
    const truth = writeClickTrack(p, 96, 8);
    const det = await detectBeats(p, { minBpm: 70, maxBpm: 180 });
    assert.ok(Math.abs(det.bpm - 96) <= 2, `expected ~96 BPM, got ${det.bpm}`);
    assertBeatsClose(det.beats, truth);
  });

  it('rejects invalid BPM ranges and missing files', async () => {
    const p = join(dir, 'click120b.wav');
    writeClickTrack(p, 120, 4);
    await assert.rejects(() => detectBeats(p, { minBpm: 180, maxBpm: 70 }), /BPM range/);
    await assert.rejects(() => detectBeats(join(dir, 'does-not-exist.wav'), {}), /ENOENT/);
  });
});
