/**
 * The record deduplication engine (CONCEPT §5.6, spec/hooks.md §6.3).
 *
 * 1. **Subjects**: every live item, with its normalised identifiers and title.
 * 2. **Blocking**: each enabled `dedupRule` of the record layer names cheap keys per subject; only
 *    subjects that share a key are compared. A rule whose `blockingKeys` throws is disabled for the
 *    run (false negatives are safe, false merges are not).
 * 3. **Comparison**: every rule compares every candidate pair. The verdicts combine as the spec
 *    says: the highest-scoring `duplicate` wins, a `distinct` from any rule vetoes it, a throw is
 *    `undecided` for that pair.
 * 4. **Clusters**: duplicate pairs are joined into groups (union–find).
 * 5. **Decision per group**: a group is *auto* when every joining verdict is a `duplicate` at or
 *    above `autoMergeThreshold` and all members share an item type — which by default only an
 *    identifier match reaches. Everything else becomes a `record_merge_candidate` review entry with
 *    the merge as its proposed payload (P3).
 * 6. **Merge** (only with `apply`): the winner rule picks the survivor — `newest` by default, the
 *    Argus One rule (date added descending, ties by id descending) — and `ItemMergeService` does the
 *    rest, reversibly.
 *
 * A dry run (the default) plans everything and writes nothing.
 */
import type { Actor, Recueil } from '@recueil/core';
import { schema } from '@recueil/core';
import { ReviewQueueService, ensureIngestSchema } from '@recueil/ingest';
import type { DedupRule, DedupSubject, DedupVerdict, Identifier } from '@recueil/plugin-sdk';
import { isNull } from 'drizzle-orm';

import type { PluginHost, RegisteredHook } from './host.js';
import { canonicalDoi, normaliseTitle } from '@recueil/plugin-sdk';

type JsonObject = { [k: string]: null | boolean | number | string | JsonObject | JsonObject[] | string[] };

export type WinnerRule = 'newest' | 'oldest' | 'most_complete';

export interface DedupOptions {
  /** Default true: plan only. */
  dryRun?: boolean;
  /** Score at or above which an all-`duplicate` group merges without review. Default 1. */
  autoMergeThreshold?: number;
  /** Score below which a `duplicate` verdict is not even a review candidate. Default 0.6. */
  reviewThreshold?: number;
  winnerRule?: WinnerRule;
  itemIds?: readonly string[];
  actor?: Actor;
}

export interface DedupPair {
  a: string;
  b: string;
  verdict: DedupVerdict;
}

export interface DedupGroup {
  itemIds: string[];
  winnerId: string;
  loserIds: string[];
  decision: 'auto' | 'review';
  pairs: DedupPair[];
  reason: string;
  /** Set after `apply`. */
  merged?: boolean;
  reviewId?: string;
}

export interface DedupRun {
  dryRun: boolean;
  subjects: number;
  comparisons: number;
  groups: DedupGroup[];
  disabledRules: { rule: string; reason: string }[];
}

const completeness = (snapshot: JsonObject): number =>
  Object.values((snapshot['bibliographic'] as JsonObject | null) ?? {}).filter(
    (value) => value !== null && value !== '' && value !== false,
  ).length;

export class DedupEngine {
  constructor(
    private readonly recueil: Recueil,
    private readonly host: PluginHost,
  ) {}

