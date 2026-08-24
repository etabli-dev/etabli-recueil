/**
 * The pipeline's settings, and the reasoning behind each default.
 *
 * CONCEPT §5.3 asks for "configurable concurrency with a conservative default" and does not say
 * what conservative means, so this file says it: two. A watched folder that has just been pointed
 * at a decade of scans will otherwise saturate a single-user box's disk and, once OCR is wired to a
 * real OCRmyPDF, its CPU as well — and the failure mode of too much concurrency is a server that
 * stops answering, which is worse than an import that takes an hour longer.
 *
 * The archive limits are the zip-bomb guard. They are deliberately generous enough for a real
 * conference proceedings zip and small enough that a 42-byte archive cannot ask for 4 GiB.
 */

export interface IngestConfig {
  /** How many candidates the pipeline works on at once (CONCEPT §5.3). */
  concurrency: number;

  /**
   * The stage-9 gate (P3). At or above this, the item is created; below it, a `review_queue` entry
   * carries the reason and the proposed action, and no item is created.
   */
  confidenceThreshold: number;

  /** The score a candidate starts with, before any stage has had an opinion. */
  baseConfidence: number;

  /** Where scratch directories are made. Defaults to the OS temporary directory. */
  scratchRoot?: string;

  /** Below this many characters of extractable text, a PDF is treated as having no text layer. */
  textLayerMinChars: number;

  /** Stage 5 runs at all only when this is true; otherwise `ocr_status` becomes `skipped`. */
  ocrEnabled: boolean;

  /** Recursion depth for archives inside archives. 1 means "extract, but do not recurse". */
  maxArchiveDepth: number;

  /** Refuse an archive with more members than this. */
  maxArchiveEntries: number;

  /** Refuse a member whose declared uncompressed size exceeds this. */
  maxArchiveEntryBytes: number;

  /** Refuse an archive whose members sum to more than this uncompressed. */
  maxArchiveTotalBytes: number;

  /** Refuse an archive whose uncompressed total exceeds its compressed size by more than this. */
  maxArchiveExpansionRatio: number;

  /** Above this, extracted text is summarised in the checkpoint rather than stored whole. */
  maxCheckpointTextBytes: number;

  /** Retries of one candidate before it is routed to review with the error as the reason. */
  maxAttemptsPerCandidate: number;
}

export const DEFAULT_INGEST_CONFIG: IngestConfig = {
  concurrency: 2,
  confidenceThreshold: 0.75,
  baseConfidence: 0.2,
  textLayerMinChars: 120,
  ocrEnabled: true,
  maxArchiveDepth: 3,
  maxArchiveEntries: 2_048,
  maxArchiveEntryBytes: 512 * 1024 * 1024,
  maxArchiveTotalBytes: 2 * 1024 * 1024 * 1024,
  maxArchiveExpansionRatio: 200,
  maxCheckpointTextBytes: 4 * 1024 * 1024,
  // `spec/hooks.md` §6.5: three consecutive throws for the same document route it to the review
  // queue with the error as the reason rather than retrying for ever.
  maxAttemptsPerCandidate: 3,
};

export const resolveConfig = (overrides: Partial<IngestConfig> = {}): IngestConfig => {
  const config = { ...DEFAULT_INGEST_CONFIG, ...overrides };
  if (!Number.isInteger(config.concurrency) || config.concurrency < 1) {
    throw new RangeError(`concurrency must be a positive integer, got ${String(config.concurrency)}`);
  }
  if (config.confidenceThreshold < 0 || config.confidenceThreshold > 1) {
    throw new RangeError(
      `confidenceThreshold must be within 0..1, got ${String(config.confidenceThreshold)}`,
    );
  }
  if (config.baseConfidence < 0 || config.baseConfidence > 1) {
    throw new RangeError(`baseConfidence must be within 0..1, got ${String(config.baseConfidence)}`);
  }
  if (config.maxArchiveDepth < 0) {
    throw new RangeError(`maxArchiveDepth must not be negative, got ${String(config.maxArchiveDepth)}`);
  }
  return config;
};
