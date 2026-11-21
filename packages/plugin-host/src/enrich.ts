/**
 * The enrichment engine (CONCEPT §5.4): resolvers in, merged facts out.
 *
 * One item at a time, in the order Metadata Mender established and its tests pin
 * (spec/parity-zotero-plugins.md §1.2–1.5):
 *
 * 1. **Identifiers and pre-flight.** DOI, PMID, PMCID, arXiv and ISBN from the facet, and DOI and
 *    PMID lines from Extra. An item whose DOIs or PMIDs are malformed or disagree is skipped before
 *    any network call: enriching an item whose identity is in doubt can only make it worse.
 * 2. **Lookup**, every enabled resolver that can look up one of those schemes, in priority order.
 *    A resolver that throws is recorded and the run continues with the rest.
 * 3. **Identity.** A returned record must carry the item's DOI when the item has one, and the same
 *    PMID when both have one; its title must be at least 0.8 similar (token Jaccard) to the item's,
 *    and the item's first author's surname must appear among its creators. A record that fails is
 *    dropped as "conflicts with the current reference", never merged.
 * 4. **Merge.** For each field independently, the first source in priority order with a value.
 *    `fill` (the default) writes only empty fields; `overwrite` writes every field. Either way the
 *    write goes through the provenance gate with the resolver's stamp, so a field a person has
 *    locked is never touched and is reported as skipped (P4). Creators are written only when the
 *    item has none, or in `overwrite`.
 * 5. **Metrics** are observations (`item_metrics`, M1), one per metric and source per day.
 *
 * `dryRun` computes everything and writes nothing.
 */
import { newId, normalise, schema } from '@recueil/core';
import type { Actor, BibliographicInput, CreatorRole, Recueil } from '@recueil/core';
import type { Identifier, MetricObservation, Resolver, ResolverRecord } from '@recueil/plugin-sdk';
import { and, eq } from 'drizzle-orm';

import type { PluginHost, RegisteredHook } from './host.js';
import { canonicalDoi, extraValues, nameKey, titleSimilarity } from '@recueil/plugin-sdk';

export type EnrichMode = 'fill' | 'overwrite';

export interface EnrichOptions {
  mode?: EnrichMode;
  dryRun?: boolean;
  /** Source names in the order they win, e.g. `['pubmed', 'openalex', 'crossref']`. Default: resolver priority. */
  sourcePriority?: readonly string[];
  /** Restrict to these sources. */
  sources?: readonly string[];
  metrics?: boolean;
  actor?: Actor;
  /** Similarity below which a record is refused as another work. Metadata Mender: 0.8. */
  titleThreshold?: number;
}

export type EnrichStatus = 'updated' | 'unchanged' | 'skipped' | 'notfound' | 'error';

export interface EnrichResult {
  itemId: string;
  status: EnrichStatus;
  reason: string | null;
  /** Field → the source whose value was written (or would be, in a dry run). */
  changes: Record<string, { source: string; before: unknown; after: unknown }>;
  /** Fields a lock protected. */
  locked: string[];
  creatorsFrom: string | null;
  metrics: number;
  sources: Record<string, 'matched' | 'nomatch' | 'conflict' | 'error'>;
  errors: Record<string, string>;
}

const COLUMN_OF_FIELD = (path: string): string | null =>
  path.startsWith('bibliographic.') ? path.slice('bibliographic.'.length) : null;

const isBlank = (value: unknown): boolean =>
  value === null || value === undefined || (typeof value === 'string' && value.trim() === '');

