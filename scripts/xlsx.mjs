// Just enough of .xlsx to read one worksheet's cells as text, with no
// dependencies: the collector installs nothing, and a whole spreadsheet
// library for one table would be most of the repo.
//
// An .xlsx is a zip of XML parts. Read the zip's central directory, inflate the
// first worksheet and the shared-string table, and walk the cells.
import { inflateRawSync } from 'node:zlib';

function unzip(buf) {
  // End-of-central-directory record: within the last 64 KiB + 22 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('xlsx: not a zip');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('xlsx: bad central directory');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    files[name] = () => {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      if (method === 0) return data.toString('utf8');
      if (method === 8) return inflateRawSync(data).toString('utf8');
      throw new Error(`xlsx: compression method ${method}`);
    };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const unescapeXml = s => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&amp;/g, '&');

// All the text runs of one <si> or <is>, joined: rich text splits a string
// into several <t> elements.
const textOf = xml => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m => unescapeXml(m[1])).join('');

const colIndex = ref => {
  const letters = /^[A-Z]+/.exec(ref)[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

/** Rows of the first worksheet, each an array of cell strings ('' for empty). */
export function readFirstSheet(buf) {
  const files = unzip(buf);
  const sheetName = files['xl/worksheets/sheet1.xml'] ? 'xl/worksheets/sheet1.xml'
    : Object.keys(files).filter(f => /^xl\/worksheets\/[^/]+\.xml$/.test(f)).sort()[0];
  if (!sheetName) throw new Error('xlsx: no worksheet');
  const shared = files['xl/sharedStrings.xml']
    ? [...files['xl/sharedStrings.xml']().matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => textOf(m[1]))
    : [];

  const rows = [];
  for (const rm of files[sheetName]().matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1], inner = cm[2] || '';
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs);
      const type = (/\bt="(\w+)"/.exec(attrs) || [])[1];
      const v = (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1];
      let text = '';
      if (type === 's') text = v != null ? (shared[+v] ?? '') : '';
      else if (type === 'inlineStr') text = textOf(inner);
      else text = v != null ? unescapeXml(v) : '';
      const i = ref ? colIndex(ref[1]) : row.length;
      while (row.length < i) row.push('');
      row[i] = text;
    }
    rows.push(row);
  }
  return rows;
}
