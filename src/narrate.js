// What the narrator should actually say, written out so it cannot be misread.
//
// Kokoro already expands Mr./Mrs./Dr., years, prices and clock times on its own (see
// voice.js). These are the extra rules a book needs on top, each one added because the
// proof-listener caught Kokoro getting it wrong without it (tests/proof.mjs measures them).

import { cardinal, ordinal, roman } from './words.js';

const TITLES = {
  Capt: 'Captain', Col: 'Colonel', Gen: 'General', Lt: 'Lieutenant', Sgt: 'Sergeant', Cpl: 'Corporal', Maj: 'Major',
  Adm: 'Admiral', Prof: 'Professor', Rev: 'Reverend', Revd: 'Reverend', Hon: 'Honourable', Gov: 'Governor', Sen: 'Senator',
  Rep: 'Representative', Pres: 'President', Supt: 'Superintendent', Insp: 'Inspector', Fr: 'Father', Mme: 'Madame',
  Mlle: 'Mademoiselle', Messrs: 'Messieurs', Mt: 'Mount',
};
const AFTER = { Jr: 'Junior', Sr: 'Senior', Esq: 'Esquire' };

// Monarchs and popes whose numbers are read as ordinals: "Henry VIII" is "Henry the Eighth".
const REGNAL = new Set(['Elizabeth', 'Charles', 'James', 'George', 'Henry', 'Edward', 'William', 'Richard', 'Louis', 'Napoleon',
  'Peter', 'Catherine', 'Mary', 'Victoria', 'Alexander', 'Frederick', 'Philip', 'Pius', 'John', 'Leo', 'Gregory', 'Innocent',
  'Ferdinand', 'Francis', 'Nicholas', 'Ivan', 'Carlos', 'Juan', 'Gustavus', 'Benedict', 'Clement', 'Urban', 'Boniface', 'Stephen', 'David', 'Robert', 'Malcolm', 'Anne']);
// Book structure, where the number is a cardinal: "Chapter IV" is "Chapter Four".
const SECTION = 'Chapter|Part|Book|Stave|Volume|Vol\\.|Act|Scene|Canto|Section|Letter|Appendix';

const titleCase = (s) => s.toLowerCase().replace(/(^|[\s"“‘(-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
const STARTERS = new Set(['In', 'The', 'He', 'She', 'It', 'We', 'I', 'They', 'A', 'An', 'But', 'And', 'On', 'At', 'This', 'That',
  'There', 'When', 'Then', 'His', 'Her', 'My', 'Our', 'As', 'So', 'If', 'You', 'Yes', 'No', 'Not', 'What', 'Who', 'Why', 'How']);

/** Headings arrive in capitals ("CHAPTER IV. A PRISONER"), which some voices spell out. */
export function heading(line) {
  const t = line.trim().replace(/\s+/g, ' ');
  const caps = t === t.toUpperCase() && /[A-Z]{2}/.test(t);
  let s = caps ? titleCase(t).replace(/\b([ivxlcdm]+)\b/gi, (m) => (roman(m.toUpperCase()) ? m.toUpperCase() : m)) : t;
  s = s.replace(new RegExp(`\\b(${SECTION})\\s+([IVXLCDM]+|\\d+)\\b`, 'gi'), (m, k, n) => {
    const v = /\d/.test(n) ? Number(n) : roman(n.toUpperCase());
    return v ? `${k} ${titleCase(cardinal(v))}` : m;
  });
  if (!/[.!?:]$/.test(s)) s += '.';
  return s;
}

/**
 * @param {string} text  one sentence, as written
 * @param {{word:string, say:string}[]} guide  the author's pronunciation guide
 */
export function narrate(text, guide = []) {
  let s = text;

  // Markdown-ish emphasis and stray markup.
  s = s.replace(/(^|\W)[*_]{1,2}([^*_]+?)[*_]{1,2}(?=\W|$)/g, '$1$2');

  // Roman numerals: book structure (cardinal), monarchs and popes (ordinal), world wars.
  s = s.replace(new RegExp(`\\b(${SECTION})\\s+([IVXLCDM]+)\\b`, 'g'), (m, k, n) => (roman(n) ? `${k} ${cardinal(roman(n))}` : m));
  s = s.replace(/\b([A-Z][a-z]+)\s+([IVXLCDM]+)\b/g, (m, name, n) => {
    const v = roman(n);
    if (!v) return m;
    if (REGNAL.has(name)) return `${name} the ${ordinal(v)}`;
    if (name === 'War') return `${name} ${cardinal(v)}`;
    return m;
  });

  // Saint or Street: "St. Paul's" vs "Baker St." / "221 Baker St". After a name or a
  // number it is a street, unless a name follows ("John St. Clair"); a word that usually
  // starts a sentence ("Baker St. In the morning") does not count as a name.
  s = s.replace(/(\b[A-Z][a-z]+|\d)\s+St\b(\.?)(?=(\s+[A-Z][a-z]*)?)/g, (m, before, dot, next) =>
    (!next || STARTERS.has(next.trim()) ? `${before} Street${dot}` : m));
  s = s.replace(/\bSt\b\.?(?=\s+[A-Z])/g, 'Saint');

  for (const [k, v] of Object.entries(TITLES)) s = s.replace(new RegExp(`\\b${k}\\.(?=\\s)`, 'g'), v);
  for (const [k, v] of Object.entries(AFTER)) s = s.replace(new RegExp(`(,?\\s)${k}\\.?(?=$|[\\s,;:.!?])`, 'g'), ` ${v}`);
  s = s.replace(/\bNo\.\s?(?=\d)/g, 'number ').replace(/\bNos\.\s?(?=\d)/g, 'numbers ');
  s = s.replace(/\bvs?\.\s/g, 'versus ').replace(/\be\.g\.,?\s/gi, 'for example, ').replace(/\bi\.e\.,?\s/gi, 'that is, ');
  s = s.replace(/\bviz\.,?\s/g, 'namely, ').replace(/\bcf\.\s/g, 'compare ').replace(/\bapprox\.\s/gi, 'approximately ');

  // Ordinals and symbols.
  s = s.replace(/\b(\d+)(?:st|nd|rd|th)\b/g, (m, n) => ordinal(Number(n)));
  s = s.replace(/\s*&\s*/g, ' and ').replace(/(\d)\s?%/g, '$1 percent').replace(/(\d)\s?°\s?([CF])\b/g, (m, d, u) => `${d} degrees ${u === 'C' ? 'Celsius' : 'Fahrenheit'}`).replace(/°/g, ' degrees');
  s = s.replace(/§\s?/g, 'section ');

  // Shouting: a long all-capitals word is a word, not a set of initials. Short ones (FBI,
  // USA) are left for the voice to spell.
  s = s.replace(/\b[A-Z]{4,}\b/g, (w) => (/[AEIOUY]/.test(w) ? w.toLowerCase() : w));

  // The author's pronunciation guide comes last, so it wins.
  for (const { word, say } of guide) {
    if (!word.trim() || !say.trim()) continue;
    const esc = word.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp(`(?<![\\p{L}])${esc}(?=(?:['’]s)?(?![\\p{L}]))`, 'gu'), say.trim().replace(/-/g, ' '));
  }

  return s.replace(/\s{2,}/g, ' ').trim();
}

/** "Dejah Thoris = Day-jah Thor-iss", one per line. */
export function parseGuide(text) {
  return text.split('\n').map((l) => l.split(/\s*[=→:]\s*/)).filter((p) => p.length === 2 && p[0] && p[1]).map(([word, say]) => ({ word: word.trim(), say: say.trim() }));
}
