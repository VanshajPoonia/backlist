// Did the narrator say what the book says? Compares the manuscript sentence with what the
// listener heard, word by word.
//
// The listener is a model too, and it has habits that are not narration errors: it writes
// "1878" for "eighteen seventy-eight", "Mr." for "mister", American spellings for British
// ones, and it cannot spell a name it has never seen ("Dejah" comes back as "Deja", "Thark"
// as "Tark"). So words are compared by how they sound, numbers are compared as words, and
// small function words are allowed to go missing. What is never forgiven: content words
// that were skipped, words that were added, and a word that sounds like a different word.

import { cardinal, ordinal, year, roman } from './words.js';

const FUNCTION = new Set(('a an the and of to in on at for with as by it is was i he she they we you his her its that this but or so ' +
  'had has have be been from not no my me him them their our upon which who there then than all are were do did if into up out ' +
  'oh o ah well now one').split(' '));

// Abbreviations the listener writes for words the narrator spoke.
const ALIAS = {
  mr: ['mister'], mrs: ['missus', 'misses', 'missis', 'mrs'], ms: ['miss', 'mizz'], dr: ['doctor', 'drive'], st: ['saint', 'street'],
  mt: ['mount'], capt: ['captain'], col: ['colonel'], gen: ['general'], lt: ['lieutenant'], sgt: ['sergeant'], prof: ['professor'],
  rev: ['reverend'], jr: ['junior'], sr: ['senior'], ok: ['okay'], vs: ['versus'], co: ['company'],
};

// Homophones: the narrator said it right and the listener spelled it another way. Numbers
// matter most, because the listener's "1" becomes "one" before comparing.
const HOMOPHONES = [['one', 'won'], ['two', 'to', 'too'], ['four', 'for', 'fore'], ['eight', 'ate'], ['no', 'know'], ['knew', 'new'],
  ['right', 'write', 'rite'], ['there', 'their', 'theyre'], ['here', 'hear'], ['see', 'sea'], ['by', 'buy', 'bye'], ['its', 'its'],
  ['whole', 'hole'], ['hour', 'our'], ['night', 'knight'], ['road', 'rode', 'rowed'], ['made', 'maid'], ['sun', 'son'], ['wait', 'weight'],
  ['weak', 'week'], ['wear', 'where', 'ware'], ['which', 'witch'], ['would', 'wood'], ['through', 'threw'], ['peace', 'piece'],
  ['plain', 'plane'], ['tail', 'tale'], ['great', 'grate'], ['heard', 'herd'], ['steal', 'steel'], ['rain', 'reign', 'rein'], ['sole', 'soul'],
  ['i', 'eye', 'aye'], ['be', 'bee'], ['dear', 'deer'], ['meet', 'meat'], ['pale', 'pail'], ['course', 'coarse'], ['allowed', 'aloud'],
  ['seen', 'scene'], ['bare', 'bear'], ['passed', 'past'], ['blew', 'blue'], ['flower', 'flour'], ['horse', 'hoarse'], ['so', 'sew', 'sow'], ['corps', 'core']];
for (const set of HOMOPHONES) for (const w of set) ALIAS[w] = [...new Set([...(ALIAS[w] ?? []), ...set.filter((x) => x !== w)])];

const numberWords = (tok) => {
  const t = tok.replace(/,/g, '');
  let m;
  if ((m = t.match(/^(\d+)(st|nd|rd|th)$/))) return ordinal(Number(m[1]));
  if ((m = t.match(/^(\d{4})s$/))) return year(Number(m[1])).replace(/y$/, 'ie') + 's';
  if (/^\d{4}$/.test(t) && Number(t) >= 1100 && Number(t) < 2100) return year(Number(t));
  if (/^\d+$/.test(t)) return cardinal(Number(t));
  if ((m = t.match(/^(\d+)\.(\d+)$/))) return `${cardinal(Number(m[1]))} point ${m[2].split('').map((d) => cardinal(Number(d))).join(' ')}`;
  return null;
};

/** Text -> lower-case spoken words. Applied identically to the book and to what was heard. */
export const words = (text) => tokens(text).map((t) => t.w);

