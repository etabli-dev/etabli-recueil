/**
 * Zotero annotations onto Recueil annotations (ADR-0009, ADR-0017, `spec/data-model.md` §4.9).
 *
 * Zotero stores an annotation as a type number, a colour, a `sortIndex` and a `position` JSON blob
 * whose shape depends on the type. Recueil stores the W3C Web Annotation selector set, of which at
 * least one member must resolve without the extracted text layer (invariant AN4) — so every
 * mapping here emits a page-anchored selector, and the text quote is an addition rather than the
 * anchor.
 *
 * | Zotero | Recueil type | Motivation | Selectors |
 * |---|---|---|---|
 * | 1 highlight | `highlight` | `highlighting` | `TextQuoteSelector` + `RectangleSelector` + page |
 * | 2 note | `note` | `commenting` | `RectangleSelector` + page |
 * | 3 image | `area` | `describing` | `RectangleSelector` + page |
 * | 4 ink | `ink` | `describing` | `InkSelector` + page |
 * | 5 underline | `underline` | `highlighting` | `TextQuoteSelector` + `RectangleSelector` + page |
 * | 6 text | `text` | `commenting` | `TextQuoteSelector` + `RectangleSelector` + page |
 *
 * `position_sort_key` is Zotero's `sortIndex` — `spec/data-model.md` §4.9 calls the column "the
 * portable equivalent of Zotero's sortIndex", and the most faithful thing to do with an equivalent
 * is to carry the original across. It is only padded to a fixed width, so that the lexicographic
 * comparison the column exists for is total even across Zotero versions that pad differently.
 */
import type { AnnotationTypeName, MotivationName } from '../recueil-vocabularies.js';
import type { ZoteroAnnotationRow, ZoteroPosition } from '../reader/types.js';

export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type AnnotationSelector =
  | { type: 'TextQuoteSelector'; exact: string; prefix?: string; suffix?: string }
  | { type: 'FragmentSelector'; conformsTo: string; value: string }
  | { type: 'RectangleSelector'; pageIndex: number; rectangles: Rectangle[] }
  | { type: 'InkSelector'; pageIndex: number; paths: Array<Array<{ x: number; y: number }>>; strokeWidth?: number };

export interface MappedAnnotation {
  annotationType: AnnotationTypeName;
  motivation: MotivationName;
  selector: AnnotationSelector[];
  quotedText: string | null;
  bodyText: string | null;
  colour: string | null;
  pageIndex: number | null;
  pageLabel: string | null;
  positionSortKey: string;
  authorName: string | null;
  isExternal: boolean;
}

/** The PDF fragment specification, as `FragmentSelector.conformsTo` names it. */
const PDF_FRAGMENT = 'http://tools.ietf.org/rfc/rfc3778';

const TYPES: Readonly<Record<number, { type: AnnotationTypeName; motivation: MotivationName }>> = {
  1: { type: 'highlight', motivation: 'highlighting' },
  2: { type: 'note', motivation: 'commenting' },
  3: { type: 'area', motivation: 'describing' },
  4: { type: 'ink', motivation: 'describing' },
  5: { type: 'underline', motivation: 'highlighting' },
  6: { type: 'text', motivation: 'commenting' },
};

export class UnmappableAnnotationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnmappableAnnotationError';
  }
}

