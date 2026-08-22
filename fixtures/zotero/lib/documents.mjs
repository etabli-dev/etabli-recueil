/*
 * Recueil — fixtures
 * Copyright (C) 2026 the Recueil authors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The files the fixture's attachments point at.
 *
 * They are generated, never downloaded: a fixture must be redistributable, and the point of the
 * attachment fixtures is the plumbing — hashes, paths, missing files, MIME types — not the content.
 * Each PDF is a complete, valid, one-page document of about a kilobyte that any reader will open.
 */

/** Latin-1 is what a PDF name/string object is written in without an encoding dictionary. */
const LATIN1 = 'latin1';

/**
 * Build a minimal but structurally complete single-page PDF: header, catalogue, page tree, one
 * page, one Helvetica text object, a correct cross-reference table and a trailer. Deterministic —
 * the same arguments always produce byte-identical output, so regenerating the fixture does not
 * change any hash.
 *
 * @param {object} spec
 * @param {string} spec.title     the `/Title` of the document information dictionary
 * @param {string[]} spec.lines   the lines drawn on the page (ASCII; anything else is transliterated
 *                                by the caller, since a real font resource would be needed for more)
 * @returns {Buffer}
 */
export function minimalPdf({ title, lines }) {
  const text = lines
    .map((line, index) => `BT /F1 11 Tf 72 ${720 - index * 16} Td (${escapePdfString(line)}) Tj ET`)
    .join('\n');
  const content = `q\n${text}\nQ\n`;

  /** @type {string[]} object bodies, 1-indexed by position + 1 */
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content, LATIN1)} >>\nstream\n${content}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Title (${escapePdfString(title)}) /Producer (Recueil fixture generator) ` +
      '/CreationDate (D:20240101000000Z) >>',
  ];

  let pdf = '%PDF-1.4\n%âãÏÓ\n';
  /** @type {number[]} byte offset of each object, for the xref table */
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, LATIN1));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const startxref = Buffer.byteLength(pdf, LATIN1);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\n` +
    `startxref\n${startxref}\n%%EOF\n`;

  return Buffer.from(pdf, LATIN1);
}

/** `(`, `)` and `\` are the only characters a literal PDF string must escape. */
function escapePdfString(value) {
  return asciiFold(value).replace(/([\\()])/g, '\\$1');
}

/**
 * Reduce a string to printable ASCII. The one-page PDFs carry no embedded font, so a `ü` drawn with
 * WinAnsi Helvetica would render but would not survive text extraction predictably. The metadata in
 * `zotero.sqlite` keeps the real characters; only the drawn page is folded.
 *
 * @param {string} value
 * @returns {string}
 */
export function asciiFold(value) {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/ß/g, 'ss')
    .replace(/[Œœ]/g, (m) => (m === 'Œ' ? 'OE' : 'oe'))
    .replace(/[^\x20-\x7e]/g, '?');
}

/**
 * A single-file web-page snapshot, the shape Zotero's `imported_url` attachments take. Kept plain
 * so that an importer's MIME sniffing and charset handling have something honest to chew on: the
 * charset is declared in a `<meta>` tag and the body is genuinely UTF-8.
 *
 * @param {object} spec
 * @param {string} spec.title
 * @param {string} spec.url
 * @param {string} spec.body
 * @returns {Buffer}
 */
export function snapshotHtml({ title, url, body }) {
  const html = [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${escapeHtml(title)}</title>`,
    `<link rel="canonical" href="${escapeHtml(url)}">`,
    '</head>',
    '<body>',
    `<h1>${escapeHtml(title)}</h1>`,
    `<p>${escapeHtml(body)}</p>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
  return Buffer.from(html, 'utf8');
}

function escapeHtml(value) {
  return value.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  );
}
