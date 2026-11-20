// The proof report as words: one row per thing to listen to, for the page, a CSV and a page
// to print.

import { RETAILERS } from './levels.js';

export const LABELS = { skipped: 'Skipped', added: 'Added', mispronounced: 'Mispronounced', garbled: 'Garbled', 'cut short': 'Cut short', 'no audio': 'No audio', 'no match': 'No match' };

/** 75.4 -> "1:15", 3725 -> "1:02:05". */
export function clock(s) {
  const t = Math.max(0, Math.floor(s ?? 0)), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export function describe(p) {
  if (p.type === 'skipped') return `Not said: “${p.words}”`;
  if (p.type === 'added') return `Said but not in the book: “${p.words}”`;
  if (p.type === 'mispronounced') return `Heard “${p.heard}” where the book says “${p.words}”`;
  if (p.type === 'garbled') return `Unclear: heard “${p.heard}” for “${p.words}”`;
  if (p.type === 'cut short') return `Sentence stops early: ${p.said} of ${p.of} words said`;
  return p.words;
}

/**
 * Everything worth a listen, in the order of the audio.
 * @returns {{kind:'line'|'name'|'coverage', type:string, file:string, t:number|null, chapter:string, line:number|null, what:string, book:string, heard:string}[]}
 */
export function rows(report, fileNames) {
  const out = [];
  for (const L of report.lines) {
    if (!L.inAudio || L.ok) continue;
    for (const p of L.problems) {
      out.push({ kind: 'line', type: p.type, file: fileNames[L.file] ?? '', t: p.t, chapter: L.title, line: L.i + 1, what: describe(p), book: L.text, heard: L.heard });
    }
  }
  // A name said unlike its other occurrences. (A name not said at all is already a skipped line.)
  for (const e of report.names) {
    for (const f of e.flags) {
      if (f.why !== 'said differently here') continue;
      const L = report.lines.find((x) => f.pos >= x.from && f.pos < x.to);
      out.push({ kind: 'name', type: 'mispronounced', file: f.file ?? '', t: f.t, chapter: L?.title ?? '', line: L ? L.i + 1 : null, what: `“${e.say}” said differently here: heard “${f.text}”`, book: L?.text ?? e.say, heard: f.text });
    }
  }
  const order = new Map(fileNames.map((n, i) => [n, i]));
  out.sort((a, b) => (order.get(a.file) ?? 0) - (order.get(b.file) ?? 0) || (a.t ?? 0) - (b.t ?? 0));
  for (const c of report.chapters) if (!c.audio) out.push({ kind: 'coverage', type: 'no audio', file: '', t: null, chapter: c.title, line: null, what: 'No audio file covers this chapter', book: '', heard: '' });
  for (const f of report.files) if (!f.matched) out.push({ kind: 'coverage', type: 'no match', file: f.name, t: null, chapter: '', line: null, what: 'This file does not match the manuscript', book: '', heard: '' });
  return out;
}

// A cell that starts with = + - @ is a formula to a spreadsheet; a leading apostrophe keeps it text.
const cell = (v) => {
  const s = String(v ?? '');
  return `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
};

export function csv(report, fileNames, levels = []) {
  const head = ['File', 'Time', 'Issue', 'What', 'Chapter', 'Line', 'Book text', 'Heard'];
  const body = rows(report, fileNames).map((r) => [r.file, r.t === null ? '' : clock(r.t), LABELS[r.type] ?? r.type, r.what, r.chapter, r.line ?? '', r.book, r.heard]);
  for (const f of levels) for (const c of f.checks) if (c.level !== 'pass') body.push([f.name, '', `${RETAILERS[c.retailer].name} ${c.level === 'fail' ? 'fails' : 'warns'}`, `${c.check}: ${c.value}, needs ${c.need}`, '', '', '', '']);
  return [head, ...body].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** A standalone page to print or keep. */
export function printable(report, fileNames, levels = [], title = 'Manuscript') {
  const list = rows(report, fileNames);
  const counts = {};
  for (const r of list) if (r.kind === 'line') counts[r.type] = (counts[r.type] ?? 0) + 1;
  const checked = report.lines.filter((L) => L.inAudio).length;
  const flagged = report.lines.filter((L) => L.inAudio && !L.ok).length;
  const issueRows = list.map((r) => `<tr><td>${esc(r.file)}</td><td>${r.t === null ? '' : clock(r.t)}</td><td>${esc(LABELS[r.type] ?? r.type)}</td><td>${esc(r.what)}${r.book && r.kind === 'line' ? `<div class="book">${esc(r.book)}</div>` : ''}</td></tr>`).join('');
  const levelRows = levels.flatMap((f) => f.checks.map((c) => `<tr class="${c.level}"><td>${esc(f.name)}</td><td>${esc(RETAILERS[c.retailer].name)}</td><td>${esc(c.check)}</td><td>${esc(c.value)}</td><td>${esc(c.need)}</td><td>${c.level}</td></tr>`)).join('');
  const nameRows = report.names.filter((e) => e.heard.length).map((e) => `<tr><td>${esc(e.say)}</td><td>${e.kind}</td><td>${e.at.length}</td><td>${esc(e.ways.map(([w, n]) => `${w} ×${n}`).join(', '))}</td><td>${e.flags.length ? esc(e.flags.map((f) => `${f.why} ${f.file ?? ''} ${clock(f.t)}`).join('; ')) : ''}</td></tr>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Proof report: ${esc(title)}</title>
<style>
body { font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: #141a22; background: #fff; margin: 0; padding: 24px 16px; }
main { max-width: 900px; margin: 0 auto; }
h1 { font: 600 26px/1.2 Georgia, serif; margin: 0 0 4px; }
h2 { font: 600 18px/1.2 Georgia, serif; margin: 28px 0 8px; }
p { margin: 0 0 8px; }
.muted, .book { color: #5b6574; }
.book { font-family: Georgia, serif; font-size: 13px; margin-top: 2px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; vertical-align: top; padding: 6px 8px; border-bottom: 1px solid #dde2e9; }
th { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: #5b6574; }
tr.fail td:last-child { color: #b3261e; font-weight: 600; }
tr.warn td:last-child { color: #b86e00; font-weight: 600; }
.wrap { overflow-x: auto; }
@media print { body { padding: 0; } h2 { break-after: avoid; } tr { break-inside: avoid; } }
</style></head><body><main>
<h1>Proof report: ${esc(title)}</h1>
<p class="muted">AuthorVoice Proof. ${checked} lines heard in ${report.files.length} file${report.files.length === 1 ? '' : 's'}, ${flagged} to check${Object.keys(counts).length ? `: ${Object.entries(counts).map(([k, n]) => `${n} ${(LABELS[k] ?? k).toLowerCase()}`).join(', ')}` : ''}. Checked on this device by an open speech recogniser. It cannot judge performance, and it cannot spell names it has never heard, so give names a listen.</p>
<h2>Lines to check</h2>
${list.length ? `<div class="wrap"><table><thead><tr><th>File</th><th>Time</th><th>Issue</th><th>What</th></tr></thead><tbody>${issueRows}</tbody></table></div>` : '<p>Every line was heard as written.</p>'}
${nameRows ? `<h2>Pronunciation list</h2><div class="wrap"><table><thead><tr><th>Word</th><th>Kind</th><th>Times</th><th>Heard as</th><th>Listen to</th></tr></thead><tbody>${nameRows}</tbody></table></div>` : ''}
${levelRows ? `<h2>Audio levels</h2><div class="wrap"><table><thead><tr><th>File</th><th>Retailer</th><th>Check</th><th>Measured</th><th>Needs</th><th></th></tr></thead><tbody>${levelRows}</tbody></table></div>` : ''}
</main></body></html>`;
}
