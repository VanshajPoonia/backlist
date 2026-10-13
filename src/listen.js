// Whisper, the proof-listener: it hears each rendered sentence back, and compare.js decides
// whether what it heard is what the book says. Same transformers.js runtime as the narrator.

export const MODELS = {
  'whisper-base.en': { id: 'onnx-community/whisper-base.en', mb: 77 },
  'whisper-tiny.en': { id: 'onnx-community/whisper-tiny.en', mb: 41 },
};
export const DEFAULT = 'whisper-base.en';

/** Kokoro speaks at 24 kHz, Whisper listens at 16 kHz: low-pass, then linear interpolation. */
export function resample(x, from, to) {
  if (from === to) return x;
  const smooth = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) smooth[i] = 0.25 * (x[i - 1] ?? x[i]) + 0.5 * x[i] + 0.25 * (x[i + 1] ?? x[i]);
  const n = Math.floor((x.length * to) / from);
  const y = new Float32Array(n);
  const r = from / to;
  for (let i = 0; i < n; i++) {
    const p = i * r, j = Math.floor(p), f = p - j;
    y[i] = smooth[j] * (1 - f) + (smooth[j + 1] ?? smooth[j]) * f;
  }
  return y;
}

/** @returns {Promise<(audio: Float32Array, rate: number) => Promise<string>>} */
export async function loadListener(tf, { model = DEFAULT, device, progress_callback } = {}) {
  const asr = await tf.pipeline('automatic-speech-recognition', MODELS[model].id, {
    dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
    device,
    progress_callback,
  });
  const pad = new Float32Array(16000 * 0.3);
  return async (audio, rate) => {
    const x = resample(audio, rate, 16000);
    const padded = new Float32Array(pad.length * 2 + x.length);
    padded.set(x, pad.length);
    const out = await asr(padded);
    return out.text.trim();
  };
}
