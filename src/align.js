// Where in the book is this audio? A chapter file (or a whole book in one file) is heard as
// one long run of words, and has to be lined up with the manuscript before any line can be
// checked. Word runs that occur exactly once in both are anchors; between anchors the words
// are aligned the same way compare.js aligns a single line, with the same sound-alike rules.

import { same } from './compare.js';

const LIMIT = 4e6; // cells; a bigger gap is split with shorter anchors first

/** Longest chain of anchors that moves forward in both the book and the audio. */
function chain(pairs) {
  pairs.sort((p, q) => p[1] - q[1] || p[0] - q[0]);
  const tails = [], prev = new Int32Array(pairs.length).fill(-1);
  for (let k = 0; k < pairs.length; k++) {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (pairs[tails[mid]][0] < pairs[k][0]) lo = mid + 1; else hi = mid; }
    if (lo > 0) prev[k] = tails[lo - 1];
    tails[lo] = k;
  }
  const out = [];
  for (let k = tails.length ? tails[tails.length - 1] : -1; k >= 0; k = prev[k]) out.push(pairs[k]);
  return out.reverse();
}

/** n-word keys that occur exactly once in a[from, to). */
function unique(a, from, to, n) {
  const m = new Map();
  for (let i = from; i + n <= to; i++) {
    let k = a[i];
    for (let d = 1; d < n; d++) k += ` ${a[i + d]}`;
    m.set(k, m.has(k) ? -1 : i);
  }
  return m;
}

function anchors(book, b0, b1, heard, h0, h1, n, bookKeys) {
  const bk = bookKeys ?? unique(book, b0, b1, n), hk = unique(heard, h0, h1, n);
  const pairs = [];
  for (const [k, j] of hk) {
    if (j < 0) continue;
    const i = bk.get(k);
    if (i !== undefined && i >= b0 && i + n <= b1) pairs.push([i, j]);
  }
  return chain(pairs);
}

/**
 * Edit-distance alignment of book[b0, b1) with heard[h0, h1). With `freeHead`, book words
 * before the alignment cost nothing (the audio may start anywhere in the window); with
 * `freeTail`, likewise after it.
 */
function dp(book, b0, b1, heard, h0, h1, { freeHead = false, freeTail = false } = {}) {
  const n = b1 - b0, m = h1 - h0;
  const D = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  const S = new Uint8Array((n + 1) * (m + 1));
  for (let j = 0; j <= m; j++) D[0][j] = j;
  for (let i = 1; i <= n; i++) {
    D[i][0] = freeHead ? 0 : i;
    for (let j = 1; j <= m; j++) {
      const eq = same(book[b0 + i - 1], heard[h0 + j - 1]);
      S[i * (m + 1) + j] = eq ? 1 : 0;
      D[i][j] = Math.min(D[i - 1][j] + 1, D[i][j - 1] + 1, D[i - 1][j - 1] + (eq ? 0 : 1));
    }
  }
  let i = n, j = m;
  if (freeTail) for (let k = n; k >= 0; k--) if (D[k][m] <= D[i][m]) i = k;
  const end = i;
  const ops = [];
  while (j > 0 || (i > 0 && !(freeHead && j === 0))) {
    const eq = i > 0 && j > 0 && S[i * (m + 1) + j] === 1;
    if (i > 0 && j > 0 && D[i][j] === D[i - 1][j - 1] + (eq ? 0 : 1)) {
      ops.push({ op: eq ? 'eq' : 'sub', bi: b0 + i - 1, hj: h0 + j - 1 }); i--; j--;
    } else if (i > 0 && D[i][j] === D[i - 1][j] + 1) {
      ops.push({ op: 'del', bi: b0 + --i });
    } else {
      ops.push({ op: 'ins', hj: h0 + --j });
    }
  }
  return { ops: ops.reverse(), from: b0 + i, to: b0 + end };
}

/** Align a stretch known to belong together, splitting it at anchors when it is too big. */
function between(book, b0, b1, heard, h0, h1, n = 3) {
  if (b1 <= b0 && h1 <= h0) return [];
  if ((b1 - b0) * (h1 - h0) <= LIMIT) return dp(book, b0, b1, heard, h0, h1).ops;
  const ch = anchors(book, b0, b1, heard, h0, h1, n);
  if (!ch.length) {
    if (n > 1) return between(book, b0, b1, heard, h0, h1, n - 1);
    // Nothing in common at all: the book words were not said and the heard words are extra.
    return [...Array.from({ length: b1 - b0 }, (_, k) => ({ op: 'del', bi: b0 + k })), ...Array.from({ length: h1 - h0 }, (_, k) => ({ op: 'ins', hj: h0 + k }))];
  }
  return stitch(book, b0, b1, heard, h0, h1, ch, n);
}

function stitch(book, b0, b1, heard, h0, h1, ch, n) {
  const ops = [];
  let b = b0, h = h0;
  for (const [i, j] of ch) {
    if (i < b || j < h) continue; // overlaps the previous anchor
    ops.push(...between(book, b, i, heard, h, j));
    for (let d = 0; d < n; d++) ops.push({ op: 'eq', bi: i + d, hj: j + d });
    b = i + n; h = j + n;
    while (b < b1 && h < h1 && book[b] === heard[h]) ops.push({ op: 'eq', bi: b++, hj: h++ });
  }
  ops.push(...between(book, b, b1, heard, h, h1));
  return ops;
}

/** Book word keys, worked out once per manuscript and shared by every file. */
export const bookKeys = (book) => unique(book, 0, book.length, 3);

/**
 * @param {string[]} book   every word of the manuscript, as compare.js spells them
 * @param {string[]} heard  every word heard in one audio file
 * @returns {{ops: {op:'eq'|'sub'|'del'|'ins', bi?:number, hj?:number}[], from:number, to:number} | null}
 *   `from` and `to` are the stretch of the book this file covers; null if it matches nothing.
 */
export function alignFile(book, heard, keys = bookKeys(book)) {
  const ch = anchors(book, 0, book.length, heard, 0, heard.length, 3, keys);
  if (!ch.length) return null;
  const [i0, j0] = ch[0];
  const last = ch[ch.length - 1];
  const bEnd = last[0] + 3, hEnd = last[1] + 3;
  // Before the first anchor and after the last, the audio may start or stop anywhere nearby.
  const reach = (k) => Math.ceil(k * 1.5) + 40;
  const head = dp(book, Math.max(0, i0 - reach(j0)), i0, heard, 0, j0, { freeHead: true });
  const mid = stitch(book, i0, bEnd, heard, j0, hEnd, ch, 3);
  const tail = dp(book, bEnd, Math.min(book.length, bEnd + reach(heard.length - hEnd)), heard, hEnd, heard.length, { freeTail: true });
  return { ops: [...head.ops, ...mid, ...tail.ops], from: head.from, to: tail.to };
}
