// The faults the evaluations plant in the text a narrator reads: three words skipped, three
// words said twice, one word swapped for another, and the last 40% never said. Shared by
// tests/proof.mjs (Kokoro, line by line) and tests/engines.mjs (whole files, any engine).

import { words, same } from '../src/compare.js';

export const TYPES = ['skipped', 'repeated', 'swapped', 'cut off'];

const SWAPS = ['window', 'basket', 'yellow', 'thunder', 'pocket', 'silver', 'garden', 'kitten', 'pencil', 'blanket', 'button', 'carpet', 'lemon', 'violin', 'turnip', 'ladder'];
const STOP = new Set(words('the and that with this from have were they them their there then than what when which while would could should about into upon been being very more most such only some other these those your yours'));

function rng(seed) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296); }

export function faultsFor(line, seed) {
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
