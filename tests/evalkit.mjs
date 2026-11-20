// Shared by the whole-file evals: render a line with macOS `say`, join lines into one file,
// and a listener whose transcripts are cached by the audio they heard.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as tf from '@huggingface/transformers';
import { loadListener, DEFAULT } from '../src/listen.js';

export const RATE = 24000;
export const CACHE = new URL('./.cache/', import.meta.url);
export const sha = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16);
mkdirSync(new URL('say/', CACHE), { recursive: true });

/** 16-bit mono WAV -> samples. */
export function readWav(file) {
  const b = new Uint8Array(readFileSync(file));
  const v = new DataView(b.buffer, b.byteOffset);
  let o = 12;
  while (o < b.length && String.fromCharCode(...b.subarray(o, o + 4)) !== 'data') o += 8 + v.getUint32(o + 4, true);
  const n = v.getUint32(o + 4, true) / 2;
  return Float32Array.from({ length: n }, (_, i) => v.getInt16(o + 8 + 2 * i, true) / 32768);
}

/** One line spoken by a macOS voice, 24 kHz mono, cached by voice and text. */
export function say(text, voice) {
  const file = new URL(`say/${sha(`${voice}|${text}`)}.wav`, CACHE);
  if (!existsSync(file)) {
    const txt = new URL('say/line.txt', CACHE);
    writeFileSync(txt, text);
    execFileSync('say', ['-v', voice, '-o', fileURLToPath(file), `--data-format=LEI16@${RATE}`, '-f', fileURLToPath(txt)]);
  }
  return readWav(file);
}

/** Where each line starts, in seconds, once joined. */
export function starts(clips, pause = 0.35) {
  const FR = RATE / 50, gap = Math.round(pause * RATE);
  let at = Math.round(0.5 * RATE);
  return clips.map((c) => { const t = at / RATE; at += Math.ceil((c.length + gap) / FR) * FR; return t; });
}

/** Lines -> one file's samples: a pause after each, every line padded to whole 20 ms frames. */
export function join(clips, pause = 0.35) {
  const FR = RATE / 50, gap = Math.round(pause * RATE);
  const out = new Float32Array(clips.reduce((s, c) => s + Math.ceil((c.length + gap) / FR) * FR, 0) + RATE);
  starts(clips, pause).forEach((t, i) => out.set(clips[i], Math.round(t * RATE)));
  return out;
}

export async function* slices(x) {
  for (let i = 0; i < x.length; i += 60 * RATE) yield { channels: [x.subarray(i, i + 60 * RATE)], rate: RATE };
}

/** The listener the app ships, with every piece it hears cached in `name`. */
export async function cachedListener(name, model = DEFAULT) {
  const asr = await loadListener(tf, { model });
  const file = new URL(name, CACHE);
  const cache = existsSync(file) ? JSON.parse(readFileSync(file)) : {};
  const stats = { n: 0, sec: 0, ms: 0 };
  const hear = async (audio) => {
    const key = sha(Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength));
    if (cache[key] === undefined) {
      const t = Date.now();
      cache[key] = await asr(audio, 16000);
      stats.ms += Date.now() - t; stats.sec += audio.length / 16000;
      if (++stats.n % 5 === 0) writeFileSync(file, JSON.stringify(cache));
    }
    return cache[key];
  };
  return { hear, stats, save: () => writeFileSync(file, JSON.stringify(cache)) };
}