/** Map one row of `itemAnnotations`. Throws only for a type this code has never heard of. */
export const mapZoteroAnnotation = (row: ZoteroAnnotationRow): MappedAnnotation => {
  const kind = TYPES[row.type];
  if (kind === undefined) {
    throw new UnmappableAnnotationError(
      `Zotero annotation type ${row.type} is not one of the six this importer knows (1 highlight, ` +
        '2 note, 3 image, 4 ink, 5 underline, 6 text).',
    );
  }

  const position = parsePosition(row.position);
  const pageIndex = typeof position.pageIndex === 'number' ? position.pageIndex : null;
  const quoted = nullIfBlank(row.text);
  const comment = nullIfBlank(row.comment);

  const selector: AnnotationSelector[] = [];
  if (quoted !== null && kind.type !== 'area' && kind.type !== 'ink') {
    selector.push({ type: 'TextQuoteSelector', exact: quoted });
  }
  if (kind.type === 'ink') {
    const paths = (position.paths ?? [])
      .map(toPoints)
      .filter((path) => path.length >= 2);
    if (paths.length > 0 && pageIndex !== null) {
      const ink: AnnotationSelector = { type: 'InkSelector', pageIndex, paths };
      if (typeof position.width === 'number') ink.strokeWidth = position.width;
      selector.push(ink);
    }
  } else {
    const rectangles = (position.rects ?? []).map(toRectangle).filter((rect) => rect !== null) as Rectangle[];
    if (rectangles.length > 0 && pageIndex !== null) {
      selector.push({ type: 'RectangleSelector', pageIndex, rectangles });
    }
  }
  if (pageIndex !== null) {
    selector.push({ type: 'FragmentSelector', conformsTo: PDF_FRAGMENT, value: `page=${pageIndex + 1}` });
  }
  if (selector.length === 0) {
    throw new UnmappableAnnotationError(
      'The annotation carries no page and no coordinates, so no selector can resolve it without ' +
        'the text layer (invariant AN4).',
    );
  }

  return {
    annotationType: kind.type,
    motivation: kind.motivation,
    selector,
    quotedText: quoted,
    // `ck_annotations_body` requires a note annotation to have a body. A Zotero note with an empty
    // comment is unusual and real; an empty string records "there is a body and it says nothing",
    // which is true, where null would break the check and lose the annotation.
    bodyText: kind.type === 'note' ? (comment ?? '') : comment,
    colour: normaliseColour(row.color),
    pageIndex,
    pageLabel: nullIfBlank(row.pageLabel),
    positionSortKey: normaliseSortIndex(row.sortIndex),
    authorName: nullIfBlank(row.authorName),
    isExternal: row.isExternal === 1,
  };
};

/**
 * Zotero's `sortIndex` is `page|offset|y`, already fixed-width within one Zotero version.
 *
 * Each segment is re-padded to a known width so that comparison stays total across versions and
 * across a library whose rows were written by different ones.
 */
export const normaliseSortIndex = (sortIndex: string): string => {
  const segments = (sortIndex ?? '').split('|');
  const widths = [5, 6, 5];
  return widths
    .map((width, index) => {
      const raw = (segments[index] ?? '').trim();
      const digits = /^\d+$/u.test(raw) ? raw : '0';
      return digits.length >= width ? digits.slice(-width) : digits.padStart(width, '0');
    })
    .join('|');
};

const parsePosition = (json: string): ZoteroPosition => {
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null ? (parsed as ZoteroPosition) : {};
  } catch {
    return {};
  }
};

/** Zotero writes `[x1, y1, x2, y2]` in PDF user space, origin bottom-left. */
const toRectangle = (rect: number[]): Rectangle | null => {
  if (rect.length < 4) return null;
  const [x1, y1, x2, y2] = rect as [number, number, number, number];
  if (![x1, y1, x2, y2].every((value) => Number.isFinite(value))) return null;
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
};

/** Zotero writes an ink path as a flat `[x, y, x, y, …]`. */
const toPoints = (path: number[]): Array<{ x: number; y: number }> => {
  const points: Array<{ x: number; y: number }> = [];
  for (let index = 0; index + 1 < path.length; index += 2) {
    const x = path[index] as number;
    const y = path[index + 1] as number;
    if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x, y });
  }
  return points;
};

/** `HexColourSchema` wants `#rrggbb`; Zotero writes exactly that, but not every plugin does. */
const normaliseColour = (value: string | null): string | null => {
  const text = (value ?? '').trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/u.test(text)) return text;
  if (/^#[0-9a-f]{3}$/u.test(text)) {
    const [, r, g, b] = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/u.exec(text) as unknown as string[];
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return null;
};

const nullIfBlank = (value: string | null | undefined): string | null => {
  const text = (value ?? '').trim();
  return text === '' ? null : text;
};
