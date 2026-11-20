// Manuscripts that are not plain text, turned into the plain text manuscript.js reads:
// paragraphs separated by blank lines, headings on their own line.
//
// An EPUB is a zip of XHTML files. Browsers (and Node) can inflate zip entries with the built-in
// DecompressionStream, so no library is needed.

const le16 = (b, o) => b[o] | (b[o + 1] << 8);
const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

async function inflate(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** @returns {Promise<Map<string, () => Promise<Uint8Array>>>}  each entry unpacked on demand */
export async function unzip(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let end = -1;
  for (let o = b.length - 22; o >= Math.max(0, b.length - 22 - 65535); o--) if (le32(b, o) === 0x06054b50) { end = o; break; }
  if (end < 0) throw new Error('not a zip file');
  const out = new Map();
  for (let o = le32(b, end + 16), n = le16(b, end + 10); n > 0; n--) {
    if (le32(b, o) !== 0x02014b50) throw new Error('damaged zip directory');
    const method = le16(b, o + 10), size = le32(b, o + 20), nameLen = le16(b, o + 28);
    const local = le32(b, o + 42);
    const name = new TextDecoder().decode(b.subarray(o + 46, o + 46 + nameLen));
    const data = local + 30 + le16(b, local + 26) + le16(b, local + 28);
    out.set(name, async () => {
      const raw = b.subarray(data, data + size);
      if (method === 0) return raw;
      if (method === 8) return inflate(raw);
      throw new Error(`${name}: unsupported compression`);
    });
    o += 46 + nameLen + le16(b, o + 30) + le16(b, o + 32);
  }
  return out;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', eacute: 'é', egrave: 'è', aacute: 'á', agrave: 'à', ccedil: 'ç', ouml: 'ö', uuml: 'ü', auml: 'ä' };
const decode = (s) => s.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m));

/** XHTML -> text. Headings become "# Title" so manuscript.js starts a chapter there. */
export function htmlText(html) {
  const s = html
    .replace(/<head[\s\S]*?<\/head>|<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, '')
    .replace(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi, (m, t) => `\n\n# ${t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}\n\n`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|blockquote|section|h[4-6]|tr|pre)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');
  return decode(s).replace(/\u00a0/g, ' ').split(/\n\s*\n/).map((p) => p.replace(/[ \t\r\f\v]+/g, ' ').replace(/ *\n */g, '\n').trim()).filter(Boolean).join('\n\n');
}

/** The book's text in reading order, following the OPF spine. */
export async function epubText(bytes) {
  const zip = await unzip(bytes);
  const read = async (name) => {
    const get = zip.get(name) ?? zip.get(decodeURIComponent(name));
    if (!get) throw new Error(`${name} is missing from the EPUB`);
    return new TextDecoder().decode(await get());
  };
  const container = await read('META-INF/container.xml');
  const opfPath = container.match(/full-path\s*=\s*"([^"]+)"/)?.[1];
  if (!opfPath) throw new Error('no package file in the EPUB');
  const opf = await read(opfPath);
  const dir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const items = new Map();
  for (const m of opf.matchAll(/<item\b[^>]*>/g)) {
    const id = m[0].match(/\bid\s*=\s*"([^"]+)"/)?.[1], href = m[0].match(/\bhref\s*=\s*"([^"]+)"/)?.[1];
    if (id && href) items.set(id, href);
  }
  const parts = [];
  for (const m of opf.matchAll(/<itemref\b[^>]*\bidref\s*=\s*"([^"]+)"[^>]*>/g)) {
    if (/linear\s*=\s*"no"/.test(m[0])) continue;
    const href = items.get(m[1]);
    if (href) parts.push(htmlText(await read(dir + href.split('#')[0])));
  }
  return parts.filter(Boolean).join('\n\n');
}

/** Markdown -> text: drop front matter, links, images and list markers; keep headings and scene breaks. */
export function markdownText(md) {
  return md
    .replace(/\r\n?/g, '\n')
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^(.+)\n=+\s*$/gm, '# $1')
    .replace(/^([^\n#>*-].*)\n-{3,}\s*$/gm, '## $1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]{0,3}>[ \t]?/gm, '')
    .replace(/^[ \t]{0,3}(?:[-+]|\d+\.)[ \t]+(?=\S)/gm, '')
    .replace(/^[ \t]{0,3}\*[ \t]+(?=\S)(?!\*)/gm, '')
    .replace(/`([^`]+)`/g, '$1');
}

/** Any supported manuscript file -> text. `mammoth` reads .docx and is passed in by the page. */
export async function manuscriptText(name, bytes, mammoth) {
  const ext = name.toLowerCase().split('.').pop();
  if (ext === 'epub') return epubText(bytes);
  if (ext === 'docx') return (await mammoth.extractRawText({ arrayBuffer: bytes.buffer ?? bytes })).value;
  const text = new TextDecoder().decode(bytes);
  if (ext === 'md' || ext === 'markdown') return markdownText(text);
  if (ext === 'html' || ext === 'htm' || ext === 'xhtml') return htmlText(text);
  return text;
}
