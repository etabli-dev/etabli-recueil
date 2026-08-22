/**
 * The PDF reader (CONCEPT.md §7, Phase 1: "basic PDF viewing (no annotation yet)").
 *
 * Page navigation, zoom, real text selection and a text search — and deliberately nothing else.
 * There is no annotation layer here, and adding one is not a small change: ADR-0009 stores
 * annotations as W3C Web Annotation records against a selector, which is a data model, a set of
 * endpoints and an export path, and it is Phase 4's work. A half-built highlight tool that wrote
 * nothing anywhere would be worse than none.
 *
 * One page is rendered at a time rather than a continuous scroll. That is the honest version of
 * "basic": a virtualised continuous view has to manage a canvas pool, and the Phase 4 caveat about
 * PDF.js performance under WebKitGTK (§5.14) is a reason to keep the rendering surface small until
 * it has been measured on the platform that is expected to struggle.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Attachment } from '@recueil/schemas';

import { ErrorState, LoadingState } from '../components/states.js';
import { ShortcutHelp } from '../keyboard/shortcut-help.js';
import { useShortcuts } from '../keyboard/use-shortcuts.js';
import { TextLayer, getDocument } from './pdfjs.js';
import type { PDFDocumentProxy } from './pdfjs.js';
import { DEFAULT_ZOOM, clampPage, formatZoom, zoomIn, zoomOut } from './view-state.js';
import { searchPages } from './text-search.js';
import type { PageText, SearchMatch } from './text-search.js';

export interface PdfReaderProps {
  attachment: Attachment;
  /** Where the bytes are. Built by the API client; PDF.js fetches it itself. */
  url: string;
  onClose: () => void;
}

