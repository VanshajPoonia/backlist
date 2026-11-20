// A manuscript -> chapters -> the lines the narrator reads, one at a time.
//
// A "line" is a sentence, or a piece of one: Kokoro reads at most 510 phoneme tokens in one
// go and silently drops the rest, and a Victorian sentence can run past that. Long
// sentences are split at their own commas and semicolons, well short of the limit.

const ABBREV = new Set(['mr', 'mrs', 'ms', 'dr', 'st', 'mt', 'jr', 'sr', 'prof', 'capt', 'col', 'gen', 'lt', 'sgt', 'rev', 'hon',
  'gov', 'sen', 'rep', 'no', 'nos', 'vs', 'etc', 'esq', 'messrs', 'mme', 'mlle', 'fr', 'vol', 'ch', 'fig', 'co', 'inc', 'ltd',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'i.e', 'e.g', 'viz', 'cf', 'p', 'pp', 'ft']);

export const MAX_WORDS = 50; // ~285 phoneme tokens typically, ~425 for the densest 1% of prose; the limit is 510

const HEADING = /^\s*(?:#{1,3}\s+.+|(?:chapter|stave|part|book|prologue|epilogue|interlude|afterword|foreword)\b[^\n]{0,80})\s*$/i;
const BREAK = /^\s*(?:\*\s*){3,}\s*$|^\s*(?:[#~•]\s*){1,3}\s*$|^\s*-{3,}\s*$/;

/** Drop Project Gutenberg's licence header and footer, if this came from there. */
export function stripGutenberg(text) {
  const start = text.match(/\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG[^\n]*\n/i);
  const end = text.match(/\n[^\n]*\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG/i);
  return text.slice(start ? start.index + start[0].length : 0, end ? end.index : undefined);
}

/** Sentence boundaries in one paragraph. */
export function sentences(para) {
  const out = [];
  let from = 0;
  const re = /[.!?…]+["'”’)\]]*(?=\s+["'“‘(\[]?[A-Z0-9]|\s*$)/g;
  for (const m of para.matchAll(re)) {
    const end = m.index + m[0].length;
    const word = para.slice(from, m.index + 1).match(/(\S+)$/)?.[1] ?? '';
    const bare = word.replace(/^["'“‘(]+/, '').replace(/\.$/, '').toLowerCase();
    if (para[m.index] === '.' && m[0] === '.' && (ABBREV.has(bare) || /^[a-z]$/i.test(bare) || /^(?:[a-z]\.)+[a-z]$/i.test(bare))) continue;
    const s = para.slice(from, end).trim();
    if (s) out.push(s);
    from = end;
  }
  const rest = para.slice(from).trim();
  if (rest) out.push(rest);
  return out;
}

/** A sentence too long for one breath -> pieces at its own punctuation, each <= MAX_WORDS. */
export function pieces(sentence, max = MAX_WORDS) {
  const n = sentence.split(/\s+/).length;
  if (n <= max) return [sentence];
  // Best cut nearest the middle: after ";" or ":" or a dash, else after ",".
  const mid = sentence.length / 2;
  let best = -1;
  for (const re of [/[;:]\s|\u2014\s?|\s\u2013\s/g, /,\s/g]) {
    for (const m of sentence.matchAll(re)) {
      const i = m.index + m[0].length;
      const left = sentence.slice(0, i).split(/\s+/).length;
      if (left < 6 || n - left < 6) continue;
      if (best === -1 || Math.abs(i - mid) < Math.abs(best - mid)) best = i;
    }
    if (best !== -1) break;
  }
  if (best === -1) {
    // No punctuation to use: cut at the middle word.
    const w = sentence.split(/\s+/);
    return [...pieces(w.slice(0, Math.ceil(n / 2)).join(' '), max), ...pieces(w.slice(Math.ceil(n / 2)).join(' '), max)];
  }
  return [...pieces(sentence.slice(0, best).trim(), max), ...pieces(sentence.slice(best).trim(), max)];
}

/**
 * @returns {{title:string, lines:{text:string, kind:'heading'|'line', pause:number, part?:number}[]}[]}
 * `pause` is the silence after the line, in seconds. `part` counts the pieces of a long sentence.
 */
export function parse(raw) {
  const text = stripGutenberg(raw).replace(/\r\n?/g, '\n');
  const blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const chapters = [];
  let ch = null;
  const open = (title) => { ch = { title, lines: [] }; chapters.push(ch); };

  for (let k = 0; k < blocks.length; k++) {
    const b = blocks[k];
    if (b.startsWith('[') && b.endsWith(']')) continue; // [Illustration] and the like
    if (BREAK.test(b)) { if (ch?.lines.length) ch.lines.at(-1).pause = 1.6; continue; }
    const firstLine = b.split('\n')[0];
    const lines = b.split('\n');
    // A table of contents: several heading-like lines in one block. Not read aloud.
    if (/^\s*contents\s*$/i.test(firstLine) || (lines.length > 3 && lines.filter((l) => HEADING.test(l)).length >= 2)) continue;
    if (HEADING.test(firstLine) && firstLine.length < 90) {
      // A heading, often with its subtitle on the next line ("CHAPTER IV" / "A PRISONER").
      const parts = b.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).filter(Boolean);
      const join = (a, b) => (/[.!?:]$/.test(a) ? `${a} ${b}` : `${a}. ${b}`);
      let title = parts.reduce(join);
      const next = blocks[k + 1];
      if (parts.length === 1 && next && next.length < 60 && !/[a-z]{3}.*[.!?]$/.test(next) && next === next.toUpperCase()) { title = join(title, next); k++; }
      open(title);
      ch.lines.push({ text: title, kind: 'heading', pause: 1.2 });
      continue;
    }
    if (!ch) open('Opening');
    const para = b.replace(/\s*\n\s*/g, ' ');
    const ss = sentences(para);
    ss.forEach((s, i) => {
      const ps = pieces(s);
      ps.forEach((p, j) => ch.lines.push({ text: p, kind: 'line', pause: j < ps.length - 1 ? 0.12 : i < ss.length - 1 ? 0.35 : 0.8, part: j }));
    });
  }
  return chapters.filter((c) => c.lines.some((l) => l.kind === 'line'));
}
