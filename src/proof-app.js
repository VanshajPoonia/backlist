import { parse } from './manuscript.js';
import { namesIn } from './compare.js';
import { probe, fileReader } from './probe.js';
import { slices } from './decode.js';
import { listenFile } from './segment.js';
import { judge, judgeBook, RETAILERS } from './levels.js';
import { book, proof, LONG } from './proof.js';
import { pronunciationList } from './names.js';
import { manuscriptText } from './ebook.js';
import { rows, csv, printable, clock, LABELS } from './report.js';
import './isolate.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const kbps = (b) => `${Math.round(b / 1000)} kbps`;

const SAMPLE = { text: 'data/samples/mars.txt', audio: 'data/samples/mars-narrated.mp3', name: 'mars-chapter-11.mp3' };

// ---------- the listener, in a worker ----------------------------------------------------------

const worker = new Worker(new URL('./worker.js?role=ear', import.meta.url), { type: 'module' });
const pending = new Map();
let seq = 0, onLoad = null, loading = null;
worker.onmessage = ({ data }) => {
  if (data.type === 'progress') { onLoad?.(data.p); return; }
  const p = pending.get(data.id);
  if (!p) return;
  pending.delete(data.id);
  if (data.error) p.reject(new Error(data.error)); else p.resolve(data);
};
worker.onerror = (e) => { for (const p of pending.values()) p.reject(new Error(e.message || 'the listener stopped')); pending.clear(); };
const call = (msg, transfer = []) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); worker.postMessage({ ...msg, id }, transfer); });
const loadListener = (cb) => { onLoad = cb; loading ??= call({ type: 'load' }).catch((e) => { loading = null; throw e; }); return loading; };
const hear = async (audio) => (await call({ type: 'hear', audio, rate: 16000 }, [audio.buffer])).text;

// ---------- the manuscript ---------------------------------------------------------------------

let text = '', bookName = '';
function setText(t) {
  text = t;
  const chapters = parse(t);
  const n = chapters.reduce((s, c) => s + c.lines.length, 0);
  const names = chapters.length ? pronunciationList(book(chapters).lines, t).filter((e) => e.kind === 'name').slice(0, 6).map((e) => e.say) : [];
  $('#book-status').textContent = chapters.length
    ? `${chapters.length} chapter${chapters.length > 1 ? 's' : ''}, ${n} lines.${names.length ? ` Names it will listen for: ${names.join(', ')}…` : ''}`
    : '';
  ready();
}
let typing = null;
$('#text').addEventListener('input', () => { clearTimeout(typing); bookName = ''; typing = setTimeout(() => setText($('#text').value), 300); });

async function readBook(file) {
  try {
    if (file.name.toLowerCase().endsWith('.docx') && !window.mammoth) {
      await new Promise((res, rej) => document.head.append(Object.assign(document.createElement('script'), { src: 'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js', onload: res, onerror: () => rej(new Error('could not load the .docx reader')) })));
    }
    const t = await manuscriptText(file.name, new Uint8Array(await file.arrayBuffer()), window.mammoth);
    $('#text').value = t;
    bookName = file.name.replace(/\.[^.]+$/, '');
    setText(t);
  } catch (err) {
    $('#book-status').textContent = `Could not read ${file.name}: ${err.message}`;
  }
}

// ---------- the audio --------------------------------------------------------------------------

let files = []; // {file, info, url}
const order = (a, b) => a.file.name.localeCompare(b.file.name, undefined, { numeric: true, sensitivity: 'base' });

async function addAudio(list) {
  $('#audio-status').textContent = 'Reading the files…';
  for (const file of list) {
    if (files.some((f) => f.file.name === file.name && f.file.size === file.size)) continue;
    try {
      files.push({ file, info: await probe(fileReader(file)) });
    } catch (err) {
      files.push({ file, info: { format: 'unknown', error: err.message } });
    }
  }
  files.sort(order);
  showFiles();
}

