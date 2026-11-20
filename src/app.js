import { parse, pieces } from './manuscript.js';
import { narrate, heading, parseGuide } from './narrate.js';
import { check, namesIn, words } from './compare.js';
import { master, wav } from './audio.js';
import { VOICES } from './voice.js';
import './isolate.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

// A starting guide for each sample: what an author would hand a human narrator.
const SAMPLES = {
  mars: { file: 'data/samples/mars.txt', guide: 'Dejah Thoris = Day-jah Thor-iss\nSarkoja = Sar-koh-ja\nSola = Soh-la\nTars Tarkas = Tarz Tar-kus\nLorquas Ptomel = Lor-kwas Toe-mel' },
  scarlet: { file: 'data/samples/scarlet.txt', guide: 'Maiwand = My-wand' },
};

// ---------- the two workers --------------------------------------------------------------

function spawn(role) {
  const w = new Worker(new URL(`./worker.js?role=${role}`, import.meta.url), { type: 'module' });
  const pending = new Map();
  let seq = 0, onProgress = null, loading = null;
  w.onmessage = ({ data }) => {
    if (data.type === 'progress') { onProgress?.(data.p); return; }
    const p = pending.get(data.id);
    if (!p) return;
    pending.delete(data.id);
    if (data.error) p.reject(new Error(data.error)); else p.resolve(data);
  };
  w.onerror = (e) => { for (const p of pending.values()) p.reject(new Error(e.message || `${role} worker failed`)); pending.clear(); };
  const call = (msg) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); w.postMessage({ ...msg, id }); });
  return {
    load(cb) { onProgress = cb; loading ??= call({ type: 'load' }).catch((e) => { loading = null; throw e; }); return loading; },
    call,
  };
}
const voiceW = spawn('voice');
const earW = spawn('ear');

async function loadModels() {
  const p = { voice: 0, ear: 0 };
  const bar = $('#bar');
  bar.hidden = false;
  const show = () => { bar.value = (p.voice + p.ear) / 2; $('#status').textContent = `Downloading the narrator and the listener (once)… ${Math.round(bar.value * 100)}%`; };
  const [v] = await Promise.all([
    voiceW.load((x) => { p.voice = x; show(); }),
    earW.load((x) => { p.ear = x; show(); }),
  ]);
  return v.device;
}

// ---------- playback ---------------------------------------------------------------------

let ctx = null, playing = null;
function play(audio, rate) {
  ctx ??= new AudioContext();
  playing?.stop();
  const b = ctx.createBuffer(1, audio.length, rate);
  b.copyToChannel(audio, 0);
  const s = ctx.createBufferSource();
  s.buffer = b;
  s.connect(ctx.destination);
  s.start();
  playing = s;
}

// ---------- the manuscript ---------------------------------------------------------------

let fullText = '';
let chapters = [];

for (const [id, v] of Object.entries(VOICES)) $('#voice').insertAdjacentHTML('beforeend', `<option value="${id}">${v.name} (${v.accent}, ${v.gender})</option>`);

function load(text) {
  fullText = text;
  chapters = parse(text);
  const sel = $('#chapter');
  sel.innerHTML = chapters.map((c, i) => `<option value="${i}">${esc(c.title)} (${c.lines.length} lines)</option>`).join('');
  $('#chapter-row').hidden = chapters.length < 2;
  const n = chapters.reduce((s, c) => s + c.lines.length, 0);
  $('#book-status').textContent = chapters.length
    ? `${chapters.length} chapter${chapters.length > 1 ? 's' : ''}, ${n} lines.${chapters.length > 1 ? ' Pick one below.' : ''}`
    : '';
  $('#go').disabled = !chapters.length;
  showNames();
}

