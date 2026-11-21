/**
 * Export a PDF with its annotations embedded (CONCEPT §7 Phase 4, ADR-0009, AN1).
 *
 * The stored document is never modified: this writes a *new* PDF, which goes into the store as its
 * own document with its own hash, recorded as derived from the original. Every reader — Acrobat,
 * Preview, Okular, Zotero, a phone — then shows the highlights, underlines, notes and ink.
 *
 * Mapping, one PDF annotation per record:
 * - `highlight`, `underline`, `strikeout` with rectangles → the matching text-markup annotation,
 *   one QuadPoints entry per rectangle;
 * - `note` (or any record with a comment and no rectangles) → a Text annotation at its position;
 * - `ink` → an Ink annotation with its paths;
 * - an `area` (`image`) record → a Square annotation.
 * The comment goes into `/Contents`, the author into `/T`, the colour into `/C`.
 */
import type { schema } from '@recueil/core';

type AnnotationRow = schema.AnnotationRow;
import { PDFArray, PDFDocument, PDFName, PDFNumber, PDFString } from 'pdf-lib';
import type { PDFDict, PDFPage } from 'pdf-lib';

type Rect = { x: number; y: number; width: number; height: number };
type Selector =
  | { type: 'RectangleSelector'; pageIndex: number; rectangles: Rect[] }
  | { type: 'InkSelector'; pageIndex: number; paths: { x: number; y: number }[][]; strokeWidth?: number }
  | { type: string; [key: string]: unknown };

const MARKUP: Record<string, string> = { highlight: 'Highlight', underline: 'Underline', strikeout: 'StrikeOut' };

const colourOf = (hex: string | null, fallback: [number, number, number]): number[] => {
  const match = hex === null ? null : /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(hex);
  if (match === null) return fallback;
  return [1, 2, 3].map((index) => Number.parseInt(match[index]!, 16) / 255);
};

const numbers = (doc: PDFDocument, values: readonly number[]): PDFArray => {
  const array = doc.context.obj([]) as PDFArray;
  for (const value of values) array.push(PDFNumber.of(Number(value.toFixed(3))));
  return array;
};

const bounds = (rects: readonly Rect[]): [number, number, number, number] => {
  const x1 = Math.min(...rects.map((r) => r.x));
  const y1 = Math.min(...rects.map((r) => r.y));
  const x2 = Math.max(...rects.map((r) => r.x + r.width));
  const y2 = Math.max(...rects.map((r) => r.y + r.height));
  return [x1, y1, x2, y2];
};

const addAnnotation = (doc: PDFDocument, page: PDFPage, dict: PDFDict): void => {
  const ref = doc.context.register(dict);
  const existing = page.node.lookup(PDFName.of('Annots'));
  if (existing instanceof PDFArray) existing.push(ref);
  else page.node.set(PDFName.of('Annots'), doc.context.obj([ref]));
};

export interface AnnotatedPdf {
  bytes: Uint8Array;
  embedded: number;
  skipped: { annotationId: string; reason: string }[];
}

export const embedAnnotations = async (original: Uint8Array, rows: readonly AnnotationRow[]): Promise<AnnotatedPdf> => {
  const doc = await PDFDocument.load(original, { updateMetadata: false });
  const pages = doc.getPages();
  const skipped: AnnotatedPdf['skipped'] = [];
  let embedded = 0;

  for (const row of rows) {
    const selectors = JSON.parse(row.selector) as Selector[];
    const rect = selectors.find((s) => s.type === 'RectangleSelector') as Extract<Selector, { type: 'RectangleSelector' }> | undefined;
    const ink = selectors.find((s) => s.type === 'InkSelector') as Extract<Selector, { type: 'InkSelector' }> | undefined;
    const pageIndex = rect?.pageIndex ?? ink?.pageIndex ?? row.pageIndex;
    if (pageIndex === null || pageIndex === undefined || pageIndex >= pages.length) {
      skipped.push({ annotationId: row.id, reason: 'no page this PDF has' });
      continue;
    }
    const page = pages[pageIndex]!;
    const common: Record<string, unknown> = {
      Type: 'Annot',
      NM: PDFString.of(`recueil:${row.publicId}`),
      M: PDFString.of(`D:${row.updatedAt.replace(/[-:T]/gu, '').slice(0, 14)}Z`),
      F: 4,
    };
    if (row.bodyText) common['Contents'] = PDFString.of(row.bodyText);
    if (row.authorName) common['T'] = PDFString.of(row.authorName);

    let dict: PDFDict | null = null;
    if (rect !== undefined && MARKUP[row.annotationType] !== undefined) {
      const quads = rect.rectangles.flatMap((r) => [r.x, r.y + r.height, r.x + r.width, r.y + r.height, r.x, r.y, r.x + r.width, r.y]);
      dict = doc.context.obj({
        ...common,
        Subtype: MARKUP[row.annotationType]!,
        Rect: numbers(doc, bounds(rect.rectangles)),
        QuadPoints: numbers(doc, quads),
        C: numbers(doc, colourOf(row.colour, [1, 0.85, 0.2])),
      } as never) as unknown as PDFDict;
    } else if (ink !== undefined) {
      const all = ink.paths.flat();
      const inkList = doc.context.obj([]) as PDFArray;
      for (const path of ink.paths) inkList.push(numbers(doc, path.flatMap((p) => [p.x, p.y])));
      dict = doc.context.obj({
        ...common,
        Subtype: 'Ink',
        Rect: numbers(doc, [Math.min(...all.map((p) => p.x)), Math.min(...all.map((p) => p.y)), Math.max(...all.map((p) => p.x)), Math.max(...all.map((p) => p.y))]),
        InkList: inkList,
        C: numbers(doc, colourOf(row.colour, [0.9, 0.1, 0.1])),
        BS: doc.context.obj({ W: ink.strokeWidth ?? 1 }),
      } as never) as unknown as PDFDict;
    } else if (rect !== undefined) {
      dict = doc.context.obj({
        ...common,
        Subtype: 'Square',
        Rect: numbers(doc, bounds(rect.rectangles)),
        C: numbers(doc, colourOf(row.colour, [0.2, 0.4, 0.9])),
      } as never) as unknown as PDFDict;
    } else if (row.bodyText) {
      const { height } = page.getSize();
      dict = doc.context.obj({
        ...common,
        Subtype: 'Text',
        Rect: numbers(doc, [20, height - 40, 40, height - 20]),
        Name: 'Comment',
        C: numbers(doc, colourOf(row.colour, [1, 0.85, 0.2])),
      } as never) as unknown as PDFDict;
    }
    if (dict === null) {
      skipped.push({ annotationId: row.id, reason: 'nothing a PDF annotation can show' });
      continue;
    }
    addAnnotation(doc, page, dict);
    embedded += 1;
  }

  return { bytes: await doc.save({ useObjectStreams: false }), embedded, skipped };
};
