/**
 * What an ingestion rule can see.
 *
 * This is the pipeline's state at CONCEPT.md §5.3 stage 8: hashing, duplicate detection, archive
 * extraction, type detection, OCR, metadata extraction and identifier resolution have all run, and
 * the rule engine is the first stage that gets to make a filing decision from all of it. The
 * subject is a plain value with no handles on it — no database, no storage, no HTTP client —
 * because a rule engine that could reach those could not be dry-run.
 *
 * Every field is optional. A file dropped in a watched folder has a path and no sender; a mail
 * attachment has a sender and no scanner identity; a PDF with no text layer and failed OCR has no
 * text. A condition on a field the subject does not have never matches, and says which it was.
 */

export interface ResolverOutcome {
  /** `crossref`, `openalex`, `pubmed`, … — the resolver's own name (CONCEPT.md §5.4). */
  readonly resolver: string;
  readonly outcome: 'hit' | 'miss' | 'ambiguous' | 'error' | 'skipped';
  /** The identifier that resolved, when one did. */
  readonly identifier?: string;
  readonly confidence?: number;
}

export interface IngestionSubject {
  /** Whatever identifies this subject to the caller: a document hash, a job id, a path. */
  readonly id: string;
  /** The ingestion source kind — `folder`, `imap`, `scanner`, … (`DocumentSourceKind`). */
  readonly source?: string;
  /** Mail sender, scanner identity, or the account a WebDAV share belongs to. */
  readonly sender?: string;
  readonly recipients?: readonly string[];
  /** Mail subject line, or a scanner job name where the device sets one. */
  readonly subject?: string;
  /** The source path. Normalised lexically before any rule sees it (`../path.ts`). */
  readonly path?: string;
  /**
   * The filename. Defaults to the last segment of `path`, so a caller with a path need not repeat
   * itself; supply it explicitly for a mail attachment, which has a name and no path.
   */
  readonly filename?: string;
  readonly mime?: string;
  /** Extracted text: the PDF text layer, the OCR output, or the plain-text body of a mail. */
  readonly text?: string;
  /** The item type as it stands — set by type detection or by an earlier rule set, not by this run. */
  readonly itemType?: string;
  /** Tags already on the subject, from an importer or from an earlier stage. */
  readonly tags?: readonly string[];
  readonly resolvers?: readonly ResolverOutcome[];
}
