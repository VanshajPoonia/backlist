// Fast checks with no model: narration rules, the manuscript splitter, the checker's word
// handling, the mastering chain, and reading audio files.
import { narrate, heading, parseGuide } from '../src/narrate.js';
import { parse, sentences, pieces, MAX_WORDS } from '../src/manuscript.js';
import { check, words, same, namesIn } from '../src/compare.js';
import { cardinal, ordinal, year, roman } from '../src/words.js';
import { master, resample, wav } from '../src/audio.js';
import { readFileSync } from 'node:fs';
import { probe, bytesReader, wavSlices } from '../src/probe.js';
import { meter, judge as specs } from '../src/levels.js';
import { toListen, segmenter } from '../src/segment.js';

let failed = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
};
const yes = (name, v) => eq(name, !!v, true);

// --- numbers ---------------------------------------------------------------------------
eq('cardinal', [cardinal(0), cardinal(21), cardinal(110), cardinal(1066), cardinal(2500000)], ['zero', 'twenty one', 'one hundred ten', 'one thousand sixty six', 'two million five hundred thousand']);
eq('ordinal', [ordinal(1), ordinal(3), ordinal(12), ordinal(20), ordinal(42)], ['first', 'third', 'twelfth', 'twentieth', 'forty second']);
eq('year', [year(1878), year(1900), year(1805), year(2004)], ['eighteen seventy eight', 'nineteen hundred', 'eighteen oh five', 'two thousand four']);
eq('roman', [roman('IV'), roman('XIX'), roman('MCMXII'), roman('IIII'), roman('MIX')], [4, 19, 1912, null, 1009]);

// --- narration rules ----------------------------------------------------------------------
eq('chapter numbers are cardinal', narrate('It ends in Chapter XII.'), 'It ends in Chapter twelve.');
eq('monarchs are ordinal', narrate('Henry VIII had six wives.'), 'Henry the eighth had six wives.');
eq('a pronoun "I" is left alone', narrate('When I came in, Elizabeth I was there.'), 'When I came in, Elizabeth the first was there.');
eq('Saint before a name', narrate("We met at St. Paul's."), "We met at Saint Paul's.");
eq('Street after a name', narrate('He lived at 221 Baker St, London.'), 'He lived at 221 Baker Street, London.');
eq('Street at the end of a sentence', narrate('Not on Baker St. In the morning, no.'), 'Not on Baker Street. In the morning, no.');
eq('titles', narrate('Capt. Smith and Lt. Jones met Prof. Moriarty.'), 'Captain Smith and Lieutenant Jones met Professor Moriarty.');
eq('symbols and ordinals', narrate('On the 3rd day, 95% of us & the dogs.'), 'On the third day, 95 percent of us and the dogs.');
eq('shouting is a word, initials are not', narrate('STOP, said the FBI.'), 'stop, said the FBI.');
eq('emphasis markers are dropped', narrate('It was *not* fine.'), 'It was not fine.');
eq('the guide wins, possessives too', narrate("Dejah's eyes met Tars Tarkas.", parseGuide('Dejah = Day-jah\nTars Tarkas = Tarz Tar-kus')), "Day jah's eyes met Tarz Tar kus.");
eq('the guide matches whole words only', narrate('Solar and Sola.', parseGuide('Sola = Soh-la')), 'Solar and Soh la.');
eq('headings in capitals', [heading('CHAPTER IV. A PRISONER'), heading("STAVE I:  MARLEY'S GHOST")], ['Chapter Four. A Prisoner.', "Stave One: Marley's Ghost."]);

// --- manuscript -----------------------------------------------------------------------------
eq('sentences keep abbreviations and initials', sentences('Mr. Holmes met Dr. Watson at 3 p.m. today. "Is it?" he asked. J. R. Smith left.'), ['Mr. Holmes met Dr. Watson at 3 p.m. today.', '"Is it?" he asked.', 'J. R. Smith left.']);
const long = `${'He walked on and on, '.repeat(8)}until at last; ${'the sun went down behind the hills, '.repeat(4)}and night came.`;
const ps = pieces(long);
yes(`a long sentence is cut into pieces of at most ${MAX_WORDS} words`, ps.length > 1 && ps.every((p) => p.split(/\s+/).length <= MAX_WORDS));
eq('pieces add back up to the sentence', ps.join(' '), long);
const ms = parse('CHAPTER IV\n\nA PRISONER\n\nWe had gone ten miles.\nThe ground rose.\n\n* * *\n\nThen it fell.\n\n[Illustration]\n\nCHAPTER V\n\nMore.');
eq('chapters, headings with subtitles, scene breaks', ms.map((c) => [c.title, c.lines.map((l) => [l.kind, l.text, l.pause])]), [
  ['CHAPTER IV. A PRISONER', [['heading', 'CHAPTER IV. A PRISONER', 1.2], ['line', 'We had gone ten miles.', 0.35], ['line', 'The ground rose.', 1.6], ['line', 'Then it fell.', 0.8]]],
  ['CHAPTER V', [['heading', 'CHAPTER V', 1.2], ['line', 'More.', 0.8]]],
]);

