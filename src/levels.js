// Audio levels against what audiobook retailers publish. Measured the way Audacity's ACX
// Check plugin measures them: RMS and peak over the whole file, and the noise floor as the
// RMS of the quietest half second. Sources for every number are in the README.

const db = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
const BLOCK = 0.01; // seconds
const QUIET = 0.5; // the noise floor window
const SOUND_DB = -45; // a 10 ms block louder than this is narration, not room tone

/** Streaming meter: add() decoded slices in order, then done(). */
export function meter(rate) {
  const per = Math.max(1, Math.round(rate * BLOCK));
  const blocks = [];
  let sq = 0, n = 0, frames = 0, peak = 0, acc = 0, accN = 0;
  return {
    add(channels) {
      const len = channels[0].length, c = channels.length;
      frames += len;
      for (let i = 0; i < len; i++) {
        let s = 0;
        for (let k = 0; k < c; k++) {
          const v = channels[k][i];
          s += v * v;
          const a = v < 0 ? -v : v;
          if (a > peak) peak = a;
        }
        sq += s; n += c; acc += s; accN += c;
        if (accN >= per * c) { blocks.push(acc / accN); acc = 0; accN = 0; }
      }
    },
    done() {
      if (accN) blocks.push(acc / accN);
      const w = Math.max(1, Math.round(QUIET / BLOCK));
      let quiet = Infinity, run = 0;
      for (let i = 0; i < blocks.length; i++) {
        run += blocks[i];
        if (i >= w) run -= blocks[i - w];
        if (i >= w - 1) quiet = Math.min(quiet, run / w);
      }
      if (quiet === Infinity) quiet = blocks.reduce((s, b) => s + b, 0) / Math.max(1, blocks.length);
      const loud = (b) => 10 * Math.log10(Math.max(b, 1e-20)) > SOUND_DB;
      const first = blocks.findIndex(loud);
      let last = blocks.length - 1;
      while (last >= 0 && !loud(blocks[last])) last--;
      return {
        seconds: frames / rate,
        rmsDb: db(Math.sqrt(sq / Math.max(1, n))),
        peakDb: db(peak),
        noiseDb: db(Math.sqrt(Math.max(quiet, 0))),
        headSec: first < 0 ? 0 : first * BLOCK,
        tailSec: first < 0 ? 0 : (blocks.length - 1 - last) * BLOCK,
      };
    },
  };
}
const SRC = {
  acx: 'https://www.acx.com/help/article/acx-audio-submission-requirements',
  google: 'https://support.google.com/books/partner/answer/3424254',
  kobo: 'https://kobocontentoperations.zendesk.com/hc/en-us/articles/4410661407003-Audio-Operations-Guide',
};

export const RETAILERS = {
  acx: { name: 'ACX (Audible)', source: SRC.acx, note: 'ACX asks for human narration. Its file spec is still the strictest one most distributors copy.' },
  google: { name: 'Google Play Books', source: SRC.google, note: 'Google publishes no loudness numbers.' },
  kobo: { name: 'Kobo', source: SRC.kobo, note: 'Kobo re-encodes to 64 kbps and publishes no loudness numbers.' },
};

const kbps = (b) => `${Math.round(b / 1000)} kbps`;
const fmtDb = (d) => (d === -Infinity ? 'silent' : `${d.toFixed(1)} dB`);

/**
 * One file against each retailer. `info` comes from probe(), `stats` from meter().done().
 * @returns {{retailer:string, check:string, value:string, need:string, level:'pass'|'fail'|'warn'}[]}
 */