function showFiles() {
  $('#files').innerHTML = files.map(({ file, info }, i) => `<li>
    <span class="fname">${esc(file.name)}</span>
    <span class="small">${info.error ? esc(info.error) : [info.seconds ? clock(info.seconds) : '', info.format.toUpperCase(), info.sampleRate ? `${info.sampleRate / 1000} kHz` : '', info.channels === 1 ? 'mono' : info.channels ? 'stereo' : '', info.bitrate ? kbps(info.bitrate) : ''].filter(Boolean).join(' · ')}</span>
    <button class="secondary chip" data-remove="${i}" aria-label="Remove ${esc(file.name)}">Remove</button>
  </li>`).join('');
  const total = files.reduce((s, f) => s + (f.info.seconds ?? 0), 0);
  $('#audio-status').textContent = files.length
    ? `${files.length} file${files.length > 1 ? 's' : ''}, ${clock(total)} in all. Checked in this order.`
    : 'Files are checked in name order, so chapter-02 comes before chapter-10.';
  ready();
}
$('#files').addEventListener('click', (e) => {
  const b = e.target.closest('[data-remove]');
  if (!b) return;
  files.splice(Number(b.dataset.remove), 1);
  showFiles();
});

function dropZone(zone, input, take) {
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('over'); if (e.dataTransfer.files.length) take([...e.dataTransfer.files]); });
  input.addEventListener('change', () => { if (input.files.length) take([...input.files]); input.value = ''; });
}
dropZone($('#book-drop'), $('#book-file'), (fs) => readBook(fs[0]));
dropZone($('#audio-drop'), $('#audio-file'), addAudio);

$('#sample').addEventListener('click', async () => {
  const b = $('#sample');
  b.disabled = true;
  try {
    const [t, audio] = await Promise.all([fetch(SAMPLE.text).then((r) => r.text()), fetch(SAMPLE.audio).then((r) => r.blob())]);
    $('#text').value = t;
    bookName = 'A Princess of Mars, chapter XI (sample)';
    setText(t);
    files = [];
    await addAudio([new File([audio], SAMPLE.name, { type: 'audio/mpeg' })]);
    b.setAttribute('aria-pressed', 'true');
  } catch (err) {
    $('#book-status').textContent = `Could not load the sample: ${err.message}`;
  } finally {
    b.disabled = false;
  }
});

const ready = () => { $('#go').disabled = !(text.trim() && files.length && files.every((f) => !f.info.error)); };

// ---------- checking ---------------------------------------------------------------------------

let report = null, done = [];
$('#go').addEventListener('click', async () => {
  const go = $('#go'), bar = $('#bar');
  go.disabled = true;
  bar.hidden = false;
  bar.value = 0;
  $('#report').hidden = true;
  try {
    $('#status').textContent = 'Loading the listener…';
    await loadListener((p) => { bar.value = p; $('#status').textContent = `Downloading the listener (once)… ${Math.round(p * 100)}%`; });
    const bk = book(parse(text));
    const total = files.reduce((s, f) => s + (f.info.seconds ?? 0), 0) || 1;
    let before = 0;
    const t0 = performance.now();
    done = [];
    for (const f of files) {
      const show = (t) => {
        bar.value = Math.min(1, (before + t) / total);
        $('#status').textContent = `Listening to ${f.file.name}: ${clock(t)} of ${clock(f.info.seconds)}`;
      };
      show(0);
      const { pieces, stats } = await listenFile(slices(f.file, f.info), hear, show);
      done.push({ name: f.file.name, file: f.file, info: f.info, pieces, stats, checks: stats ? judge(f.info, stats) : [] });
      before += f.info.seconds ?? 0;
    }
    $('#status').textContent = 'Lining the audio up with the manuscript…';
    report = proof(bk, done, { known: namesIn(text), fullText: text });
    const secs = (performance.now() - t0) / 1000;
    $('#status').textContent = `Done: ${clock(total)} of audio in ${clock(secs)} (${(total / secs).toFixed(1)}x real time).`;
    render();
  } catch (err) {
    console.error(err);
    $('#status').textContent = `Something went wrong: ${err.message}`;
  } finally {
    bar.hidden = true;
    ready();
  }
});

// ---------- the report -------------------------------------------------------------------------

let filter = 'all';
const names = () => done.map((d) => d.name);
const play = (fi, t) => `<button class="play" data-file="${fi}" data-t="${t ?? 0}" aria-label="Play ${esc(done[fi]?.name ?? '')} from ${clock(t)}">▶ ${clock(t)}</button>`;

