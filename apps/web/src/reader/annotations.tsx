/**
 * The annotation layer and panel of the reader (Phase 4: "annotate → note → cite").
 *
 * - Select text, press **Highlight**, optionally with a comment: the selection becomes an
 *   annotation with a `TextQuoteSelector` and the page rectangles, in PDF units.
 * - The page shows every annotation on it; the panel lists them all in reading order.
 * - **Make note** turns one into a note on the item that quotes the passage and ends in a Pandoc
 *   citation, `[@key, p. 12]`, ready to paste into a manuscript.
 * - **Download with annotations** fetches the PDF with all of them embedded; the stored file is
 *   never changed.
 */
import { useCallback, useEffect, useState } from 'react';
import type { Annotation } from '@recueil/schemas';

import type { RecueilClient } from '../api/client.js';
import { ErrorState } from '../components/states.js';
import { pdfRectToScreen, selectionToPdfRects } from './annotation-geometry.js';
import type { PdfRect, ViewportLike } from './annotation-geometry.js';

type RectangleSelector = { type: 'RectangleSelector'; pageIndex: number; rectangles: PdfRect[] };

const rectanglesOf = (annotation: Annotation): RectangleSelector | undefined =>
  (annotation.selector as { type: string }[]).find((selector) => selector.type === 'RectangleSelector') as RectangleSelector | undefined;

export interface AnnotationsState {
  annotations: Annotation[];
  error: unknown;
  reload: () => void;
  highlightSelection: (input: { pageElement: HTMLElement; pageIndex: number; viewport: ViewportLike; comment: string }) => Promise<boolean>;
  remove: (id: string) => Promise<void>;
  makeNote: (id: string) => Promise<string>;
}

export const useAnnotations = (client: RecueilClient, documentId: string, itemId: string | null): AnnotationsState => {
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (documentId === '') return undefined; // no API: the Phase 1 viewer
    const controller = new AbortController();
    client.listAnnotations(documentId, controller.signal).then(
      (page) => setAnnotations(page.data),
      (cause: unknown) => {
        if (!(cause instanceof DOMException && cause.name === 'AbortError')) setError(cause);
      },
    );
    return () => controller.abort();
  }, [client, documentId, generation]);

  const reload = useCallback(() => setGeneration((value) => value + 1), []);

  const highlightSelection: AnnotationsState['highlightSelection'] = async ({ pageElement, pageIndex, viewport, comment }) => {
    const selection = globalThis.getSelection?.();
    if (selection === null || selection === undefined || selection.isCollapsed || selection.rangeCount === 0) return false;
    const range = selection.getRangeAt(0);
    if (!pageElement.contains(range.commonAncestorContainer)) return false;
    const exact = selection.toString().replace(/\s+/gu, ' ').trim();
    const origin = pageElement.getBoundingClientRect();
    const rectangles = selectionToPdfRects([...range.getClientRects()], origin, viewport);
    if (exact === '' || rectangles.length === 0) return false;
    try {
      await client.createAnnotation({
        documentId,
        ...(itemId === null ? {} : { itemId }),
        annotationType: 'highlight',
        motivation: comment.trim() === '' ? 'highlighting' : 'commenting',
        selector: [
          { type: 'TextQuoteSelector', exact },
          { type: 'RectangleSelector', pageIndex, rectangles },
          { type: 'FragmentSelector', conformsTo: 'http://tools.ietf.org/rfc/rfc3778', value: `page=${pageIndex + 1}` },
        ],
        ...(comment.trim() === '' ? {} : { bodyText: comment.trim() }),
        pageIndex,
      });
      selection.removeAllRanges();
      reload();
      return true;
    } catch (cause) {
      setError(cause);
      return false;
    }
  };

  const remove = async (id: string): Promise<void> => {
    try {
      await client.trashAnnotation(id);
      reload();
    } catch (cause) {
      setError(cause);
    }
  };

  const makeNote = async (id: string): Promise<string> => {
    const note = await client.noteFromAnnotation(id);
    return note.contentMarkdown;
  };

  return { annotations, error, reload, highlightSelection, remove, makeNote };
};

