/**
 * Searching the text of a document.
 *
 * PDF.js ships a find controller, but it belongs to the `pdf_viewer` component set — the whole
 * viewer application, with its own layout, its own toolbar and its own annotation layer. Phase 4
 * brings the annotation layer and can reconsider then. For now the reader needs one thing, "where
 * does this string occur", and that is a function over the text content the pages already return:
 * no viewer, no DOM, and testable on strings.
 *
 * Matching is case-insensitive and whitespace-normalised, because a PDF's text layer breaks lines
 * wherever the typesetter did, and a reader who searches for "randomised trial" means the phrase
 * rather than the two words with whatever whitespace fell between them.
 */

export interface PageText {
  pageNumber: number;
  text: string;
}

export interface SearchMatch {
  pageNumber: number;
  /** Offset of the match within the normalised page text. */
  index: number;
  /** Enough of the surrounding text to recognise the hit in a result list. */
  excerpt: string;
}

const CONTEXT = 40;

/** Collapse every run of whitespace to one space, so a line break does not hide a phrase. */
export const normaliseForSearch = (text: string): string => text.replace(/\s+/gu, ' ').trim();

export const searchPages = (
  pages: readonly PageText[],
  query: string,
  limit = 200,
): SearchMatch[] => {
  const needle = normaliseForSearch(query).toLowerCase();
  if (needle === '') return [];

  const matches: SearchMatch[] = [];
  for (const page of pages) {
    const haystack = normaliseForSearch(page.text);
    const lowered = haystack.toLowerCase();
    let from = 0;
    for (;;) {
      const index = lowered.indexOf(needle, from);
      if (index === -1) break;
      matches.push({
        pageNumber: page.pageNumber,
        index,
        excerpt: excerptAround(haystack, index, needle.length),
      });
      if (matches.length >= limit) return matches;
      from = index + needle.length;
    }
  }
  return matches;
};

const excerptAround = (text: string, index: number, length: number): string => {
  const start = Math.max(index - CONTEXT, 0);
  const end = Math.min(index + length + CONTEXT, text.length);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
};
