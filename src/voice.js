// Kokoro-82M, the narrator. Runs in the browser and in Node on the same transformers.js
// build as the listener, so one runtime does both jobs.
//
// Text handling is ported from kokoro-js by Joshua Lochner (Apache-2.0), itself a port of
// hexgrad's Kokoro: a little normalisation, then espeak-ng phonemes (via the `phonemizer`
// package), then the model. The caller passes in transformers.js and phonemizer (from
// jsDelivr in the browser, from npm in Node).

export const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
export const SAMPLE_RATE = 24000;

// The voices offered in the app: the ones the Kokoro authors grade highest for long-form.
export const VOICES = {
  af_heart: { name: 'Heart', accent: 'American', gender: 'female' },
  af_bella: { name: 'Bella', accent: 'American', gender: 'female' },
  af_nicole: { name: 'Nicole', accent: 'American', gender: 'female' },
  am_michael: { name: 'Michael', accent: 'American', gender: 'male' },
  am_fenrir: { name: 'Fenrir', accent: 'American', gender: 'male' },
  bf_emma: { name: 'Emma', accent: 'British', gender: 'female' },
  bm_george: { name: 'George', accent: 'British', gender: 'male' },
  bm_fable: { name: 'Fable', accent: 'British', gender: 'male' },
};

// ---- Kokoro's own normalisation (kokoro-js, unchanged in behaviour) --------------------

function splitNum(m) {
  if (m.includes('.')) return m;
  if (m.includes(':')) {
    const [h, min] = m.split(':').map(Number);
    return min === 0 ? `${h} o'clock` : min < 10 ? `${h} oh ${min}` : `${h} ${min}`;
  }
  const y = parseInt(m.slice(0, 4), 10);
  if (y < 1100 || y % 1000 < 10) return m;
  const left = m.slice(0, 2), right = parseInt(m.slice(2, 4), 10), s = m.endsWith('s') ? 's' : '';
  if (y % 1000 >= 100 && y % 1000 <= 999) {
    if (right === 0) return `${left} hundred${s}`;
    if (right < 10) return `${left} oh ${right}${s}`;
  }
  return `${left} ${right}${s}`;
}

function flipMoney(m) {
  const bill = m[0] === '$' ? 'dollar' : 'pound';
  if (isNaN(Number(m.slice(1)))) return `${m.slice(1)} ${bill}s`;
  if (!m.includes('.')) return `${m.slice(1)} ${bill}${m.slice(1) === '1' ? '' : 's'}`;
  const [b, c] = m.slice(1).split('.');
  const cents = parseInt(c.padEnd(2, '0'), 10);
  const coins = m[0] === '$' ? (cents === 1 ? 'cent' : 'cents') : cents === 1 ? 'penny' : 'pence';
  return `${b} ${bill}${b === '1' ? '' : 's'} and ${cents} ${coins}`;
}

const pointNum = (m) => { const [a, b] = m.split('.'); return `${a} point ${b.split('').join(' ')}`; };

