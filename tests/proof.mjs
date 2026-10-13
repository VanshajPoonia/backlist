// Runs the real narrator and the real listener, and reproduces the README's numbers.
//
//   npm test                                 Kokoro q8 + Whisper base.en (what ships)
//   LISTENER=whisper-tiny.en npm test        the smaller listener, for comparison
//   SET=tuning npm test                      the 30 lines compare.js was tuned on (A Christmas Carol)
//
// What it measures:
//   1. Does the proof-listener catch real narration faults? Each test line is rendered as
//      written, and four more times with a fault planted in the text the narrator reads: three
//      words skipped, three words said twice, one word swapped for another, and the last 40%
//      never said. Every rendering is heard back and checked against the book.
//   2. Does it cry wolf? The clean renderings should pass. A checker that flags good audio
//      sends the author to re-listen to everything, which is the job it was meant to save.
//   3. Do the narration rules (src/narrate.js) fix anything? Lines they change are rendered
//      both ways and both are heard back.
// Lines rotate through four voices, two American and two British. Audio and transcripts are
// cached in tests/.cache, so a second run, or a run with another listener, is fast.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as tf from '@huggingface/transformers';
import { phonemize } from 'phonemizer';
import { loadVoice, SAMPLE_RATE } from '../src/voice.js';
import { loadListener, DEFAULT } from '../src/listen.js';
import { narrate, heading } from '../src/narrate.js';
import { check, words, namesIn, same } from '../src/compare.js';
import { parse } from '../src/manuscript.js';
import { ensureBooks } from '../scripts/books.mjs';

const LISTENER = process.env.LISTENER || DEFAULT;
const DTYPE = process.env.DTYPE || 'q8';
const SET = process.env.SET || 'test';
const VOICES = ['af_heart', 'bm_george', 'bf_emma', 'am_michael'];

const CACHE = new URL('./.cache/', import.meta.url);
const AUDIO = new URL('audio/', CACHE);
mkdirSync(AUDIO, { recursive: true });
await ensureBooks();
const book = (id) => readFileSync(new URL(`books/pg${id}.txt`, CACHE), 'utf8');

// ---- the lines -------------------------------------------------------------------------

const chapter = (id, title) => parse(book(id)).find((c) => c.title.startsWith(title));
const body = (c, n) => c.lines.filter((l) => l.kind === 'line').slice(0, n).map((l) => l.text);

let main, extra = [], heads = [], names;
if (SET === 'tuning') {
  main = body(chapter(46, 'STAVE I'), 30);
  names = namesIn(book(46));
} else {
  const scarlet = parse(book(244)), mars = parse(book(62));
  main = [...body(chapter(244, 'CHAPTER I. MR. SHERLOCK'), 40), ...body(chapter(62, 'CHAPTER IV. A PRISONER'), 40)];
  // Every line in the two books that the narration rules change, spread evenly, 15 per book.
  for (const b of [scarlet, mars]) {
    const changed = b.flatMap((c) => c.lines).filter((l) => l.kind === 'line' && narrate(l.text) !== l.text && !main.includes(l.text)).map((l) => l.text);
    const step = Math.max(1, Math.floor(changed.length / 15));
    extra.push(...changed.filter((_, i) => i % step === 0).slice(0, 15));
    heads.push(...b.filter((c) => /^(CHAPTER|PART)/.test(c.title)).slice(0, 6).map((c) => c.title));
  }
  names = new Set([...namesIn(book(244)), ...namesIn(book(62))]);
}

// ---- the models -------------------------------------------------------------------------

