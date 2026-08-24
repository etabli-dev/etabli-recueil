/*
 * Recueil — fixtures
 * Copyright (C) 2026 the Recueil authors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * A PDF writer with exactly the two things the ingestion fixtures need to tell apart: a page whose
 * words are in a text object, and a page whose words are in a raster.
 *
 * `fixtures/zotero/lib/documents.mjs` already writes one-page text PDFs and is deliberately left
 * alone — every byte it emits is hashed into the committed Zotero fixture. This module is the
 * Phase 2 sibling: multi-page, image-only, mixed, and `/Rotate`-carrying documents.
 *
 * Deterministic: no clock, no counter that depends on call order, `zlib.deflateSync` at a pinned
 * level. Regenerating the corpus produces byte-identical files.
 */
import zlib from 'node:zlib';

/** Literal PDF strings and stream bytes are Latin-1; there is no encoding dictionary here. */
const LATIN1 = 'latin1';

/**
 * @typedef {object} PageSpec
 * @property {number} [width]   points; default A4
 * @property {number} [height]  points; default A4
 * @property {number} [rotate]  0, 90, 180 or 270 — the `/Rotate` a scanner writes for a page fed
 *                              in sideways. A pipeline that ignores it OCRs a rotated raster.
 * @property {{ width: number, height: number, pixels: Uint8Array }} [image]
 *          an 8-bit greyscale raster drawn to fill the page. Its presence is what makes a page
 *          "scanned"; its absence plus `text` is what makes a page "born digital".
 * @property {string[]} [text]  lines placed in a text object, i.e. a real text layer
 * @property {number} [textSize]
 * @property {number} [textTop]
 */

/**
 * @param {object} spec
 * @param {string} spec.title
 * @param {string} [spec.producer]
 * @param {string} [spec.creator]
 * @param {PageSpec[]} spec.pages
 * @returns {Buffer}
 */
export function buildPdf({ title, producer = 'Recueil fixture generator', creator, pages }) {
  if (!pages.length) throw new Error('a PDF fixture needs at least one page');

  /** @type {Buffer[]} object bodies; index + 1 is the object number. */
  const objects = [];
  const alloc = (body) => {
    objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body, LATIN1));
    return objects.length;
  };
  const placeholder = () => alloc('null');
  const replace = (number, body) => {
    objects[number - 1] = Buffer.isBuffer(body) ? body : Buffer.from(body, LATIN1);
  };

  const catalogue = placeholder();
  const pageTree = placeholder();
  const fontNeeded = pages.some((page) => page.text?.length);
  const font = fontNeeded
    ? alloc('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
    : null;

  /** @type {number[]} */
  const pageObjects = [];
  for (const page of pages) {
    const width = page.width ?? 595;
    const height = page.height ?? 842;
    const parts = [];
    /** @type {string[]} */
    const resources = [];

    let imageObject = null;
    if (page.image) {
      const data = zlib.deflateSync(Buffer.from(page.image.pixels), { level: 9 });
      imageObject = alloc(
        Buffer.concat([
          Buffer.from(
            '<< /Type /XObject /Subtype /Image ' +
              `/Width ${page.image.width} /Height ${page.image.height} ` +
              '/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode ' +
              `/Length ${data.length} >>\nstream\n`,
            LATIN1,
          ),
          data,
          Buffer.from('\nendstream', LATIN1),
        ]),
      );
      resources.push(`/XObject << /Im0 ${imageObject} 0 R >>`);
      parts.push(`q\n${width} 0 0 ${height} 0 0 cm\n/Im0 Do\nQ`);
    }

    if (page.text?.length) {
      const size = page.textSize ?? 11;
      const top = page.textTop ?? height - 72;
      resources.push(`/Font << /F1 ${font} 0 R >>`);
      parts.push(
        page.text
          .map(
            (line, index) =>
              `BT /F1 ${size} Tf 64 ${top - index * (size + 5)} Td ` +
              `(${escapePdfString(line)}) Tj ET`,
          )
          .join('\n'),
      );
    }

    const content = `${parts.join('\n')}\n`;
    const contentObject = alloc(
      `<< /Length ${Buffer.byteLength(content, LATIN1)} >>\nstream\n${content}endstream`,
    );

    const pageObject = placeholder();
    replace(
      pageObject,
      `<< /Type /Page /Parent ${pageTree} 0 R /MediaBox [0 0 ${width} ${height}] ` +
        `/Resources << ${resources.join(' ')} >> /Contents ${contentObject} 0 R` +
        `${page.rotate ? ` /Rotate ${page.rotate}` : ''} >>`,
    );
    pageObjects.push(pageObject);
  }

  const info = alloc(
    `<< /Title (${escapePdfString(title)}) /Producer (${escapePdfString(producer)})` +
      `${creator ? ` /Creator (${escapePdfString(creator)})` : ''}` +
      ' /CreationDate (D:20240101000000Z) /ModDate (D:20240101000000Z) >>',
  );

  replace(catalogue, `<< /Type /Catalog /Pages ${pageTree} 0 R >>`);
  replace(
    pageTree,
    `<< /Type /Pages /Kids [${pageObjects.map((n) => `${n} 0 R`).join(' ')}] ` +
      `/Count ${pageObjects.length} >>`,
  );

  /* -- serialise --------------------------------------------------------------------------- */
  const chunks = [Buffer.from('%PDF-1.5\n%\xe2\xe3\xcf\xd3\n', LATIN1)];
  let offset = chunks[0].length;
  /** @type {number[]} */
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(offset);
    const head = Buffer.from(`${index + 1} 0 obj\n`, LATIN1);
    const tail = Buffer.from('\nendobj\n', LATIN1);
    chunks.push(head, body, tail);
    offset += head.length + body.length + tail.length;
  });

  const startxref = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) xref += `${String(at).padStart(10, '0')} 00000 n \n`;
  xref +=
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalogue} 0 R /Info ${info} 0 R >>\n` +
    `startxref\n${startxref}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, LATIN1));

  return Buffer.concat(chunks);
}

/**
 * WinAnsi fills Latin-1's unused C1 range with typographic punctuation, and the corpus uses it:
 * German quotation marks, en and em dashes, a euro sign. Without this table those characters would
 * have to be folded away, and a text layer that has been folded to ASCII is not a text layer worth
 * extracting from.
 */
const WINANSI = {
  '€': 0x80,
  '‚': 0x82,
  '„': 0x84,
  '…': 0x85,
  '†': 0x86,
  '‡': 0x87,
  '‰': 0x89,
  '‹': 0x8b,
  Œ: 0x8c,
  '‘': 0x91,
  '’': 0x92,
  '“': 0x93,
  '”': 0x94,
  '•': 0x95,
  '–': 0x96,
  '—': 0x97,
  '™': 0x99,
  '›': 0x9b,
  œ: 0x9c,
  Ÿ: 0x9f,
};

/**
 * `(`, `)` and `\` must be escaped in a literal string; anything with no WinAnsi code point would
 * be a lie on the page, so it is refused rather than mangled.
 */
function escapePdfString(value) {
  let out = '';
  for (const char of value) {
    const code = WINANSI[char] ?? char.codePointAt(0);
    if (char === '\\' || char === '(' || char === ')') out += `\\${char}`;
    else if (code >= 0x20 && code <= 0x7e) out += char;
    else if (code <= 0xff) out += `\\${code.toString(8).padStart(3, '0')}`;
    else throw new Error(`${JSON.stringify(char)} cannot be written to a WinAnsi PDF text object`);
  }
  return out;
}