export function kokoroNormalize(t) {
  return t
    .replace(/[‘’]/g, "'").replace(/«/g, '“').replace(/»/g, '”').replace(/[“”]/g, '"')
    .replace(/\(/g, '«').replace(/\)/g, '»')
    .replace(/[^\S \n]/g, ' ').replace(/  +/, ' ').replace(/(?<=\n) +(?=\n)/g, '')
    .replace(/\bD[Rr]\.(?= [A-Z])/g, 'Doctor')
    .replace(/\b(?:Mr\.|MR\.(?= [A-Z]))/g, 'Mister')
    .replace(/\b(?:Ms\.|MS\.(?= [A-Z]))/g, 'Miss')
    .replace(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/g, 'Mrs')
    .replace(/\betc\.(?! [A-Z])/gi, 'etc')
    .replace(/\b(y)eah?\b/gi, "$1e'a")
    .replace(/\d*\.\d+|\b\d{4}s?\b|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)/g, splitNum)
    .replace(/(?<=\d),(?=\d)/g, '')
    .replace(/[$£]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|[$£]\d+\.\d\d?\b/gi, flipMoney)
    .replace(/\d*\.\d+/g, pointNum)
    .replace(/(?<=\d)-(?=\d)/g, ' to ')
    .replace(/(?<=\d)S/g, ' S')
    .replace(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/g, "'S")
    .replace(/(?<=X')S\b/g, 's')
    .replace(/(?:[A-Za-z]\.){2,} [a-z]/g, (m) => m.replace(/\./g, '-'))
    .replace(/(?<=[A-Z])\.(?=[A-Z])/gi, '-')
    .trim();
}

const PUNCT = new RegExp(`(\\s*[${';:,.!?¡¿\u2014…"«»“”(){}[]'.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}]+\\s*)+`, 'g');

async function toPhonemes(phonemize, text, lang) {
  const chunks = [];
  let at = 0;
  for (const m of text.matchAll(PUNCT)) {
    if (at < m.index) chunks.push({ punct: false, text: text.slice(at, m.index) });
    if (m[0].length) chunks.push({ punct: true, text: m[0] });
    at = m.index + m[0].length;
  }
  if (at < text.length) chunks.push({ punct: false, text: text.slice(at) });
  const espeak = lang === 'a' ? 'en-us' : 'en';
  const parts = await Promise.all(chunks.map(async (c) => (c.punct ? c.text : (await phonemize(c.text, espeak)).join(' '))));
  let p = parts.join('')
    .replace(/kəkˈoːɹoʊ/g, 'kˈoʊkəɹoʊ').replace(/kəkˈɔːɹəʊ/g, 'kˈəʊkəɹəʊ')
    .replace(/ʲ/g, 'j').replace(/r/g, 'ɹ').replace(/x/g, 'k').replace(/ɬ/g, 'l')
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, ' ')
    .replace(/ z(?=[;:,.!?¡¿\u2014…"«»“” ]|$)/g, 'z');
  if (lang === 'a') p = p.replace(/(?<=nˈaɪn)ti(?!ː)/g, 'di');
  return p.trim();
}

// ---- the model ---------------------------------------------------------------------------

async function fetchVoice(name) {
  const url = `https://huggingface.co/${MODEL}/resolve/main/voices/${name}.bin`;
  let cache;
  try { cache = await caches.open('backlist-voices'); const hit = await cache.match(url); if (hit) return hit.arrayBuffer(); } catch { /* no Cache Storage */ }
  const res = await fetch(url);
  const buf = await res.arrayBuffer();
  try { await cache?.put(url, new Response(buf.slice(0))); } catch { /* quota */ }
  return buf;
}

/**
 * @param {object} tf  transformers.js
 * @param {(text:string, lang:string)=>Promise<string[]>} phonemize  from the phonemizer package
 * @param {{dtype?:string, device?:string, progress_callback?:Function, readVoice?:(name:string)=>Promise<ArrayBuffer>}} opts
 */
export async function loadVoice(tf, phonemize, { dtype = 'q8', device, progress_callback, readVoice = fetchVoice } = {}) {
  const [model, tokenizer] = await Promise.all([
    tf.StyleTextToSpeech2Model.from_pretrained(MODEL, { dtype, device, progress_callback }),
    tf.AutoTokenizer.from_pretrained(MODEL, { progress_callback }),
  ]);
  const styles = new Map();
  const style = async (name) => {
    if (!styles.has(name)) styles.set(name, new Float32Array(await readVoice(name)));
    return styles.get(name);
  };

  return {
    /** The phonemes Kokoro will be given, after its own normalisation. */
    phonemes: (text, voice = 'af_heart') => toPhonemes(phonemize, kokoroNormalize(text), voice[0]),

    /** @returns {{audio: Float32Array, phonemes: string, tokens: number}} 24 kHz mono */
    async speak(text, { voice = 'af_heart', speed = 1 } = {}) {
      const phonemes = await toPhonemes(phonemize, kokoroNormalize(text), voice[0]);
      const { input_ids } = tokenizer(phonemes, { truncation: true });
      const n = input_ids.dims.at(-1);
      const s = await style(voice);
      const at = 256 * Math.min(Math.max(n - 2, 0), 509);
      const { waveform } = await model({
        input_ids,
        style: new tf.Tensor('float32', s.slice(at, at + 256), [1, 256]),
        speed: new tf.Tensor('float32', [speed], [1]),
      });
      return { audio: waveform.data, phonemes, tokens: n };
    },
  };
}
