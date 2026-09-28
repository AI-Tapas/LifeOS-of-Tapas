// B22. Plain text out of a Word (.docx) file, in memory, server-side, for
// lifeos_read_mail_attachment only.
//
// No new dependency. A .docx is a zip archive whose main text is the XML part
// word/document.xml. This reads the zip's central directory by hand (the
// format is fixed and small) and inflates that one entry with Node's
// built-in zlib, the same raw deflate every zip uses. The XML is then reduced
// to its text: paragraph and line breaks become newlines, tabs become tabs,
// every tag goes, and the five XML entities (plus numeric ones) are decoded.
//
// Limits: the inflated XML is capped (INFLATE_CAP) so a zip bomb cannot eat
// memory, only stored and deflated entries are read, and anything that does
// not parse returns "" rather than throwing. No macros, no embedded objects,
// no headers or footers: body text only.

import { inflateRawSync } from "node:zlib";

export const INFLATE_CAP = 20 * 1024 * 1024;

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

// The bytes of one named entry, or null when it is not there.
export function zipEntry(bytes: Uint8Array, name: string): Uint8Array | null {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < 22) return null;
  // The end-of-central-directory record sits in the last 22 bytes plus an
  // optional comment of at most 65,535 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== CENTRAL_SIG) return null;
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const entryName = buf.toString("utf8", p + 46, p + 46 + nameLen);
    if (entryName === name) {
      if (local + 30 > buf.length || buf.readUInt32LE(local) !== LOCAL_SIG) return null;
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + compressed);
      if (method === 0) return new Uint8Array(data);
      if (method === 8) return new Uint8Array(inflateRawSync(data, { maxOutputLength: INFLATE_CAP }));
      return null;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// word/document.xml to plain text.
export function documentXmlText(xml: string): string {
  return decodeEntities(
    xml
      .replace(/<w:tab\/>/g, "\t")
      .replace(/<w:(br|cr)\b[^>]*\/>/g, "\n")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function docxText(bytes: Uint8Array, cap: number): Promise<string> {
  // A zip starts with a local file header; anything else is not read at all.
  if (bytes.length < 4 || Buffer.from(bytes.subarray(0, 4)).readUInt32LE(0) !== LOCAL_SIG) return "";
  try {
    const xml = zipEntry(bytes, "word/document.xml");
    if (!xml) return "";
    return documentXmlText(Buffer.from(xml).toString("utf8")).slice(0, cap);
  } catch {
    return "";
  }
}
