// A minimal, deterministic text-only PDF: PDF 1.4, the standard Helvetica fonts with WinAnsiEncoding, uncompressed
// content streams and no dates or random identifiers, so the same text always gives the same bytes and the same SHA-256.
// The live lane renders catalogue records with it (catalogue-ecat.ts), so a record follows the same pinned-hash,
// layout, review and publication path as any document and is cited by page like one.
export interface TextBlock { text: string; size?: number; bold?: boolean; gapBefore?: number }

const PAGE = { width: 595, height: 842, margin: 56 } as const; // A4, in points
const MAX_PAGES = 40, MAX_TEXT = 200_000;
// WinAnsiEncoding codes for the characters it holds outside Latin-1 (PDF 32000-1, Annex D).
const WIN_ANSI: Readonly<Record<string, number>> = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89, "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c,
  "Ž": 0x8e, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "˜": 0x98, "™": 0x99, "š": 0x9a, "›": 0x9b,
  "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f,
};
// Characters WinAnsi lacks, written as a reader would expect: the Greek mu as the micro sign, the minus sign as a hyphen.
const SUBSTITUTE: Readonly<Record<string, string>> = {
  "\u03bc": "\u00b5", "\u2212": "-", "\u2010": "-", "\u2011": "-", "\u2032": "'", "\u2033": "\"", "\u2265": ">=", "\u2264": "<=",
  "\u2248": "~", "\u2192": "->", "\u00a0": " ", "\u2009": " ", "\u202f": " ", "\u200b": "", "\t": " ",
};
export function winAnsi(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const sub = SUBSTITUTE[ch];
    if (sub !== undefined) { out.push(...winAnsi(sub)); continue; }
    const code = ch.codePointAt(0)!;
    if (code >= 0x20 && code <= 0x7e) out.push(code);
    else if (Object.hasOwn(WIN_ANSI, ch)) out.push(WIN_ANSI[ch]);
    else if (code >= 0xa1 && code <= 0xff) out.push(code);
    else out.push(0x3f);
  }
  return out;
}
// A PDF literal string kept in ASCII: delimiters escaped and every other byte above 126 written in octal.
const literal = (bytes: number[]) => `(${bytes.map((b) => b === 0x28 || b === 0x29 || b === 0x5c ? `\\${String.fromCharCode(b)}` : b > 0x7e ? `\\${b.toString(8).padStart(3, "0")}` : String.fromCharCode(b)).join("")})`;
// Document-information strings are text strings, so the title is written as UTF-16BE with its byte order mark.
const textString = (s: string) => `<FEFF${Buffer.from(s, "utf16le").swap16().toString("hex").toUpperCase()}>`;
// Approximate Helvetica advance widths in thousandths of an em. Generous, so a wrapped line never runs past the margin.
const NARROW = new Set([...".,:;'|!()[]`ilIjtfr "]), WIDE = new Set([..."mwMW@%"]);
const advance = (b: number) => { const c = String.fromCharCode(b); return NARROW.has(c) ? 300 : WIDE.has(c) ? 920 : b >= 0x41 && b <= 0x5a ? 720 : 570; };
function wrap(bytes: number[], size: number, bold: boolean): number[][] {
  const limit = ((PAGE.width - 2 * PAGE.margin) * 1000) / (size * (bold ? 1.06 : 1));
  const lines: number[][] = []; let line: number[] = [], used = 0;
  const words: number[][] = []; let word: number[] = [];
  for (const b of bytes) { if (b === 0x20) { if (word.length) words.push(word); word = []; } else word.push(b); }
  if (word.length) words.push(word);
  for (const w of words) {
    const width = w.reduce((n, b) => n + advance(b), 0), space = line.length ? advance(0x20) : 0;
    if (used + space + width <= limit) { if (line.length) line.push(0x20); line.push(...w); used += space + width; continue; }
    if (line.length) lines.push(line);
    line = []; used = 0;
    for (const b of w) { if (used + advance(b) > limit) { lines.push(line); line = []; used = 0; } line.push(b); used += advance(b); }
  }
  if (line.length || !lines.length) lines.push(line);
  return lines;
}
export function textPdf(title: string, blocks: TextBlock[]): Buffer {
  if (blocks.reduce((n, b) => n + b.text.length, 0) > MAX_TEXT) throw new Error("Text exceeds the rendering bound");
  const pages: string[][] = [[]]; const top = PAGE.height - PAGE.margin; let y = top;
  for (const block of blocks) {
    const size = block.size ?? 10, font = block.bold ? "F2" : "F1", leading = Math.round(size * 1.4 * 100) / 100;
    y -= block.gapBefore ?? 0;
    for (const paragraph of block.text.split("\n")) for (const line of wrap(winAnsi(paragraph), size, !!block.bold)) {
      y -= leading;
      if (y < PAGE.margin) { pages.push([]); y = top - leading; if (pages.length > MAX_PAGES) throw new Error("Text exceeds the page bound"); }
      if (line.length) pages.at(-1)!.push(`BT /${font} ${size} Tf ${PAGE.margin} ${y.toFixed(2)} Td ${literal(line)} Tj ET`);
    }
  }
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${6 + 2 * i} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    `<< /Title ${textString(title)} /Producer (GeoBasin Explorer AI catalogue importer) >>`,
  ];
  for (const [i, lines] of pages.entries()) {
    const content = lines.join("\n");
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${7 + 2 * i} 0 R >>`);
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  const parts = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")], offsets: number[] = [];
  let length = parts[0].length;
  for (const [i, body] of objects.entries()) {
    offsets.push(length);
    const part = Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`, "latin1"); parts.push(part); length += part.length;
  }
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${length}\n%%EOF\n`, "latin1"));
  return Buffer.concat(parts);
}
