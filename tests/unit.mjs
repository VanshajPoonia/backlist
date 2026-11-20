// Fast checks with no model: narration rules, the manuscript splitter, the checker's word
// handling, and the mastering chain.
import { narrate, heading, parseGuide } from '../src/narrate.js';
import { parse, sentences, pieces, MAX_WORDS } from '../src/manuscript.js';
import { check, words, same, namesIn } from '../src/compare.js';
import { cardinal, ordinal, year, roman } from '../src/words.js';
import { master, resample, wav } from '../src/audio.js';

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

console.log(failed ? `\n${failed} FAILED` : '\nall unit checks pass');
process.exit(failed ? 1 : 0);
