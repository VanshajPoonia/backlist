// The three public-domain books the tests read from, fetched once from Project Gutenberg
// into tests/.cache/books (not committed).
//
//   62   A Princess of Mars, Edgar Rice Burroughs (1912): invented names on every page
//   244  A Study in Scarlet, Arthur Conan Doyle (1887): Dr., Mr., years, places, Roman numerals
//   46   A Christmas Carol, Charles Dickens (1843): the lines compare.js was tuned on

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const BOOKS = { 62: 'A Princess of Mars', 244: 'A Study in Scarlet', 46: 'A Christmas Carol' };
const DIR = new URL('../tests/.cache/books/', import.meta.url);

export async function ensureBooks() {
  mkdirSync(DIR, { recursive: true });
  for (const id of Object.keys(BOOKS)) {
    const file = new URL(`pg${id}.txt`, DIR);
    if (existsSync(file)) continue;
    console.log(`downloading ${BOOKS[id]} from Project Gutenberg ...`);
    for (let i = 0; ; i++) {
      try {
        const res = await fetch(`https://www.gutenberg.org/cache/epub/${id}/pg${id}.txt`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        writeFileSync(file, await res.text());
        break;
      } catch (err) {
        if (i >= 4) throw err;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await ensureBooks();
