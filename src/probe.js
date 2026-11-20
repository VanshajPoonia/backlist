// What is in an audio file before it is decoded: format, sample rate, channels, bitrate and
// whether the bitrate is constant. Retailers check all of these, and the browser's decoder
// hides them (it hands back samples at its own rate), so they are read from the headers.
//
// Every function takes a reader, { size, read(offset, length) -> Promise<Uint8Array> }, so a
// two-hour file is never loaded whole. fileReader() makes one from a browser File.

export const fileReader = (file) => ({ size: file.size, read: async (o, n) => new Uint8Array(await file.slice(o, o + n).arrayBuffer()) });
export const bytesReader = (b) => ({ size: b.length, read: async (o, n) => b.subarray(o, Math.min(b.length, o + n)) });

const ascii = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));
const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const le16 = (b, o) => b[o] | (b[o + 1] << 8);

/**
 * @returns {Promise<{format:string, sampleRate?:number, channels?:number, bits?:number, bitrate?:number,
 *   cbr?:boolean|null, jointStereo?:boolean, seconds?:number, dataOffset?:number, dataSize?:number, cuts?:number[]}>}
 * bitrate is in bits per second. cbr is null when the format does not say.
 */
export async function probe(reader) {
  const head = await reader.read(0, 64);
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WAVE') return wavInfo(reader);
  if (ascii(head, 0, 4) === 'fLaC') return flacInfo(reader, head);
  if (ascii(head, 4, 4) === 'ftyp') return mp4Info(reader);
  if (head[0] === 0xff && (head[1] & 0xf6) === 0xf0) return adtsInfo(reader);
  if (ascii(head, 0, 3) === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) return mp3Info(reader);
  return { format: ascii(head, 0, 4) === 'OggS' ? 'ogg' : 'unknown' };
}

// ---- WAV ------------------------------------------------------------------------------------

async function wavInfo(reader) {
  let o = 12, fmt = null;
  while (o + 8 <= reader.size) {
    const h = await reader.read(o, 8);
    const id = ascii(h, 0, 4), size = le32(h, 4);
    if (id === 'fmt ') {
      const f = await reader.read(o + 8, Math.min(size, 40));
      let tag = le16(f, 0);
      if (tag === 0xfffe && size >= 26) tag = le16(f, 24); // WAVE_FORMAT_EXTENSIBLE: the real format is in the sub-format GUID
      fmt = { tag, channels: le16(f, 2), sampleRate: le32(f, 4), bits: le16(f, 14) };
    } else if (id === 'data' && fmt) {
      const dataSize = Math.min(size, reader.size - o - 8);
      const bitrate = fmt.sampleRate * fmt.channels * fmt.bits;
      return {
        format: fmt.tag === 3 ? 'wav-float' : fmt.tag === 1 ? 'wav' : `wav-${fmt.tag}`,
        sampleRate: fmt.sampleRate, channels: fmt.channels, bits: fmt.bits, bitrate, cbr: true,
        seconds: (dataSize * 8) / bitrate, dataOffset: o + 8, dataSize,
      };
    }
    o += 8 + size + (size & 1);
  }
  return { format: 'wav', error: 'no audio data found' };
}

/** Uncompressed WAV straight to samples, a slice at a time: no decoder, any length. */
export async function* wavSlices(reader, info, seconds = 60) {
  const bps = info.bits / 8, frame = bps * info.channels;
  const step = Math.max(1, Math.floor(info.sampleRate * seconds)) * frame;
  for (let at = 0; at < info.dataSize; at += step) {
    const b = await reader.read(info.dataOffset + at, Math.min(step, info.dataSize - at));
    const n = Math.floor(b.length / frame);
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const ch = Array.from({ length: info.channels }, () => new Float32Array(n));
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < info.channels; c++) {
        const p = i * frame + c * bps;
        ch[c][i] = info.format === 'wav-float' ? (bps === 8 ? v.getFloat64(p, true) : v.getFloat32(p, true))
          : bps === 2 ? v.getInt16(p, true) / 32768
            : bps === 3 ? (((b[p] | (b[p + 1] << 8) | (b[p + 2] << 16)) << 8) >> 8) / 8388608
              : bps === 4 ? v.getInt32(p, true) / 2147483648 : (b[p] - 128) / 128;
      }
    }
    yield { channels: ch, rate: info.sampleRate, t0: at / frame / info.sampleRate };
  }
}

// ---- MP3 ------------------------------------------------------------------------------------

