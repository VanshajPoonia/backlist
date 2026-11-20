// Does AuthorVoice Proof catch a sentence an engine cut short? Kokoro reads at most 510 phoneme
// tokens in one go and silently drops the rest. Every sentence in the three test books that
// runs over that is rendered unsplit by Kokoro (so the engine really cuts it), and in full by
// macOS `say` (so nothing is cut). Both sets go through the whole pipeline as one file each.
// The sentence counts as caught if any of its lines is labelled cut short.
//
//   npm run eval:cutoff        needs macOS for the `say` half

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as tf from '@huggingface/transformers';
import { phonemize } from 'phonemizer';
import { loadVoice, SAMPLE_RATE } from '../src/voice.js';
import { listenFile } from '../src/segment.js';
import { parse } from '../src/manuscript.js';
import { namesIn } from '../src/compare.js';
import { book, proof } from '../src/proof.js';
import { ensureBooks, BOOKS } from '../scripts/books.mjs';
import { CACHE, sha, readWav, slices, cachedListener } from './evalkit.mjs';

if (process.platform !== 'darwin') { console.log('needs macOS for say; skipped'); process.exit(0); }
mkdirSync(new URL('cutoff/', CACHE), { recursive: true });
await ensureBooks();
const texts = Object.keys(BOOKS).map((id) => readFileSync(new URL(`books/pg${id}.txt`, CACHE), 'utf8'));
const known = new Set(texts.flatMap((t) => [...namesIn(t)]));

// ---- the sentences Kokoro cannot read in one go ------------------------------------------------

const voice = await loadVoice(tf, phonemize, { dtype: 'q8' });
const tokenizer = await tf.AutoTokenizer.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX');
// Whole sentences as the manuscript reader sees them (no contents pages), rejoined from pieces.
const long = [];
for (const t of texts) {
  const whole = [];
  for (const l of parse(t).flatMap((c) => c.lines)) if (l.kind === 'line') { if (l.part) whole[whole.length - 1] += ` ${l.text}`; else whole.push(l.text); }
  for (const s of whole) {
    if (s.split(/\s+/).length < 50) continue;
    const n = tokenizer(await voice.phonemes(s)).input_ids.dims.at(-1);
    if (n > 510) long.push(s);
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
  return readWav(file);
}
function join(clips) {
  const gap = Math.round(0.6 * SAMPLE_RATE);
  const out = new Float32Array(clips.reduce((s, c) => s + c.length + gap, gap));
  let at = gap;
  for (const c of clips) { out.set(c, at); at += c.length + gap; }
  return out;
}

const { hear, save } = await cachedListener('heard-cutoff-whisper-base.en.json');

const bk = book(parse(long.join('\n\n')));
const results = {};
for (const [name, render] of [['kokoro, unsplit', kokoro], ['say, in full', say]]) {
  const clips = [];
  for (const s of long) clips.push(await render(s));
  const { pieces } = await listenFile(slices(join(clips)), hear);
  save();
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