/** The highlights on the current page, drawn over the canvas. */
export const AnnotationLayer = ({
  annotations,
  pageIndex,
  viewport,
  selected,
  onSelect,
}: {
  annotations: readonly Annotation[];
  pageIndex: number;
  viewport: ViewportLike | null;
  selected: string | null;
  onSelect: (id: string) => void;
}): JSX.Element | null => {
  if (viewport === null) return null;
  return (
    <div className="reader__annotations" aria-label="Annotations on this page">
      {annotations.flatMap((annotation) => {
        const selector = rectanglesOf(annotation);
        if (selector === undefined || selector.pageIndex !== pageIndex) return [];
        return selector.rectangles.map((rect, index) => {
          const screen = pdfRectToScreen(rect, viewport);
          return (
            <button
              key={`${annotation.id}-${index}`}
              type="button"
              className={`reader__highlight${selected === annotation.id ? ' reader__highlight--selected' : ''}`}
              style={{
                left: screen.left,
                top: screen.top,
                width: screen.width,
                height: screen.height,
                ...(annotation.colour ? { backgroundColor: `${annotation.colour}66` } : {}),
              }}
              aria-label={`Highlight: ${annotation.quotedText ?? ''}`}
              tabIndex={-1}
              onClick={() => onSelect(annotation.id)}
            />
          );
        });
      })}
    </div>
  );
};

/** The list of every annotation, with the actions. */
export const AnnotationsPanel = ({
  state,
  selected,
  onSelect,
  onGoto,
  downloadUrl,
}: {
  state: AnnotationsState;
  selected: string | null;
  onSelect: (id: string) => void;
  onGoto: (pageNumber: number) => void;
  downloadUrl: string;
}): JSX.Element => {
  const [noted, setNoted] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<unknown>(null);

  return (
    <section className="reader__annotation-panel" aria-label="Annotations">
      <h3 className="section__title">Annotations ({state.annotations.length})</h3>
      <a className="button button--small" href={downloadUrl} download>
        Download with annotations
      </a>
      {state.error === null ? null : <ErrorState label="Annotations" error={state.error} onRetry={state.reload} />}
      {failure === null ? null : <ErrorState label="Could not make the note" error={failure} />}
      {state.annotations.length === 0 ? <p className="section__note">Select text and press Highlight.</p> : null}
      <ol className="reader__annotation-list">
        {state.annotations.map((annotation) => (
          <li key={annotation.id} className={selected === annotation.id ? 'reader__annotation reader__annotation--selected' : 'reader__annotation'}>
            <button
              type="button"
              className="reader__annotation-go"
              onClick={() => {
                onSelect(annotation.id);
                if (annotation.pageIndex != null) onGoto(annotation.pageIndex + 1);
              }}
            >
              <span className="reader__match-page">p. {annotation.pageLabel ?? (annotation.pageIndex == null ? '?' : annotation.pageIndex + 1)}</span>
              {annotation.quotedText ? <q className="reader__annotation-quote">{annotation.quotedText}</q> : null}
            </button>
            {annotation.bodyText ? <p className="reader__annotation-comment">{annotation.bodyText}</p> : null}
            <div className="reader__annotation-actions">
              <button
                type="button"
                className="button button--small"
                onClick={() => {
                  setFailure(null);
                  state.makeNote(annotation.id).then(
                    (markdown) => setNoted((current) => ({ ...current, [annotation.id]: markdown })),
                    (cause: unknown) => setFailure(cause),
                  );
                }}
              >
                Make note
              </button>
              <button type="button" className="button button--small" onClick={() => void state.remove(annotation.id)}>
                Delete
              </button>
            </div>
            {noted[annotation.id] === undefined ? null : (
              <p className="reader__annotation-noted" role="status">
                Note added: <code>{noted[annotation.id]!.split('\n').at(-1)}</code>
              </p>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
};
