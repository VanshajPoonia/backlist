// Rendered lines -> one chapter file, to the spec audiobook distributors ask for:
// 44.1 kHz, 16-bit mono, RMS between -23 and -18 dB, peaks no higher than -3 dB,
// 0.5 to 1 s of silence at the start and 1 to 5 s at the end.

export const OUT_RATE = 44100;
const TARGET_RMS_DB = -20;
const PEAK_DB = -3.5; // the spec says -3; half a dB of headroom for dither and rounding
const HEAD = 0.75, TAIL = 2.5;

const db = (x) => 20 * Math.log10(Math.max(x, 1e-9));
const lin = (d) => 10 ** (d / 20);

/** Kokoro pads its clips with a little silence of its own; trim it so pauses are ours. */
export function trim(x, rate, threshold = 0.004) {
  const keep = Math.round(rate * 0.03);
  let a = 0, b = x.length - 1;
  while (a < b && Math.abs(x[a]) < threshold) a++;
  while (b > a && Math.abs(x[b]) < threshold) b--;
  return x.subarray(Math.max(0, a - keep), Math.min(x.length, b + keep + 1));
}

/**
 * Windowed-sinc (Lanczos, a = 8) resampling: 24 kHz Kokoro -> 44.1 kHz delivery.
 * The rates are in a fixed ratio (80:147), so the filter weights repeat every 147 output
 * samples and are worked out once.
 */
export function resample(x, from, to) {
  if (from === to) return x;
  const gcd = (p, q) => (q ? gcd(q, p % q) : p);
  const g = gcd(from, to), L = to / g, M = from / g;
  const a = 8, n = Math.floor((x.length * L) / M);
  const lanczos = (d) => (d === 0 ? 1 : Math.abs(d) >= a ? 0 : (a * Math.sin(Math.PI * d) * Math.sin((Math.PI * d) / a)) / (Math.PI * Math.PI * d * d));
  const W = Array.from({ length: L }, (_, p) => {
    const frac = p / L;
    const w = Float64Array.from({ length: 2 * a }, (_, j) => lanczos(frac - (j - a + 1)));
    const sum = w.reduce((s, v) => s + v, 0);
    return w.map((v) => v / sum);
  });
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const c = Math.floor((i * M) / L), w = W[(i * M) % L];
    let s = 0;
    for (let j = 0; j < 2 * a; j++) {
      const k = c - a + 1 + j;
      if (k >= 0 && k < x.length) s += x[k] * w[j];
    }
    y[i] = s;
  }
  return y;
}

/**
 * @param {{audio: Float32Array, pause: number}[]} clips  at `rate`
 * @returns {{samples: Float32Array, rate: number, stats: {seconds:number, rmsDb:number, peakDb:number}}}
 */
export function master(clips, rate) {
  const parts = clips.map((c) => ({ x: trim(c.audio, rate), pause: c.pause }));
  const len = Math.round(HEAD * rate) + parts.reduce((s, p) => s + p.x.length + Math.round(p.pause * rate), 0) + Math.round(TAIL * rate);
  const raw = new Float32Array(len);
  let at = Math.round(HEAD * rate);
  for (const p of parts) { raw.set(p.x, at); at += p.x.length + Math.round(p.pause * rate); }

  const out = resample(raw, rate, OUT_RATE);

  // Loudness: bring the whole file to the target RMS...
  let sq = 0;
  for (const v of out) sq += v * v;
  const gain = lin(TARGET_RMS_DB) / Math.sqrt(sq / out.length);
  // ...then hold peaks under the ceiling with a fast-attack, slow-release limiter.
  const ceil = lin(PEAK_DB), release = Math.exp(-1 / (0.08 * OUT_RATE));
  let env = 1, peak = 0, sq2 = 0;
  for (let i = 0; i < out.length; i++) {
    const v = out[i] * gain;
    const need = Math.abs(v) > ceil ? ceil / Math.abs(v) : 1;
    env = need < env ? need : 1 - (1 - env) * release;
    out[i] = v * env;
    peak = Math.max(peak, Math.abs(out[i]));
    sq2 += out[i] * out[i];
  }
  return { samples: out, rate: OUT_RATE, stats: { seconds: out.length / OUT_RATE, rmsDb: db(Math.sqrt(sq2 / out.length)), peakDb: db(peak) } };
}

/** 16-bit PCM mono WAV, with triangular dither. */
export function wav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const d = (Math.random() - Math.random()) / 32768;
    const s = Math.max(-1, Math.min(1, samples[i] + d));
    v.setInt16(44 + i * 2, Math.round(s * 32767), true);
  }
  return buf;
}
