// Audio files -> samples, in the browser, a stretch at a time. WAV is read directly. MP3 is cut
// at frame boundaries into five-minute stretches for the browser's decoder, so a whole book in
// one file never has to fit in memory. Other formats (M4A, AAC, FLAC) are decoded whole.

import { fileReader, wavSlices } from './probe.js';

const STRETCH = 5; // minutes of MP3 per decode

async function decode(buf, rate) {
  // A context at the file's own rate hands the samples back as they are, not resampled.
  const ctx = new OfflineAudioContext(1, 1, rate && rate >= 8000 && rate <= 96000 ? rate : 48000);
  const ab = await ctx.decodeAudioData(buf);
  return { channels: Array.from({ length: ab.numberOfChannels }, (_, c) => ab.getChannelData(c)), rate: ab.sampleRate };
}

/** @param {File} file  @param {object} info  from probe() */
export async function* slices(file, info) {
  if (info.format === 'wav' || info.format === 'wav-float') {
    yield* wavSlices(fileReader(file), info, 60);
    return;
  }
  if (info.format === 'mp3' && info.cuts?.length > STRETCH) {
    for (let k = 0; k < info.cuts.length; k += STRETCH) {
      const end = info.cuts[k + STRETCH] ?? file.size;
      yield await decode(await file.slice(info.cuts[k], end).arrayBuffer(), info.sampleRate);
    }
    return;
  }
  try {
    yield await decode(await file.arrayBuffer(), info.sampleRate);
  } catch (err) {
    throw new Error(`${file.name}: this browser could not decode it (${err.message || err.name}). Long M4A files can be too big to decode at once; MP3 or WAV work at any length.`);
  }
}