  private subjects(itemIds?: readonly string[]): DedupSubject[] {
    const rows = this.recueil.db
      .select()
      .from(schema.items)
      .where(isNull(schema.items.trashedAt))
      .all()
      .filter((row) => itemIds === undefined || itemIds.includes(row.id));
    const bibs = new Map(
      this.recueil.db
        .select()
        .from(schema.itemBibliographic)
        .all()
        .map((row) => [row.itemId, row]),
    );
    return rows.map((row) => {
      const bib = bibs.get(row.id);
      const identifiers: Identifier[] = [];
      const doi = canonicalDoi(bib?.doi ?? null);
      if (doi !== null) identifiers.push({ scheme: 'doi', value: doi });
      if (bib?.pmid) identifiers.push({ scheme: 'pmid', value: bib.pmid });
      if (bib?.pmcid) identifiers.push({ scheme: 'pmcid', value: bib.pmcid.toUpperCase() });
      if (bib?.arxivId) identifiers.push({ scheme: 'arxiv', value: bib.arxivId.toLowerCase().replace(/v\d+$/u, '') });
      if (bib?.isbn) identifiers.push({ scheme: 'isbn', value: bib.isbn.replace(/[^0-9X]/giu, '').toUpperCase() });
      const snapshot: JsonObject = {
        id: row.id,
        itemType: row.itemType,
        title: row.title,
        dateAdded: row.dateAdded,
        bibliographic: (bib === undefined ? null : JSON.parse(JSON.stringify(bib))) as JsonObject,
        firstAuthor: this.recueil.creators.forItem(row.id)[0]?.creator.familyName ?? null,
      };
      return {
        layer: 'record',
        itemId: row.id,
        itemType: row.itemType,
        snapshot,
        identifiers,
        normalisedTitle: normaliseTitle(row.title ?? bib?.title ?? ''),
        ...(bib?.issuedYear == null ? {} : { issuedYear: bib.issuedYear }),
      } as DedupSubject;
    });
  }

