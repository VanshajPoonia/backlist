// Renders data/samples/mars-narrated.mp3, the narration the demo checks: chapter XI of A Princess
// of Mars, read by Kokoro with four mistakes planted in the text it was given, mastered the
// way the narrator masters a chapter and encoded with lame at 128 kbps (enough for Google
// Play, under ACX's 192, so the levels check has something to say).
//
//   node scripts/sample.mjs        needs lame on the PATH

import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as tf from '@huggingface/transformers';
import { phonemize } from 'phonemizer';
import { loadVoice, SAMPLE_RATE } from '../src/voice.js';
import { parse } from '../src/manuscript.js';
import { narrate, heading } from '../src/narrate.js';
import { master, wav } from '../src/audio.js';

const MISTAKES = [
  ['her two little hands', 'her hands'], // skipped
  ['“You are a great chieftain now, John Carter,” she said,', 'Quote. You are a great chieftain now, John Carter, unquote, she said,'], // added
  ['an exclamation of rapture', 'an exclamation of torture'], // a word misread
  ['carried in my hand and slung across my shoulder.', 'carried in my hand.'], // the sentence stops early
];

const text = readFileSync(new URL('../data/samples/mars.txt', import.meta.url), 'utf8');
const voice = await loadVoice(tf, phonemize, { dtype: 'q8' });
const clips = [];
const used = new Set();
for (const [i, l] of parse(text)[0].lines.entries()) {
  let say = l.kind === 'heading' ? heading(l.text) : l.text;
  for (const [from, to] of MISTAKES) if (say.includes(from)) { say = say.replace(from, to); used.add(from); }
  const { audio } = await voice.speak(narrate(say), { voice: 'af_heart' });
  clips.push({ audio: new Float32Array(audio), pause: l.pause });
  console.log(`${i + 1}. ${say.slice(0, 70)}`);
}
if (used.size !== MISTAKES.length) throw new Error(`planted ${used.size} of ${MISTAKES.length} mistakes`);
const m = master(clips, SAMPLE_RATE);
const tmp = new URL('../tests/.cache/sample.wav', import.meta.url);
writeFileSync(tmp, Buffer.from(wav(m.samples, m.rate)));
execFileSync('lame', ['--quiet', '-m', 'm', '-b', '128', '--cbr', fileURLToPath(tmp), fileURLToPath(new URL('../data/samples/mars-narrated.mp3', import.meta.url))]);
rmSync(tmp);
console.log(`${m.stats.seconds.toFixed(1)} s, RMS ${m.stats.rmsDb.toFixed(1)} dB, peak ${m.stats.peakDb.toFixed(1)} dB`);
