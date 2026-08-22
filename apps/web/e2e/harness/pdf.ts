/**
 * A small, deterministic PDF, built by hand.
 *
 * The reader test has to assert two things that only a *known* document can support: that the
 * canvas drew ink, and that the text layer contains the words that are printed on page one. A
 * fixture copied from somewhere else would make the second assertion a guess about a file, so the
 * bytes are generated here — uncompressed content streams, one standard font, and text chosen so
 * that a match cannot be a coincidence.
 *
 * Two pages, because "renders page 1" is only a claim worth making about a document that has more
 * than one page to get wrong.
 */

/** Printed on page one, and asserted against the text layer PDF.js builds. */
export const PAGE_ONE_TEXT = 'Recueil end-to-end page one';

/** Printed on page two, so that "page 1 is showing" is distinguishable from "a page is showing". */
export const PAGE_TWO_TEXT = 'Recueil end-to-end page two';

const pageStream = (text: string): string =>
  `BT /F1 24 Tf 72 700 Td (${text}) Tj ET\n`;

/**
 * Assemble the file.
 *
 * A PDF is a list of numbered objects followed by a cross-reference table of their byte offsets, so
 * the objects are serialised first and the offsets recorded as they go; `startxref` then points at
 * the table. Getting those offsets wrong is the one way to produce something that looks like a PDF
 * and opens in nothing, so they are measured from the buffer rather than counted by hand.
 */
export const buildTwoPagePdf = (): Buffer => {
  const contentOne = pageStream(PAGE_ONE_TEXT);
  const contentTwo = pageStream(PAGE_TWO_TEXT);

  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${contentOne.length} >>\nstream\n${contentOne}endstream`,
    `<< /Length ${contentTwo.length} >>\nstream\n${contentTwo}endstream`,
  ];

  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%âãÏÓ\n', 'latin1')];
  const offsets: number[] = [];
  let length = chunks[0]?.byteLength ?? 0;

  objects.forEach((body, index) => {
    offsets.push(length);
    const chunk = Buffer.from(`${index + 1} 0 obj\n${body}\nendobj\n`, 'latin1');
    chunks.push(chunk);
    length += chunk.byteLength;
  });

  const xrefOffset = length;
  const entries = offsets
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  const trailer =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${entries}` +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  chunks.push(Buffer.from(trailer, 'latin1'));

  return Buffer.concat(chunks);
};