function render() {
  const list = rows(report, names());
  const lineRows = list.filter((r) => r.kind !== 'coverage');
  const checked = report.lines.filter((L) => L.inAudio).length;
  const flagged = report.lines.filter((L) => L.inAudio && !L.ok).length;
  const audio = done.reduce((s, d) => s + (d.stats?.seconds ?? 0), 0);
  $('#summary').textContent = flagged ? `${flagged} of ${checked} lines to check.` : checked ? `All ${checked} lines were heard as written.` : 'None of the audio matched the manuscript.';
  $('#summary-small').textContent = flagged
    ? `Listen to these instead of all ${clock(audio)}. Each one plays from just before the problem.`
    : 'The listener cannot judge performance or spell names it has never heard, so look over the pronunciation list too.';

  const notes = [];
  const silent = report.chapters.filter((c) => !c.audio).map((c) => `<strong>${esc(c.title)}</strong>`);
  if (silent.length) notes.push(`No audio covers ${silent.length > 4 ? `${silent.length} chapters, including ${silent.slice(0, 3).join(', ')}` : silent.join(', ')}. Those are skipped, not flagged.`);
  report.files.forEach((f, i) => {
    if (!f.matched) notes.push(`<strong>${esc(f.name)}</strong> does not match the manuscript.`);
    if (f.extraHead) notes.push(`${play(i, 0)} Before the book starts, <strong>${esc(f.name)}</strong> says “${esc(f.extraHead.slice(0, 160))}”. Fine if that is your opening credits.`);
    if (f.extraTail) notes.push(`${play(i, f.last)} After the book ends, <strong>${esc(f.name)}</strong> says “${esc(f.extraTail.slice(0, 160))}”. Fine if that is your closing credits.`);
  });
  $('#notes').innerHTML = notes.map((n) => `<p class="note">${n}</p>`).join('');

  const counts = {};
  for (const r of lineRows) counts[r.type] = (counts[r.type] ?? 0) + 1;
  const types = Object.keys(LABELS).filter((k) => counts[k]);
  if (filter !== 'all' && !counts[filter]) filter = 'all';
  $('#types').innerHTML = lineRows.length
    ? [`<button class="chip" data-type="all" aria-pressed="${filter === 'all'}">All ${lineRows.length}</button>`, ...types.map((k) => `<button class="chip" data-type="${k}" aria-pressed="${filter === k}">${LABELS[k]} ${counts[k]}</button>`)].join('')
    : '';
  const fileIndex = new Map(names().map((n, i) => [n, i]));
  $('#issues').innerHTML = lineRows.filter((r) => filter === 'all' || r.type === filter).map((r) => `<li class="line flagged issue-row">
    <span class="badge ${r.type.replace(' ', '-')}">${esc(LABELS[r.type] ?? r.type)}</span>
    <div class="what"><p>${esc(r.what)}</p>${r.book ? `<p class="booktext">${esc(r.book)}</p>` : ''}${r.heard && r.kind === 'line' ? `<p class="heard small">Heard: <q>${esc(r.heard)}</q></p>` : ''}
      <p class="small">${esc(r.file)}${r.chapter ? ` · ${esc(r.chapter)}` : ''}${r.line ? `, line ${r.line}` : ''}</p></div>
    ${play(fileIndex.get(r.file) ?? 0, r.t)}
  </li>`).join('') || '<li class="empty">Nothing to check.</li>';

  renderNames();
  const longCut = report.cut.filter((c) => c.long).length;
  $('#long').textContent = report.longSentences.length
    ? `${report.longSentences.length} sentence${report.longSentences.length > 1 ? 's are' : ' is'} over ${LONG} words, where engines with a length limit tend to stop early. ${longCut ? `${longCut} of them stopped early (listed above as cut short).` : 'All of them were read to the end.'}${report.cut.length > longCut ? ` ${report.cut.length - longCut} shorter sentence${report.cut.length - longCut > 1 ? 's' : ''} also stopped early.` : ''}`
    : `No sentence is over ${LONG} words.${report.cut.length ? ` ${report.cut.length} sentence${report.cut.length > 1 ? 's' : ''} stopped early anyway (listed above).` : ''}`;
  renderLevels();
  $('#report').hidden = false;
}

function renderNames() {
  const fileIndex = new Map(names().map((n, i) => [n, i]));
  const shown = report.names.filter((e) => e.heard.length).slice(0, 60);
  const kind = { name: 'Name', foreign: 'Foreign word', heteronym: 'Two ways to say it' };
  $('#names').innerHTML = shown.length ? `<div class="table"><table>
    <thead><tr><th>Word</th><th>Times</th><th>Heard as</th><th>Listen</th></tr></thead>
    <tbody>${shown.map((e) => {
      const flags = e.flags.filter((f) => f.why !== 'not said');
      const listen = e.kind === 'heteronym' ? e.heard.slice(0, 4) : flags;
      return `<tr class="${flags.length ? 'warn' : ''}"><td><strong>${esc(e.say)}</strong><br><span class="small">${kind[e.kind]}</span></td><td>${e.heard.length}</td>
        <td>${esc(e.ways.slice(0, 4).map(([w, n]) => (n > 1 ? `${w} ×${n}` : w)).join(', '))}</td>
        <td>${listen.map((f) => `${play(fileIndex.get(f.file) ?? 0, f.t)}${f.why ? ` <span class="small">${esc(f.why)}</span>` : ''}`).join(' ')}</td></tr>`;
    }).join('')}</tbody></table></div>` : '<p class="small">No names or unusual words were found in the audio.</p>';
}

