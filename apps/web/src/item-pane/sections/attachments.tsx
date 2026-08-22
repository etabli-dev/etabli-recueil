/**
 * The attachments section.
 *
 * The attachment rows come from the item expansion rather than a second request, because
 * `GET /items/{id}?expand=attachments` already returned them and a section that refetches what the
 * pane was handed is a section that makes the pane slower for no information.
 *
 * Opening one is a route change, not a modal: the reader has its own URL so that a deep link to a
 * page of a PDF is possible at all (`recueil://` deep links, CONCEPT.md §5.14).
 */
import type { Attachment } from '@recueil/schemas';

import { EmptyState } from '../../components/states.js';
import type { ItemPaneSectionProps } from '../registry.js';

/**
 * How the pane opens an attachment.
 *
 * Injected through a module-level setter rather than a prop, because the registry hands a section
 * nothing but the item — the seam a plugin section will get. The route installs the real one.
 */
let openAttachment: (attachment: Attachment) => void = () => undefined;

export const setAttachmentOpener = (opener: (attachment: Attachment) => void): void => {
  openAttachment = opener;
};

/** Whether the reader can show this attachment at all. Phase 1 reads PDFs and nothing else. */
export const isReadable = (attachment: Attachment): boolean =>
  attachment.linkMode === 'stored' && attachment.contentTypeHint !== 'text/html';

export const AttachmentsSection = ({ item }: ItemPaneSectionProps): JSX.Element => {
  const attachments = item.attachments ?? [];

  if (attachments.length === 0) {
    return (
      <EmptyState
        title="No attachments"
        description="Nothing is filed against this item yet. Capture a PDF with the connector, or drop a file into a watched folder."
      />
    );
  }

  return (
    <ul className="attachments">
      {attachments.map((attachment) => (
        <li key={attachment.id} className="attachments__row" data-testid={`attachment-${attachment.id}`}>
          <span className="attachments__title">{attachment.title ?? 'Untitled attachment'}</span>
          <span className="badge">{attachment.role}</span>
          <span className="badge badge--quiet">{attachment.linkMode}</span>
          {attachment.hasAnnotations ? (
            <span className="badge badge--quiet">{attachment.annotationCount} annotations</span>
          ) : null}
          {isReadable(attachment) ? (
            <button
              type="button"
              className="button button--small"
              onClick={() => openAttachment(attachment)}
            >
              Open in reader
            </button>
          ) : (
            <span className="attachments__note">
              {attachment.linkMode === 'linked_url' ? 'A link, with no bytes in the library.' : 'Not readable in the browser.'}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
};
