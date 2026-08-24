/**
 * The document, beside the decision.
 *
 * A review queue without a preview is a list of filenames, and nobody can decide anything from a
 * filename — which is the whole reason P3 says "flag, never guess" rather than "guess and let them
 * fix it later". So the pane shows the bytes: the PDF, the scan, or, when neither can be embedded,
 * the extracted text the pipeline read.
 *
 * The PDF is embedded rather than rendered with PDF.js. The reader in `src/reader/` is a reading
 * surface — text layer, search, page state — and pulling three hundred kilobytes of it into the
 * review route to glance at page one would make the screen this component exists to keep fast slow.
 * `Open in the reader` is one keystroke away for the cases that need it.
 *
 * Nothing here is fetched by this component. The URL is `GET /documents/{id}/content`, which the
 * browser requests itself with the session cookie, exactly as the reader does.
 */
import type { Document } from '@recueil/schemas';

export interface SubjectPreviewProps {
  /**
   * The document row, fetched by the workspace.
   *
   * A review entry carries `subjectType` and `subjectId` and nothing else — there is no expanded
   * subject on the wire — so the media type, the size and the digest come from
   * `GET /api/v1/documents/{id}`, which is the record for all three.
   */
  document: Document | null | undefined;
  /** `client.documentContentUrl(documentId)`. Absent when the subject is not a document. */
  contentUrl: string | null;
  /** Why there is nothing to preview, when there is not: a merge candidate, an item, a job. */
  absentReason?: string;
  loading?: boolean;
}

const EMBEDDABLE_PDF = 'application/pdf';

export const SubjectPreview = ({
  document: row,
  contentUrl,
  absentReason,
  loading = false,
}: SubjectPreviewProps): JSX.Element => {
  if (loading) {
    return (
      <div className="preview preview--empty">
        <p className="section__note">Loading the document…</p>
      </div>
    );
  }

  if (row === null || row === undefined) {
    return (
      <div className="preview preview--empty" data-testid="preview-absent">
        <p className="section__note">
          {absentReason ??
            'This entry names no document. Merge candidates and enrichment disagreements are decided from the two records, not from a file.'}
        </p>
      </div>
    );
  }

  const mediaType = row.mimeType ?? null;
  const label = row.originalFilename ?? row.sha256.slice(0, 12);

  return (
    <div className="preview" data-testid="subject-preview">
      <header className="preview__header">
        <span className="preview__name">{label}</span>
        {mediaType === null ? null : <code className="preview__type">{mediaType}</code>}
        <span className="preview__size">{formatBytes(row.byteSize)}</span>
        {row.sourceKind === null || row.sourceKind === undefined ? null : (
          <span className="badge badge--quiet">{row.sourceKind}</span>
        )}
      </header>

      <div className="preview__body">
        {contentUrl !== null && mediaType === EMBEDDABLE_PDF ? (
          <object
            className="preview__object"
            data={contentUrl}
            type={EMBEDDABLE_PDF}
            aria-label={`Preview of ${label}`}
            data-testid="preview-pdf"
          >
            <p>
              This browser will not embed the PDF. <a href={contentUrl}>Download {label}</a> instead.
            </p>
          </object>
        ) : contentUrl !== null && mediaType !== null && mediaType.startsWith('image/') ? (
          <img className="preview__image" src={contentUrl} alt={`Scan of ${label}`} data-testid="preview-image" />
        ) : (
          <div className="preview__text" data-testid="preview-other">
            <p className="section__note">
              {mediaType === null
                ? 'The document has no recorded media type, so it cannot be embedded here.'
                : `A ${mediaType} cannot be embedded here.`}{' '}
              The rules matched against the text the pipeline extracted, which the run trace beside
              this pane records.
            </p>
            {contentUrl === null ? null : (
              <p>
                <a href={contentUrl}>Download {label}</a>
              </p>
            )}
          </div>
        )}
      </div>

      <footer className="preview__footer">
        <span className="preview__hash-label">SHA-256</span>
        <code className="preview__hash">{row.sha256}</code>
        {row.hasTextLayer === true ? null : (
          <span className="badge badge--warn">no text layer</span>
        )}
      </footer>
    </div>
  );
};

/** Bytes as a person reads them. Decimal units, because that is what a file manager shows. */
export const formatBytes = (bytes: number): string => {
  if (bytes < 1000) return `${String(bytes)} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit] ?? 'kB'}`;
};