/** The identifiers an item carries, and whether they are fit to look up (§1.2). */
export const itemIdentifiers = (
  recueil: Recueil,
  itemId: string,
): { identifiers: Identifier[]; problem: string | null } => {
  const record = recueil.library.getItem(itemId);
  const bib = record.bibliographic;
  const identifiers: Identifier[] = [];

  const dois = new Set<string>();
  let badDoi = false;
  for (const raw of [bib?.doi, ...extraValues(record.item.extra, 'DOI')]) {
    if (isBlank(raw)) continue;
    const doi = canonicalDoi(raw);
    if (doi === null) badDoi = true;
    else dois.add(doi);
  }
  if (badDoi || dois.size > 1) return { identifiers: [], problem: 'DOI identifiers are invalid or conflict; review before lookup' };

  const pmids = new Set<string>();
  let badPmid = false;
  for (const raw of [bib?.pmid, ...extraValues(record.item.extra, 'PMID')]) {
    if (isBlank(raw)) continue;
    const pmid = String(raw).trim();
    if (!/^\d+$/u.test(pmid)) badPmid = true;
    else pmids.add(pmid);
  }
  if (badPmid || pmids.size > 1) return { identifiers: [], problem: 'PMID identifiers are invalid or conflict; review before lookup' };

  for (const doi of dois) identifiers.push({ scheme: 'doi', value: doi });
  for (const pmid of pmids) identifiers.push({ scheme: 'pmid', value: pmid });
  if (!isBlank(bib?.pmcid)) identifiers.push({ scheme: 'pmcid', value: String(bib?.pmcid) });
  if (!isBlank(bib?.arxivId)) identifiers.push({ scheme: 'arxiv', value: String(bib?.arxivId) });
  if (!isBlank(bib?.isbn)) identifiers.push({ scheme: 'isbn', value: String(bib?.isbn) });
  return { identifiers, problem: null };
};

/** Metadata Mender `_checkIdentity` and the local-reference conflict test (§1.4). */
export const identityProblem = (
  record: ResolverRecord,
  item: { identifiers: Identifier[]; title: string | null; firstAuthor: string | null },
  titleThreshold: number,
): string | null => {
  const itemDoi = item.identifiers.find((id) => id.scheme === 'doi')?.value ?? null;
  const recordDoi =
    canonicalDoi(record.fields['bibliographic.doi']?.value) ??
    canonicalDoi(record.matched.find((id) => id.scheme === 'doi')?.value);
  if (itemDoi !== null && recordDoi !== itemDoi) return recordDoi === null ? 'the record carries no DOI' : `the record is DOI ${recordDoi}`;

  const itemPmid = item.identifiers.find((id) => id.scheme === 'pmid')?.value ?? null;
  const recordPmid = (record.fields['bibliographic.pmid']?.value as string | undefined) ?? record.matched.find((id) => id.scheme === 'pmid')?.value;
  if (itemPmid !== null && recordPmid !== undefined && recordPmid !== null && String(recordPmid) !== itemPmid) {
    return `the record is PMID ${recordPmid}`;
  }
  if (itemPmid !== null && itemDoi === null && (recordPmid === undefined || recordPmid === null)) return 'the record carries no PMID';

  const recordTitle = record.fields['bibliographic.title']?.value;
  if (!isBlank(item.title) && typeof recordTitle === 'string' && recordTitle.trim() !== '') {
    const similarity = titleSimilarity(item.title as string, recordTitle);
    if (similarity < titleThreshold) return `the title is too different (${similarity.toFixed(2)})`;
  }
  if (item.firstAuthor !== null && (record.creators ?? []).length > 0) {
    const key = nameKey(item.firstAuthor);
    const found = (record.creators ?? []).some((creator) => nameKey(creator.family ?? creator.literal ?? '') === key);
    if (!found) return `no creator of the record is called ${item.firstAuthor}`;
  }
  return null;
};

export class EnrichmentEngine {
  constructor(
    private readonly recueil: Recueil,
    private readonly host: PluginHost,
  ) {}

  private orderedResolvers(options: EnrichOptions): RegisteredHook<Resolver>[] {
    let resolvers = [...this.host.resolvers()];
    if (options.sources !== undefined) resolvers = resolvers.filter((hook) => options.sources!.includes(hook.impl.source));
    if (options.sourcePriority !== undefined) {
      const rank = (source: string) => {
        const index = options.sourcePriority!.indexOf(source);
        return index === -1 ? Number.MAX_SAFE_INTEGER : index;
      };
      resolvers.sort((left, right) => rank(left.impl.source) - rank(right.impl.source));
    }
    return resolvers;
  }