// --- the checker ----------------------------------------------------------------------------
eq('numbers compare as words', words('In 1878, on the 3rd, £5 and 10%'), 'in eighteen seventy eight on the third five pounds and ten percent'.split(' '));
yes('British and American spellings sound the same', same('colour', 'color') && same('grey', 'gray') && same('realise', 'realize'));
yes('the listener\'s abbreviations count', check('Mister Holmes met Doctor Watson.', 'Mr. Holmes met Dr. Watson.').ok);
yes('a garbled name is not a narration error', check('Dejah Thoris rode to Thark.', 'Digiothorus rode to Tark.', namesIn('Then Dejah Thoris spoke.')).ok);
yes('a missing name is', !check('Dejah Thoris rode to Thark.', 'rode to Thark.', namesIn('Then Dejah Thoris spoke.')).ok);
eq('three skipped words', check('We had gone perhaps ten miles when the ground began to rise.', 'We had gone when the ground began to rise.').problems, [{ type: 'skipped', words: 'perhaps ten miles' }]);
eq('a swapped word', check('The ground began to rise very rapidly.', 'The ground began to fall very rapidly.').problems, [{ type: 'misread', words: 'rise', heard: 'fall' }]);
yes('a cut-off ending', !check('We had gone perhaps ten miles when the ground began to rise.', 'We had gone perhaps ten miles.').ok);
yes('a dropped "the" is forgiven', check('He walked to the end of the road.', 'He walked to end of the road.').ok);
yes('compounds: "door-nail" heard as "doornail"', check('Marley was as dead as a door-nail.', 'Marley was as dead as a doornail.').ok);
yes('compounds: "ironmongery" heard as "iron mongering"', check('the deadest piece of ironmongery in the trade.', 'the deadest piece of iron mongering in the trade.').ok);
yes('homophones: "won" heard as "one"', check('kills won his way close to the rank', 'kills one his way close to the rank').ok);
yes('homophones: "There I was" heard as "Their eye was"', check('There I was struck on the shoulder.', 'Their eye was struck on the shoulder.').ok);
yes('a respelled name may come back as several words', check('So Sarkoja merely gave us an ugly look.', 'So SARS-Co-Ya merely gave us an ugly look.', namesIn('Then Sarkoja spoke.')).ok);
yes('a name split into extra pieces', check('close to the rank of Tars Tarkas, who, as you know', "close to the rank of Tar's Tar Cuss. Who, as you know", namesIn('Then Tars Tarkas spoke.')).ok);
yes('a word the book also writes in lower case is not a name', !namesIn('the Rocky Mountains. We climbed the mountains.').has('mountains') && namesIn('Then Dejah Thoris spoke.').has('dejah'));
yes('a split word with half already matched: "Decameron" heard as "de Cameron"', check('A copy of the Decameron, with a name.', 'A copy of the de Cameron, with a name.', namesIn('Read the Decameron.')).ok);
yes('a doubled word is a stutter, even a small one', !check('Marley was as dead as a door-nail.', 'Marley was as dead as as a doornail.').ok);
const runs = check('We had gone perhaps ten miles when the ground began to rise.', 'We had gone when the ground began to fall.');
eq('each problem knows where it is in the alignment', runs.runs, [[3, 6], [11, 12]]);
eq('long sentences remember their pieces', parse(long).flatMap((c) => c.lines.map((l) => l.part)), ps.map((_, j) => j));

