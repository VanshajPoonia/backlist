// The demo: does the report on data/samples/mars-narrated.mp3 find the four mistakes planted by
// scripts/sample.mjs, with the right labels? Node has no audio decoder, so the MP3 is decoded
// with macOS afconvert; the rest is the pipeline the page runs.
//
//   npm run eval:sample        needs macOS

import { readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse } from '../src/manuscript.js';
import { namesIn } from '../src/compare.js';
import { probe, bytesReader, wavSlices } from '../src/probe.js';
import { listenFile } from '../src/segment.js';
import { judge } from '../src/levels.js';
import { book, proof } from '../src/proof.js';
import { rows, clock, LABELS } from '../src/report.js';
import { CACHE, cachedListener } from './evalkit.mjs';

if (process.platform !== 'darwin') { console.log('needs macOS for afconvert; skipped'); process.exit(0); }
const mp3 = new URL('../data/samples/mars-narrated.mp3', import.meta.url);
const wav = new URL('sample-decoded.wav', CACHE);
execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16', fileURLToPath(mp3), fileURLToPath(wav)]);

const text = readFileSync(new URL('../data/samples/mars.txt', import.meta.url), 'utf8');
const info = await probe(bytesReader(new Uint8Array(readFileSync(mp3))));
const pcm = bytesReader(new Uint8Array(readFileSync(wav)));
rmSync(wav);
const { hear, save } = await cachedListener('heard-sample-whisper-base.en.json');
const { pieces, stats } = await listenFile(wavSlices(pcm, await probe(pcm), 60), hear);
save();
const r = proof(book(parse(text)), [{ name: 'mars-chapter-11.mp3', pieces }], { known: namesIn(text), fullText: text });

const list = rows(r, ['mars-chapter-11.mp3']);
for (const x of list) console.log(`${clock(x.t).padStart(5)}  ${(LABELS[x.type] ?? x.type).padEnd(13)} ${x.what}`);
console.log(`\n${list.length} rows; levels: ${judge(info, stats).filter((c) => c.level !== 'pass').map((c) => `${c.retailer} ${c.check} ${c.value} (${c.level})`).join('; ')}`);

const PLANTED = [['skipped', 'two little'], ['added', 'quote'], ['mispronounced', 'rapture'], ['cut short', 'slung across my shoulder']];
const found = PLANTED.filter(([type, w]) => list.some((x) => x.type === type && `${x.what} ${x.book}`.toLowerCase().includes(w)));
console.log(`planted mistakes found with the right label: ${found.length} of ${PLANTED.length}`);
process.exit(found.length === PLANTED.length ? 0 : 1);