  async enrichItem(itemId: string, options: EnrichOptions = {}): Promise<EnrichResult> {
    const result: EnrichResult = {
      itemId,
      status: 'unchanged',
      reason: null,
      changes: {},
      locked: [],
      creatorsFrom: null,
      metrics: 0,
      sources: {},
      errors: {},
    };
    const record = this.recueil.library.getItem(itemId, { includeTrashed: true });
    if (record.item.trashedAt !== null) return { ...result, status: 'skipped', reason: 'the item is in the trash' };

    const { identifiers, problem } = itemIdentifiers(this.recueil, itemId);
    if (problem !== null) return { ...result, status: 'skipped', reason: problem };
    if (identifiers.length === 0) return { ...result, status: 'skipped', reason: 'no DOI, PMID, PMCID, arXiv id or ISBN' };

    const creators = this.recueil.creators.forItem(itemId);
    const firstAuthor = creators.find((entry) => entry.appearance.role === 'author')?.creator;
    const identity = {
      identifiers,
      title: record.item.title,
      firstAuthor: firstAuthor === undefined ? null : (firstAuthor.familyName ?? firstAuthor.literalName),
    };

    const accepted: { source: string; record: ResolverRecord }[] = [];
    const resolvers = this.orderedResolvers(options);
    for (const hook of resolvers) {
      const usable = identifiers.filter((id) => hook.impl.supports.lookup.includes(id.scheme));
      if (usable.length === 0) continue;
      const source = hook.impl.source;
      try {
        const records = await this.host.call<ResolverRecord[]>(hook as RegisteredHook<object>, 'lookup', [{ identifiers: usable }], {
          defaultTimeoutMs: 30_000,
          ceilingTimeoutMs: 300_000,
          ...(options.actor === undefined ? {} : { actor: options.actor }),
          dryRun: options.dryRun ?? false,
        });
        if (records.length === 0) {
          result.sources[source] = 'nomatch';
          continue;
        }
        const best = [...records].sort((left, right) => right.score - left.score)[0]!;
        const conflict = identityProblem(best, identity, options.titleThreshold ?? 0.8);
        if (conflict !== null) {
          result.sources[source] = 'conflict';
          result.errors[source] = `metadata conflicts with the current reference: ${conflict}`;
          continue;
        }
        result.sources[source] = 'matched';
        accepted.push({ source, record: best });
      } catch (error) {
        result.sources[source] = 'error';
        result.errors[source] = error instanceof Error ? error.message : String(error);
      }
    }

    if (accepted.length === 0) {
      const anyError = Object.keys(result.errors).length > 0;
      return {
        ...result,
        status: anyError ? 'error' : 'notfound',
        reason: anyError ? 'no verified source metadata; lookup or identity checks failed' : 'no source knows this work',
      };
    }

    /* Merge, field by field: the first accepted source with a value wins. */
    const mode = options.mode ?? 'fill';
    const current = (record.bibliographic ?? {}) as Record<string, unknown>;
    const locked = new Set(this.recueil.library.lockedBibliographicFields(itemId));
    const write: Record<string, unknown> = {};
    const stamps: Record<string, string> = {};
    for (const { source, record: found } of accepted) {
      for (const [path, entry] of Object.entries(found.fields)) {
        const column = COLUMN_OF_FIELD(path);
        if (column === null || column in write || column in stamps) continue;
        if (isBlank(entry.value)) continue;
        stamps[column] = source;
        const before = column === 'title' ? (current['title'] ?? record.item.title) : current[column];
        if (mode === 'fill' && !isBlank(before)) continue;
        if (String(before ?? '') === String(entry.value)) continue;
        if (locked.has(column)) {
          result.locked.push(column);
          continue;
        }
        write[column] = entry.value;
        result.changes[column] = { source, before: before ?? null, after: entry.value };
      }
    }

    let creatorWrite: ResolverRecord['creators'] | null = null;
    if (creators.length === 0 || mode === 'overwrite') {
      const from = accepted.find(({ record: found }) => (found.creators ?? []).length > 0);
      if (from !== undefined) {
        creatorWrite = from.record.creators!;
        result.creatorsFrom = from.source;
      }
    }

    const observations: MetricObservation[] = [];
    if (options.metrics !== false) {
      for (const hook of resolvers) {
        if (hook.impl.metrics === undefined || hook.impl.supports.metrics.length === 0) continue;
        if (!accepted.some(({ source }) => source === hook.impl.source)) continue;
        try {
          observations.push(
            ...(await this.host.call<MetricObservation[]>(
              hook as RegisteredHook<object>,
              'metrics',
              [{ identifiers, metrics: [...hook.impl.supports.metrics] }],
              { defaultTimeoutMs: 30_000, ceilingTimeoutMs: 300_000, dryRun: options.dryRun ?? false },
            )),
          );
        } catch (error) {
          result.errors[`${hook.impl.source}:metrics`] = error instanceof Error ? error.message : String(error);
        }
      }
    }
    result.metrics = observations.length;

    const changed = Object.keys(result.changes).length > 0 || creatorWrite !== null;
    result.status = changed ? 'updated' : 'unchanged';
    if (options.dryRun === true) return result;

    const actor = options.actor ?? this.recueil.actor;
    this.recueil.connection.transaction(() => {
      // One write per winning source, so each field carries the provenance of the source it came from.
      const bySource = new Map<string, BibliographicInput>();
      for (const [column, value] of Object.entries(write)) {
        const source = result.changes[column]!.source;
        const entry = bySource.get(source) ?? {};
        (entry as Record<string, unknown>)[column] = value;
        bySource.set(source, entry);
      }
      for (const [source, values] of bySource) {
        const outcome = this.recueil.library.writeBibliographic(itemId, values, actor, {
          provenance: { source, lock: false, confidence: 0.9 },
        });
        for (const skipped of outcome.skipped) {
          result.locked.push(skipped.fieldPath);
          delete result.changes[skipped.fieldPath];
        }
      }
      if (creatorWrite !== null) this.writeCreators(itemId, creatorWrite, actor);
      this.writeMetrics(itemId, observations);
    })();
    if (Object.keys(result.changes).length === 0 && creatorWrite === null) result.status = 'unchanged';
    return result;
  }

