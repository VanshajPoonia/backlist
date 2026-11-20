// The pronunciation list: the book's names and unusual words, where each one occurs, and how
// the listener heard it each time.
//
// A listener cannot spell a name it has never heard, so a name is not wrong just because it
// came back spelled oddly. What it can show is a name said differently from one place to
// the next: the same voice saying the same name should come back much the same each time,
// so an occurrence that sounds unlike all the others is worth a listen.

import { tokens, namesIn, same, sound } from './compare.js';

// Words a voice can read two ways, where only the sentence tells it which. The listener writes
// the same word either way, so these can only be listed, not checked.
export const HETERONYMS = new Set(('wound bow bows sow dove desert deserts minute invalid entrance refuse console polish sewer bass ' +
  'tear tears lead wind row rows does buffet axes').split(' '));

const ACCENTED = /[^\x00-\x7F’‘“”—–…]/;

/**
 * @param {{text:string, from:number, toks:{w:string}[]}[]} lines  from proof.js book()
 * @param {string} fullText  the whole manuscript, to tell names from ordinary words
 * @returns {{say:string, words:string[], kind:'name'|'foreign'|'heteronym', at:number[]}[]}  `at` holds book word positions
 */
export function pronunciationList(lines, fullText) {
  const names = namesIn(fullText);
  const display = new Map();
  for (const m of fullText.matchAll(/[\p{L}][\p{L}'’-]*/gu)) {
    const k = m[0].toLowerCase().replace(/['’]s$/, 's').replace(/['’]/g, '');
    if (!display.has(k) || /^\p{Lu}/u.test(m[0])) display.set(k, m[0].replace(/['’]s$/, ''));
  }
  const found = new Map();
  const add = (key, entry, pos) => {
    if (!found.has(key)) found.set(key, { ...entry, at: [] });
    found.get(key).at.push(pos);
  };
  for (const L of lines) {
    // Walk the written words beside the checker's words, so a run of names stops at punctuation.
    let pos = L.from, run = [];
    const flush = () => {
      if (run.length) {
        const ws = run.map((r) => r.w);
        add(`n:${ws.join(' ')}`, { say: ws.map((w) => display.get(w) ?? w).join(' '), words: ws, kind: 'name' }, run[0].pos);
      }
      run = [];
    };
    const raw = L.text.split(/\s+/);
    const counts = raw.map((r) => tokens(r).length);
    if (counts.reduce((s, n) => s + n, 0) !== L.toks.length) continue;
    raw.forEach((r, i) => {
      const ws = tokens(r).map((t) => t.w);
      // "Sarkoja's" is Sarkoja: fold a possessive into the plain name when the book has both.
      const w = ws.length === 1 && ws[0].endsWith('s') && /['’]s\W*$/.test(r) && names.has(ws[0].slice(0, -1)) ? ws[0].slice(0, -1) : ws[0];
      if (ws.length === 1 && names.has(w)) {
        run.push({ w, pos });
        if (/[^\p{L}\p{N}'’]$/u.test(r.replace(/['’]s$/, ''))) flush();
      } else {
        flush();
        if (ws.length === 1 && !names.has(ws[0])) {
          if (ACCENTED.test(r)) add(`f:${ws[0]}`, { say: r.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, ''), words: ws, kind: 'foreign' }, pos);
          else if (HETERONYMS.has(ws[0])) add(`h:${ws[0]}`, { say: ws[0], words: ws, kind: 'heteronym' }, pos);
        }
      }
      pos += counts[i];
    });
    flush();
  }
  const order = { name: 0, foreign: 1, heteronym: 2 };
  return [...found.values()].sort((a, b) => order[a.kind] - order[b.kind] || b.at.length - a.at.length || a.say.localeCompare(b.say));
}

const letters = (s) => s.toLowerCase().replace(/[^a-z]/g, '');
const lev = (a, b) => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
};

/**
 * How each entry was heard. `heardAt(pos, n)` returns what the listener heard for the book words
 * [pos, pos + n): {text, t, file} or null where that stretch is not in the audio.
 * @returns entries with `heard` (each occurrence) and `flags` (occurrences worth a listen)
 */
export function pronunciationCheck(list, heardAt) {
  return list.map((e) => {
    const heard = e.at.map((pos) => ({ pos, ...(heardAt(pos, e.words.length) ?? { missing: true }) })).filter((h) => !h.missing);
    const flags = [];
    for (const h of heard) {
      if (!h.text) { flags.push({ ...h, why: 'not said' }); continue; }
      if (e.kind === 'heteronym') continue;
      if (e.kind === 'foreign') { if (!same(e.words.join(''), letters(h.text))) flags.push({ ...h, why: 'heard as a different word' }); continue; }
      // A name: does this occurrence sound like the others? Compare consonant outlines.
      const key = sound(letters(h.text));
      const others = heard.filter((o) => o !== h && o.text).map((o) => sound(letters(o.text)));
      if (others.length < 2) continue;
      const near = others.filter((k) => lev(k, key) <= Math.max(1, Math.floor(key.length / 4))).length;
      const book = sound(e.words.join(''));
      if (near === 0 && lev(book, key) > Math.max(1, Math.floor(book.length / 4))) flags.push({ ...h, why: 'said differently here' });
    }
    // Group the spellings, most common first, so the author sees at a glance how it came out.
    const ways = new Map();
    for (const h of heard) if (h.text) ways.set(h.text.toLowerCase(), (ways.get(h.text.toLowerCase()) ?? 0) + 1);
    return { ...e, heard, flags, ways: [...ways].sort((a, b) => b[1] - a[1]) };
  });
}
