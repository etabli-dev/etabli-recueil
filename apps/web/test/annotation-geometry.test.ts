import { describe, expect, it } from 'vitest';

import { pdfRectToScreen, selectionToPdfRects } from '../src/reader/annotation-geometry.js';

// A page 600 units tall at zoom 2: PDF y runs upwards from the bottom, screen y downwards.
const viewport = {
  convertToPdfPoint: (x: number, y: number) => [x / 2, 600 - y / 2],
  convertToViewportRectangle: ([x1, y1, x2, y2]: number[]) => [x1! * 2, (600 - y1!) * 2, x2! * 2, (600 - y2!) * 2],
};

describe('annotation geometry', () => {
  it('turns a selection into PDF rectangles and back', () => {
    const rects = selectionToPdfRects([{ left: 110, top: 220, width: 200, height: 20 }], { left: 10, top: 20 }, viewport);
    expect(rects).toEqual([{ x: 50, y: 490, width: 100, height: 10 }]);
    expect(pdfRectToScreen(rects[0]!, viewport)).toEqual({ left: 100, top: 200, width: 200, height: 20 });
  });

  it('joins fragments of one line and drops slivers', () => {
    const rects = selectionToPdfRects(
      [
        { left: 0, top: 0, width: 100, height: 20 },
        { left: 100, top: 0, width: 50, height: 20 },
        { left: 0, top: 40, width: 0.5, height: 20 },
      ],
      { left: 0, top: 0 },
      viewport,
    );
    expect(rects).toEqual([{ x: 0, y: 590, width: 75, height: 10 }]);
  });
});
