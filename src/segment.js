import { meter } from './levels.js';

// Long narration -> pieces the listener can hear one at a time. Whisper always works on a
// 30 second window, so short pieces waste most of each pass: a chapter is cut at its own
// pauses into pieces of 12 to 25 seconds, each stamped with where it sits in the file.

export const RATE = 16000;

/**
 * Mix to mono and resample to 16 kHz with a windowed-sinc low-pass (Blackman window). The
 * filter weights are worked out once per phase; odd rate pairs share 1024 phases.
 */
export function toListen(channels, from) {
  const len = channels[0].length;
  let x = channels[0];
  if (channels.length > 1) {
    x = new Float32Array(len);
    for (const c of channels) for (let i = 0; i < len; i++) x[i] += c[i] / channels.length;
  }
  if (from === RATE) return Float32Array.from(x);
  const ratio = RATE / from, scale = Math.min(1, ratio), fc = 0.47 * scale;
  const half = Math.ceil(8 / scale);
  const gcd = (p, q) => (q ? gcd(q, p % q) : p);
  const L = RATE / gcd(RATE, from), P = Math.min(L, 1024);
  const table = Array.from({ length: P }, (_, p) => {
    const frac = p / P;
    const w = new Float32Array(2 * half);
    let sum = 0;
    for (let j = 0; j < 2 * half; j++) {
      const t = j - half + 1 - frac;
      const sinc = t === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * t) / (Math.PI * t);
      const u = (t + half) / (2 * half);
      w[j] = sinc * (0.42 - 0.5 * Math.cos(2 * Math.PI * u) + 0.08 * Math.cos(4 * Math.PI * u));
      sum += w[j];
    }
    for (let j = 0; j < w.length; j++) w[j] /= sum;
    return w;
  });
  const n = Math.floor(len * ratio);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const pos = i / ratio, c = Math.floor(pos);
    const w = table[Math.min(P - 1, Math.round((pos - c) * P))];
    let s = 0;
    for (let j = 0; j < w.length; j++) {
      const k = c - half + 1 + j;
      if (k >= 0 && k < len) s += x[k] * w[j];
    }
    y[i] = s;
  }
  return y;
}

const FRAME = 320; // 20 ms
const MIN_PAUSE = 8; // frames: 160 ms of quiet is a pause
const MAX = 25 * 50, HARD = 28 * 50; // frames: aim for at most 25 s, never more than 28 s

/** Frame energies in dB. */
function energies(x) {
  const n = Math.floor(x.length / FRAME), e = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0;
    for (let i = f * FRAME; i < (f + 1) * FRAME; i++) s += x[i] * x[i];
    e[f] = 10 * Math.log10(s / FRAME + 1e-12);
  }
  return e;
}

/** Speech or not, per frame: well above this stretch's own quiet, and not far below its speech. */
function voiced(e) {
  const sorted = Float32Array.from(e).sort();
  const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? -120;
  const thr = Math.min(Math.max(p(0.1) + 15, -55), p(0.9) - 25);
  return Array.from(e, (v) => v > thr);
}

/**
 * Cut points for one stretch of 16 kHz audio. Returns [startFrame, endFrame) pieces of speech.
 * A piece ends at a pause once it is long enough, and at the longest pause before the limit
 * when the narrator does not stop.
 */
export function pieces(x) {
  const e = energies(x), v = voiced(e);
  // Speech runs, with pauses shorter than MIN_PAUSE bridged.
  const runs = [];
  for (let f = 0; f < v.length;) {
    if (!v[f]) { f++; continue; }
    let g = f;
    while (g < v.length) {
      if (v[g]) { g++; continue; }
      let h = g;
      while (h < v.length && !v[h]) h++;
      if (h - g >= MIN_PAUSE || h === v.length) break;
      g = h;
    }
    if (g - f >= 3) runs.push([f, g]);
    f = g;
  }
  const out = [];
  let cur = null;
  for (let r = 0; r < runs.length; r++) {
    const [a, b] = runs[r];
    if (!cur) cur = [a, b];
    else cur[1] = b;
    const len = cur[1] - cur[0];
    const next = runs[r + 1];
    const gap = next ? next[0] - b : Infinity;
    // Stop at a sentence-sized pause once there is enough to fill most of the window.
    if (!next || (len >= 600 && gap >= 15) || (len >= 900 && gap >= 10) || next[1] - cur[0] > MAX) { out.push(cur); cur = null; }
  }
  // No pause at all for too long: cut at the quietest frame in the last third.
  return out.flatMap(function split([a, b]) {
    if (b - a <= HARD) return [[a, b]];
    let cut = a + Math.floor(MAX * 0.66);
    for (let f = cut; f < a + MAX; f++) if (e[f] < e[cut]) cut = f;
    return [[a, cut], ...split([cut, b])];
  });
}

/**
 * Feed decoded audio in order, get back pieces with times. Only the tail since the last cut is
 * kept, so a ten-hour file is never held in memory at once.
 */
export function segmenter() {
  let buf = new Float32Array(0), t0 = 0;
  const PAD = 0.12 * RATE;
  const take = (x, final) => {
    const all = pieces(x);
    // The last piece may still be growing unless this is the end of the file.
    const done = final ? all : all.slice(0, -1);
    const out = done.map(([a, b], i) => {
      // Pad into the quiet on each side, but never past halfway to the next piece.
      const prev = i ? all[i - 1][1] * FRAME : 0, next = all[i + 1] ? all[i + 1][0] * FRAME : x.length;
      const s = Math.max(0, a * FRAME - PAD, Math.ceil((prev + a * FRAME) / 2));
      const e = Math.min(x.length, b * FRAME + PAD, Math.floor((b * FRAME + next) / 2));
      return { audio: x.slice(s, e), start: t0 + s / RATE, end: t0 + e / RATE };
    });
    const keep = final || !done.length ? (final ? x.length : 0) : Math.max(0, done.at(-1)[1] * FRAME);
    return { out, keep };
  };
  return {
    push(x) {
      const nb = new Float32Array(buf.length + x.length);
      nb.set(buf); nb.set(x, buf.length);
      buf = nb;
      if (buf.length < 45 * RATE) return [];
      const { out, keep } = take(buf, false);
      t0 += keep / RATE;
      buf = buf.slice(keep);
      return out;
    },
    flush() {
      const { out } = take(buf, true);
      buf = new Float32Array(0);
      return out;
    },
  };
}

/**
 * Decoded slices of one file -> what the listener heard, piece by piece, and the file's levels.
 * @param {AsyncIterable<{channels: Float32Array[], rate: number}>} slices
 * @param {(audio: Float32Array) => Promise<string>} hear  takes 16 kHz mono
 */
export async function listenFile(slices, hear, onProgress) {
  const seg = segmenter(), pieces = [];
  let m = null;
  const run = async (ps) => {
    for (const p of ps) {
      pieces.push({ start: p.start, end: p.end, text: await hear(p.audio) });
      onProgress?.(p.end);
    }
  };
  for await (const s of slices) {
    m ??= meter(s.rate);
    m.add(s.channels);
    await run(seg.push(toListen(s.channels, s.rate)));
  }
  await run(seg.flush());
  return { pieces, stats: m?.done() ?? null };
}
