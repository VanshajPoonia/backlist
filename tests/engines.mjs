// AuthorVoice Proof on audio from another engine, end to end: whole files go in, the way an
// author would upload them, and the report comes out.
//
//   npm run eval:engines                    macOS `say`, the test lines (needs macOS)
//   SET=tuning npm run eval:engines         the lines compare.js was tuned on (A Christmas Carol)
//   ENGINE=kokoro npm run eval:engines      Kokoro's line audio cached by tests/proof.mjs, joined into files
//
// The lines and faults are the ones tests/proof.mjs uses. Each line is rendered as written and
// with each planted fault; the lines are joined into two files (one per book). There is one
// clean set of files, and four with faults: in each, every line long enough carries one fault,
// a different one each time, so over the four every line gets every fault once. A fault
// counts as caught only if its own line is flagged.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parse } from '../src/manuscript.js';
import { narrate } from '../src/narrate.js';
import { namesIn } from '../src/compare.js';
import { DEFAULT } from '../src/listen.js';
import { listenFile } from '../src/segment.js';
import { book, proof } from '../src/proof.js';
import { ensureBooks } from '../scripts/books.mjs';
import { faultsFor, TYPES } from './faults.mjs';
import { CACHE, say, join, starts, slices, cachedListener } from './evalkit.mjs';

const ENGINE = process.env.ENGINE || 'say';
const SET = process.env.SET || 'test';
const LISTENER = process.env.LISTENER || DEFAULT;

if (ENGINE === 'say' && process.platform !== 'darwin') {
  console.log('the say engine needs macOS; skipped');
  process.exit(0);
}

await ensureBooks();
const text = (id) => readFileSync(new URL(`books/pg${id}.txt`, CACHE), 'utf8');

// ---- the lines (as in tests/proof.mjs) --------------------------------------------------------

const chapter = (id, title) => parse(text(id)).find((c) => c.title.startsWith(title));
const body = (c, n) => c.lines.filter((l) => l.kind === 'line').slice(0, n).map((l) => l.text);
const parts = SET === 'tuning'
  ? [body(chapter(46, 'STAVE I'), 30)]
  : [body(chapter(244, 'CHAPTER I. MR. SHERLOCK'), 40), body(chapter(62, 'CHAPTER IV. A PRISONER'), 40)];
const known = SET === 'tuning' ? namesIn(text(46)) : new Set([...namesIn(text(244)), ...namesIn(text(62))]);
const lines = parts.flat();

// ---- the engines ------------------------------------------------------------------------------

const SAY_VOICES = ['Samantha', 'Daniel', 'Karen', 'Moira']; // American, British, Australian, Irish
const KOKORO_VOICES = ['af_heart', 'bm_george', 'bf_emma', 'am_michael'];