/** Like words(), but each word also knows if the book capitalised it mid-sentence: a name. */
export function tokens(text) {
  const out = [];
  let first = true;
  const toks = text
    .replace(/[’‘]/g, "'")
    .replace(/[£$]\s?(\d[\d,]*(?:\.\d+)?)/g, (m, n) => `${n} ${m[0] === '£' ? 'pounds' : 'dollars'}`)
    .replace(/(\d)\s?%/g, '$1 percent')
    .replace(/&/g, ' and ')
    .replace(/[\u2014\u2013-]+/g, ' ')
    .split(/\s+/);
  for (const raw of toks) {
    const bare = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}']+$/gu, '').replace(/'$/, '');
    if (!bare) continue;
    const r = /^[IVXLCDM]{2,}$/.test(bare) ? roman(bare) : null;
    const n = r ? cardinal(r) : numberWords(bare);
    const w = (n ?? bare).toLowerCase().replace(/'s$/, 's').replace(/'/g, '');
    const name = !first && !n && /^\p{Lu}\p{Ll}/u.test(bare);
    out.push(...w.split(/\s+/).filter(Boolean).map((x) => ({ w: x, name })));
    first = /[.!?:]['"”’)]*$/.test(raw);
  }
  return out;
}

/** A rough sound key: what is left of a word once spelling quirks are removed. */
export function sound(w) {
  let s = w.toLowerCase().replace(/[^a-z]/g, '');
  if (!s) return w;
  s = s.replace(/^kn|^gn|^pn|^wr/, (m) => m[1]).replace(/^x/, 's').replace(/^wh/, 'w')
    .replace(/our$/, 'or').replace(/re$/, 'er').replace(/ise$/, 'ize').replace(/ce$/, 'se')
    .replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/sch/g, 'sk').replace(/tch/g, 'ch').replace(/dg(?=[eiy])/g, 'j')
    .replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k').replace(/q/g, 'k').replace(/x/g, 'ks').replace(/z/g, 's')
    .replace(/gh(?![aeiou])/g, '').replace(/([^aeiou])h/g, '$1').replace(/v/g, 'f').replace(/th/g, '0').replace(/dt/g, 't');
  const first = s[0];
  s = first + s.slice(1).replace(/[aeiouyw]+/g, '');
  return s.replace(/(.)\1+/g, '$1');
}

function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

/** Book word vs heard word. */
export function same(a, b) {
  if (a === b) return true;
  if (ALIAS[b]?.includes(a) || ALIAS[a]?.includes(b)) return true;
  if (a.replace(/s$/, '') === b.replace(/s$/, '')) return true;
  const ka = sound(a), kb = sound(b);
  if (ka === kb) return true;
  // Names and rare words: close in sound, or close in spelling.
  if (Math.min(a.length, b.length) >= 4 && (lev(ka, kb) <= 1 || lev(a, b) / Math.max(a.length, b.length) <= 0.25)) return true;
  return false;
}

/** Word alignment (edit distance with sound-alike matches). Returns ops in reading order. */
export function align(book, heard) {
  const n = book.length, m = heard.length;
  const D = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = 0; i <= n; i++) D[i][0] = i;
  for (let j = 0; j <= m; j++) D[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      D[i][j] = Math.min(D[i - 1][j] + 1, D[i][j - 1] + 1, D[i - 1][j - 1] + (same(book[i - 1], heard[j - 1]) ? 0 : 1));
    }
  }
  const ops = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && D[i][j] === D[i - 1][j - 1] + (same(book[i - 1], heard[j - 1]) ? 0 : 1)) {
      ops.push({ op: same(book[i - 1], heard[j - 1]) ? 'eq' : 'sub', book: book[i - 1], heard: heard[j - 1] });
      i--; j--;
    } else if (i > 0 && D[i][j] === D[i - 1][j] + 1) {
      ops.push({ op: 'del', book: book[--i] });
    } else {
      ops.push({ op: 'ins', heard: heard[--j] });
    }
  }
  return ops.reverse();
}

const content = (w) => !FUNCTION.has(w);

/**
 * @param {Set<string>} known  names from the whole manuscript (see namesIn) and the guide
 * @returns {{ok: boolean, problems: {type:'skipped'|'added'|'misread', words:string, heard?:string}[], runs: number[][], wer: number}}
 */
export function check(bookText, heardText, known = new Set()) {
  const toks = tokens(bookText);
  return judge(toks, align(toks.map((t) => t.w), words(heardText)), known);
}

/**
 * The rules, on an alignment already made: `toks` are one line's tokens and `ops` that line's
 * slice of the alignment (see align.js, which aligns a whole chapter at once).
 */
