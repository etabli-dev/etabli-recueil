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
  /**
   * Of those, the ones whose Recueil item is not in the trash.
   *
   * The expected side of `document_count_parity`. A document whose item a person has binned is
   * excluded from both sides of every per-document count, and `trashedInRecueil` below names them,
   * because an exclusion nobody can see is the shape ADR-0021 §2 forbids.
   */
  apiActive: number;
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
  /** Live items in the target claiming a Paperless origin the server does not have. */
  orphanedInRecueil: string[];
  /** Paperless documents whose Recueil item is in the trash. Excluded from the counts, listed here. */
  trashedInRecueil: number[];
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
  /**
   * Paperless ids with an item, no stored original, and nothing in the run's record explaining it.
   *
   * The blocking half of `originals_accounted_for`, matched by id rather than by count: counting
   * alone let a recorded failure for one document excuse a quietly absent file under another.
   */
  unaccountedWithoutOriginal: number[];
  /** Paperless ids the run recorded as missing or unreadable whose blob is in the store after all. */
  contradictedByStore: number[];
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
  /** Of those, the ones with a name Recueil can hold. An empty name is refused (§3.11). */
  apiNamed: number;
  /** Tags in the target whose name is one the API listed, by query. */
  recueilTotal: number;
  /** Paperless tag names with no Recueil tag. */
  missingInRecueil: string[];
  /** Tag assignments across every document the API returned. */
  apiAssignments: number;
  /** Rows in `item_tags` for the imported items, by query. */
  recueilAssignments: number;
  /**
   * Assignments naming a tag `/api/tags/` defined, counted from the API payload.
   *
   * The expected side of `tag_assignments_carried`. The subtraction is decided by comparing the
   * documents against `snapshot.tags` — both sides of the source — and never by counting what the
   * importer logged that it skipped.
   */
  apiAssignmentsResolvable: number;
  /** Assignments naming a tag id `/api/tags/` did not define. */
  apiAssignmentsDangling: number;
  /** The distinct tag ids behind those, in ascending order. Blocking: `tag_references_resolvable`. */
  danglingTagIds: number[];
  /** Assignments naming a tag that was not in `/api/tags/`. Each one is also in `skipped`. */
  skippedAssignments: number;
  /** Paperless tags that have a parent. Recueil tags are flat, so the tree is not carried. */
  hierarchical: number;
  inboxTags: number;
  coloured: number;
}

export interface CustomFieldReconciliation {
  apiTotal: number;
  /** Of those, the ones whose Paperless data type this importer maps. Source-derived. */
  apiSupported: number;
  /** Definitions in the target whose `field_key` is one this run planned, by query. */
  recueilDefined: number;
  byDataType: Record<string, number>;
  /** Paperless types this importer has no mapping for. Their values are not written. */
  unsupported: Array<{ paperlessId: number; name: string; dataType: string; reason: string }>;
  /** Values the API carried on the documents it returned. Same number as `apiValueInstances`. */
  apiValues: number;
  /** Custom-field value instances on the API payload, unfiltered. */
  apiValueInstances: number;
  /** Of those, the ones naming a field id `/api/custom_fields/` did not define. */
  apiInstancesDangling: number;
  /** Of those, the ones on a field whose Paperless data type this importer has no mapping for. */
  apiInstancesUnsupportedType: number;
  /**
   * Instances the source can express: the total less the three exclusions above and below.
   *
   * The expected side of `custom_field_values_carried`. Every exclusion is a fact about the source
   * — a field id the source never defined, a data type this version has no column for, an option
   * id the source's own field definition does not list — and every one is listed rather than
   * subtracted from both sides.
   */
  apiInstancesCarryable: number;
  /** The distinct undefined field ids. Blocking: `custom_field_references_resolvable`. */
  danglingFieldIds: number[];
  /** Values the source's own field definition gives no meaning to, one entry each. */
  unrepresentableValues: UnrepresentableValue[];
  /** Rows in `field_values` for the imported items, by query. */
  recueilValues: number;
  /**
   * Distinct `(item, field, group)` slots among those rows, by query.
   *
   * One Paperless value is one slot however many rows it becomes: a `documentlink` writes one row
   * per link, so comparing rows with instances would compare two different units and the check
   * would drift by however many links the library happens to hold.
   */
  recueilInstances: number;
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
  /** Documents whose ASN is on their own item's `item_office.asn`, by query. */
  recueilCarried: number;
  /** Documents whose ASN is on `paperless_asn` because something provably holds the number. */
  recueilDeferred: number;
  /** One entry per deferral, with the live item that holds the number where there is one. */
  deferrals: AsnDeferral[];
  /** ASNs that reached neither column. Non-empty fails `asn_preserved`. */
  lost: AsnLoss[];
  /** Non-null ASNs among live items in the whole target, by query. Counted, not deduplicated. */
  recueilLiveAsn: number;
  /** Distinct non-null ASNs among live items in the whole target, by query. */
  recueilDistinctAsn: number;
  /** True when those two agree: `ux_item_office_asn` holds and nothing shares a number. */
  unique: boolean;
  /** ASNs Paperless itself had on more than one document. */
  duplicatesInSource: Array<{ asn: number; documents: number[] }>;
  /** How many ASNs those duplicates cost: one document keeps each number, the rest cannot. */
  duplicateLossesInSource: number;
  /** ASNs that could not be written because another item already held them. */
  collisions: Array<{ asn: number; paperlessId: number; heldByItemId: string }>;
  /** The lowest and highest ASN carried across, for a person checking against Paperless. */
  range: { min: number | null; max: number | null };
}

export interface NoteReconciliation {
  /** Notes the API carried on the documents it returned. */
  apiTotal: number;
  /**
   * Of those, distinct by trimmed text within one document.
   *
   * The expected side of `notes_carried`. A note is keyed by its item and its text, so two
   * byte-identical notes on one document are one note in Recueil; comparing against `apiTotal`
   * would make that collapse look like a loss.
   */
  apiDistinct: number;
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

/**
 * How a check's two numbers are compared.
 *
 * `at-least` exists for the one informational check where a larger target side is genuinely
 * correct. Every blocking check is `equals`: ADR-0021 §3 allows an inequality only with a comment
 * saying which direction is the failure and why the other is impossible, and none of these has one.
 */
export type CheckComparison = 'equals' | 'at-least';

/**
 * One named assertion, so that `pass` can be traced to the checks that decided it.
 *
 * `pass` is **derived** from `expected`, `actual` and `compare` by `build.ts`. It is not a separate
 * expression that happens to be printed beside them, because that is exactly how the Phase 2 review
 * came to find a blocking check reading `PASS ... expected=6 actual=0`.
 */
export interface ReportCheck {
  name: string;
  description: string;
  pass: boolean;
  expected: number | string;
  actual: number | string;
  compare: CheckComparison;
  /** False when the check is informational and does not affect `pass`. */
  blocking: boolean;
}

/** One custom-field value the source's own field definition gives no meaning to. */
export interface UnrepresentableValue {
  paperlessId: number;
  fieldId: number;
  fieldName: string;
  reason: string;
}

/** One ASN the facet could not take, with the target's own evidence for why. */
export interface AsnDeferral {
  asn: number;
  paperlessId: number;
  /** The live item in the target that holds the number, queried, or null. */
  heldByItemId: string | null;
  /** True when Paperless itself put the number on a lower document id. */
  duplicateInSource: boolean;
}

/** One ASN that reached neither `item_office.asn` nor `paperless_asn`. */
export interface AsnLoss {
  asn: number;
  paperlessId: number;
  reason: string;
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
