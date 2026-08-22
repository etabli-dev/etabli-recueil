/**
 * The reader's arithmetic and its text search.
 *
 * Neither needs a PDF, a canvas or a browser, which is exactly why they were written as functions
 * rather than as component state: the parts of the reader that can be wrong quietly are the parts
 * that are tested here.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
  clampPage,
  clampZoom,
  formatZoom,
  zoomIn,
  zoomOut,
} from '../src/reader/view-state.js';
import { normaliseForSearch, searchPages } from '../src/reader/text-search.js';

describe('the reader view state', () => {
  it('keeps the page inside the document', () => {
    expect(clampPage(0, 10)).toBe(1);
    expect(clampPage(11, 10)).toBe(10);
    expect(clampPage(4, 10)).toBe(4);
    expect(clampPage(Number.NaN, 10)).toBe(1);
    // A document with no pages is not a reason to show page zero.
    expect(clampPage(3, 0)).toBe(1);
  });

  it('steps the zoom rather than scaling it, and stops at both ends', () => {
    expect(zoomIn(1)).toBe(1.25);
    expect(zoomOut(1)).toBe(0.75);
    expect(zoomIn(MAX_ZOOM)).toBe(MAX_ZOOM);
    expect(zoomOut(MIN_ZOOM)).toBe(MIN_ZOOM);
    expect(clampZoom(100)).toBe(MAX_ZOOM);
    expect(clampZoom(Number.NaN)).toBe(DEFAULT_ZOOM);
  });

  it('renders the zoom as a percentage', () => {
    expect(formatZoom(1)).toBe('100%');
    expect(formatZoom(0.75)).toBe('75%');
  });
});

describe('searching the document text', () => {
  const pages = [
    { pageNumber: 1, text: 'Attrition bias in\nrandomised   trials of physiotherapy' },
    { pageNumber: 2, text: 'No mention here.' },
    { pageNumber: 3, text: 'randomised trials again, and randomised trials once more' },
  ];

  it('collapses the whitespace a PDF text layer inherits from the typesetting', () => {
    expect(normaliseForSearch('randomised   trials\nof')).toBe('randomised trials of');
  });

  it('finds a phrase across a line break', () => {
    const matches = searchPages(pages, 'randomised trials');
    expect(matches.map((match) => match.pageNumber)).toEqual([1, 3, 3]);
  });

  it('is case-insensitive and reports every occurrence on a page', () => {
    expect(searchPages(pages, 'RANDOMISED TRIALS')).toHaveLength(3);
  });

  it('returns nothing for an empty query rather than everything', () => {
    expect(searchPages(pages, '   ')).toEqual([]);
  });

  it('carries enough context to recognise the hit', () => {
    const [match] = searchPages(pages, 'physiotherapy');
    expect(match?.excerpt).toContain('trials of physiotherapy');

    // A hit in the middle of a long page is elided at both ends.
    const long = [{ pageNumber: 1, text: `${'padding '.repeat(20)}needle${' padding'.repeat(20)}` }];
    const [elided] = searchPages(long, 'needle');
    expect(elided?.excerpt.startsWith('…')).toBe(true);
    expect(elided?.excerpt.endsWith('…')).toBe(true);
  });

  it('stops at the limit rather than building an unbounded list', () => {
    const busy = [{ pageNumber: 1, text: 'ab '.repeat(500) }];
    expect(searchPages(busy, 'ab', 10)).toHaveLength(10);
  });
});
