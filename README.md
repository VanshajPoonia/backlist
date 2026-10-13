# Backlist 🎙️

Audiobooks of the books you have already written, made on your own laptop.

Paste a chapter. **Kokoro**, an open-weight voice model, narrates it in your browser. Then **Whisper**, an open-weight speech recogniser, listens to every line and checks it against the manuscript. You re-check the handful of lines it flags instead of the whole chapter (accept them by ear, or fix the text and re-narrate just that line), and download a file mastered to audiobook spec.

**Live:** https://vanshajpoonia.github.io/backlist/

<img src="docs/review.png" alt="Proof-listening a passage of A Study in Scarlet: one line of 15 flagged, with what the listener heard, Re-narrate and Sounds right" width="560">

## Why a second model

A human-narrated audiobook costs an indie author $200 to $400 per finished hour, so a ten-hour novel is $2,000 to $4,000. An author with fifteen books in their backlist does not have that, which is why most backlists are never narrated. Text-to-speech fixes the cost. It does not fix the other half of audiobook production: **proof-listening**, where someone hears every minute against the manuscript to catch skipped words, misread words and garbled lines. That is a paid human job too, and nobody wants to sit through ten hours of a voice model to find the six lines it got wrong.

So Backlist uses a second open model as the proofer. It cannot judge performance, but it can hear when the words are wrong, and that turns out to be most of what goes wrong.

## How it works

<img src="docs/how-it-works.png" alt="How Backlist proof-listens" width="640">

```
manuscript ──► chapters ──► lines (<= 50 words) ──► narration rules + your pronunciation guide
                 src/manuscript.js                      src/narrate.js
                                                              │
                     ┌────────────────────────────────────────┘
                     ▼
   worker 1: Kokoro-82M ──audio──► worker 2: Whisper base.en ──text──► does it match the book?
   (GPU, or CPU q8)                (CPU, q8)                            src/compare.js
                     │                                                   │            │
                     ▼                                                  ok        flagged: you listen,
              src/audio.js: trim, pauses, 44.1 kHz, RMS -20 dB,                    fix the text, re-narrate
              peaks under -3 dB, lead-in and tail ──► chapter.wav                  that one line
```

