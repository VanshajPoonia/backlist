// One model per worker, so narrating line 12 and listening to line 11 happen at the same
// time and the page never freezes. `?role=voice` runs Kokoro, `?role=ear` runs Whisper.
import * as tf from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js';
import { phonemize } from 'https://cdn.jsdelivr.net/npm/phonemizer@1.2.1/dist/phonemizer.js';
import { loadVoice, SAMPLE_RATE } from './voice.js';
import { loadListener } from './listen.js';

tf.env.allowLocalModels = false;
tf.env.useBrowserCache = true;

const role = new URL(self.location.href).searchParams.get('role');
let engine = null;
let device = null;

async function webgpu() {
  try { return !!(self.navigator.gpu && (await self.navigator.gpu.requestAdapter())); } catch { return false; }
}

async function load() {
  const files = new Map();
  const progress_callback = (e) => {
    if (e.status !== 'progress' || !e.total) return;
    files.set(e.file, [e.loaded, e.total]);
    let l = 0, t = 0;
    for (const [a, b] of files.values()) { l += a; t += b; }
    self.postMessage({ type: 'progress', p: l / t });
  };
  if (role === 'voice') {
    // Kokoro: full precision on the GPU when there is one (fast), 8-bit on the CPU otherwise.
    // Whichever runs, every line it produces is checked by the listener, so the safety net
    // does not depend on which build the browser got.
    const order = (await webgpu()) ? [['webgpu', 'fp32'], ['wasm', 'q8']] : [['wasm', 'q8']];
    let lastErr;
    for (const [d, dtype] of order) {
      try {
        engine = await loadVoice(tf, phonemize, { dtype, device: d, progress_callback });
        await engine.speak('Ready.');
        device = d;
        return;
      } catch (err) { lastErr = err; }
    }
    throw lastErr;
  }
  // Whisper: the 8-bit CPU build, exactly the configuration tests/proof.mjs measured.
  engine = await loadListener(tf, { device: 'wasm', progress_callback });
  device = 'wasm';
}

self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    if (type === 'load') {
      await load();
      self.postMessage({ id, device });
    } else if (type === 'speak') {
      const r = await engine.speak(data.text, { voice: data.voice, speed: data.speed });
      const audio = new Float32Array(r.audio);
      self.postMessage({ id, audio, rate: SAMPLE_RATE, tokens: r.tokens }, [audio.buffer]);
    } else if (type === 'hear') {
      self.postMessage({ id, text: await engine(data.audio, data.rate) });
    }
  } catch (err) {
    self.postMessage({ id, error: String(err?.message ?? err) });
  }
};
