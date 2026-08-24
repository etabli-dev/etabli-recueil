/**
 * The dry run: what this rule set would do to this corpus.
 *
 * CONCEPT.md §5.6 asks for "a dry-run report before execution" and §5.3 puts a rule engine in the
 * middle of an ingestion pipeline that writes to a library. The report below is the answer to both,
 * and its honesty rests on one structural fact rather than on a flag: `evaluateRules` is a pure
 * function from a rule set and a plain subject value to a plain outcome value. It is handed no
 * database, no storage backend and no HTTP client, so there is no "apply" path that a dry run has
 * to remember to switch off. Running the corpus twice produces the same report, and running it once
 * produces no writes because there is nothing here that could write.
 *
 * What the report counts is the *engine's* answers, not its own notes. Every number below is
 * derived from the outcomes and traces returned by the evaluation, each of which was produced by
 * evaluating a condition against a subject. There is no counter incremented at the point of
 * decision and then reported back as evidence that the decision was made.
 */
import { evaluateRules, sortRules } from './engine.js';
import type { Evaluation, EvaluateOptions, ResolvedLimits, RuleFacet, RuleSetLike } from './engine.js';
import { dedupFacet } from './dedup/facet.js';
import type { DedupOutcome } from './dedup/outcome.js';
import type { DedupPair } from './dedup/subject.js';
import { ingestionFacet } from './ingestion/facet.js';
import type { IngestionOutcome } from './ingestion/outcome.js';
import type { IngestionSubject } from './ingestion/subject.js';
import type { DedupAction, DedupCondition } from './schema/dedup.js';
import type { IngestionAction, IngestionCondition } from './schema/ingestion.js';
import type { EvaluationTrace, RuleOutcome } from './trace.js';

export interface DryRunEntry<Outcome> {
  readonly subjectId: string;
  readonly outcome: Outcome;
  /** Absent once `maxTraces` is reached. The counts always cover every subject. */
  readonly trace?: EvaluationTrace;
}

export interface RuleStatistics {
  readonly ruleId: string;
  readonly order: number;
  readonly priority: number;
  readonly matched: number;
  readonly notMatched: number;
  readonly notReached: number;
  readonly disabled: number;
  readonly errors: number;
}

export interface DryRunReport<Outcome> {
  readonly ruleSet: string;
  readonly kind: string;
  readonly mode: string;
  readonly subjectCount: number;
  readonly entries: readonly DryRunEntry<Outcome>[];
  /** One row per rule, in evaluation order, whatever its outcome. A rule that never fires is news. */
  readonly rules: readonly RuleStatistics[];
  /** Subjects no rule matched. In an ingestion run these are the ones a human still has to file. */
  readonly unmatchedSubjectIds: readonly string[];
  /** Subjects on which some rule could not be evaluated. */
  readonly erroredSubjectIds: readonly string[];
  readonly warnings: readonly string[];
}

export interface DryRunOptions {
  readonly limits?: Partial<ResolvedLimits>;
  /** Keep at most this many traces in the report. Default: keep them all. */
  readonly maxTraces?: number;
}

/**
 * Evaluate a rule set over a corpus.
 *
 * Generic over the facet, so the ingestion and the dedup reports are the same report. The subject's
 * own `id` is what the entries are keyed by, which is what lets a caller join the report back to
 * whatever it holds.
 */
export const dryRun = <Subject extends { readonly id: string }, Condition extends object, Action extends { type: string }, Draft, Outcome>(
  ruleSet: RuleSetLike<Condition, Action>,
  subjects: Iterable<Subject>,
  facet: RuleFacet<Subject, Condition, Action, Draft, Outcome>,
  options: DryRunOptions = {},
): DryRunReport<Outcome> => {
  const ordered = sortRules(ruleSet.rules);
  const counters = new Map<string, { matched: number; notMatched: number; notReached: number; disabled: number; errors: number }>();
  for (const rule of ordered) counters.set(rule.id, { matched: 0, notMatched: 0, notReached: 0, disabled: 0, errors: 0 });

  const entries: DryRunEntry<Outcome>[] = [];
  const unmatchedSubjectIds: string[] = [];
  const erroredSubjectIds: string[] = [];
  const warnings: string[] = [];
  const maxTraces = options.maxTraces ?? Number.POSITIVE_INFINITY;
  let subjectCount = 0;
  let mode = ruleSet.mode ?? 'all-match';

  const evaluateOptions: EvaluateOptions = options.limits === undefined ? {} : { limits: options.limits };

  for (const subject of subjects) {
    subjectCount += 1;
    const evaluation: Evaluation<Outcome> = evaluateRules(ruleSet, subject, facet, { ...evaluateOptions, subjectId: subject.id });
    mode = evaluation.trace.mode;

    for (const rule of evaluation.trace.rules) {
      const counter = counters.get(rule.ruleId);
      if (counter === undefined) continue;
      const bucket: Record<RuleOutcome, keyof typeof counter> = {
        matched: 'matched',
        'not-matched': 'notMatched',
        'not-reached': 'notReached',
        disabled: 'disabled',
        error: 'errors',
      };
      counter[bucket[rule.outcome]] += 1;
    }

    if (evaluation.trace.matchedRuleIds.length === 0) unmatchedSubjectIds.push(subject.id);
    if (evaluation.trace.rules.some((rule) => rule.outcome === 'error')) erroredSubjectIds.push(subject.id);
    for (const warning of evaluation.trace.warnings) warnings.push(`${subject.id}: ${warning}`);

    entries.push(
      entries.length < maxTraces
        ? { subjectId: subject.id, outcome: evaluation.outcome, trace: evaluation.trace }
        : { subjectId: subject.id, outcome: evaluation.outcome },
    );
  }

  return {
    ruleSet: ruleSet.name ?? '(unnamed)',
    kind: ruleSet.kind,
    mode,
    subjectCount,
    entries,
    rules: ordered.map((rule, order) => {
      const counter = counters.get(rule.id)!;
      return { ruleId: rule.id, order, priority: rule.priority ?? 0, ...counter };
    }),
    unmatchedSubjectIds,
    erroredSubjectIds,
    warnings,
  };
};

