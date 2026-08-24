/**
 * The verification report (CONCEPT §6, §7 Phase 2 exit: "Paperless decommissioned after verified
 * import").
 *
 * The same shape as the Zotero importer's, for the same two reasons.
 *
 * **It is machine-readable first.** The JSON below is the report; the Markdown rendering is a view
 * of it. A number a person reads in the Markdown and a number a test asserts against are then the
 * same number by construction, and the exit criterion is a `pass` field rather than a judgement.
 *
 * **It says what did not happen.** Counts that match are the easy half. Every document whose
 * original could not be fetched, every custom-field value that had no representation, every ASN
 * that collided, every document link that pointed outside the import, and every facet column whose
 * source field was ambiguous is listed individually with its reason (P3).
 *
 * And one rule that the Phase 1 review paid for: **every side of every count is a query.** The
 * Paperless side comes from what the API returned; the Recueil side comes from the target's own
 * tables through `reconcile.ts`. Neither side is ever counted from `job_logs`, from the importer's
 * plans, or from anything else that is a narration of the run. A check built that way cannot fail
 * and reads as evidence.
 */

/** The `schema` field of the JSON report. Bumped when the shape changes incompatibly. */
export const REPORT_SCHEMA = 'recueil.paperless-import-report/1';

/** Where the report's numbers came from. */
export interface ReportSource {
  /** The API root, with any credential removed. */
  baseUrl: string;
  /** `X-Version` from the server, or null when a proxy stripped it. */
  serverVersion: string | null;
  /** `X-Api-Version` from the server: the newest version it allows. */
  serverApiVersion: string | null;
  /** The DRF Accept-header version this run asked for. */
  requestedApiVersion: string;
  /** The Paperless-ngx release `src/client/types.ts` was transcribed from. */
  modelledAgainstVersion: string;
  /**
   * False when the server's `X-Version` is not the release these types were written against.
   *
   * Not a failure — the API is stable across patch releases — but the one fact that tells a reader
   * how much of this report is a claim about *their* server rather than about the fake.
   */
  versionMatchesModel: boolean;
  /** The endpoints the DRF router advertised at `/api/`. */
  endpoints: string[];
  /** When this run started asking the server for things. */
  fetchedAt: string;
}

export interface ReportRun {
  jobId: string;
  idempotencyKey: string;
  runLabel: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  attempt: number;
  /** The stage this run picked up from, when it resumed an interrupted one. */
  resumedFromStage: string | null;
  /** The Paperless document id this run resumed after, when it resumed. */
  resumedAfterDocumentId: number | null;
  /** Documents this run skipped because an earlier attempt had already finished them. */
  documentsSkippedAsAlreadyDone: number;
}

/**
 * One row of the per-document-type parity table.
 *
 * Both sides are counted independently. The Paperless side is the documents the API returned with
 * that `document_type`; the Recueil side is rows in the target's `items` table whose `source_id` is
 * one of those documents **and** whose stored `item_type` is what the mapping says it should be.
 * Bucketing the target side by the importer's own mapping output would make the comparison an
 * identity: it would hold however the rows were written.
 */
export interface DocumentTypeParity {
  /** The Paperless document type id, or null for the documents that have none. */
  paperlessId: number | null;
  paperlessName: string | null;
  /** What `mapDocumentType` says this becomes, recomputed from the name. */
  recueilItemType: string;
  /** The slug that reaches `item_office.office_document_type`. */
  officeDocumentType: string | null;
  paperlessTotal: number;
  /** Target rows for those documents whose stored `item_type` is `recueilItemType`. */
  recueilTotal: number;
  /**
   * Target rows for those documents stored under some other `item_type`.
   *
   * Counted apart rather than folded in, because "the item is there but it is the wrong type" and
   * "the item is not there" are different faults with different repairs.
   */
  recueilMistyped: number;
  delta: number;
}

