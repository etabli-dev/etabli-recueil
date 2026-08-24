/**
 * Stage 6, behind an interface.
 *
 * CONCEPT §5.3 stage 6 is two different jobs wearing one number: "GROBID for scholarly PDFs (title,
 * authors, DOI, abstract, reference list, in-text citation contexts); date/correspondent heuristics
 * for office documents". The first needs a sidecar; the second is a page of regular expressions
 * over text that is already in memory. Both are `MetadataExtractor`s, and the pipeline picks the
 * ones that say they can help with the type stage 4 decided.
 *
 * Everything an extractor returns is a *proposal*, never a value: each field carries its own
 * `Provenance` (P4), and each extractor reports a `confidence` the stage-9 gate can add up. That is
 * what makes the difference between "GROBID is sure this is the title" and "the office heuristics
 * think the largest date on the page is the document date" visible at the gate instead of lost.
 */
import type {
  DetectedType,
  ExtractedReference,
  HealthReport,
  Identifier,
  ProposedCreator,
  ProposedField,
  Sha256,
} from '../types.js';

export interface MetadataRequest {
  bytes: Buffer;
  mediaType: string;
  sha256: Sha256;
  detectedType: DetectedType;
  /** Everything the pipeline knows so far: the text layer, or the OCR output. */
  text: string | null;
  /** As received. Informational — an extractor may read it, but it decides nothing on its own. */
  filename?: string | null;
  /** Sender, subject, folder path: the envelope, for extractors that can use it. */
  sourceMetadata?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ExtractedMetadata {
  /** The Recueil item type this extractor believes in, when it has an opinion. */
  itemType?: string;
  /** Facet-qualified field paths: `bibliographic.title`, `office.correspondent`. */
  fields: Record<string, ProposedField>;
  creators: ProposedCreator[];
  /** Identifiers found in the document, for stage 7 to resolve. */
  identifiers: Identifier[];
  /** The reference list, when the extractor can read one. Phase 5 turns these into ShadowWorks. */
  references: ExtractedReference[];
  /** 0..1: this extractor's belief in the record as a whole. */
  confidence: number;
  /** The extractor id, written into every field's provenance. */
  extractor: string;
  warnings?: string[];
}

export interface MetadataExtractor {
  readonly id: string;
  /** Which stage-4 verdicts this extractor is for. */
  supports(detectedType: DetectedType, mediaType: string): boolean;
  extract(request: MetadataRequest): Promise<ExtractedMetadata>;
  health?(): Promise<HealthReport>;
}

/** An empty result, for an extractor that looked and found nothing. */
export const noMetadata = (extractor: string): ExtractedMetadata => ({
  fields: {},
  creators: [],
  identifiers: [],
  references: [],
  confidence: 0,
  extractor,
});
