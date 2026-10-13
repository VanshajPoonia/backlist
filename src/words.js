// Numbers and Roman numerals as spoken English. Used twice: to turn a manuscript into what
// the narrator should say, and to compare that with what the listener heard (which may come
// back as "1878", "eighteen seventy-eight" or "XVIII" for the same audio).

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES = [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']];

export function cardinal(n) {
  if (n < 0) return `minus ${cardinal(-n)}`;
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : '');
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${cardinal(n % 100)}` : ''}`;
  for (const [v, name] of SCALES) {
    if (n >= v) return `${cardinal(Math.floor(n / v))} ${name}${n % v ? ` ${cardinal(n % v)}` : ''}`;
  }
  return String(n);
}

const ORD = { one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' };
export function ordinal(n) {
  const words = cardinal(n).split(' ');
  const last = words.pop();
  const o = ORD[last] ?? (last.endsWith('y') ? `${last.slice(0, -1)}ieth` : `${last}th`);
  return [...words, o].join(' ');
}

/** 1878 -> "eighteen seventy eight", 1900 -> "nineteen hundred", 2005 -> "two thousand five". */
export function year(n) {
  if (n >= 2000 && n < 2010) return cardinal(n);
  const hi = Math.floor(n / 100), lo = n % 100;
  if (lo === 0) return `${cardinal(hi)} hundred`;
  return `${cardinal(hi)} ${lo < 10 ? `oh ${ONES[lo]}` : cardinal(lo)}`;
}

const ROMAN = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
export function roman(s) {
  if (!/^[IVXLCDM]+$/.test(s)) return null;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const v = ROMAN[s[i]], next = ROMAN[s[i + 1]] ?? 0;
    n += v < next ? -v : v;
  }
  // Reject things that only look like numerals ("MIX", "DID", "CIVIL" is not even a match).
  return toRoman(n) === s ? n : null;
}
function toRoman(n) {
  const t = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let s = '';
  for (const [v, r] of t) while (n >= v) { s += r; n -= v; }
  return s;
}