export interface DocumentCounts {
  /** `count` from the first page of `/api/documents/`: what the server says it holds. */
  apiReportedTotal: number;
  /** Documents this run actually received in the pages it walked. */
  apiFetched: number;
  /** Documents an earlier attempt of this job had already finished, and this one skipped. */
  carriedFromEarlierAttempt: number;
  /** Rows in the target's `items` whose `source_system` is `paperless`, by query. */
  recueilTotal: number;
  /** Of those, the ones whose `source_id` is a document this run saw. */
  recueilMatched: number;
  /** Target rows there under the wrong stored `item_type`. Non-zero is a blocking failure. */
  recueilMistyped: number;
  /** Paperless documents with no row in the target at all. */
  missingInRecueil: number[];
  /** Items in the target claiming a Paperless origin the server does not have. */
  orphanedInRecueil: string[];
  delta: number;
  byDocumentType: DocumentTypeParity[];
  /** Documents whose Paperless `deleted_at` is set. Not imported; see `README.md`. */
  inPaperlessTrash: number;
}

export type OriginalStatus = 'stored' | 'missing' | 'unreadable' | 'checksum_mismatch';

export interface OriginalReportEntry {
  paperlessId: number;
  title: string;
  status: OriginalStatus;
  sha256: string | null;
  byteSize: number | null;
  /** The MD5 Paperless recorded for the original. */
  paperlessChecksum: string | null;
  /** Whether the bytes we fetched hash to that MD5. Null when Paperless recorded none. */
  matchesPaperlessChecksum: boolean | null;
  /** The size Paperless recorded. Null when the metadata endpoint gave none. */
  paperlessSize: number | null;
  originalFilename: string | null;
  mimeType: string | null;
  reason: string | null;
}

/** The original-file hash coverage the exit criterion is judged on (ADR-0004). */
export interface OriginalCoverage {
  /**
   * False when the run was asked not to fetch originals (`downloadOriginals: false`).
   *
   * The four checks about files are then **left out of the report entirely** rather than passing
   * vacuously. A metadata-only rehearsal that reported 100% hash coverage would be the worst kind of
   * evidence: true as arithmetic, false as a statement about the library.
   */
  fetchEnabled: boolean;
  /** Documents this run tried to fetch an original for. */
  attempted: number;
  stored: number;
  missing: number;
  unreadable: number;
  /** `stored / attempted`, to one decimal place. 100 when nothing was attempted. */
  hashCoveragePercent: number;
  /**
   * Originals whose bytes did not hash to the MD5 Paperless recorded.
   *
   * A real reconciliation of two independently held facts, not a self-check: Paperless computed its
   * checksum when the document was consumed, and this number is our MD5 of the bytes it just sent.
   */
  checksumMismatches: number;
  /** Documents for which Paperless recorded no checksum, so nothing could be compared. */
  checksumUnavailable: number;
  /** Distinct SHA-256 digests: the number of Documents the import created or reused. */
  distinctDocuments: number;
  /** Documents Paperless holds more than one copy of, found by digest collision on our side. */
  duplicateOriginals: number;
  /**
   * Blobs the target holds for these documents, by query over `document_provenance`.
   *
   * The expected side of `attachment_records_carried`: independent of the log, because it counts
   * provenance rows the ingest wrote rather than observations the importer made.
   */
  recueilDocuments: number;
  /**
   * Rows found in the target's `attachments` table, one per stored blob, by query.
   *
   * Not a count of the importer's own log entries — that number cannot disagree with itself.
   */
  recueilAttachments: number;
  /** Paperless ids whose blob is in the store but reachable from no item. */
  recueilAttachmentsMissing: number[];
  /** Paperless ids with an item but no stored original. Expected to equal missing + unreadable. */
  recueilWithoutOriginal: number[];
  entries: OriginalReportEntry[];
}

export interface CorrespondentReconciliation {
  apiTotal: number;
  /** Correspondents at least one imported document refers to. */
  referenced: number;
  /** Distinct `item_office.correspondent` values over the imported items, by query. */
  recueilDistinct: number;
  /** Documents with no Paperless correspondent, which got the placeholder. */
  withoutCorrespondent: number;
  placeholder: string;
  /** Correspondents the API listed that no document uses. Carried nowhere; nothing is lost. */
  unused: number;
}

export interface DocumentTypeReconciliation {
  apiTotal: number;
  /** Types whose name mapped onto a core Recueil item type. */
  mappedToCoreItemType: number;
  /** Types carried across in `office_document_type` only, with `item_type = document`. */
  carriedAsOfficeType: number;
  /** Items in the target carrying a non-null `office_document_type`, by query. */
  recueilWithOfficeType: number;
  byName: Array<{ paperlessId: number; name: string; itemType: string; officeDocumentType: string }>;
}