/** One line of narration, 24 kHz mono. */
function render(spoken, idx) {
  if (ENGINE !== 'kokoro') return say(spoken, SAY_VOICES[idx % 4]);
  const key = createHash('sha1').update(`q8|${KOKORO_VOICES[idx % 4]}|${narrate(spoken)}`).digest('hex').slice(0, 16);
  const file = new URL(`audio/${key}.f32`, CACHE);
  if (!existsSync(file)) throw new Error(`no cached Kokoro audio for "${spoken.slice(0, 40)}"; run npm test first`);
  const b = readFileSync(file);
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

const { hear, stats, save } = await cachedListener(`heard-files-${LISTENER}.json`, LISTENER);

// ---- run --------------------------------------------------------------------------------------

const manuscript = parts.map((p) => p.join('\n\n')).join('\n\n');
const bk = book(parse(manuscript));
const parsed = bk.lines.filter((L) => L.kind === 'line');
if (parsed.length !== lines.length) throw new Error(`the manuscript parsed into ${parsed.length} lines, expected ${lines.length}`);

const faults = lines.map((l, i) => faultsFor(l, i + 1));
const configs = [{ name: 'clean', fault: () => null }];
for (let t = 0; t < 4; t++) configs.push({ name: `faults ${t + 1}`, fault: (i) => TYPES[(t + i) % 4] });

console.log(`engine: ${ENGINE}, listener: ${LISTENER}, set: ${SET}; ${lines.length} lines in ${parts.length} file(s), ${configs.length} file sets\n`);
const t0 = Date.now();
const score = { clean: 0, cleanN: 0, spill: 0, spillN: 0, near: 0, caught: {}, n: {}, labels: {} };
for (const t of TYPES) { score.caught[t] = 0; score.n[t] = 0; score.labels[t] = {}; }
const missed = [], alarms = [], timeErr = [];
const LABEL = { skipped: ['skipped'], repeated: ['added'], swapped: ['mispronounced', 'garbled'], 'cut off': ['cut short'] };

for (const cfg of configs) {
  let idx = 0;
  const files = [];
  const said = [], truth = [];
  for (const [k, part] of parts.entries()) {
    const first = idx;
    const clips = part.map((line) => {
      const i = idx++;
      const type = cfg.fault(i), f = type ? faults[i]?.[type] : null;
      said[i] = f ? type : null;
      return render(f ?? line, i);
    });
    starts(clips).forEach((t, j) => { truth[first + j] = { file: k, t }; });
    const { pieces } = await listenFile(slices(join(clips)), hear);
    files.push({ name: `part${k + 1}.wav`, pieces });
  }
  const r = proof(bk, files, { known });
  const res = r.lines.filter((L) => L.kind === 'line');
  // How far the reported time of each line read as written is from where it really starts.
  if (cfg.name === 'clean') for (const [i, L] of res.entries()) if (L.inAudio && L.file === truth[i].file) timeErr.push(Math.abs(L.t - truth[i].t));
  res.forEach((L, i) => {
    const type = said[i];
    if (!type) {
      const bad = !L.ok;
      if (cfg.name === 'clean') { score.cleanN++; if (bad) { score.clean++; alarms.push({ cfg: cfg.name, L }); } }
      else { score.spillN++; if (bad) { score.spill++; alarms.push({ cfg: cfg.name, L }); } }
      return;
    }
    score.n[type]++;
    if (!L.ok) {
      score.caught[type]++;
      const labels = [...new Set(L.problems.map((p) => p.type))];
      const right = labels.some((l) => LABEL[type].includes(l));
      score.labels[type][right ? 'right' : labels.join('+')] = (score.labels[type][right ? 'right' : labels.join('+')] ?? 0) + 1;
    } else {
      if (!res[i - 1]?.ok || !res[i + 1]?.ok) score.near++;
      missed.push({ type, line: lines[i], said: faults[i][type], heard: L.heard });
    }
  });
  save();
  console.log(`  ${cfg.name}: ${res.filter((L) => !L.ok).length} of ${res.length} lines flagged`);
}

// ---- report ------------------------------------------------------------------------------------

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '-');
const caught = TYPES.reduce((s, t) => s + score.caught[t], 0), n = TYPES.reduce((s, t) => s + score.n[t], 0);
console.log(`\n${((Date.now() - t0) / 60000).toFixed(1)} min` + (stats.sec ? `; listener ${(stats.sec / (stats.ms / 1000)).toFixed(1)}x real time on ${stats.n} new pieces` : ''));
timeErr.sort((a, b) => a - b);
const q = (p) => timeErr[Math.min(timeErr.length - 1, Math.floor(p * timeErr.length))] ?? 0;
console.log(`reported line times vs the real start: median ${q(0.5).toFixed(1)} s off, 90% within ${q(0.9).toFixed(1)} s, worst ${q(1).toFixed(1)} s`);
console.log(`\nfalse alarms on clean files:            ${score.clean}/${score.cleanN} (${pct(score.clean, score.cleanN)})`);
console.log(`clean lines between faults, flagged:     ${score.spill}/${score.spillN} (${pct(score.spill, score.spillN)})`);
console.log(`faults caught on their own line:         ${caught}/${n} (${pct(caught, n)})`);
for (const t of TYPES) console.log(`  ${t.padEnd(10)} ${`${score.caught[t]}/${score.n[t]}`.padStart(8)}  labelled ${JSON.stringify(score.labels[t])}`);
console.log(`missed faults with a flag on a neighbouring line: ${score.near}`);
console.log('\nfalse alarms:');
for (const a of alarms) console.log(`  [${a.cfg}] "${a.L.text.slice(0, 90)}"\n    heard "${a.L.heard.slice(0, 90)}"  ${JSON.stringify(a.L.problems.map((p) => [p.type, p.words, p.heard].filter(Boolean)))}`);
console.log('\nmissed faults:');
for (const m of missed) console.log(`  ${m.type}: said "${m.said.slice(0, 90)}"\n    heard "${m.heard.slice(0, 90)}"`);

writeFileSync(new URL(`engines-${ENGINE}-${SET}.json`, CACHE), JSON.stringify({ engine: ENGINE, set: SET, listener: LISTENER, score, caught, n, time: { median: q(0.5), p90: q(0.9), worst: q(1) } }, null, 1));
const pass = score.clean / score.cleanN <= 0.1 && caught / n >= 0.85; // the bar tests/proof.mjs sets
console.log(pass ? '\nPASS' : '\nFAIL');
process.exit(pass ? 0 : 1);