$('#text').addEventListener('input', () => {
  document.querySelectorAll('[data-sample]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
  load($('#text').value);
});
$('#chapter').addEventListener('change', showNames);

document.querySelectorAll('[data-sample]').forEach((b) => b.addEventListener('click', async () => {
  document.querySelectorAll('[data-sample]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  const s = SAMPLES[b.dataset.sample];
  const text = await (await fetch(s.file)).text();
  $('#text').value = text;
  $('#guide').value = s.guide;
  load(text);
}));

const drop = $('#drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0]); });
$('#file').addEventListener('change', (e) => { if (e.target.files[0]) readFile(e.target.files[0]); });

async function readFile(file) {
  try {
    let text;
    if (file.name.toLowerCase().endsWith('.docx')) {
      if (!window.mammoth) {
        await new Promise((res, rej) => {
          const el = Object.assign(document.createElement('script'), { src: 'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js', onload: res, onerror: rej });
          document.head.append(el);
        });
      }
      text = (await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })).value;
    } else {
      text = await file.text();
    }
    $('#text').value = text;
    document.querySelectorAll('[data-sample]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
    load(text);
  } catch (err) {
    $('#book-status').textContent = `Could not read ${file.name}: ${err.message}`;
  }
}

const TITLE_WORDS = new Set(('mr mrs miss ms dr doctor sir madam lady lord king queen prince princess captain colonel general major lieutenant ' +
  'sergeant professor reverend father mother uncle aunt saint street road lane house hall church river lake mount north south east west ' +
  'first second third fifth god heaven chapter part book monday tuesday wednesday thursday friday saturday sunday january february march ' +
  'april may june july august september october november december english french german american').split(' '));

/** Names the chapter uses that the guide does not cover yet, most frequent first. */
function showNames() {
  const ch = chapters[$('#chapter').value || 0];
  if (!ch) { $('#names').innerHTML = ''; return; }
  const covered = new Set(parseGuide($('#guide').value).flatMap((g) => words(g.word)));
  const text = ch.lines.map((l) => l.text).join(' ');
  // Ordinary words in capitals ("Doctor of Medicine") are not what the guide is for: skip
  // titles, and anything the book also writes in lower case.
  const lower = new Set(fullText.match(/\b\p{Ll}+\b/gu) ?? []);
  const plain = (w) => TITLE_WORDS.has(w.toLowerCase()) || lower.has(w.toLowerCase());
  const count = new Map();
  for (const m of text.matchAll(/(?<=[a-z,;:]\s+|[a-z,;:]\s+[“"‘])(\p{Lu}\p{Ll}+(?:\s+\p{Lu}\p{Ll}+)?)/gu)) {
    const w = m[1].split(/\s+/).filter((x) => !plain(x)).join(' ');
    if (!w || words(w).every((x) => covered.has(x))) continue;
    count.set(w, (count.get(w) ?? 0) + 1);
  }
  const top = [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  $('#names').innerHTML = top.length
    ? `<p class="small">Names in this chapter without a guide entry. Add any the narrator should say a particular way:</p>${top.map(([w]) => `<button data-name="${esc(w)}">+ ${esc(w)}</button>`).join('')}`
    : '';
}
$('#guide').addEventListener('input', showNames);
$('#names').addEventListener('click', (e) => {
  const b = e.target.closest('[data-name]');
  if (!b) return;
  const g = $('#guide');
  g.value = `${g.value.trim()}${g.value.trim() ? '\n' : ''}${b.dataset.name} = `;
  g.focus();
  g.setSelectionRange(g.value.length, g.value.length);
  showNames();
});

$('#preview').addEventListener('click', async () => {
  const btn = $('#preview');
  btn.disabled = true;
  try {
    $('#status').textContent = 'Loading the narrator…';
    await loadModels();
    const guide = parseGuide($('#guide').value);
    const names = guide.map((g) => g.word).slice(0, 4);
    const line = names.length ? `This is how I will read your book. ${names.join(', ')}.` : 'This is how I will read your book.';
    const r = await voiceW.call({ type: 'speak', text: narrate(line, guide), voice: $('#voice').value, speed: Number($('#speed').value) });
    $('#bar').hidden = true;
    $('#status').textContent = '';
    play(r.audio, r.rate);
  } catch (err) {
    $('#status').textContent = `Something went wrong: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

// ---------- narrating and proof-listening ------------------------------------------------

let lines = [];
let chapterTitle = 'chapter';
let known = new Set();

const PROBLEM = {
  skipped: (p) => `Words missing: “${p.words}”`,
  added: (p) => `Extra words: “${p.words}”`,
  misread: (p) => `Heard “${p.heard}” where the book says “${p.words}”`,
};

// A line is fine if the listener heard the book, or if the author listened and says so.
const fine = (L) => L.result && (L.result.ok || L.accepted);

function row(L) {
  const state = L.result ? (fine(L) ? 'ok' : 'flagged') : 'pending';
  const mark = { ok: '✓', flagged: '!', pending: '…' }[state];
  const issue = state === 'flagged'
    ? `<div class="issue">
        <p>${L.result.problems.map((p) => esc(PROBLEM[p.type](p))).join('<br>')}</p>
        <p class="heard">The listener heard: <q>${esc(L.heard)}</q></p>
        <div class="fix"><input aria-label="Say it as" value="${esc(L.say)}"><button data-redo="${L.i}">Re-narrate</button><button data-accept="${L.i}" class="secondary">Sounds right</button></div>
      </div>`
    : L.accepted && !L.result.ok ? '<div class="issue"><p class="heard">Accepted by ear.</p></div>' : '';
  return `<li class="line ${state} ${L.kind}" id="line-${L.i}">
    <span class="mark" aria-label="${state}">${mark}</span>
    <span class="text">${esc(L.book)}</span>
    <button class="play" data-play="${L.i}" ${L.audio ? '' : 'disabled'} aria-label="Play line">▶</button>
    ${issue}
  </li>`;
}
const update = (L) => { $(`#line-${L.i}`).outerHTML = row(L); };

async function speak(L) {
  const opts = { voice: $('#voice').value, speed: Number($('#speed').value) };
  const r = await voiceW.call({ type: 'speak', text: L.say, ...opts });
  L.rate = r.rate;
  if (r.tokens < 510) { L.audio = r.audio; return; }
  // Still too long for one breath (dense text: numbers, initials). Say it in halves.
  const halves = pieces(L.say, Math.ceil(L.say.split(/\s+/).length / 2));
  const clips = [];
  for (const h of halves) clips.push((await voiceW.call({ type: 'speak', text: h, ...opts })).audio);
  const gap = Math.round(r.rate * 0.12);
  L.audio = new Float32Array(clips.reduce((s, c) => s + c.length + gap, 0));
  let at = 0;
  for (const c of clips) { L.audio.set(c, at); at += c.length + gap; }
}

async function listen(L) {
  const r = await earW.call({ type: 'hear', audio: L.audio, rate: L.rate });
  L.heard = r.text;
  L.result = check(L.book, L.heard, known);
}

$('#go').addEventListener('click', async () => {
  const ch = chapters[$('#chapter').value || 0];
  const guide = parseGuide($('#guide').value);
  chapterTitle = ch.title;
  known = new Set([...namesIn(fullText), ...guide.flatMap((g) => words(g.word))]);
  lines = ch.lines.map((l, i) => {
    const h = l.kind === 'heading' ? heading(l.text) : null;
    return { i, kind: l.kind, book: h ?? l.text, say: h ? narrate(h, guide) : narrate(l.text, guide), pause: l.pause, audio: null, heard: null, result: null };
  });

  $('#go').disabled = true;
  $('#review').hidden = false;
  $('#export').hidden = true;
  $('#lines').classList.remove('only-flagged');
  setFilter('all');
  $('#lines').innerHTML = lines.map(row).join('');
  $('#summary').textContent = 'Narrating…';
  $('#summary-small').textContent = '';

  try {
    const device = await loadModels();
    const bar = $('#bar');
    bar.value = 0;
    const t0 = performance.now();
    let spoken = 0, heardN = 0, seconds = 0;
    const status = () => {
      bar.value = (spoken + heardN) / (2 * lines.length);
      $('#status').textContent = `Narrated ${spoken} of ${lines.length} lines, proof-listened ${heardN}.`;
    };

    // The narrator works ahead; the listener follows one line behind.
    const queue = [];
    let wake = null;
    const narrator = (async () => {
      for (const L of lines) {
        await speak(L);
        seconds += L.audio.length / L.rate;
        spoken++;
        update(L);
        status();
        queue.push(L);
        wake?.();
      }
    })();
    const listener = (async () => {
      while (heardN < lines.length) {
        if (!queue.length) await new Promise((r) => { wake = r; });
        while (queue.length) {
          const L = queue.shift();
          await listen(L);
          heardN++;
          update(L);
          status();
        }
      }
    })();
    await Promise.all([narrator, listener]);

    const secs = (performance.now() - t0) / 1000;
    bar.hidden = true;
    $('#status').textContent = `Done: ${mmss(seconds)} of audio in ${mmss(secs)} (${(seconds / secs).toFixed(1)}x real time, narrator on ${device === 'webgpu' ? 'the GPU' : 'the CPU'}).`;
    summarise();
    await buildExport();
  } catch (err) {
    console.error(err);
    $('#status').textContent = `Something went wrong: ${err.message}`;
  } finally {
    $('#go').disabled = false;
  }
});

function summarise() {
  const flagged = lines.filter((L) => L.result && !fine(L));
  const total = lines.reduce((s, L) => s + (L.audio ? L.audio.length / L.rate : 0), 0);
  const toCheck = flagged.reduce((s, L) => s + L.audio.length / L.rate, 0);
  const byEar = lines.filter((L) => L.accepted && L.result && !L.result.ok).length;
  $('#summary').textContent = flagged.length
    ? `${flagged.length} of ${lines.length} lines to check.`
    : byEar ? `All ${lines.length} lines done.` : `All ${lines.length} lines passed.`;
  $('#summary-small').textContent = flagged.length
    ? `Instead of re-listening to all ${mmss(total)}, listen to ${flagged.length === 1 ? 'this one' : `these ${flagged.length}`} (${mmss(toCheck)}). If it sounds right, say so; if not, fix the text the narrator reads (or add a name to the guide) and re-narrate just that line.`
    : byEar
      ? `${lines.length - byEar} passed the listener, and you accepted ${byEar === 1 ? 'one' : byEar} by ear.`
      : `The listener heard every line as written. Names are the one thing it cannot judge: give them a listen.`;
  setFilter(flagged.length ? 'flagged' : 'all');
}

function setFilter(f) {
  document.querySelectorAll('[data-filter]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filter === f)));
  $('#lines').classList.toggle('only-flagged', f === 'flagged');
}
document.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => setFilter(b.dataset.filter)));

$('#lines').addEventListener('click', async (e) => {
  const p = e.target.closest('[data-play]');
  if (p) { const L = lines[p.dataset.play]; play(L.audio, L.rate); return; }
  const a = e.target.closest('[data-accept]');
  if (a) { const L = lines[a.dataset.accept]; L.accepted = true; update(L); summarise(); return; }
  const r = e.target.closest('[data-redo]');
  if (!r) return;
  const L = lines[r.dataset.redo];
  L.say = r.parentElement.querySelector('input').value;
  L.accepted = false;
  r.disabled = true;
  r.textContent = 'Narrating…';
  try {
    await speak(L);
    await listen(L);
    update(L);
    play(L.audio, L.rate);
    summarise();
    await buildExport();
  } catch (err) {
    r.textContent = `Failed: ${err.message}`;
  }
});

// ---------- export ---------------------------------------------------------------------------

let url = null;
async function buildExport() {
  const m = master(lines.map((L) => ({ audio: L.audio, pause: L.pause })), lines[0].rate);
  const blob = new Blob([wav(m.samples, m.rate)], { type: 'audio/wav' });
  if (url) URL.revokeObjectURL(url);
  url = URL.createObjectURL(blob);
  $('#player').src = url;
  const ok = m.stats.rmsDb >= -23 && m.stats.rmsDb <= -18 && m.stats.peakDb <= -3;
  $('#spec').textContent = `${mmss(m.stats.seconds)}, 44.1 kHz 16-bit mono, RMS ${m.stats.rmsDb.toFixed(1)} dB, peak ${m.stats.peakDb.toFixed(1)} dB, ${ok ? 'inside the usual audiobook spec' : 'outside the usual audiobook spec'}.`;
  $('#export').hidden = false;
}

$('#download').addEventListener('click', () => {
  const a = Object.assign(document.createElement('a'), { href: url, download: `${chapterTitle.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'chapter'}.wav` });
  a.click();
});