export function judge(info, stats) {
  const out = [];
  const add = (retailer, check, value, need, ok, soft = false) => out.push({ retailer, check, value, need, level: ok ? 'pass' : soft ? 'warn' : 'fail' });
  const mono = info.channels === 1;
  const fmt = info.format;
  const khz = info.sampleRate ? `${info.sampleRate / 1000} kHz` : 'unknown';

  // ACX: every file a 192 kbps+ constant-bitrate MP3 at 44.1 kHz, -23 to -18 dB RMS, peaks at -3 dB or
  // below, noise floor -60 dB or below, 0.5 to 1 s of room tone at the head and 1 to 5 s at the tail.
  add('acx', 'Format', fmt === 'mp3' ? 'MP3' : fmt.toUpperCase(), 'MP3', fmt === 'mp3');
  if (fmt === 'mp3') {
    add('acx', 'Bitrate', `${kbps(info.bitrate)}${info.cbr ? ' constant' : ' variable'}`, '192 kbps or more, constant', info.bitrate >= 192000 && info.cbr);
    if (!mono) add('acx', 'Stereo mode', info.jointStereo ? 'joint stereo' : 'stereo', 'not joint stereo', !info.jointStereo);
  }
  add('acx', 'Sample rate', khz, '44.1 kHz', info.sampleRate === 44100);
  add('acx', 'RMS', fmtDb(stats.rmsDb), '-23 to -18 dB', stats.rmsDb >= -23 && stats.rmsDb <= -18);
  add('acx', 'Peak', fmtDb(stats.peakDb), '-3 dB or lower', stats.peakDb <= -3);
  add('acx', 'Noise floor', fmtDb(stats.noiseDb), '-60 dB or lower', stats.noiseDb <= -60);
  // Pure digital silence passes the number but is not room tone; Audacity's ACX Check flags it.
  if (stats.noiseDb < -90) add('acx', 'Room tone', 'digital silence', 'a little room tone, not pure silence', false, true);
  add('acx', 'Silence at the start', `${stats.headSec.toFixed(2)} s`, '0.5 to 1 s', stats.headSec >= 0.5 && stats.headSec <= 1);
  add('acx', 'Silence at the end', `${stats.tailSec.toFixed(2)} s`, '1 to 5 s', stats.tailSec >= 1 && stats.tailSec <= 5);
  add('acx', 'Length', `${(stats.seconds / 60).toFixed(1)} min`, '120 min or less', stats.seconds <= 120 * 60);

  // Google Play Books: MP3 or M4A at 128 kbps+ mono or 256 kbps+ stereo (constant preferred), or 16-bit
  // FLAC or WAV at 44.1 kHz or more.
  const lossy = fmt === 'mp3' || fmt === 'm4a' || fmt === 'aac';
  const lossless = fmt === 'flac' || fmt === 'wav';
  add('google', 'Format', fmt.toUpperCase(), 'MP3, M4A, AAC, FLAC or WAV', lossy || lossless);
  if (lossy) {
    const need = mono ? 128000 : 256000;
    add('google', 'Bitrate', `${kbps(info.bitrate)} ${mono ? 'mono' : 'stereo'}`, `${kbps(need)} or more`, info.bitrate >= need);
    if (info.cbr === false) add('google', 'Bitrate mode', 'variable', 'constant preferred', false, true);
  }
  if (lossless) {
    add('google', 'Bit depth', `${info.bits}-bit`, '16-bit', info.bits === 16);
    add('google', 'Sample rate', khz, '44.1 kHz or more', info.sampleRate >= 44100);
  }

  // Kobo: everything at 96 kbps or more is re-encoded to 64 kbps; it recommends sending 192 kbps or more.
  if (lossy) add('kobo', 'Bitrate', kbps(info.bitrate), '192 kbps or more recommended', info.bitrate >= 192000, true);
  else add('kobo', 'Format', fmt.toUpperCase(), 'MP3 expected', fmt === 'mp3', true);
  return out;
}

/** Checks that span the whole book rather than one file. */
export function judgeBook(files) {
  const out = [];
  const chans = new Set(files.map((f) => f.info.channels));
  if (files.length > 1) out.push({ retailer: 'acx', check: 'Channels', value: chans.size > 1 ? 'mono and stereo mixed' : chans.has(1) ? 'all mono' : 'all stereo', need: 'all mono or all stereo', level: chans.size > 1 ? 'fail' : 'pass' });
  const total = files.reduce((s, f) => s + (f.stats?.seconds ?? 0), 0);
  out.push({ retailer: 'google', check: 'Total length', value: `${(total / 60).toFixed(1)} min`, need: '5 min to 100 hours', level: total >= 300 && total <= 360000 ? 'pass' : 'fail' });
  return out;
}
