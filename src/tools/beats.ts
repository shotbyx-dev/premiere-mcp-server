/**
 * Automatic beat detection — pure TypeScript, zero native npm dependencies.
 *
 * Pipeline:
 *   1. Decode to mono 16-bit PCM @ 22050 Hz by shelling out to ffmpeg
 *      (system binary; the Windows installer ensures it is present).
 *   2. Spectral-flux onset envelope (Hann-windowed STFT, log-magnitude,
 *      half-wave-rectified positive differences).
 *   3. Adaptive peak picking (local-maximum + moving-average threshold).
 *   4. Tempo estimation via autocorrelation of the onset envelope over the
 *      configured BPM range, with parabolic sub-lag interpolation and an
 *      octave check (prefer the faster tempo when the half-lag is strong).
 *   5. Beat-grid phase search: pick the offset that maximizes onset energy
 *      under the grid, then emit beat times in seconds (ms precision).
 *
 * Time is expressed in SECONDS (float) to match the tool-layer convention.
 */

import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';

export interface BeatDetectionOptions {
  minBpm?: number;
  maxBpm?: number;
}

export interface BeatDetectionResult {
  bpm: number;
  beatCount: number;
  /** Beat times in seconds, ms precision, ascending. */
  beats: number[];
  /** 0..1 — how strongly the audio supports the reported grid. */
  confidence: number;
}

const TARGET_SR = 22050;
const FFT_SIZE = 1024;
const HOP_SIZE = 512;

/** Decode any ffmpeg-readable audio file to mono float32 PCM @ 22050 Hz. */
export async function decodeMono16k(
  audioPath: string
): Promise<{ samples: Float32Array; sampleRate: number }> {
  await stat(audioPath); // throws a clear ENOENT when the path is wrong
  return new Promise((resolve, reject) => {
    const child = spawn(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        audioPath,
        '-ac',
        '1',
        '-ar',
        String(TARGET_SR),
        '-sample_fmt',
        's16',
        '-f',
        's16le',
        'pipe:1',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    child.on('error', (err: Error) =>
      reject(
        new Error(
          `ffmpeg is not installed or failed to start: ${err.message}. ` +
            `The Windows installer installs it via winget (Gyan.FFmpeg).`
        )
      )
    );
    child.on('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `ffmpeg decode failed for "${audioPath}" (exit ${code}): ` +
              (stderr.trim().slice(0, 400) || 'no details')
          )
        );
        return;
      }
      const raw = Buffer.concat(chunks);
      const n = Math.floor(raw.length / 2);
      if (n === 0) {
        reject(new Error(`ffmpeg produced no audio samples for "${audioPath}".`));
        return;
      }
      const samples = new Float32Array(n);
      for (let i = 0; i < n; i++) samples[i] = raw.readInt16LE(i * 2) / 32768;
      resolve({ samples, sampleRate: TARGET_SR });
    });
  });
}

/** In-place iterative radix-2 FFT (re/im pairs, length must be a power of two). */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1;
      let cwi = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k];
        const ai = im[i + k];
        const br = re[i + k + len / 2];
        const bi = im[i + k + len / 2];
        const vr = br * cwr - bi * cwi;
        const vi = br * cwi + bi * cwr;
        re[i + k] = ar + vr;
        im[i + k] = ai + vi;
        re[i + k + len / 2] = ar - vr;
        im[i + k + len / 2] = ai - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
}

interface OnsetEnvelope {
  env: Float32Array;
  hopSec: number;
}

/** Spectral-flux onset envelope: sum of positive log-magnitude differences. */
function onsetEnvelope(samples: Float32Array, sr: number): OnsetEnvelope {
  const hann = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++)
    hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));

  const nFrames = Math.max(1, Math.floor((samples.length - FFT_SIZE) / HOP_SIZE) + 1);
  const env = new Float32Array(nFrames);
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  let prev = new Float64Array(FFT_SIZE / 2 + 1);

  for (let f = 0; f < nFrames; f++) {
    const off = f * HOP_SIZE;
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = (off + i < samples.length ? samples[off + i] : 0) * hann[i];
      im[i] = 0;
    }
    fft(re, im);
    let flux = 0;
    const mag = new Float64Array(FFT_SIZE / 2 + 1);
    for (let k = 0; k <= FFT_SIZE / 2; k++) {
      const m = Math.log1p(Math.sqrt(re[k] * re[k] + im[k] * im[k]));
      mag[k] = m;
      const d = m - prev[k];
      if (d > 0) flux += d;
    }
    prev = mag;
    env[f] = flux / (FFT_SIZE / 2);
  }
  return { env, hopSec: HOP_SIZE / sr };
}