function renderLevels() {
  const book = judgeBook(done.filter((d) => d.stats));
  const verdict = (checks, r) => {
    const mine = checks.filter((c) => c.retailer === r);
    const fails = mine.filter((c) => c.level === 'fail'), warns = mine.filter((c) => c.level === 'warn');
    return fails.length ? `<span class="bad">fails ${esc(fails.map((c) => c.check.toLowerCase()).join(', '))}</span>`
      : warns.length ? `<span class="meh">passes, with a note on ${esc(warns.map((c) => c.check.toLowerCase()).join(', '))}</span>` : '<span class="good">passes</span>';
  };
  $('#levels').innerHTML = done.map((d) => `<details class="levels">
      <summary><strong>${esc(d.name)}</strong> ${d.stats ? `· RMS ${d.stats.rmsDb.toFixed(1)} dB, peak ${d.stats.peakDb.toFixed(1)} dB, noise floor ${Number.isFinite(d.stats.noiseDb) ? `${d.stats.noiseDb.toFixed(1)} dB` : 'silent'}` : ''}
        <span class="verdicts">${Object.keys(RETAILERS).map((r) => `${RETAILERS[r].name}: ${verdict(d.checks, r)}`).join('<br>')}</span></summary>
      <div class="table"><table><thead><tr><th>Retailer</th><th>Check</th><th>Measured</th><th>Needs</th><th></th></tr></thead><tbody>
      ${d.checks.map((c) => `<tr class="${c.level}"><td>${esc(RETAILERS[c.retailer].name)}</td><td>${esc(c.check)}</td><td>${esc(c.value)}</td><td>${esc(c.need)}</td><td>${c.level}</td></tr>`).join('')}
      </tbody></table></div></details>`).join('')
    + (book.length ? `<p class="small">Whole book: ${book.map((c) => `${esc(RETAILERS[c.retailer].name)} ${esc(c.check.toLowerCase())} ${esc(c.value)} (${c.level === 'pass' ? 'fine' : `needs ${esc(c.need)}`})`).join('; ')}.</p>` : '')
    + `<p class="small">Specs from ${Object.values(RETAILERS).map((r) => `<a href="${r.source}">${esc(r.name)}</a>`).join(', ')}. ${Object.values(RETAILERS).map((r) => esc(r.note)).join(' ')} Measured as Audacity's ACX Check does: RMS and peak over the whole file, noise floor in the quietest half second.</p>`;
}

$('#types').addEventListener('click', (e) => {
  const b = e.target.closest('[data-type]');
  if (!b) return;
  filter = b.dataset.type;
  render();
});

// ---------- playback and export ----------------------------------------------------------------

const urls = new Map();
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-file][data-t]');
  if (!b) return;
  const d = done[Number(b.dataset.file)];
  if (!d) return;
  if (!urls.has(d.name)) urls.set(d.name, URL.createObjectURL(d.file));
  const p = $('#player');
  const t = Math.max(0, Number(b.dataset.t) - 1.5);
  if (p.dataset.name !== d.name) { p.src = urls.get(d.name); p.dataset.name = d.name; }
  $('#player-bar').hidden = false;
  $('#now').textContent = `${d.name} from ${clock(t)}`;
  const start = () => { p.currentTime = t; p.play(); };
  if (p.readyState >= 1) start(); else p.addEventListener('loadedmetadata', start, { once: true });
});

const save = (data, type, name) => {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([data], { type })), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
const title = () => bookName || report?.chapters[0]?.title || 'Manuscript';
$('#csv').addEventListener('click', () => save(csv(report, names(), done), 'text/csv', 'proof-report.csv'));
$('#print').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([printable(report, names(), done, title())], { type: 'text/html' }));
  if (!window.open(url, '_blank')) save(printable(report, names(), done, title()), 'text/html', 'proof-report.html');
});
