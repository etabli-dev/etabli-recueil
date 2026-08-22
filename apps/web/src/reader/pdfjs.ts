/**
 * PDF.js, configured once.
 *
 * The worker is imported through Vite's `?url` suffix so that it is emitted as its own asset with a
 * hashed name and no CDN is involved — the whole application has to work on a machine with no
 * outbound network, which is the point of self-hosting (CONCEPT.md §5.15). PDF.js is Apache-2.0 and
 * so compatible with AGPL-3.0 (§5.16).
 *
 * Isolated in its own module so that everything else in `src/reader` can be imported — and tested —
 * without pulling three megabytes of PDF engine in with it.
 */
import { GlobalWorkerOptions, TextLayer, getDocument } from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;

export { TextLayer, getDocument };
export type { PDFDocumentProxy, PDFPageProxy };