// --- audio ----------------------------------------------------------------------------------
const tone = (f, s, r) => Float32Array.from({ length: Math.round(r * s) }, (_, i) => 0.3 * Math.sin((2 * Math.PI * f * i) / r));
const m = master([{ audio: tone(220, 1, 24000), pause: 0.35 }, { audio: tone(330, 1, 24000), pause: 0.8 }], 24000);
yes(`mastered to spec: 44.1 kHz, RMS ${m.stats.rmsDb.toFixed(1)} dB in [-23, -18], peak ${m.stats.peakDb.toFixed(1)} dB <= -3`, m.rate === 44100 && m.stats.rmsDb >= -23 && m.stats.rmsDb <= -18 && m.stats.peakDb <= -3);
const r = resample(tone(440, 1, 24000), 24000, 44100), ideal = tone(440, 1, 44100);
let err = 0;
for (let i = 500; i < 40000; i++) err = Math.max(err, Math.abs(r[i] - ideal[i]));
yes(`resampling is clean (max error ${err.toExponential(1)})`, err < 1e-3);
eq('WAV header', new TextDecoder().decode(new Uint8Array(wav(new Float32Array(10), 44100), 0, 4)), 'RIFF');

// --- audio files ------------------------------------------------------------------------------
// One second of `say`, encoded by lame, afconvert and ffmpeg (tests/fixtures).
const fixture = (f) => bytesReader(new Uint8Array(readFileSync(new URL(`fixtures/${f}`, import.meta.url))));
const brief = (i) => [i.format, i.sampleRate, i.channels, i.bitrate, i.cbr, i.jointStereo ?? null];
eq('MP3, constant 192 kbps mono', brief(await probe(fixture('cbr192-mono.mp3'))), ['mp3', 44100, 1, 192000, true, false]);
eq('MP3, variable bitrate joint stereo', brief(await probe(fixture('vbr-joint.mp3'))), ['mp3', 44100, 2, 89000, false, true]);
eq('M4A, AAC 128 kbps mono (channels from the AAC config, not the fixed 2)', brief(await probe(fixture('aac128.m4a'))), ['m4a', 44100, 1, 128000, null, null]);
eq('AAC in ADTS frames', brief(await probe(fixture('aac128.aac'))).slice(0, 3), ['aac', 44100, 1]);
eq('FLAC, 16-bit 22.05 kHz', [...brief(await probe(fixture('s16-22k.flac'))).slice(0, 3), (await probe(fixture('s16-22k.flac'))).bits], ['flac', 22050, 1, 16]);
const w24 = await probe(fixture('s24-48k-stereo.wav'));
eq('WAV, 24-bit stereo 48 kHz (extensible header)', [w24.format, w24.sampleRate, w24.channels, w24.bits, w24.seconds], ['wav', 48000, 2, 24, 0.25]);
let frames = 0, top = 0;
for await (const s of wavSlices(fixture('s24-48k-stereo.wav'), w24, 0.1)) { frames += s.channels[1].length; for (const v of s.channels[0]) top = Math.max(top, Math.abs(v)); }
yes(`WAV read in slices without a decoder (${frames} frames, peak ${top.toFixed(2)})`, frames === 12000 && top > 0.05 && top <= 1);
eq('not audio', (await probe(bytesReader(new TextEncoder().encode('Chapter One. It was a dark and stormy night, and the rain fell in torrents.')))).format, 'unknown');

// --- levels against retailer specs ------------------------------------------------------------
// 0.75 s of room tone at -70 dB, 3 s of tone, 2 s of room tone: what a well-made chapter looks like.
const fileRate = 44100, room = (s) => Float32Array.from({ length: s * fileRate }, () => (Math.random() * 2 - 1) * 10 ** (-70 / 20) * Math.sqrt(3));
const body3 = Float32Array.from({ length: 3 * fileRate }, (_, i) => 0.14 * Math.sin((2 * Math.PI * 200 * i) / fileRate));
const lv = meter(fileRate);
for (const part of [room(0.75), body3, room(2)]) lv.add([part]);
const st = lv.done();
yes(`levels: RMS ${st.rmsDb.toFixed(1)}, peak ${st.peakDb.toFixed(1)}, noise floor ${st.noiseDb.toFixed(1)} dB, head ${st.headSec} s, tail ${st.tailSec} s`,
  Math.abs(st.peakDb - 20 * Math.log10(0.14)) < 0.1 && Math.abs(st.noiseDb + 70) < 1 && Math.abs(st.headSec - 0.75) < 0.02 && Math.abs(st.tailSec - 2) < 0.02 && Math.abs(st.seconds - 5.75) < 1e-6);