const VOICE_DIR = new URL('../node_modules/@huggingface/transformers/.cache/onnx-community/Kokoro-82M-v1.0-ONNX/voices/', import.meta.url);
const readVoice = async (n) => { const b = await readFile(new URL(`${n}.bin`, VOICE_DIR)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const voice = await loadVoice(tf, phonemize, { dtype: DTYPE, readVoice });
const hear = await loadListener(tf, { model: LISTENER });

const transcripts = new URL(`heard-${LISTENER}-${DTYPE}.json`, CACHE);
const heardCache = existsSync(transcripts) ? JSON.parse(readFileSync(transcripts)) : {};
let synthMs = 0, synthSec = 0, hearMs = 0, rendered = 0;

/** Render `spoken` in `v`, hear it back. Cached by text, voice and model. */
async function roundTrip(spoken, v) {
  const key = createHash('sha1').update(`${DTYPE}|${v}|${spoken}`).digest('hex').slice(0, 16);
  if (heardCache[key] !== undefined) return heardCache[key];
  const file = new URL(`${key}.f32`, AUDIO);
  let audio;
  if (existsSync(file)) {
    const b = readFileSync(file);
    audio = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  } else {
    const t = Date.now();
    ({ audio } = await voice.speak(spoken, { voice: v }));
    synthMs += Date.now() - t; synthSec += audio.length / SAMPLE_RATE;
    writeFileSync(file, Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength));
  }
  const t = Date.now();
  const heard = await hear(audio, SAMPLE_RATE);
  hearMs += Date.now() - t;
  heardCache[key] = heard;
  if (++rendered % 20 === 0) {
    writeFileSync(transcripts, JSON.stringify(heardCache));
    console.log(`  ${rendered} rendered and heard`);
  }
  return heard;
}

// ---- faults -----------------------------------------------------------------------------

const SWAPS = ['window', 'basket', 'yellow', 'thunder', 'pocket', 'silver', 'garden', 'kitten', 'pencil', 'blanket', 'button', 'carpet', 'lemon', 'violin', 'turnip', 'ladder'];
const STOP = new Set(words('the and that with this from have were they them their there then than what when which while would could should about into upon been being very more most such only some other these those your yours'));

function rng(seed) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296); }

function faultsFor(line, seed) {
  const w = line.split(/\s+/);
  if (w.length < 8) return null;
  const r = rng(seed);
  const at = (lo, hi) => lo + Math.floor(r() * (hi - lo));
  const i = at(1, w.length - 4), j = at(1, w.length - 4);
  const out = {
    skipped: [...w.slice(0, i), ...w.slice(i + 3)].join(' '),
    repeated: [...w.slice(0, j + 3), ...w.slice(j, j + 3), ...w.slice(j + 3)].join(' '),
    'cut off': w.slice(0, Math.ceil(w.length * 0.6)).join(' '),
  };
  // Swap an ordinary lower-case word (never a name) for one that sounds nothing like it.
  const cand = w.map((x, k) => [x, k]).filter(([x, k]) => k > 0 && /^[a-z]{4,}[,;:.!?]?$/.test(x) && !STOP.has(x.replace(/\W/g, '')));
  if (cand.length) {
    const [x, k] = cand[at(0, cand.length)];
    const bare = x.replace(/\W/g, '');
    const sub = SWAPS.find((s, n) => n >= at(0, SWAPS.length) - 0 && !same(bare, s)) ?? 'window';
    out.swapped = [...w.slice(0, k), x.replace(bare, sub), ...w.slice(k + 1)].join(' ');
  }
  return out;
}

// ---- checkers ---------------------------------------------------------------------------

function wer(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return a.length ? d[a.length][b.length] / a.length : 0;
}
const CHECKERS = {
  'exact match': (b, h) => words(b).join(' ') === words(h).join(' '),
  'word error rate <= 15%': (b, h) => wer(words(b), words(h)) <= 0.15,
  'shipped (src/compare.js)': (b, h) => check(b, h, names).ok,
};

// ---- run --------------------------------------------------------------------------------

console.log(`narrator: Kokoro-82M (${DTYPE}), listener: ${LISTENER}, set: ${SET}`);
console.log(`${main.length} lines with planted faults, ${extra.length} more lines the narration rules change, ${heads.length} chapter headings\n`);
const t0 = Date.now();

const TYPES = ['skipped', 'repeated', 'swapped', 'cut off'];
const res = Object.fromEntries(Object.keys(CHECKERS).map((k) => [k, { clean: 0, cleanN: 0, caught: Object.fromEntries(TYPES.map((t) => [t, 0])), n: Object.fromEntries(TYPES.map((t) => [t, 0])) }]));
const falseAlarms = [], missed = [];

