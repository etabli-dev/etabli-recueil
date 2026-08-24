/**
 * Stage 7: identifier resolution, as far as Phase 2 goes.
 *
 * CONCEPT §5.3 stage 7 is "identifier resolution → enrichment (§5.4)", and §5.4 is Phase 3: the
 * `Resolver` hook of `spec/hooks.md` §6.1, Crossref and OpenAlex and the rest, adaptive rate
 * limiting, per-field merge policy. None of that exists yet, and inventing a smaller version of it
 * here would mean writing a merge policy that Phase 3 then has to unpick.
 *
 * So Phase 2 does the part that is genuinely the pipeline's: it finds the identifiers in the
 * document, normalises them, records them on the proposal with their provenance, and offers a
 * seam — this interface — for a resolver to answer. `NullResolver` is what a deployment with no
 * network configured gets, and it is what the tests use unless they are testing resolution itself.
 * The seam takes the shape of §6.1's `lookup` so that the first-party Crossref plugin implements
 * one interface rather than two.
 *
 * What Phase 2 *does* do with resolution is honest about the negative case: a scholarly PDF with no
 * identifier and no resolver answer gets the `no_identifier_match` reason code at the gate rather
 * than being filed on the strength of a parsed title (P3).
 */
import type {
  HealthReport,
  Identifier,
  ProposedCreator,
  ProposedField,
} from '../types.js';

export interface ResolutionRequest {
  /** One or more identifiers for the same work. Resolving any of them is a success. */
  identifiers: readonly Identifier[];
  /** What the extractor believes, for a resolver that can search rather than look up. */
  hint?: {
    title?: string;
    authors?: string[];
    containerTitle?: string;
    issuedYear?: number;
  };
  signal?: AbortSignal;
}

export interface ResolutionRecord {
  /** Which identifiers this record answers, plus any the source added. */
  matched: Identifier[];
  itemType?: string;
  fields: Record<string, ProposedField>;
  creators: ProposedCreator[];
  /** 0..1, the resolver's own belief that this record is the requested work. */
  score: number;
  /** The value written into every field's provenance, and into the job log. */
  source: string;
}

export interface IdentifierResolver {
  readonly id: string;
  /** Written into `Provenance.source`. */
  readonly source: string;
  readonly supports: readonly Identifier['scheme'][];
  lookup(request: ResolutionRequest): Promise<ResolutionRecord[]>;
  health?(): Promise<HealthReport>;
}

/**
 * The resolver used when none is configured: it answers nothing, quickly.
 *
 * The pipeline treats "no resolver" and "resolver found nothing" identically, which is right: both
 * mean the identifiers on the document are unverified, and both are a reason for the gate to be
 * less sure. What it does *not* do is invent metadata to fill the gap.
 */
export class NullResolver implements IdentifierResolver {
  readonly id = 'none';
  readonly source = 'none';
  readonly supports: readonly Identifier['scheme'][] = [];

  async lookup(): Promise<ResolutionRecord[]> {
    return [];
  }

  async health(): Promise<HealthReport> {
    return {
      status: 'unavailable',
      message: 'No identifier resolver is configured; stage 7 records identifiers without checking them.',
      checkedAt: new Date().toISOString(),
    };
  }
}

/**
 * An in-process resolver over a fixture map, for tests and for offline demonstrations.
 *
 * Keyed by `scheme:value`, so a test can say "this DOI resolves to this record" and then assert
 * that the fields arrived with `source: 'fixture'` in their provenance rather than the extractor's.
 */
export class FixtureResolver implements IdentifierResolver {
  readonly id: string;
  readonly source: string;
  readonly supports: readonly Identifier['scheme'][];

  readonly calls: Identifier[][] = [];

  constructor(
    private readonly records: Record<string, Omit<ResolutionRecord, 'source'>>,
    options: { id?: string; source?: string; supports?: readonly Identifier['scheme'][] } = {},
  ) {
    this.id = options.id ?? 'fixture';
    this.source = options.source ?? 'fixture';
    this.supports = options.supports ?? ['doi', 'arxiv', 'pmid', 'isbn'];
  }

  async lookup(request: ResolutionRequest): Promise<ResolutionRecord[]> {
    this.calls.push([...request.identifiers]);
    const out: ResolutionRecord[] = [];
    for (const identifier of request.identifiers) {
      const record = this.records[`${identifier.scheme}:${identifier.value}`];
      if (record !== undefined) out.push({ ...record, source: this.source });
    }
    return out;
  }

  async health(): Promise<HealthReport> {
    return { status: 'ok', message: 'in-process fixture', checkedAt: new Date().toISOString() };
  }
}