/** Local-maximum peak picking with a moving-average + delta threshold. */
function pickPeaks(env: Float32Array, hopSec: number): number[] {
  const n = env.length;
  if (n === 0) return [];
  let maxEnv = 0;
  for (let i = 0; i < n; i++) if (env[i] > maxEnv) maxEnv = env[i];

  const preMax = Math.max(1, Math.round(0.03 / hopSec));
  const avgWin = Math.max(1, Math.round(0.12 / hopSec));
  const wait = Math.max(1, Math.round(0.05 / hopSec));
  const delta = 0.06 * maxEnv;

  const cumsum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cumsum[i + 1] = cumsum[i] + env[i];
  const localMean = (c: number): number => {
    const a = Math.max(0, c - avgWin);
    const b = Math.min(n, c + avgWin);
    return b > a ? (cumsum[b] - cumsum[a]) / (b - a) : 0;
  };

  const peaks: number[] = [];
  let last = -wait - 1;
  for (let i = 0; i < n; i++) {
    if (i - last <= wait) continue;
    let isMax = env[i] > 0;
    for (let k = Math.max(0, i - preMax); k < i && isMax; k++)
      if (env[k] > env[i]) isMax = false;
    for (let k = i + 1; k < Math.min(n, i + preMax + 1) && isMax; k++)
      if (env[k] >= env[i]) isMax = false;
    if (isMax && env[i] > localMean(i) + delta) {
      peaks.push(i);
      last = i;
    }
  }
  return peaks;
}

interface TempoEstimate {
  bpm: number;
  /** Normalized autocorrelation strength at the chosen lag (0..1). */
  strength: number;
}

/** Tempo from autocorrelation of the onset envelope + octave disambiguation. */
function estimateTempo(
  env: Float32Array,
  hopSec: number,
  minBpm: number,
  maxBpm: number
): TempoEstimate {
  const n = env.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= n;
  const x = new Float64Array(n);
  let variance = 0;
  for (let i = 0; i < n; i++) {
    x[i] = env[i] - mean;
    variance += x[i] * x[i];
  }
  variance /= n;

  const minLag = Math.max(2, Math.round(60 / maxBpm / hopSec));
  const maxLag = Math.min(n - 1, Math.round(60 / minBpm / hopSec));
  if (maxLag <= minLag || variance <= 0) return { bpm: 0, strength: 0 };

  const ac = new Map<number, number>();
  let bestLag = minLag;
  let bestVal = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i < n - lag; i++) s += x[i] * x[i + lag];
    const v = s / (n - lag) / variance; // normalized: <= ~1
    ac.set(lag, v);
    if (v > bestVal) {
      bestVal = v;
      bestLag = lag;
    }
  }

  // Octave check: if the half-lag is nearly as strong, the true tempo is
  // probably the faster one (avoids half-time estimates).
  let lag = bestLag;
  const half = Math.round(bestLag / 2);
  if (half >= minLag && (ac.get(half) ?? -Infinity) >= 0.7 * bestVal) lag = half;

  // Parabolic interpolation around the chosen peak for sub-lag accuracy.
  const y0 = ac.get(lag - 1);
  const y1 = ac.get(lag) ?? 0;
  const y2 = ac.get(lag + 1);
  let refined = lag;
  if (y0 !== undefined && y2 !== undefined) {
    const denom = y0 - 2 * y1 + y2;
    if (Math.abs(denom) > 1e-12) refined = lag + (0.5 * (y0 - y2)) / denom;
  }

  const bpm = 60 / (refined * hopSec);
  return { bpm, strength: Math.max(0, Math.min(1, bestVal)) };
}