const MP3_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
const MP3_KBPS = {
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

/** One MPEG audio layer III frame header, or null. */
export function mp3Frame(b, o) {
  if (b[o] !== 0xff || (b[o + 1] & 0xe0) !== 0xe0) return null;
  const ver = (b[o + 1] >> 3) & 3, layer = (b[o + 1] >> 1) & 3;
  const bi = b[o + 2] >> 4, si = (b[o + 2] >> 2) & 3, pad = (b[o + 2] >> 1) & 1, mode = b[o + 3] >> 6;
  if (ver === 1 || layer !== 1 || bi === 0 || bi === 15 || si === 3) return null;
  const rate = MP3_RATES[ver][si], kbps = MP3_KBPS[ver === 3 ? 1 : 2][bi];
  const samples = ver === 3 ? 1152 : 576;
  return { rate, kbps, samples, mode, size: Math.floor((samples / 8) * (kbps * 1000) / rate) + pad, mpeg1: ver === 3 };
}

async function mp3Info(reader) {
  let start = 0;
  const id3 = await reader.read(0, 10);
  if (ascii(id3, 0, 3) === 'ID3') start = 10 + ((id3[6] << 21) | (id3[7] << 14) | (id3[8] << 7) | id3[9]) + (id3[5] & 0x10 ? 10 : 0);
  // Walk every frame header: it is the only reliable way to know the bitrate is constant.
  const CHUNK = 1 << 20;
  let buf = new Uint8Array(0), base = start, o = 0, frames = 0, samples = 0, first = null, xing = null, lost = 0;
  const kbps = new Map(), cuts = [start];
  let nextCut = 60;
  while (base + o < reader.size) {
    if (o + 4 > buf.length) {
      const rest = buf.subarray(o);
      const more = await reader.read(base + buf.length, CHUNK);
      if (!more.length) break;
      const nb = new Uint8Array(rest.length + more.length);
      nb.set(rest); nb.set(more, rest.length);
      base += o; buf = nb; o = 0;
      continue;
    }
    const f = mp3Frame(buf, o);
    if (!f || (first && f.rate !== first.rate)) { o++; lost++; if (lost > 65536 && !first) break; continue; }
    if (!first) {
      first = f;
      // A Xing/Info header lives in the first frame, after the side information.
      const side = f.mpeg1 ? (f.mode === 3 ? 17 : 32) : (f.mode === 3 ? 9 : 17);
      if (o + 4 + side + 4 > buf.length) { const more = await reader.read(base + buf.length, CHUNK); const nb = new Uint8Array(buf.length + more.length); nb.set(buf); nb.set(more, buf.length); buf = nb; }
      const tag = ascii(buf, o + 4 + side, 4);
      if (tag === 'Xing' || tag === 'Info') xing = tag;
      else if (ascii(buf, o + 36, 4) === 'VBRI') xing = 'VBRI';
      if (xing) { o += f.size; continue; } // the tag frame is silent and not counted
    }
    frames++;
    kbps.set(f.kbps, (kbps.get(f.kbps) ?? 0) + 1);
    samples += f.samples;
    if (samples / f.rate >= nextCut) { cuts.push(base + o); nextCut += 60; }
    o += f.size;
  }
  if (!first) return { format: 'mp3', error: 'no MPEG audio frames found' };
  const seconds = samples / first.rate;
  const avg = [...kbps].reduce((s, [k, n]) => s + k * n, 0) / Math.max(1, frames);
  return {
    format: 'mp3', sampleRate: first.rate, channels: first.mode === 3 ? 1 : 2, jointStereo: first.mode === 1,
    bitrate: Math.round(avg) * 1000, cbr: kbps.size === 1 && xing !== 'Xing' && xing !== 'VBRI', seconds, frames, cuts,
  };
}

// ---- MP4 / M4A / M4B ------------------------------------------------------------------------

async function boxes(reader, from, to) {
  const out = [];
  for (let o = from; o + 8 <= to;) {
    const h = await reader.read(o, 16);
    let size = u32(h, 0), hl = 8;
    if (size === 1) { size = u32(h, 8) * 2 ** 32 + u32(h, 12); hl = 16; }
    if (size === 0) size = to - o;
    if (size < hl) break;
    out.push({ type: ascii(h, 4, 4), start: o, body: o + hl, end: o + size });
    o += size;
  }
  return out;
}

const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

async function mp4Info(reader) {
  const top = await boxes(reader, 0, reader.size);
  const moov = top.find((b) => b.type === 'moov');
  const mdat = top.filter((b) => b.type === 'mdat').reduce((s, b) => s + (b.end - b.body), 0);
  if (!moov) return { format: 'm4a', error: 'no moov box' };
  const m = await reader.read(moov.start, moov.end - moov.start);
  const mb = bytesReader(m);
  const find = async (from, to, path) => {
    let list = await boxes(mb, from, to);
    for (const [i, t] of path.entries()) {
      const hits = list.filter((b) => b.type === t);
      if (i === path.length - 1 || !hits.length) return hits;
      list = (await Promise.all(hits.map((h) => boxes(mb, h.body, h.end)))).flat();
    }
    return [];
  };
  for (const trak of await find(moov.body - moov.start, m.length, ['trak'])) {
    const [hdlr] = await find(trak.body, trak.end, ['mdia', 'hdlr']);
    if (!hdlr || ascii(m, hdlr.body + 8, 4) !== 'soun') continue;
    const [mdhd] = await find(trak.body, trak.end, ['mdia', 'mdhd']);
    const v1 = m[mdhd.body] === 1;
    const scale = u32(m, mdhd.body + (v1 ? 20 : 12));
    const dur = v1 ? u32(m, mdhd.body + 24) * 2 ** 32 + u32(m, mdhd.body + 28) : u32(m, mdhd.body + 16);
    const [stsd] = await find(trak.body, trak.end, ['mdia', 'minf', 'stbl', 'stsd']);
    const entry = stsd.body + 8; // version, flags, entry count
    const codec = ascii(m, entry + 4, 4);
    let channels = u16(m, entry + 8 + 16), sampleRate = u16(m, entry + 8 + 24);
    let avgBitrate = 0;
    const esds = codec === 'mp4a' ? (await boxes(mb, entry + 36, u32(m, entry) + entry)).find((b) => b.type === 'esds') : null;
    if (esds) {
      // ES descriptor (tag 3), then the decoder config (tag 4) that holds the average bitrate.
      const skipLen = (q) => { while (m[q] & 0x80) q++; return q + 1; };
      let q = esds.body + 4;
      if (m[q] === 3) {
        q = skipLen(q + 1);
        const flags = m[q + 2];
        q += 3 + (flags & 0x80 ? 2 : 0) + (flags & 0x40 ? 1 + m[q + 3] : 0) + (flags & 0x20 ? 2 : 0);
      }
      if (m[q] === 4) {
        q = skipLen(q + 1);
        avgBitrate = u32(m, q + 9);
        // AudioSpecificConfig (tag 5): object type, rate index, channel layout. The sample entry's own
        // channel count is often a fixed 2, so this is the one to trust.
        if (m[q + 13] === 5) {
          const a = skipLen(q + 14), ri = ((m[a] & 7) << 1) | (m[a + 1] >> 7), cfg = (m[a + 1] >> 3) & 15;
          if (AAC_RATES[ri]) sampleRate = AAC_RATES[ri];
          if (cfg >= 1 && cfg <= 7) channels = cfg === 7 ? 8 : cfg;
        }
      }
    }
    const seconds = scale ? dur / scale : 0;
    return {
      format: codec === 'mp4a' ? 'm4a' : `mp4-${codec}`, codec, sampleRate, channels,
      bitrate: avgBitrate || (seconds ? Math.round((mdat * 8) / seconds) : 0), cbr: null, seconds,
    };
  }
  return { format: 'm4a', error: 'no audio track' };
}

/** Raw AAC (.aac): a run of ADTS frames of 1024 samples each. */
async function adtsInfo(reader) {
  let o = 0, frames = 0, sampleRate = 0, channels = 0, buf = new Uint8Array(0), base = 0;
  while (o + 7 <= reader.size) {
    if (o + 7 > base + buf.length) { base = o; buf = await reader.read(o, 1 << 20); }
    const h = buf.subarray(o - base, o - base + 7);
    if (h[0] !== 0xff || (h[1] & 0xf6) !== 0xf0) break;
    sampleRate = AAC_RATES[(h[2] >> 2) & 15];
    channels = ((h[2] & 1) << 2) | (h[3] >> 6);
    const len = ((h[3] & 3) << 11) | (h[4] << 3) | (h[5] >> 5);
    if (len < 7) break;
    frames++;
    o += len;
  }
  const seconds = sampleRate ? (frames * 1024) / sampleRate : 0;
  return { format: 'aac', sampleRate, channels, bitrate: seconds ? Math.round((o * 8) / seconds) : 0, cbr: null, seconds };
}

// ---- FLAC -----------------------------------------------------------------------------------

async function flacInfo(reader, head) {
  // STREAMINFO is always the first metadata block: 20-bit rate, 3-bit channels - 1, 5-bit bits - 1, 36-bit samples.
  const b = head.subarray(8);
  const sampleRate = (b[10] << 12) | (b[11] << 4) | (b[12] >> 4);
  const channels = ((b[12] >> 1) & 7) + 1, bits = (((b[12] & 1) << 4) | (b[13] >> 4)) + 1;
  const total = (b[13] & 15) * 2 ** 32 + u32(b, 14);
  const seconds = sampleRate ? total / sampleRate : 0;
  return { format: 'flac', sampleRate, channels, bits, bitrate: seconds ? Math.round((reader.size * 8) / seconds) : 0, cbr: null, seconds };
}
