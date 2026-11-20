// From what the listener heard to the proof report. Each audio file is lined up with the
// manuscript (align.js), each manuscript line gets its slice of that alignment, and the
// checker's rules (compare.js judge) decide whether the line was read as written.

import { tokens, words, judge, namesIn } from './compare.js';
import { heading } from './narrate.js';
import { alignFile, bookKeys } from './align.js';
import { pronunciationList, pronunciationCheck } from './names.js';

export const LONG = 50; // words: the sentences an engine with a length limit is most likely to cut

/** The manuscript as the checker compares it: every word, and the line it belongs to. */
export function book(chapters) {
  const lines = [], all = [];
  let sentence = -1;
  chapters.forEach((ch, c) => {
    ch.lines.forEach((l, i) => {
      if (!l.part) sentence++;
      const text = l.kind === 'heading' ? heading(l.text) : l.text;
      const toks = tokens(text);
      lines.push({ n: lines.length, chapter: c, title: ch.title, i, kind: l.kind, text, toks, from: all.length, to: all.length + toks.length, sentence });
      for (const t of toks) all.push(t.w);
    });
  });
  const lineOf = new Int32Array(all.length);
  for (const L of lines) lineOf.fill(L.n, L.from, L.to);
  return { chapters: chapters.map((c) => c.title), lines, words: all, lineOf, keys: bookKeys(all) };
}

/**
 * A file's pieces -> one run of heard words, each with a time. Within a piece, time is shared out
 * by letters rather than by words, since long words take longer to say.
 */
export function heardWords(pieces) {
  const w = [], t = [];
  for (const p of pieces) {
    const ws = words(p.text), len = ws.map((x) => x.length + 2);
    const all = len.reduce((a, b) => a + b, 0);
    let at = 0;
    ws.forEach((x, k) => { w.push(x); t.push(p.start + ((p.end - p.start) * at) / Math.max(1, all)); at += len[k]; });
  }
  return { w, t };
}

const TYPE = (p) => (p.type === 'misread' ? (p.words.split(' ').length >= 3 ? 'garbled' : 'mispronounced') : p.type);

/**
 * @param {ReturnType<typeof book>} bk
 * @param {{name:string, pieces:{start:number, end:number, text:string}[]}[]} files  in order
 * @param {{known?: Set<string>, fullText?: string}} opts
 */