const mp3Info = { format: 'mp3', sampleRate: 44100, channels: 1, bitrate: 192000, cbr: true, jointStereo: false };
const verdict = (info, stats) => Object.fromEntries(specs(info, stats).map((c) => [`${c.retailer} ${c.check}`, c.level]));
const good = verdict(mp3Info, { ...st, rmsDb: -20 });
yes('a 192 kbps CBR mono MP3 at -20 dB RMS passes every ACX check', Object.entries(good).filter(([k]) => k.startsWith('acx')).every(([, v]) => v === 'pass'));
const bad = verdict({ ...mp3Info, channels: 2, bitrate: 128000, cbr: false, jointStereo: true }, { ...st, rmsDb: -15, peakDb: -1, noiseDb: -100, headSec: 0, tailSec: 0.2 });
eq('a loud VBR joint-stereo MP3 with no room tone fails ACX on each count', ['Bitrate', 'Stereo mode', 'RMS', 'Peak', 'Silence at the start', 'Silence at the end'].map((k) => bad[`acx ${k}`]), ['fail', 'fail', 'fail', 'fail', 'fail', 'fail']);
eq('pure digital silence is a warning, not room tone', bad['acx Room tone'], 'warn');
eq('Google wants 256 kbps for stereo, and Kobo 192', [bad['google Bitrate'], bad['kobo Bitrate'], good['google Bitrate']], ['fail', 'warn', 'pass']);
eq('Google takes 16-bit WAV at 44.1 kHz, not 24-bit', verdict({ format: 'wav', sampleRate: 48000, channels: 1, bits: 24 }, st)['google Bit depth'], 'fail');

// --- cutting long audio for the listener -------------------------------------------------------
const sine = (f, s, r, a = 0.5) => Float32Array.from({ length: Math.round(r * s) }, (_, i) => a * Math.sin((2 * Math.PI * f * i) / r));
const rms = (x) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
const low = toListen([sine(440, 1, 44100)], 44100), high = toListen([sine(12000, 1, 44100)], 44100);
yes(`44.1 kHz to 16 kHz keeps speech (440 Hz at ${(rms(low.subarray(800, 15000)) / rms(sine(440, 1, 16000))).toFixed(3)}x) and removes what 16 kHz cannot hold (12 kHz down ${(20 * Math.log10(rms(high.subarray(800, 15000)) / 0.354)).toFixed(0)} dB)`,
  low.length === 16000 && Math.abs(rms(low.subarray(800, 15000)) / rms(sine(440, 1, 16000)) - 1) < 0.01 && rms(high.subarray(800, 15000)) < 0.354 * 0.01);
eq('stereo is mixed to mono', toListen([sine(440, 0.1, 16000), sine(440, 0.1, 16000, -0.5)], 16000).every((v) => Math.abs(v) < 1e-7), true);
// Ten 2.5 s "sentences" of noise, 0.45 s apart, fed in 7 s slices as a decoder would.
const R16 = 16000, said = [];
const chapterAudio = new Float32Array(Math.round(30 * R16));
for (let k = 0, at = 0.6; k < 10; k++, at += 2.95) {
  said.push([at, at + 2.5]);
  for (let i = Math.round(at * R16); i < Math.round((at + 2.5) * R16); i++) chapterAudio[i] = (Math.random() * 2 - 1) * 0.3;
}
const seg = segmenter(), cut = [];
for (let i = 0; i < chapterAudio.length; i += 7 * R16) cut.push(...seg.push(chapterAudio.subarray(i, i + 7 * R16)));
cut.push(...seg.flush());
const inside = (t) => said.some(([a, b]) => t > a + 0.05 && t < b - 0.05);
yes(`speech is cut only at pauses (${cut.length} pieces, ${cut.map((p) => `${p.start.toFixed(2)}-${p.end.toFixed(2)}`).join(' ')})`,
  cut.length >= 2 && cut.every((p) => !inside(p.start) && !inside(p.end) && p.end - p.start <= 27) && Math.abs(cut[0].start - (said[0][0] - 0.12)) < 0.03 && Math.abs(cut.at(-1).end - (said[9][1] + 0.12)) < 0.03);
const nonstop = segmenter(), runOn = [...nonstop.push(Float32Array.from({ length: 70 * R16 }, () => (Math.random() * 2 - 1) * 0.3)), ...nonstop.flush()];
yes(`a narrator who never pauses is still cut to fit the listener (${runOn.map((p) => (p.end - p.start).toFixed(1)).join(', ')} s)`, runOn.every((p) => p.end - p.start <= 27.5) && Math.abs(runOn.reduce((s, p) => s + p.end - p.start, 0) - 70) < 0.1);

console.log(failed ? `\n${failed} FAILED` : '\nall unit checks pass');
process.exit(failed ? 1 : 0);