export const PdfReader = ({ attachment, url, onClose }: PdfReaderProps): JSX.Element => {
  const [document_, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [renderError, setRenderError] = useState<unknown>(null);
  const [helpOpen, setHelpOpen] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  /* Loading the document ---------------------------------------------------------------------- */

  useEffect(() => {
    let cancelled = false;
    setDocument(null);
    setLoadError(null);
    setPageNumber(1);

    const task = getDocument({ url, withCredentials: true });
    task.promise.then(
      (loaded) => {
        // The loading task owns the document; the cleanup below destroys both.
        if (!cancelled) setDocument(loaded);
      },
      (cause: unknown) => {
        if (!cancelled) setLoadError(cause);
      },
    );

    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [url]);

  const pageCount = document_?.numPages ?? 0;

  /* Rendering one page ------------------------------------------------------------------------ */

  useEffect(() => {
    if (document_ === null) return undefined;
    const canvas = canvasRef.current;
    const container = textLayerRef.current;
    if (canvas === null || container === null) return undefined;

    let cancelled = false;
    setRenderError(null);

    const run = async (): Promise<void> => {
      const page = await document_.getPage(clampPage(pageNumber, document_.numPages));
      if (cancelled) return;

      const viewport = page.getViewport({ scale: zoom });
      const context = canvas.getContext('2d');
      if (context === null) throw new Error('This browser did not provide a 2D canvas context.');

      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;

      const task = page.render({ canvasContext: context, canvas, viewport });
      await task.promise;
      if (cancelled) return;

      // The text layer is what makes selection and copy-out work: it is transparent, positioned
      // text over the canvas, not a second rendering of the page.
      container.replaceChildren();
      container.style.width = `${Math.floor(viewport.width)}px`;
      container.style.height = `${Math.floor(viewport.height)}px`;
      container.style.setProperty('--total-scale-factor', String(zoom));

      const textLayer = new TextLayer({
        textContentSource: await page.getTextContent(),
        container,
        viewport,
      });
      await textLayer.render();
    };

    run().catch((cause: unknown) => {
      if (!cancelled) setRenderError(cause);
    });

    return () => {
      cancelled = true;
    };
  }, [document_, pageNumber, zoom]);

  /* Searching --------------------------------------------------------------------------------- */

  const search = usePdfSearch(document_);

  /* Shortcuts --------------------------------------------------------------------------------- */

  const goto = useCallback(
    (page: number) => setPageNumber((current) => clampPage(page, pageCount === 0 ? current : pageCount)),
    [pageCount],
  );

  useShortcuts(
    {
      'reader-next-page': () => goto(pageNumber + 1),
      'reader-previous-page': () => goto(pageNumber - 1),
      'reader-zoom-in': () => setZoom(zoomIn),
      'reader-zoom-out': () => setZoom(zoomOut),
      'reader-zoom-reset': () => setZoom(DEFAULT_ZOOM),
      'reader-find': () => searchRef.current?.focus(),
      'reader-close': onClose,
      'shortcut-help': () => setHelpOpen(true),
      dismiss: () => (helpOpen ? setHelpOpen(false) : onClose()),
    },
    { scope: 'reader' },
  );

  /* Rendering --------------------------------------------------------------------------------- */

  if (loadError !== null) {
    return (
      <ErrorState
        label={`Could not open ${attachment.title ?? 'the attachment'}`}
        error={loadError}
        onRetry={() => setLoadError(null)}
      />
    );
  }
  if (document_ === null) return <LoadingState label="Opening the document…" />;

  return (
    <div className="reader">
      <header className="reader__toolbar">
        <button type="button" className="button" onClick={onClose}>
          Back to the library
        </button>
        <h2 className="reader__title">{attachment.title ?? 'Attachment'}</h2>

        <div className="reader__pages">
          <button type="button" className="button button--small" onClick={() => goto(pageNumber - 1)} disabled={pageNumber <= 1}>
            Previous page
          </button>
          <label className="reader__page-label" htmlFor="reader-page">
            Page
          </label>
          <input
            id="reader-page"
            className="reader__page-input"
            type="number"
            min={1}
            max={pageCount}
            value={pageNumber}
            onChange={(event) => goto(Number(event.target.value))}
          />
          <span className="reader__page-count">of {pageCount}</span>
          <button
            type="button"
            className="button button--small"
            onClick={() => goto(pageNumber + 1)}
            disabled={pageNumber >= pageCount}
          >
            Next page
          </button>
        </div>

        <div className="reader__zoom">
          <button type="button" className="button button--small" onClick={() => setZoom(zoomOut)} aria-label="Zoom out">
            −
          </button>
          <span className="reader__zoom-value">{formatZoom(zoom)}</span>
          <button type="button" className="button button--small" onClick={() => setZoom(zoomIn)} aria-label="Zoom in">
            +
          </button>
        </div>
      </header>

      <div className="reader__body">
        <aside className="reader__search" aria-label="Search the document">
          <label className="field__label" htmlFor="reader-search">
            Find in document
          </label>
          <input
            id="reader-search"
            ref={searchRef}
            className="field__input"
            type="search"
            value={search.query}
            onChange={(event) => search.setQuery(event.target.value)}
          />
          {search.status === 'extracting' ? <LoadingState label="Reading the document text…" /> : null}
          {search.status === 'failed' ? <ErrorState label="Could not read the document text" error={search.error} /> : null}
          {search.status === 'ready' && search.query.trim() !== '' ? (
            search.matches.length === 0 ? (
              <p className="section__note">No match.</p>
            ) : (
              <ol className="reader__matches">
                {search.matches.map((match) => (
                  <li key={`${match.pageNumber}-${match.index}`}>
                    <button
                      type="button"
                      className="reader__match"
                      onClick={() => goto(match.pageNumber)}
                    >
                      <span className="reader__match-page">p. {match.pageNumber}</span>
                      <span className="reader__match-text">{match.excerpt}</span>
                    </button>
                  </li>
                ))}
              </ol>
            )
          ) : null}
        </aside>

        <div className="reader__canvas-wrap">
          {renderError === null ? null : <ErrorState label="Could not draw the page" error={renderError} />}
          <div className="reader__page">
            <canvas ref={canvasRef} className="reader__canvas" aria-label={`Page ${pageNumber}`} />
            <div ref={textLayerRef} className="textLayer" />
          </div>
        </div>
      </div>

      <ShortcutHelp open={helpOpen} scope="reader" onClose={() => setHelpOpen(false)} />
    </div>
  );
};

interface PdfSearchState {
  query: string;
  setQuery: (query: string) => void;
  status: 'idle' | 'extracting' | 'ready' | 'failed';
  error: unknown;
  matches: SearchMatch[];
}

/**
 * The document's text, extracted once, and the matches in it.
 *
 * Extraction is per document rather than per keystroke: `getTextContent` on three hundred pages is
 * not something to do while somebody types.
 */
const usePdfSearch = (document_: PDFDocumentProxy | null): PdfSearchState => {
  const [query, setQuery] = useState('');
  const [pages, setPages] = useState<PageText[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (document_ === null) {
      setPages(null);
      return undefined;
    }
    let cancelled = false;
    setPages(null);
    setError(null);

    const extract = async (): Promise<void> => {
      const collected: PageText[] = [];
      for (let pageNumber = 1; pageNumber <= document_.numPages; pageNumber += 1) {
        if (cancelled) return;
        const page = await document_.getPage(pageNumber);
        const content = await page.getTextContent();
        const text = content.items
          .map((item) => ('str' in item ? item.str : ''))
          .join(' ');
        collected.push({ pageNumber, text });
      }
      if (!cancelled) setPages(collected);
    };

    extract().catch((cause: unknown) => {
      if (!cancelled) setError(cause);
    });

    return () => {
      cancelled = true;
    };
  }, [document_]);

  const matches = useMemo(() => (pages === null ? [] : searchPages(pages, query)), [pages, query]);

  const status: PdfSearchState['status'] =
    error !== null ? 'failed' : document_ === null ? 'idle' : pages === null ? 'extracting' : 'ready';

  return { query, setQuery, status, error, matches };
};