- **Two models, two Web Workers, one runtime.** Both run on [transformers.js](https://github.com/huggingface/transformers.js). The narrator works ahead and the listener follows one line behind, so checking costs almost no extra time.
- **The narrator's text handling** is a readable port of [kokoro-js](https://github.com/hexgrad/kokoro/tree/main/kokoro.js) (`src/voice.js`): Kokoro's own normalisation, then eSpeak NG phonemes, then the model, so the browser and the test suite run identical code.
- **The checker** (`src/compare.js`) aligns the book's words with what was heard and forgives what is the listener's fault rather than the narrator's: numbers written as digits, "Mr." for "mister", British vs American spelling, compounds ("door-nail" heard as "doornail"), homophones ("won" heard as "one"), and names it has never heard ("Dejah Thoris" comes back as "Digiothorus"). What it does not forgive: skipped words, added or repeated words, a word swapped for a different one, a line cut short.
- **Mastering** (`src/audio.js`) trims Kokoro's own silences, adds consistent pauses (sentence, paragraph, scene break), resamples to 44.1 kHz with a windowed-sinc filter, sets the RMS to -20 dB and holds peaks under -3 dB with a limiter: the spec most audiobook distributors publish.

## What the proof-listener found in Kokoro

Things the listener caught while building this, each now handled in `src/narrate.js` or `src/manuscript.js`:

- **Roman numerals are read as "Roman".** Kokoro reads *Chapter IV* as "Chapter Roman four" and *Henry VIII* as "Henry Roman eight". Book headings get cardinals ("Chapter Four"), monarchs get ordinals ("Henry the Eighth").
- **Long sentences are cut off without warning.** Kokoro reads at most 510 phoneme tokens at a time and silently drops the rest. Across the three books used for testing, **21 sentences** are over that limit; the longest, in *A Princess of Mars*, is 168 words (1,317 tokens), so more than half of it would simply never be said. Backlist splits sentences over 50 words at their own commas and semicolons, and re-splits any line that still comes close.

## Measured

`npm test` renders real book lines through the real models and plants faults in the text the narrator reads: three words skipped, three words said twice, one word swapped for another, and the last 40% of the line never said. A good proof-listener catches the faults and stays quiet on clean audio. Lines rotate through four voices, two American and two British.

The checker's rules were tuned on 30 lines of *A Christmas Carol*, then frozen and tested on lines it had never seen, from *A Study in Scarlet* and *A Princess of Mars*.

**Test set** (80 lines with faults planted, plus 19 more lines the narration rules change and 12 chapter headings):

| Checker | False alarms on clean audio | Skipped | Repeated | Swapped | Cut off | All faults |
|---|---|---|---|---|---|---|
| Exact match after normalising | 25/80 (31%) | 74/74 | 68/74 | 74/74 | 74/74 | 98% |
| Word error rate ≤ 15% | 1/80 (1%) | 27/74 | 24/74 | 5/74 | 74/74 | 44% |
| **Backlist, rules frozen before the test** | **1/80 (1%)** | **74/74** | **67/74** | **72/74** | **74/74** | **97%** |
| Backlist after fixing what the test exposed | 0/80 | 74/74 | 67/74 | 74/74 | 74/74 | 98% |

The exact-match checker catches everything and cries wolf on almost a third of perfectly good lines. The usual word-error-rate threshold is quiet, but misses more than half the faults, including all but 5 of 74 swapped words: one wrong word in a long sentence is under 15%. Backlist's checker is as quiet as the threshold and as thorough as exact match.

The frozen run is the honest held-out number. It also exposed three gaps, now fixed: a word only counts as a name if the book never writes it in lower case (a title-case table of contents had made "Through" a name, and "Mountains" was one because of "the Rocky Mountains"); a word the listener splits in two ("Decameron" as "de Cameron"); and the homophone "corps"/"core". The last row is after those fixes, so it is no longer a held-out number. **Every fault still missed is a repetition**: three words said twice, which the listener wrote down once (more on that below).

**Narration rules:** of the 31 test lines the rules change, the listener flagged 6 rendered as written and 1 rendered with the rules. Five of the six were chapter headings ("Chapter Roman 2", "Chapter Romans 3, my Advent on Mark"), all fixed. The one left is *"bade adieu to their landlady upon Tuesday, the 4th inst."*, heard as "bated due ... the fourth inced" either way: archaic and French words are what the pronunciation guide is for. The other rules (Saint or Street, military titles, symbols) never changed a verdict in these books; they are cheap insurance, not a measured fix.

Tuning set (*A Christmas Carol*, 30 lines):

| Checker | False alarms on clean audio | Skipped | Repeated | Swapped | Cut off |
|---|---|---|---|---|---|
| Exact match after normalising | 12/30 (40%) | 21/21 | 20/21 | 21/21 | 21/21 |
| Word error rate ≤ 15% | 2/30 (7%) | 17/21 | 17/21 | 4/21 | 21/21 |
| **Backlist** | **1/30 (3%)** | **21/21** | **20/21** | **21/21** | **21/21** |

The repeat it misses is a real limit of the listener, not the rules: Kokoro said "to the point to the point" and Whisper wrote it down once. Whisper was trained on tidied-up transcripts and quietly removes repetitions. The test set confirmed it: all seven faults Backlist misses there are repetitions.

Two rules were added after the tuning run, from trying the app on a chapter of *A Princess of Mars* outside the test lines: a respelled name ("Sar-koh-ja") comes back as several words, and a split name ("Tar's Tar Cuss") can leave a stray piece beside it. Neither changed the tuning numbers above.

## Speed

Narrating, proof-listening and mastering the *A Princess of Mars* sample (3 minutes 21 seconds of audio) in Chrome on an Apple M4:

| | Time | Speed |
|---|---|---|
| Narrator on the GPU, page cross-origin isolated (the live site) | 0:44 | 4.5x real time |
| Narrator on the GPU, not isolated | 1:34 | 2.1x real time |
| No GPU at all (both models on the CPU) | 4:51 | 0.7x real time |

On the GPU every line of that chapter passes. The CPU build of the narrator is 8-bit, and with it one line is flagged: *"there are but ten chieftains"*, heard as "about 10". That changes the meaning, so it is worth the ten seconds it takes to listen.

The listener always runs on the CPU, and it is only quick when the page is cross-origin isolated, which lets ONNX Runtime use several threads. GitHub Pages cannot send the headers for that, so the service worker (`sw.js`) adds them to every file it serves and the page reloads itself once on the first visit. On a host that can send headers, `vercel.json` does the same job.

## Run it

```bash
npm start           # static server on :8000, no build step
npm install         # only for the tests
npm test            # unit checks, then the proof-listening evaluation (about an hour the first time)
LISTENER=whisper-tiny.en npm test   # the smaller listener, for comparison
```

## Files

```
src/manuscript.js   chapters, headings, scene breaks, sentences, splitting long ones
src/narrate.js      narration rules and the pronunciation guide
src/voice.js        Kokoro: normalisation, phonemes, the model (port of kokoro-js)
src/listen.js       Whisper, and 24 kHz -> 16 kHz resampling
src/compare.js      the checker
src/audio.js        trimming, pauses, resampling, loudness, limiter, WAV
src/worker.js       one model per Web Worker
src/app.js          UI
tests/unit.mjs      fast checks, no model
tests/proof.mjs     the evaluation
```

## Before you publish

Stores differ and their rules change. At the time of writing, Audible's ACX requires human narration, while Google Play Books has a "Synthesized voice" narrator type in its Partner Center and Kobo Writing Life accepts digitally narrated audiobooks if you say so in the description. Selling direct (your own site, Bookfunnel, a Kickstarter reward) has no such rules. Check your distributor before uploading.

## Credits

Narration: [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) by hexgrad (Apache-2.0), [ONNX build](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX). Text handling ported from kokoro-js (Apache-2.0). Phonemes: [phonemizer.js](https://github.com/xenova/phonemizer.js) (Apache-2.0), built on eSpeak NG (GPL-3.0), loaded at runtime. Proof-listening: [Whisper](https://github.com/openai/whisper) by OpenAI (MIT). Runtime: transformers.js and ONNX Runtime Web. Sample and test texts are public domain, via Project Gutenberg.

Code: MIT licence.