/** Choose the grid phase that maximizes onset energy under the grid. */
function snapToGrid(
  env: Float32Array,
  hopSec: number,
  bpm: number,
  durationSec: number
): number[] {
  const period = 60 / bpm;
  const steps = 40;
  const radius = Math.max(1, Math.round(0.035 / hopSec));
  let bestPhase = 0;
  let bestScore = -Infinity;
  for (let s = 0; s < steps; s++) {
    const phase = (s / steps) * period;
    let score = 0;
    let count = 0;
    for (let t = phase; t < durationSec; t += period) {
      const c = Math.round(t / hopSec);
      for (let k = Math.max(0, c - radius); k <= Math.min(env.length - 1, c + radius); k++)
        score += env[k];
      count++;
    }
    const norm = count > 0 ? score / count : 0;
    if (norm > bestScore) {
      bestScore = norm;
      bestPhase = phase;
    }
  }
  const beats: number[] = [];
  for (let t = bestPhase; t < durationSec; t += period)
    beats.push(Math.round(t * 1000) / 1000);
  return beats;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * Snap each grid beat to the strongest nearby time-domain transient.
 *
 * The spectral-flux envelope systematically leads true onsets (a straddling
 * FFT frame registers the transient ~1 hop early), so after the grid is
 * placed we refine every beat in the time domain: the 5 ms energy frame with
 * the largest central-difference rise inside ±60 ms wins. Precise to ~±3 ms
 * on percussive material, harmless on smooth material.
 */
function refineBeatsToTransients(
  samples: Float32Array,
  sampleRate: number,
  beats: number[]
): number[] {
  if (beats.length === 0) return beats;
  const win = Math.max(1, Math.round(0.005 * sampleRate)); // 5 ms energy frames
  const nF = Math.ceil(samples.length / win);
  const energy = new Float64Array(nF);
  for (let f = 0; f < nF; f++) {
    let s = 0;
    const off = f * win;
    const end = Math.min(off + win, samples.length);
    for (let i = off; i < end; i++) s += samples[i] * samples[i];
    energy[f] = s;
  }
  const radius = Math.max(1, Math.round((0.06 * sampleRate) / win)); // ±60 ms
  return beats.map((b) => {
    const c = Math.round((b * sampleRate) / win);
    let best = c;
    let bestRise = -Infinity;
    for (let f = Math.max(1, c - radius); f <= Math.min(nF - 2, c + radius); f++) {
      const rise = energy[f + 1] - energy[f - 1];
      if (rise > bestRise) {
        bestRise = rise;
        best = f;
      }
    }
    return Math.round((((best + 0.5) * win) / sampleRate) * 1000) / 1000;
  });
}

/**
 * Detect beats in an audio file. Returns BPM, beat times in seconds
 * (ms precision, ascending), and a 0..1 confidence score.
 */
export async function detectBeats(
  audioPath: string,
  opts: BeatDetectionOptions = {}
): Promise<BeatDetectionResult> {
  const minBpm = opts.minBpm ?? 70;
  const maxBpm = opts.maxBpm ?? 180;
  if (!(minBpm > 0) || !(maxBpm > 0) || minBpm >= maxBpm)
    throw new Error(`Invalid BPM range: minBpm=${minBpm} must be < maxBpm=${maxBpm}.`);

  const { samples, sampleRate } = await decodeMono16k(audioPath);
  const durationSec = samples.length / sampleRate;
  const { env, hopSec } = onsetEnvelope(samples, sampleRate);
  const peaks = pickPeaks(env, hopSec);

  const empty: BeatDetectionResult = { bpm: 0, beatCount: 0, beats: [], confidence: 0 };
  if (peaks.length < 3) return empty;

  const { bpm, strength } = estimateTempo(env, hopSec, minBpm, maxBpm);
  if (bpm <= 0) return { ...empty, confidence: 0.05 };

  const beats = refineBeatsToTransients(
    samples,
    sampleRate,
    snapToGrid(env, hopSec, bpm, durationSec)
  );

  // Fraction of beats with an onset peak nearby -> grid support.
  const peakTimes = peaks.map((p) => p * hopSec);
  let aligned = 0;
  for (const b of beats) {
    for (const p of peakTimes) {
      if (Math.abs(p - b) <= 0.05) {
        aligned++;
        break;
      }
    }
  }
  const fracAligned = beats.length > 0 ? aligned / beats.length : 0;
  const confidence = Math.round(clamp01(0.6 * clamp01(strength * 1.6) + 0.4 * fracAligned) * 100) / 100;

  return {
    bpm: Math.round(bpm * 10) / 10,
    beatCount: beats.length,
    beats,
    confidence,
  };
}