export interface TagReconciliation {
  apiTotal: number;
  /** Tags in the target whose name is one the API listed, by query. */
  recueilTotal: number;
  /** Paperless tag names with no Recueil tag. */
  missingInRecueil: string[];
  /** Tag assignments across every document the API returned. */
  apiAssignments: number;
  /** Rows in `item_tags` for the imported items, by query. */
  recueilAssignments: number;
  /** Assignments naming a tag that was not in `/api/tags/`. Each one is also in `skipped`. */
  skippedAssignments: number;
  /** Paperless tags that have a parent. Recueil tags are flat, so the tree is not carried. */
  hierarchical: number;
  inboxTags: number;
  coloured: number;
}

export interface CustomFieldReconciliation {
  apiTotal: number;
  /** Definitions in the target whose `field_key` is one this run planned, by query. */
  recueilDefined: number;
  byDataType: Record<string, number>;
  /** Paperless types this importer has no mapping for. Their values are not written. */
  unsupported: Array<{ paperlessId: number; name: string; dataType: string; reason: string }>;
  /** Values the API carried on the documents it returned. */
  apiValues: number;
  /** Rows in `field_values` for the imported items, by query. */
  recueilValues: number;
  /** Values recorded as explicitly empty (`is_blank`). */
  blankValues: number;
  /** Values that could not be represented. Each one is also in `skipped`. */
  skippedValues: number;
  /** `documentlink` targets outside this import. Each one is also in `review`. */
  unresolvedDocumentLinks: number;
  /** How each facet column's source field was chosen. */
  facetSources: Array<{
    column: string;
    outcome: string;
    fieldId: number | null;
    fieldName: string | null;
    detail: string;
  }>;
}

/** The archive serial number: preserved, and unique (CONCEPT §6). */
export interface AsnReconciliation {
  /** Documents the API returned that carry an ASN. */
  apiWithAsn: number;
  /** Imported items whose `item_office.asn` is not null, by query. */
  recueilWithAsn: number;
  /** Distinct non-null ASNs among live items in the whole target, by query. */
  recueilDistinctAsn: number;
  /** True when those two agree: `ux_item_office_asn` holds and nothing shares a number. */
  unique: boolean;
  /** ASNs Paperless itself had on more than one document. */
  duplicatesInSource: Array<{ asn: number; documents: number[] }>;
  /** ASNs that could not be written because another item already held them. */
  collisions: Array<{ asn: number; paperlessId: number; heldByItemId: string }>;
  /** The lowest and highest ASN carried across, for a person checking against Paperless. */
  range: { min: number | null; max: number | null };
}

export interface NoteReconciliation {
  /** Notes the API carried on the documents it returned. */
  apiTotal: number;
  /** Rows in `notes` for the imported items, by query. */
  recueilTotal: number;
  delta: number;
}

/** A field Paperless has that this phase of Recueil has nowhere to put. */
export interface NotCarriedField {
  field: string;
  count: number;
  reason: string;
}

/** A record the importer did not write, and why. */
export interface SkippedRecord {
  kind: string;
  paperlessId: number | null;
  subject: string;
  reason: string;
}

/** Something a person has to look at (P3, CONCEPT §6's `_REVIEW/`). */
export interface ReviewEntry {
  kind: string;
  paperlessId: number | null;
  subject: string;
  reason: string;
  proposedAction: string;
  detail?: Record<string, unknown>;
}

/** One named assertion, so that `pass` can be traced to the checks that decided it. */
export interface ReportCheck {
  name: string;
  description: string;
  pass: boolean;
  expected: number | string;
  actual: number | string;
  /** False when the check is informational and does not affect `pass`. */
  blocking: boolean;
}

export interface PaperlessImportReport {
  schema: typeof REPORT_SCHEMA;
  generatedAt: string;
  /** The top-level verdict: exact document-count parity, a unique ASN, and nothing lost silently. */
  pass: boolean;
  source: ReportSource;
  run: ReportRun;
  documents: DocumentCounts;
  originals: OriginalCoverage;
  correspondents: CorrespondentReconciliation;
  documentTypes: DocumentTypeReconciliation;
  tags: TagReconciliation;
  customFields: CustomFieldReconciliation;
  asn: AsnReconciliation;
  notes: NoteReconciliation;
  notCarried: NotCarriedField[];
  skipped: SkippedRecord[];
  review: ReviewEntry[];
  checks: ReportCheck[];
}