  private writeCreators(itemId: string, creators: NonNullable<ResolverRecord['creators']>, actor: Actor): void {
    const entries: { creatorId: string; role: CreatorRole; rawName: string | null }[] = [];
    const seen = new Set<string>();
    for (const creator of [...creators].sort((left, right) => left.sequence - right.sequence)) {
      const organisation = creator.literal !== undefined && creator.family === undefined;
      const sortName = organisation
        ? (creator.literal ?? '')
        : creator.given === undefined
          ? (creator.family ?? '')
          : `${creator.family ?? ''}, ${creator.given}`;
      // The same person already in the library is reused, not created a second time.
      const existing = this.recueil.creators
        .findBySortName(normalise(sortName))
        .find((candidate) =>
          organisation
            ? candidate.literalName === (creator.literal ?? '')
            : candidate.familyName === (creator.family ?? null) && candidate.givenName === (creator.given ?? null),
        );
      const created =
        existing ??
        this.recueil.creators.create(
          organisation
            ? { kind: 'organisation', literalName: creator.literal ?? '' }
            : { kind: 'person', familyName: creator.family ?? null, givenName: creator.given ?? null, orcid: creator.orcid ?? null },
          actor,
        );
      const role = (creator.role === 'editor' || creator.role === 'translator' ? creator.role : 'author') as CreatorRole;
      if (seen.has(`${created.id}:${role}`)) continue;
      seen.add(`${created.id}:${role}`);
      entries.push({ creatorId: created.id, role, rawName: created.displayName });
    }
    this.recueil.creators.setItemCreators(itemId, entries, actor);
  }

  private writeMetrics(itemId: string, observations: readonly MetricObservation[]): void {
    for (const observation of observations) {
      if (!Number.isFinite(observation.value)) continue;
      // One observation per metric and source per day (M1, ux_item_metrics_observation).
      const observedAt = `${observation.observedAt.slice(0, 10)}T00:00:00.000Z`;
      const exists = this.recueil.db
        .select({ id: schema.itemMetrics.id })
        .from(schema.itemMetrics)
        .where(
          and(
            eq(schema.itemMetrics.itemId, itemId),
            eq(schema.itemMetrics.metric, observation.metric),
            eq(schema.itemMetrics.source, observation.provenance.source),
            eq(schema.itemMetrics.observedAt, observedAt),
          ),
        )
        .get();
      if (exists !== undefined) continue;
      this.recueil.db
        .insert(schema.itemMetrics)
        .values({
          id: newId(),
          itemId,
          metric: observation.metric,
          metricValue: observation.value,
          source: observation.provenance.source,
          observedAt,
          sourceAsOf: null,
          jobId: null,
        })
        .run();
    }
  }
}
