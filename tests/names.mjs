// Does the pronunciation check notice a name said differently in one place? Eight invented
// names from A Princess of Mars, five short lines each, spoken by macOS `say` in two voices.
// In one rendering every name is said as written. In two more, one occurrence of each name is
// changed: one consonant swapped, or two. The swap stands in for an engine guessing a name
// differently in one chapter. The check was written before this eval was run.
//
//   npm run eval:names        needs macOS

import { readFileSync } from 'node:fs';
import { parse } from '../src/manuscript.js';
import { namesIn } from '../src/compare.js';
import { listenFile } from '../src/segment.js';
import { book, proof } from '../src/proof.js';
import { ensureBooks } from '../scripts/books.mjs';
import { CACHE, say, join, slices, cachedListener } from './evalkit.mjs';

if (process.platform !== 'darwin') { console.log('needs macOS for say; skipped'); process.exit(0); }
await ensureBooks();
const mars = readFileSync(new URL('books/pg62.txt', CACHE), 'utf8');
const NAMES = ['Tal Hajus', 'Kantos Kan', 'Lorquas Ptomel', 'Woola', 'Zodanga', 'Kosis', 'Tardos Mors', 'Sarkoja'];
const VOICES = ['Samantha', 'Daniel'];

// Five short lines per name, each naming it once and no other name on the list.
const all = parse(mars).flatMap((c) => c.lines).filter((l) => l.kind === 'line' && l.text.split(/\s+/).length <= 30).map((l) => l.text);
const count = (line, name) => line.split(new RegExp(`\\b${name}\\b`)).length - 1;
const picks = NAMES.map((n) => {
  const ok = all.filter((l) => count(l, n) === 1 && NAMES.every((m) => m === n || count(l, m) === 0));
  if (ok.length < 5) throw new Error(`only ${ok.length} lines for ${n}`);
  return [0, 1, 2, 3, 4].map((k) => ok[Math.floor((k * ok.length) / 5)]);
});
// Round-robin, so each name's lines are spread through the file.
const lines = [0, 1, 2, 3, 4].flatMap((k) => picks.map((p, i) => ({ text: p[k], name: NAMES[i], k })));

const SWAP = { b: 'd', c: 't', d: 'b', f: 's', g: 'd', h: 'f', j: 'v', k: 'p', l: 'n', m: 'n', n: 'm', p: 'k', q: 'k', r: 'l', s: 'f', t: 'k', v: 'z', w: 'r', x: 'f', z: 'v' };
/** Swap n consonants in the name's longest word, leaving its first letter for last. */
function mutate(name, n) {
  const ws = name.split(' ');
  const w = ws.reduce((a, b) => (b.length > a.length ? b : a));
  const chars = [...w];
  const at = chars.map((c, i) => i).filter((i) => SWAP[chars[i].toLowerCase()]);
  for (const i of [...at.filter((i) => i > 0), ...at.filter((i) => i === 0)].slice(0, n)) {
    const s = SWAP[chars[i].toLowerCase()];
    chars[i] = chars[i] === chars[i].toUpperCase() ? s.toUpperCase() : s;
  }
  return ws.map((x) => (x === w ? chars.join('') : x)).join(' ');
}

const manuscript = lines.map((l) => l.text).join('\n\n');
const bk = book(parse(manuscript));
const known = namesIn(mars);
const { hear, stats, save } = await cachedListener('heard-names-whisper-base.en.json');
const PLANT = 2; // the third of each name's five lines carries the changed name

console.log(`${NAMES.length} names x 5 lines, voices ${VOICES.join(', ')}\n`);
const score = { 1: [0, 0], 2: [0, 0] }, alarms = [0, 0], misses = [], falses = [];
for (const v of VOICES) {
  for (const change of [0, 1, 2]) {
    const said = lines.map((l) => (change && l.k === PLANT ? l.text.replace(l.name, mutate(l.name, change)) : l.text));
    const { pieces } = await listenFile(slices(join(said.map((t) => say(t, v)))), hear);
    const r = proof(bk, [{ name: `${v}-${change}`, pieces }], { known, fullText: mars });
    for (const e of r.names.filter((x) => x.kind === 'name')) {
      const target = NAMES.indexOf(e.say);
      for (const h of e.heard) {
        const L = bk.lines.find((x) => h.pos >= x.from && h.pos < x.to);
        const li = bk.lines.filter((x) => x.kind === 'line').indexOf(L);
        const planted = change && target >= 0 && lines[li]?.name === e.say && lines[li].k === PLANT;
        const flagged = e.flags.some((f) => f.pos === h.pos && f.why === 'said differently here');
        if (planted) {
          score[change][1]++;
          if (flagged) score[change][0]++; else misses.push(`${v}, ${change} swapped: ${mutate(e.say, change)} heard "${h.text}" (others: ${e.ways.map(([w]) => w).join(', ')})`);
        } else {
          alarms[1]++;
          if (flagged) { alarms[0]++; falses.push(`${v}, ${e.say} heard "${h.text}" (others: ${e.ways.map(([w]) => w).join(', ')})`); }
        }
      }
    }
    save();
    console.log(`  ${v}, ${change ? `${change} consonant${change > 1 ? 's' : ''} changed` : 'as written'}: done`);
  }
}

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '-');
console.log(`\nlistener: ${stats.n} new pieces`);
console.log(`one consonant changed, flagged:   ${score[1][0]}/${score[1][1]} (${pct(...score[1])})`);
console.log(`two consonants changed, flagged:  ${score[2][0]}/${score[2][1]} (${pct(...score[2])})`);
console.log(`names said as written, flagged:   ${alarms[0]}/${alarms[1]} (${pct(...alarms)})`);
console.log('\nmissed:');
for (const m of misses) console.log(`  ${m}`);
console.log('\nfalse alarms:');
for (const f of falses) console.log(`  ${f}`);
