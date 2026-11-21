/**
 * Between the screen and PDF user space (ADR-0009: rectangles are stored in PDF units, origin
 * bottom-left, so they mean the same thing at every zoom, on every device and in the PDF export).
 *
 * Pure functions over a minimal viewport, so they are tested without a browser.
 */

export interface PdfRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The two PDF.js viewport conversions the reader needs. */
export interface ViewportLike {
  convertToPdfPoint(x: number, y: number): number[];
  convertToViewportRectangle(rect: number[]): number[];
}

export interface ScreenRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Client rectangles of a text selection → PDF rectangles on the page. `origin` is the page
 * element's client rectangle. Line fragments narrower than a point, and duplicates the browser
 * reports for nested spans, are dropped; overlapping fragments on one line are joined.
 */
export const selectionToPdfRects = (rects: readonly ScreenRect[], origin: { left: number; top: number }, viewport: ViewportLike): PdfRect[] => {
  const out: PdfRect[] = [];
  for (const rect of rects) {
    if (rect.width < 1 || rect.height < 1) continue;
    const [x1, y1] = viewport.convertToPdfPoint(rect.left - origin.left, rect.top - origin.top) as [number, number];
    const [x2, y2] = viewport.convertToPdfPoint(rect.left - origin.left + rect.width, rect.top - origin.top + rect.height) as [number, number];
    const next: PdfRect = {
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
    };
    const sameLine = out.find(
      (existing) => Math.abs(existing.y - next.y) < next.height / 2 && next.x <= existing.x + existing.width + 2 && next.x + next.width >= existing.x - 2,
    );
    if (sameLine === undefined) out.push(next);
    else {
      const left = Math.min(sameLine.x, next.x);
      const right = Math.max(sameLine.x + sameLine.width, next.x + next.width);
      sameLine.x = left;
      sameLine.width = right - left;
      sameLine.height = Math.max(sameLine.height, next.height);
    }
  }
  return out.map((rect) => ({
    x: Number(rect.x.toFixed(2)),
    y: Number(rect.y.toFixed(2)),
    width: Number(rect.width.toFixed(2)),
    height: Number(rect.height.toFixed(2)),
  }));
};

/** A stored PDF rectangle → where to draw it on the current page. */
export const pdfRectToScreen = (rect: PdfRect, viewport: ViewportLike): ScreenRect => {
  const [x1, y1, x2, y2] = viewport.convertToViewportRectangle([rect.x, rect.y, rect.x + rect.width, rect.y + rect.height]) as [
    number,
    number,
    number,
    number,
  ];
  return { left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
};