export function judge(toks, ops, known = new Set()) {
  const book = toks.map((t) => t.w);
  const names = new Set([...toks.filter((t) => t.name).map((t) => t.w), ...[...known].filter((w) => book.includes(w))]);
  const problems = [], runs = []; // runs[i] = [from, to) in ops for problems[i]
  let errs = 0;
  for (let k = 0; k < ops.length;) {
    const o = ops[k];
    if (o.op === 'eq') { k++; continue; }
    // A run of consecutive non-matching ops is one problem.
    let e = k;
    while (e < ops.length && ops[e].op !== 'eq') e++;
    const run = ops.slice(k, e);
    errs += run.length;
    const missing = run.filter((x) => x.op === 'del' || x.op === 'sub').map((x) => x.book);
    const extra = run.filter((x) => x.op === 'ins' || x.op === 'sub').map((x) => x.heard);
    const dels = run.filter((x) => x.op === 'del').map((x) => x.book);
    const ins = run.filter((x) => x.op === 'ins').map((x) => x.heard);
    const subs = run.filter((x) => x.op === 'sub');
    // A word said twice is a stutter, even a small one ("as dead as as"): the listener does
    // not invent those, so it is never forgiven below.
    const doubled = run.some((x, t) => x.op === 'ins' && (ops[k + t - 1]?.heard === x.heard || ops[k + t + 1]?.heard === x.heard));

    // Compounds: "door-nail" in the book, "doornail" in the transcript, or "ironmongery"
    // heard as "iron mongering". Spacing is the listener's choice, not the narrator's. Only a
    // real merge or split counts (two words heard as one, or one as two).
    if (missing.length && extra.length && missing.length !== extra.length && same(missing.join(''), extra.join(''))) { k = e; continue; }

    // Names: the listener has never heard "Dejah Thoris" and writes "Digiothorus". If every
    // book word in the run is a name and something was heard in its place, it is a matter
    // for the pronunciation guide, not a narration error. A respelled name ("Sar-koh-ja") is
    // several words by the time it is spoken, so allow for that.
    if (missing.length && missing.every((w) => names.has(w)) && extra.length && extra.length <= 2 * missing.length + 2) { k = e; continue; }

    // When the listener splits a name ("Tars Tarkas" as "Tar's Tar Cuss"), a spare piece can
    // land in a run of its own beside the name. Forgiven only if it sounds like that name.
    const name = [ops[k - 1]?.book, ops[e]?.book].filter((w) => w && names.has(w));
    const piece = (w) => name.some((n) => same(w, n) || n.slice(0, 3) === w.slice(0, 3));
    if (!missing.length && !doubled && ins.length <= 2 && name.length && ins.every(piece)) { k = e; continue; }

    // A word split in two where the alignment matched only half: "Decameron" heard as
    // "de Cameron", with "cameron" already matched. The stray piece plus its neighbour spell it.
    const prev = ops[k - 1], next = ops[e];
    const rejoins = (w) => (next?.op === 'eq' && same(next.book, w + next.heard)) || (prev?.op === 'eq' && same(prev.book, prev.heard + w));
    if (!missing.length && !doubled && ins.length === 1 && rejoins(ins[0])) { k = e; continue; }

    const n = problems.length;
    if (dels.length >= 2 || dels.some(content)) problems.push({ type: 'skipped', words: dels.join(' ') });
    else if (ins.length >= 2 || ins.some(content) || doubled) problems.push({ type: 'added', words: ins.join(' ') });
    else if (subs.some((x) => content(x.book) || content(x.heard))) problems.push({ type: 'misread', words: missing.join(' '), heard: extra.join(' ') });
    if (problems.length > n) runs.push([k, e]);
    k = e;
  }
  return { ok: problems.length === 0, problems, runs, wer: book.length ? errs / book.length : 0 };
}

/**
 * The book's cast of characters and places: words it capitalises mid-sentence and never
 * writes in lower case. ("Mountains" in "the Rocky Mountains" is not a name if the book
 * also says "mountains", and a title-case contents page does not make "Through" one.)
 */
export function namesIn(text) {
  const lower = new Set(words(text.match(/(?<![\p{L}'’])\p{Ll}[\p{L}'’]*/gu)?.join(' ') ?? ''));
  const out = new Set();
  for (const t of tokens(text)) if (t.name && !lower.has(t.w)) out.add(t.w);
  return out;
}
