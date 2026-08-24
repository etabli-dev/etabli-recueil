/**
 * The vocabulary of the pipeline.
 *
 * CONCEPT §5.3 lists ten stages and names the properties they have to hold: idempotent by
 * `(hash, source, path)`, resumable, concurrent with a conservative default, scratch cleaned after
 * hashing. Those properties are the reason the types here are shaped the way they are — a candidate
 * is addressed by a reference rather than by a path, an outcome is a closed set rather than a
 * boolean, and every stage's contribution to the record is a *proposal* carrying provenance rather
 * than a value written straight onto a row (P4).
 *
 * The hook-facing names (`PipelineAnchor`, `IngestStageInput`, `IngestStageResult`, `IngestRef`,
 * `IngestOutcome`) are the ones in `spec/hooks.md` §6.4 and §6.5, spelled exactly as the spec
 * spells them. They live here rather than in `@recueil/plugin-sdk` because the SDK package is not
 * written yet; when it is, it re-exports these and the pipeline keeps its single definition.
 */
import type { DocumentSourceKind } from '@recueil/core';

/** A JSON value, as it crosses the plugin boundary (`spec/hooks.md` §3). */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** RFC 3339 in the one permitted form (`spec/data-model.md` §1.1). */
export type Timestamp = string;
export type Sha256 = string;

export { type DocumentSourceKind };

/* ------------------------------------------------------------------------------------------ */
/* Stages                                                                                       */
/* ------------------------------------------------------------------------------------------ */

/**
 * The ten stages, in order (CONCEPT §5.3). `spec/hooks.md` calls these the pipeline *anchors*,
 * because a plugin stage attaches `before` or `after` one of them.
 */
export const PIPELINE_ANCHORS = [
  'hash',
  'duplicate_check',
  'archive_extraction',
  'type_detection',
  'ocr',
  'metadata_extraction',
  'resolution',
  'rules',
  'confidence_gate',
  'commit',
] as const;

export type PipelineAnchor = (typeof PIPELINE_ANCHORS)[number];

/** `ingest.4`, `ingest.9` — the `review_queue.source_stage` value a stage writes (§6.1). */
export const stageLabel = (anchor: PipelineAnchor): string =>
  `ingest.${PIPELINE_ANCHORS.indexOf(anchor) + 1}`;

/* ------------------------------------------------------------------------------------------ */
/* Candidates                                                                                   */
/* ------------------------------------------------------------------------------------------ */

/**
 * Where a candidate came from, in the source's own terms (`spec/hooks.md` §6.4).
 *
 * `externalId` is the "path" of the pipeline's `(hash, source, path)` idempotency key: a mailbox
 * UID, a WebDAV path plus etag, an absolute file path. `revision` distinguishes new content at the
 * same `externalId` — a rewritten file — from the same content seen again.
 */
export interface IngestRef {
  sourceId: string;
  externalId: string;
  revision?: string;
}

/** One file offered to the pipeline. */
export interface IngestCandidate {
  ref: IngestRef;
  /** Which `documents.source_kind` this arrival is. Closed vocabulary (§3.3). */
  sourceKind: DocumentSourceKind;
  /** As received. Informational only: it never decides identity, and it is never used as a path. */
  suggestedFilename?: string;
  /** What the source claims. Advisory — the bytes are sniffed and may disagree. */
  mediaType?: string;
  observedAt?: Timestamp;
  /** Sender, subject, folder path, scanner id — whatever the rule engine may match on at stage 8. */
  sourceMetadata?: JsonObject;
  /** Produce the bytes. Called at most once per attempt, and only when the pipeline needs them. */
  read(): Promise<Buffer>;
}

/** The outcome of one candidate (`spec/hooks.md` §6.4). */
export type IngestOutcome =
  | {
      status: 'ingested';
      documentId: string;
      itemId: string;
      sha256: Sha256;
      confidence: number;
      /** Documents extracted from this one at stage 3, each with its own outcome. */
      members?: IngestOutcome[];
    }
  | { status: 'duplicate'; documentId: string; itemId?: string; sha256: Sha256 }
  | {
      status: 'review';
      reviewQueueEntryId: string;
      documentId: string;
      sha256: Sha256;
      reasonCode: string;
      members?: IngestOutcome[];
    }
  | {
      status: 'container';
      documentId: string;
      sha256: Sha256;
      /** A zip or an eml is not itself a library record; its members are. */
      members: IngestOutcome[];
    }
  | { status: 'stopped'; reasonCode: string; explanation: string; documentId?: string; sha256?: Sha256 }
  | { status: 'failed'; code: string; message: string };