export function proof(bk, files, { known = new Set(), fullText = '' } = {}) {
  const runs = new Map(); // line -> [{file, ops}] in reading order
  const put = (n, file, ops) => {
    if (!runs.has(n)) runs.set(n, []);
    const r = runs.get(n);
    if (r.length && r.at(-1).file === file) r.at(-1).ops.push(...ops); else r.push({ file, ops: [...ops] });
  };
  const covered = new Uint8Array(bk.words.length);
  const when = new Map();
  const out = files.map((f, fi) => {
    const H = heardWords(f.pieces);
    const a = alignFile(bk.words, H.w, bk.keys);
    const res = { name: f.name, heard: H, from: a?.from ?? -1, to: a?.to ?? -1, matched: !!a, extraHead: '', extraTail: '' };
    if (!a) return res;
    covered.fill(1, a.from, a.to);
    // Words heard before the book starts or after it ends (credits, a retail sample) are reported
    // once for the file, not charged to a line.
    let s = 0, e = a.ops.length;
    while (s < e && a.ops[s].op === 'ins') s++;
    while (e > s && a.ops[e - 1].op === 'ins') e--;
    res.extraHead = a.ops.slice(0, s).map((o) => H.w[o.hj]).join(' ');
    res.extraTail = a.ops.slice(e).map((o) => H.w[o.hj]).join(' ');
    // Extra words between two lines belong to the line they come before. Every book word gets a
    // time: its own if it was heard, else that of the last word heard before it.
    const body = a.ops.slice(s, e);
    let pending = [], last = H.t[body.find((o) => o.hj !== undefined)?.hj] ?? 0;
    res.first = last;
    for (const o of body) {
      if (o.hj !== undefined) last = H.t[o.hj];
      if (o.bi === undefined) { pending.push(o); continue; }
      when.set(o.bi, last);
      put(bk.lineOf[o.bi], fi, [...pending, o]);
      pending = [];
    }
    res.last = last;
    return res;
  });

  // Chapters with no audio at all are reported as such. Words missing from the edges of the
  // files in a chapter that does have audio were skipped.
  const chapterHas = new Set();
  for (const L of bk.lines) for (let w = L.from; w < L.to; w++) if (covered[w]) { chapterHas.add(L.chapter); break; }
  // A missing word is charged to the nearest file that covers its chapter.
  const chapterSpan = new Map();
  for (const L of bk.lines) { const c = chapterSpan.get(L.chapter) ?? [L.from, L.to]; chapterSpan.set(L.chapter, [Math.min(c[0], L.from), Math.max(c[1], L.to)]); }
  const nearest = (w, chapter) => {
    const [c0, c1] = chapterSpan.get(chapter);
    let best = -1, d = Infinity;
    out.forEach((f, fi) => {
      if (!f.matched || f.to <= c0 || f.from >= c1) return;
      const dd = w < f.from ? f.from - w : w >= f.to ? w - f.to + 1 : 0;
      if (dd < d) { d = dd; best = fi; }
    });
    return best;
  };
  for (const L of bk.lines) {
    if (!chapterHas.has(L.chapter)) continue;
    for (let w = L.from; w < L.to; w++) {
      if (covered[w]) continue;
      const fi = nearest(w, L.chapter);
      when.set(w, w < out[fi].from ? out[fi].first : out[fi].last);
      const r = runs.get(L.n) ?? [];
      // Keep book order: before the first run that starts after this word, or at the end.
      const at = r.findIndex((x) => x.ops.some((o) => o.bi !== undefined && o.bi > w));
      const piece = { file: fi, ops: [{ op: 'del', bi: w }] };
      if (at < 0) r.push(piece); else r.splice(at, 0, piece);
      runs.set(L.n, r);
    }
  }

  // A line that stops early can end with its last word paired with the next line's first extra
  // word ("shoulder" with "quote"). Give that word back to the next line.
  for (const L of bk.lines) {
    const r = runs.get(L.n), next = runs.get(L.n + 1);
    if (!r || !next || next[0].file !== r.at(-1).file) continue;
    const last = r.at(-1).ops, o = last.at(-1);
    if (o?.op !== 'sub' || last.at(-2)?.op !== 'del' || last.at(-3)?.op !== 'del') continue;
    last[last.length - 1] = { op: 'del', bi: o.bi };
    next[0].ops.unshift({ op: 'ins', hj: o.hj });
  }

  const timeOf = (fi, ops) => {
    const H = out[fi]?.heard;
    if (!H) return null;
    for (const o of ops) if (o.hj !== undefined) return H.t[o.hj];
    return null;
  };

  const lines = bk.lines.map((L) => {
    const r = runs.get(L.n);
    if (!r) return { ...L, inAudio: false };
    const ops = r.flatMap((x) => x.ops.map((o) => ({ ...o, file: x.file })));
    const flat = ops.map((o) => ({ op: o.op, book: bk.words[o.bi], heard: o.hj !== undefined ? out[o.file].heard.w[o.hj] : undefined }));
    const v = judge(L.toks, flat, known);
    const file = r.find((x) => x.ops.some((o) => o.hj !== undefined))?.file ?? r[0].file;
    // Nothing heard for this line: point at where it should have been.
    const t = timeOf(file, ops) ?? when.get(L.from) ?? 0;
    const problems = v.problems.map((p, k) => {
      const [a, b] = v.runs[k];
      const first = ops.slice(a, b).find((o) => o.bi !== undefined);
      return { type: TYPE(p), words: p.words, heard: p.heard, t: timeOf(ops[a]?.file ?? file, ops.slice(a, b)) ?? (first ? when.get(first.bi) : null) ?? t, from: a, to: b };
    });
    return { ...L, inAudio: true, ops, ok: v.ok, problems, file, t, heard: flat.filter((o) => o.heard).map((o) => o.heard).join(' ') };
  });

  // Sentences that stop early: three or more words never said at the end, after the narrator
  // had said some of it. The unsaid end may hold a mismatch or two (the alignment can pair the
  // last word with the next sentence's first) and one word matched by chance, as long as at
  // least half of it is plainly missing.
  const sentences = new Map();
  for (const L of lines) if (L.inAudio) { if (!sentences.has(L.sentence)) sentences.set(L.sentence, []); sentences.get(L.sentence).push(L); }
  const cut = [];
  for (const group of sentences.values()) {
    const ops = group.flatMap((L) => L.ops.filter((o) => o.op !== 'ins').map((o) => ({ ...o, L })));
    const total = ops.length;
    let k = ops.length, chance = 0;
    while (k > 0) {
      if (ops[k - 1].op !== 'eq') { k--; continue; }
      // One lone matched word ("the", "and") inside a long unsaid end does not end it.
      if (!chance && total - k >= 3 && k > 1 && ops[k - 2].op !== 'eq') { chance++; k--; continue; }
      break;
    }
    const dels = ops.slice(k).filter((o) => o.op === 'del').length;
    if (dels < 3 || k < 2 || dels * 2 < total - k) continue;
    const at = ops[k];
    cut.push({ line: at.L.n, said: k, of: total, long: total > LONG });
    for (const L of group) {
      for (const p of L.problems) {
        if (p.type !== 'skipped') continue;
        const firstDel = L.ops.slice(p.from, p.to).find((o) => o.op === 'del');
        if (firstDel && firstDel.bi >= at.bi) { p.type = 'cut short'; p.said = k; p.of = total; }
      }
    }
  }

  // The pronunciation list, checked against what was heard where each entry occurs.
  const wordAt = new Map();
  for (const L of lines) if (L.inAudio) for (const o of L.ops) if (o.bi !== undefined) wordAt.set(o.bi, o);
  const heardAt = (pos, n) => {
    const os = [];
    for (let w = pos; w < pos + n; w++) { const o = wordAt.get(w); if (!o) return null; os.push(o); }
    const f = out[os[0].file];
    // Include extra pieces heard inside the name ("Tar's Tar Cuss").
    const L = lines[bk.lineOf[pos]];
    const i0 = L.ops.indexOf(os[0]), i1 = L.ops.indexOf(os.at(-1));
    const span = i1 >= i0 ? L.ops.slice(i0, i1 + 1) : os; // a name split across two lines
    const text = span.filter((o) => o.hj !== undefined).map((o) => out[o.file].heard.w[o.hj]).join(' ');
    return { text, t: timeOf(os[0].file, span) ?? L.t, file: f?.name };
  };
  const names = fullText ? pronunciationCheck(pronunciationList(bk.lines, fullText), heardAt) : [];

  const longSentences = [...sentences.values()].map((g) => ({ line: g[0].n, words: g.reduce((s, L) => s + L.toks.length, 0) })).filter((s) => s.words > LONG);
  const chapters = bk.chapters.map((title, c) => ({ title, audio: chapterHas.has(c) }));
  return { files: out.map(({ heard, ...f }) => ({ ...f, words: heard.w.length })), lines, cut, longSentences, chapters, names };
}