  async run(options: DedupOptions = {}): Promise<DedupRun> {
    const dryRun = options.dryRun ?? true;
    const reviewThreshold = options.reviewThreshold ?? 0.6;
    const autoThreshold = options.autoMergeThreshold ?? 1;
    const rules = this.host.dedupRules().filter((hook) => hook.impl.layer === 'record');
    const subjects = this.subjects(options.itemIds);
    const byId = new Map(subjects.map((subject) => [(subject as { itemId: string }).itemId, subject]));
    const run: DedupRun = { dryRun, subjects: subjects.length, comparisons: 0, groups: [], disabledRules: [] };

    /* Blocking. */
    const candidatePairs = new Set<string>();
    const activeRules: RegisteredHook<DedupRule>[] = [];
    for (const hook of rules) {
      const buckets = new Map<string, string[]>();
      try {
        for (const subject of subjects) {
          const keys = await this.host.call<string[]>(hook as RegisteredHook<object>, 'blockingKeys', [subject], {
            defaultTimeoutMs: 2_000,
            ceilingTimeoutMs: 10_000,
            dryRun,
          });
          for (const key of new Set(keys)) buckets.set(key, [...(buckets.get(key) ?? []), (subject as { itemId: string }).itemId]);
        }
      } catch (error) {
        run.disabledRules.push({ rule: `${hook.plugin}:${hook.hookId}`, reason: error instanceof Error ? error.message : String(error) });
        continue;
      }
      activeRules.push(hook);
      for (const members of buckets.values()) {
        if (members.length > 500) continue; // an over-full block is a bad key, not 125 000 comparisons
        for (let i = 0; i < members.length; i += 1) {
          for (let j = i + 1; j < members.length; j += 1) {
            const [a, b] = [members[i]!, members[j]!].sort();
            candidatePairs.add(`${a}\u0000${b}`);
          }
        }
      }
    }

    /* Comparison and combination. */
    const duplicates: DedupPair[] = [];
    for (const pair of candidatePairs) {
      const [a, b] = pair.split('\u0000') as [string, string];
      const verdicts: DedupVerdict[] = [];
      for (const hook of activeRules) {
        run.comparisons += 1;
        try {
          verdicts.push(
            await this.host.call<DedupVerdict>(hook as RegisteredHook<object>, 'compare', [byId.get(a), byId.get(b)], {
              defaultTimeoutMs: 5_000,
              ceilingTimeoutMs: 30_000,
              dryRun,
            }),
          );
        } catch (error) {
          verdicts.push({
            ruleId: hook.hookId,
            score: 0,
            action: 'undecided',
            reason: `the comparison failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
      if (verdicts.some((verdict) => verdict.action === 'distinct')) continue;
      const best = verdicts
        .filter((verdict) => verdict.action === 'duplicate' || verdict.action === 'undecided')
        .sort((left, right) => right.score - left.score)[0];
      if (best === undefined) continue;
      if (best.action === 'duplicate' && best.score < reviewThreshold) continue;
      if (best.action === 'undecided' && !verdicts.some((verdict) => verdict.reason.startsWith('the comparison failed'))) continue;
      duplicates.push({ a, b, verdict: best });
    }

    /* Clusters. */
    const parent = new Map<string, string>();
    const find = (id: string): string => {
      let root = id;
      while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
      parent.set(id, root);
      return root;
    };
    for (const { a, b } of duplicates) {
      parent.set(find(a), find(b));
    }
    const groups = new Map<string, string[]>();
    for (const { a, b } of duplicates) {
      for (const id of [a, b]) {
        const root = find(id);
        const members = groups.get(root) ?? [];
        if (!members.includes(id)) members.push(id);
        groups.set(root, members);
      }
    }

    for (const members of groups.values()) {
      const pairs = duplicates.filter(({ a }) => members.includes(a));
      const types = new Set(members.map((id) => (byId.get(id) as { itemType: string }).itemType));
      const auto =
        types.size === 1 && pairs.every(({ verdict }) => verdict.action === 'duplicate' && verdict.score >= autoThreshold);
      const ordered = this.order(members, byId, options.winnerRule ?? 'newest');
      run.groups.push({
        itemIds: [...members].sort(),
        winnerId: ordered[0]!,
        loserIds: ordered.slice(1),
        decision: auto ? 'auto' : 'review',
        pairs,
        reason: types.size > 1 ? 'the items are of different types' : pairs.map(({ verdict }) => verdict.reason).join('; '),
      });
    }
    run.groups.sort((left, right) => (left.winnerId < right.winnerId ? -1 : 1));

    if (!dryRun) this.apply(run, options.actor ?? this.recueil.actor);
    return run;
  }

  /** The winner first. `newest` is Argus One's rule: date added descending, ties by id descending. */
  private order(members: readonly string[], byId: Map<string, DedupSubject>, rule: WinnerRule): string[] {
    const snapshot = (id: string) => (byId.get(id) as { snapshot: JsonObject }).snapshot;
    const dateOf = (id: string) => String(snapshot(id)['dateAdded'] ?? '');
    return [...members].sort((left, right) => {
      if (rule === 'most_complete') {
        const diff = completeness(snapshot(right)) - completeness(snapshot(left));
        if (diff !== 0) return diff;
      }
      const byDate = dateOf(left) < dateOf(right) ? -1 : dateOf(left) > dateOf(right) ? 1 : 0;
      const byId2 = left < right ? -1 : left > right ? 1 : 0;
      if (rule === 'oldest') return byDate || byId2;
      return -byDate || -byId2;
    });
  }

  private apply(run: DedupRun, actor: Actor): void {
    ensureIngestSchema(this.recueil.connection);
    const review = new ReviewQueueService(this.recueil.db, this.recueil.audit);
    for (const group of run.groups) {
      if (group.decision === 'auto') {
        this.recueil.merges.merge(group.winnerId, group.loserIds, actor, {
          reason: { engine: 'dedup.record', pairs: group.pairs.map(({ a, b, verdict }) => ({ a, b, rule: verdict.ruleId, score: verdict.score })) },
        });
        group.merged = true;
        continue;
      }
      const entry = review.raise({
        subjectType: 'merge_candidate' as never,
        subjectId: group.winnerId,
        secondarySubjectType: 'item',
        secondarySubjectId: group.loserIds.join(','),
        reasonCode: 'record_merge_candidate',
        explanation: `These ${group.itemIds.length} items look like the same work: ${group.reason}.`,
        proposedAction: 'merge' as never,
        proposedPayload: { winnerId: group.winnerId, loserIds: group.loserIds },
        confidence: Math.max(...group.pairs.map(({ verdict }) => verdict.score)),
        severity: 'warning',
        sourceStage: 'dedup.record',
        actor,
      });
      group.reviewId = entry.id;
    }
  }
}
