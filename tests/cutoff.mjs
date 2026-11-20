// Does AuthorVoice Proof catch a sentence an engine cut short? Kokoro reads at most 510 phoneme
// tokens in one go and silently drops the rest. Every sentence in the three test books that
// runs over that is rendered unsplit by Kokoro (so the engine really cuts it), and in full by
// macOS `say` (so nothing is cut). Both sets go through the whole pipeline as one file each.
//
//   npm run eval:cutoff        needs macOS for the `say` half

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as tf from '@huggingface/transformers';
import { phonemize } from 'phonemizer';
import { loadVoice, SAMPLE_RATE } from '../src/voice.js';
import { loadListener, DEFAULT } from '../src/listen.js';
import { listenFile } from '../src/segment.js';
import { parse, sentences, stripGutenberg } from '../src/manuscript.js';
import { namesIn } from '../src/compare.js';
import { book, proof } from '../src/proof.js';
import { ensureBooks, BOOKS } from '../scripts/books.mjs';

const CACHE = new URL('./.cache/', import.meta.url);
mkdirSync(new URL('cutoff/', CACHE), { recursive: true });
await ensureBooks();
const sha = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16);
const texts = Object.keys(BOOKS).map((id) => readFileSync(new URL(`books/pg${id}.txt`, CACHE), 'utf8'));
const known = new Set(texts.flatMap((t) => [...namesIn(t)]));

// ---- the sentences Kokoro cannot read in one go ------------------------------------------------

const voice = await loadVoice(tf, phonemize, { dtype: 'q8' });
const tokenizer = await tf.AutoTokenizer.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX');
const long = [];
for (const t of texts) {
  for (const para of stripGutenberg(t).replace(/\r\n?/g, '\n').split(/\n\s*\n/)) {
    for (const s of sentences(para.replace(/\s*\n\s*/g, ' ').trim())) {
      if (s.split(/\s+/).length < 50) continue;
      const n = tokenizer(await voice.phonemes(s)).input_ids.dims.at(-1);
      if (n > 510) long.push(s);
    }
  }
}
console.log(`${long.length} sentences are over Kokoro's 510 tokens\n`);

// ---- render ------------------------------------------------------------------------------------

async function kokoro(s) {
  const file = new URL(`cutoff/k-${sha(s)}.f32`, CACHE);
  if (!existsSync(file)) writeFileSync(file, Buffer.from((await voice.speak(s, { voice: 'af_heart' })).audio.buffer));
  const b = readFileSync(file);
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}
function say(s) {
  const file = new URL(`cutoff/s-${sha(s)}.wav`, CACHE);
  if (!existsSync(file)) {
    writeFileSync(new URL('cutoff/line.txt', CACHE), s);
    execFileSync('say', ['-v', 'Samantha', '-o', fileURLToPath(file), `--data-format=LEI16@${SAMPLE_RATE}`, '-f', fileURLToPath(new URL('cutoff/line.txt', CACHE))]);
  }
  const b = new Uint8Array(readFileSync(file));
  const v = new DataView(b.buffer, b.byteOffset);
  let o = 12;
  while (String.fromCharCode(...b.subarray(o, o + 4)) !== 'data') o += 8 + v.getUint32(o + 4, true);
  return Float32Array.from({ length: v.getUint32(o + 4, true) / 2 }, (_, i) => v.getInt16(o + 8 + 2 * i, true) / 32768);
}
function join(clips) {
  const gap = Math.round(0.6 * SAMPLE_RATE);
  const out = new Float32Array(clips.reduce((s, c) => s + c.length + gap, gap));
  let at = gap;
  for (const c of clips) { out.set(c, at); at += c.length + gap; }
  return out;
}

const asr = await loadListener(tf, { model: DEFAULT });
const cacheFile = new URL(`heard-cutoff-${DEFAULT}.json`, CACHE);
const heard = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile)) : {};
async function hear(audio) {
  const key = sha(Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength));
  if (heard[key] === undefined) {
    heard[key] = await asr(audio, 16000);
    writeFileSync(cacheFile, JSON.stringify(heard));
  }
  return heard[key];
}
async function* slices(x) { for (let i = 0; i < x.length; i += 60 * SAMPLE_RATE) yield { channels: [x.subarray(i, i + 60 * SAMPLE_RATE)], rate: SAMPLE_RATE }; }

const bk = book(parse(long.join('\n\n')));
const results = {};
for (const [name, render] of [['kokoro, unsplit', kokoro], ['say, in full', say]]) {
  const clips = [];
  for (const s of long) clips.push(await render(s));
  const { pieces } = await listenFile(slices(join(clips)), hear);
  writeFileSync(cacheFile, JSON.stringify(heard));
  const r = proof(bk, [{ name, pieces }], { known });
  const bySentence = new Map();
  for (const L of r.lines) {
    if (!bySentence.has(L.sentence)) bySentence.set(L.sentence, []);
    bySentence.get(L.sentence).push(L);
  }
  const flagged = [...bySentence.values()].map((g) => ({ text: g.map((L) => L.text).join(' '), types: [...new Set(g.flatMap((L) => L.problems ?? []).map((p) => p.type))] }));
  results[name] = flagged;
  const cut = flagged.filter((f) => f.types.includes('cut short')).length;
  const any = flagged.filter((f) => f.types.length).length;
  console.log(`${name}: ${cut} of ${long.length} labelled cut short, ${any} flagged for anything`);
  for (const f of flagged) console.log(`  ${f.types.join(', ').padEnd(28) || 'ok'.padEnd(28)} ${f.text.slice(0, 80)}`);
}
writeFileSync(new URL('cutoff.json', CACHE), JSON.stringify({ sentences: long.length, results }, null, 1));