for (const [idx, line] of main.entries()) {
  const v = VOICES[idx % VOICES.length];
  const heard = await roundTrip(narrate(line), v);
  for (const [k, fn] of Object.entries(CHECKERS)) {
    res[k].cleanN++;
    if (!fn(line, heard)) { res[k].clean++; if (k.startsWith('shipped')) falseAlarms.push({ line, heard, why: check(line, heard, names).problems }); }
  }
  const f = faultsFor(line, idx + 1);
  if (!f) continue;
  for (const t of TYPES) {
    if (!f[t]) continue;
    const h = await roundTrip(narrate(f[t]), v);
    for (const [k, fn] of Object.entries(CHECKERS)) {
      res[k].n[t]++;
      if (!fn(line, h)) res[k].caught[t]++;
      else if (k.startsWith('shipped')) missed.push({ type: t, line, said: f[t], heard: h });
    }
  }
}

// Narration rules: render the lines they change both ways (headings through heading()).
const before = [], after = [];
for (const [idx, line] of [...extra, ...heads].entries()) {
  const isHead = idx >= extra.length;
  const v = VOICES[idx % VOICES.length];
  const fixed = isHead ? heading(line) : narrate(line);
  const hRaw = await roundTrip(line, v);
  const hFix = await roundTrip(fixed, v);
  const rRaw = check(line, hRaw, names), rFix = check(line, hFix, names);
  if (!rRaw.ok) before.push({ line, heard: hRaw, why: rRaw.problems, fixedOk: rFix.ok, heardFixed: hFix });
  if (!rFix.ok) after.push({ line, said: fixed, heard: hFix, why: rFix.problems });
}
writeFileSync(transcripts, JSON.stringify(heardCache));

// ---- report -----------------------------------------------------------------------------

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '  -');
console.log(`\n${((Date.now() - t0) / 60000).toFixed(1)} min` + (synthSec ? `; narrator ${(synthSec / (synthMs / 1000)).toFixed(2)}x real time, listener ${(hearMs / 1000 / rendered).toFixed(2)} s per line` : ''));
console.log(`\n${'checker'.padEnd(26)} ${'false alarms on clean audio'.padEnd(30)} ${TYPES.map((t) => t.padStart(10)).join(' ')}   all faults`);
for (const [k, r] of Object.entries(res)) {
  const caught = TYPES.reduce((s, t) => s + r.caught[t], 0), n = TYPES.reduce((s, t) => s + r.n[t], 0);
  console.log(`${k.padEnd(26)} ${`${r.clean}/${r.cleanN} (${pct(r.clean, r.cleanN)})`.padEnd(30)} ${TYPES.map((t) => `${r.caught[t]}/${r.n[t]}`.padStart(10)).join(' ')}   ${caught}/${n} (${pct(caught, n)})`);
}

const items = extra.length + heads.length;
console.log(`\nnarration rules: of ${items} lines they change, the listener flagged ${before.length} rendered as written, and ${after.length} rendered with the rules`);
for (const b of before) console.log(`  AS WRITTEN "${b.line.slice(0, 90)}"\n     heard   "${b.heard.slice(0, 90)}"  ${JSON.stringify(b.why)}\n     fixed:  ${b.fixedOk ? 'passes' : `still flagged, heard "${b.heardFixed.slice(0, 80)}"`}`);
for (const a of after) console.log(`  STILL FLAGGED "${a.line.slice(0, 80)}" said "${a.said.slice(0, 80)}" heard "${a.heard.slice(0, 80)}" ${JSON.stringify(a.why)}`);

console.log('\nfalse alarms (shipped checker):');
for (const f of falseAlarms) console.log(`  "${f.line.slice(0, 100)}"\n    heard "${f.heard.slice(0, 100)}"  ${JSON.stringify(f.why)}`);
console.log('\nmissed faults (shipped checker):');
for (const m of missed) console.log(`  ${m.type}: said "${m.said.slice(0, 90)}"\n    heard "${m.heard.slice(0, 90)}"`);

const s = res['shipped (src/compare.js)'];
const caught = TYPES.reduce((a, t) => a + s.caught[t], 0), n = TYPES.reduce((a, t) => a + s.n[t], 0);
const pass = s.clean / s.cleanN <= 0.1 && caught / n >= 0.85;
console.log(pass ? '\nPASS' : '\nFAIL');
process.exit(pass ? 0 : 1);
