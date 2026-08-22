/**
 * The notes section.
 *
 * Notes are fetched rather than expanded: `GET /items/{id}` returns `noteIds`, not the note bodies,
 * because a note is up to a megabyte of markdown and an item pane that pulled every one of them
 * before drawing a title would be unusable on a well-annotated item.
 *
 * The body is shown as its markdown source. Rendering it means a markdown pipeline and a
 * sanitiser, and Phase 4 — which brings annotation-to-note and the reader's own note editor — is
 * where that belongs; showing the source is honest in the meantime, and lossless.
 */
import { useNotes } from '../../api/queries.js';
import { EmptyState, ErrorState, LoadingState } from '../../components/states.js';
import type { ItemPaneSectionProps } from '../registry.js';

export const NotesSection = ({ item }: ItemPaneSectionProps): JSX.Element => {
  const notes = useNotes(item.id);

  if (notes.isPending) return <LoadingState label="Loading notes…" />;
  if (notes.isError) {
    return <ErrorState label="Could not load the notes" error={notes.error} onRetry={() => void notes.refetch()} />;
  }

  const rows = notes.data.data;
  if (rows.length === 0) {
    return <EmptyState title="No notes" description="Nothing has been written about this item yet." />;
  }

  return (
    <ul className="notes">
      {rows.map((note) => (
        <li key={note.id} className="notes__row" data-testid={`note-${note.id}`}>
          <h4 className="notes__title">{note.title ?? 'Untitled note'}</h4>
          <span className="badge badge--quiet">{note.noteKind}</span>
          <pre className="notes__body">{note.contentMarkdown}</pre>
        </li>
      ))}
    </ul>
  );
};