/* -------------------------------------------------------------------------------------------- */
/* Facet-specific summaries                                                                        */
/* -------------------------------------------------------------------------------------------- */

export interface IngestionSummary {
  readonly itemTypes: ReadonlyMap<string, number>;
  readonly collections: ReadonlyMap<string, number>;
  readonly tags: ReadonlyMap<string, number>;
  readonly customFields: ReadonlyMap<string, number>;
  readonly correspondents: ReadonlyMap<string, number>;
  readonly reviewReasons: ReadonlyMap<string, number>;
  readonly conflictCount: number;
  readonly stoppedCount: number;
}

const tally = <Value>(target: Map<string, number>, key: string, _value?: Value): void => {
  target.set(key, (target.get(key) ?? 0) + 1);
};

/** Roll an ingestion dry run up into the counts a human reads first. */
export const summariseIngestion = (report: DryRunReport<IngestionOutcome>): IngestionSummary => {
  const itemTypes = new Map<string, number>();
  const collections = new Map<string, number>();
  const tags = new Map<string, number>();
  const customFields = new Map<string, number>();
  const correspondents = new Map<string, number>();
  const reviewReasons = new Map<string, number>();
  let conflictCount = 0;
  let stoppedCount = 0;

  for (const entry of report.entries) {
    const outcome = entry.outcome;
    if (outcome.itemType !== undefined) tally(itemTypes, outcome.itemType.value);
    if (outcome.correspondent !== undefined) tally(correspondents, outcome.correspondent.value);
    for (const collection of outcome.collections) tally(collections, collection.value);
    for (const tag of outcome.tags) tally(tags, tag.value);
    for (const field of outcome.customFields) tally(customFields, field.field);
    for (const review of outcome.review) tally(reviewReasons, review.reasonCode);
    conflictCount += outcome.conflicts.length;
    if (outcome.stopped) stoppedCount += 1;
  }

  return { itemTypes, collections, tags, customFields, correspondents, reviewReasons, conflictCount, stoppedCount };
};

export interface DedupSummary {
  readonly decisions: ReadonlyMap<string, number>;
  readonly winners: ReadonlyMap<string, number>;
  readonly reviewReasons: ReadonlyMap<string, number>;
  readonly conflictCount: number;
  readonly undecidedCount: number;
}

export const summariseDedup = (report: DryRunReport<DedupOutcome>): DedupSummary => {
  const decisions = new Map<string, number>();
  const winners = new Map<string, number>();
  const reviewReasons = new Map<string, number>();
  let conflictCount = 0;
  let undecidedCount = 0;

  for (const entry of report.entries) {
    const outcome = entry.outcome;
    if (outcome.decision === undefined) undecidedCount += 1;
    else tally(decisions, outcome.decision.value);
    if (outcome.winner !== undefined) tally(winners, outcome.winner.value);
    for (const review of outcome.review) tally(reviewReasons, review.reasonCode);
    conflictCount += outcome.conflicts.length;
  }

  return { decisions, winners, reviewReasons, conflictCount, undecidedCount };
};

/** Run an ingestion rule set over a corpus. */
export const dryRunIngestion = (
  ruleSet: RuleSetLike<IngestionCondition, IngestionAction>,
  subjects: Iterable<IngestionSubject>,
  options: DryRunOptions = {},
): DryRunReport<IngestionOutcome> => dryRun(ruleSet, subjects, ingestionFacet, options);

/** Run a dedup rule set over a corpus of candidate pairs. */
export const dryRunDedup = (
  ruleSet: RuleSetLike<DedupCondition, DedupAction>,
  pairs: Iterable<DedupPair>,
  options: DryRunOptions = {},
): DryRunReport<DedupOutcome> => dryRun(ruleSet, pairs, dedupFacet, options);