/* ------------------------------------------------------------------------------------------ */
/* Type detection (stage 4)                                                                     */
/* ------------------------------------------------------------------------------------------ */

/** The four kinds CONCEPT §5.3 stage 4 names, plus the containers and the honest fallback. */
export const DETECTED_TYPES = [
  'scholarly_pdf',
  'scan',
  'office_document',
  'image',
  'archive',
  'email',
  'text',
  'unknown',
] as const;

export type DetectedType = (typeof DETECTED_TYPES)[number];

/* ------------------------------------------------------------------------------------------ */
/* Provenance and proposals                                                                     */
/* ------------------------------------------------------------------------------------------ */

/** Provenance travels with every derived fact (P4). Nothing enters the library without one. */
export interface Provenance {
  /** Resolver source name, extractor id, rule id or `manual`. */
  source: string;
  sourceRecordId?: string;
  fetchedAt: Timestamp;
  /** 0..1. A source that cannot estimate confidence reports its configured default, never 1. */
  confidence: number;
}

export interface ProposedField {
  value: JsonValue;
  provenance: Provenance;
}

export interface ProposedCreator {
  role: string;
  family?: string;
  given?: string;
  literal?: string;
  orcid?: string;
  affiliation?: string;
  sequence: number;
  provenance: Provenance;
}

/**
 * The item the pipeline intends to create.
 *
 * Field paths are dotted and facet-qualified — `bibliographic.title`, `office.correspondent` — so
 * that two stages writing to two facets never collide, and so that the commit can route each value
 * without a second lookup table. `confidence` is the running score the stage-9 gate reads.
 */
export interface ItemProposal {
  itemType?: string;
  fields: Record<string, ProposedField>;
  creators: ProposedCreator[];
  collectionIds: string[];
  tags: string[];
  customFields: Record<string, JsonValue>;
  /** Free-text notes to attach to the item on commit, e.g. the body of an ingested mail. */
  notes: string[];
  confidence: number;
}

export const emptyProposal = (): ItemProposal => ({
  fields: {},
  creators: [],
  collectionIds: [],
  tags: [],
  customFields: {},
  notes: [],
  confidence: 0,
});

/** A patch a stage — first-party or plugin — asks the pipeline to apply to the proposal. */
export interface ProposalPatch {
  itemType?: string;
  fields?: Record<string, ProposedField>;
  creators?: ProposedCreator[];
  addCollectionIds?: string[];
  addTags?: string[];
  customFields?: Record<string, JsonValue>;
  addNotes?: string[];
}

/* ------------------------------------------------------------------------------------------ */
/* Identifiers                                                                                  */
/* ------------------------------------------------------------------------------------------ */

export const IDENTIFIER_SCHEMES = [
  'doi',
  'pmid',
  'pmcid',
  'arxiv',
  'isbn',
  'issn',
  'issn_l',
  'openalex',
  'semantic_scholar',
  'datacite',
  'orcid',
  'ror',
  'url',
  'zotero_key',
] as const;

export type IdentifierScheme = (typeof IDENTIFIER_SCHEMES)[number];

export interface Identifier {
  scheme: IdentifierScheme;
  /** Normalised: DOIs lower-cased and bare, ISBNs hyphen-free, arXiv ids without the prefix. */
  value: string;
}

/* ------------------------------------------------------------------------------------------ */
/* Health                                                                                       */
/* ------------------------------------------------------------------------------------------ */

/** What an adapter says about the sidecar behind it (`spec/hooks.md` §3). */
export interface HealthReport {
  status: 'ok' | 'degraded' | 'unavailable';
  message?: string;
  checkedAt: Timestamp;
  detail?: JsonObject;
}

/* ------------------------------------------------------------------------------------------ */
/* Reference lists                                                                              */
/* ------------------------------------------------------------------------------------------ */

/**
 * One entry of a document's reference list, as an extractor read it.
 *
 * Phase 5 turns these into `ShadowWork`s and graph edges (CONCEPT §5.8); Phase 2 stores them on the
 * proposal and in the job log, so that the moment a resolver exists there is already a corpus to
 * point it at. `raw` is kept because a parsed reference that turns out to be wrong is only
 * debuggable against the string it came from.
 */
export interface ExtractedReference {
  raw: string;
  title?: string;
  containerTitle?: string;
  issuedYear?: number;
  authors?: Array<{ family?: string; given?: string; literal?: string }>;
  identifiers: Identifier[];
}
