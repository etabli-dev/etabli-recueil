/**
 * The in-process metadata extractor the tests use in place of GROBID.
 *
 * It is a real `MetadataExtractor` over a fixture corpus keyed by digest, not a stub: it returns
 * properly stamped fields with provenance, it can be told to return a weak record so the
 * confidence gate has something to reject, and it counts its calls so the resume test can prove
 * stage 6 was not repeated. A test that needs GROBID's *parsing* tests `parseTeiHeader` against a
 * captured TEI fixture; a test that needs GROBID's *transport* needs a container and therefore does
 * not exist in this suite.
 */
import type {
  DetectedType,
  ExtractedReference,
  Identifier,
  ProposedCreator,
  ProposedField,
  Sha256,
} from '../types.js';
import type { ExtractedMetadata, MetadataExtractor, MetadataRequest } from './extractor.js';

export interface FakeRecord {
  itemType?: string;
  title?: string;
  containerTitle?: string;
  issuedYear?: number;
  doi?: string;
  abstract?: string;
  authors?: Array<{ family?: string; given?: string; literal?: string; orcid?: string }>;
  references?: ExtractedReference[];
  /** The extractor's belief in the record. The gate reads it; set it low to exercise review. */
  confidence: number;
}

export interface FakeMetadataOptions {
  /** Digest to record. Bytes with no entry get `fallback`, or nothing. */
  corpus?: Record<Sha256, FakeRecord>;
  fallback?: FakeRecord;
  supports?: readonly DetectedType[];
  id?: string;
  /** Fixed timestamp, so a proposal is byte-identical between runs. */
  fetchedAt?: string;
}

export class FakeMetadataExtractor implements MetadataExtractor {
  readonly id: string;

  readonly calls: Array<{ sha256: Sha256; detectedType: DetectedType }> = [];

  private readonly corpus: Record<Sha256, FakeRecord>;
  private readonly fallback: FakeRecord | null;
  private readonly supported: ReadonlySet<DetectedType>;
  private readonly fetchedAt: string;

  constructor(options: FakeMetadataOptions = {}) {
    this.id = options.id ?? 'fake-metadata';
    this.corpus = options.corpus ?? {};
    this.fallback = options.fallback ?? null;
    this.supported = new Set(options.supports ?? ['scholarly_pdf', 'scan', 'text']);
    this.fetchedAt = options.fetchedAt ?? '2026-08-22T09:14:00.000Z';
  }

  supports(detectedType: DetectedType): boolean {
    return this.supported.has(detectedType);
  }

  async extract(request: MetadataRequest): Promise<ExtractedMetadata> {
    this.calls.push({ sha256: request.sha256, detectedType: request.detectedType });

    const record = this.corpus[request.sha256] ?? this.fallback;
    if (record === undefined || record === null) {
      return {
        fields: {},
        creators: [],
        identifiers: [],
        references: [],
        confidence: 0,
        extractor: this.id,
        warnings: ['the fake corpus holds nothing for these bytes'],
      };
    }

    const provenance = { source: this.id, fetchedAt: this.fetchedAt, confidence: record.confidence };
    const fields: Record<string, ProposedField> = {};
    const set = (path: string, value: string | number | undefined): void => {
      if (value === undefined) return;
      fields[path] = { value, provenance };
    };

    set('bibliographic.title', record.title);
    set('bibliographic.containerTitle', record.containerTitle);
    set('bibliographic.issuedYear', record.issuedYear);
    set('bibliographic.doi', record.doi);
    set('bibliographic.abstract', record.abstract);

    const identifiers: Identifier[] = record.doi === undefined ? [] : [{ scheme: 'doi', value: record.doi }];

    const creators: ProposedCreator[] = (record.authors ?? []).map((author, index) => {
      const entry: ProposedCreator = { role: 'author', sequence: index + 1, provenance };
      if (author.family !== undefined) entry.family = author.family;
      if (author.given !== undefined) entry.given = author.given;
      if (author.literal !== undefined) entry.literal = author.literal;
      if (author.orcid !== undefined) entry.orcid = author.orcid;
      return entry;
    });

    const result: ExtractedMetadata = {
      fields,
      creators,
      identifiers,
      references: record.references ?? [],
      confidence: record.confidence,
      extractor: this.id,
    };
    if (record.itemType !== undefined) result.itemType = record.itemType;
    return result;
  }

  callsFor(sha256: Sha256): number {
    return this.calls.filter((call) => call.sha256 === sha256).length;
  }
}
