/**
 * `@recueil/rules` behind the pipeline's stage-8 seam.
 *
 * Two rule engines exist in this tree and they are not rivals. `@recueil/ingest` carries a small
 * built-in one so the pipeline can run with no dependencies beyond itself; `@recueil/rules` is the
 * declarative, versioned, traced engine of CONCEPT.md §5.6, which is what the rules editor in the
 * web UI writes and what `recueil rules test` evaluates. `IngestPipelineOptions.ruleEngine` exists
 * precisely so the second can be dropped into the first, and this file is that adapter.
 *
 * Why it matters that it is one engine and not two: `recueil rules test --against` is only worth
 * running if what it predicts is what `recueil ingest --rules` will do. If the dry run used
 * `@recueil/rules` and the real ingest used the built-in engine, the dry run would be a report
 * about a program nobody runs.
 *
 * Three places where the two vocabularies genuinely differ, and what is done about each:
 *
 * - **Confidence.** `set-confidence` names an absolute score; the pipeline's evaluation carries a
 *   delta. The subject the pipeline hands over already contains the running score, so the delta is
 *   computed against it and the gate ends up at exactly the number the rule asked for.
 * - **Collections.** A rule names a collection by path (`Office/Invoices`); the pipeline commits
 *   collection *ids*. The path is resolved against the library here, and created — parents first —
 *   when the rule said `create` and it does not exist. A path that cannot be resolved and may not
 *   be created is reported as a warning on the trace rather than silently dropped.
 * - **Stopping.** `@recueil/rules` marks an outcome `stopped` only for an explicit `stop` action;
 *   first-match mode ending the run shows up on the trace as `stoppedBy` and *not* on the outcome.
 *   That distinction is load-bearing — mapping first-match to the pipeline's stop would file
 *   nothing at all from a first-match rule set — so only `outcome.stopped` becomes a pipeline stop.
 */
import type { Actor, Recueil } from '@recueil/core';
import type { RuleEvaluation, RuleEvaluator, RuleSubject } from '@recueil/ingest';
import { evaluateIngestion } from '@recueil/rules';
import type {
  Evaluation,
  EvaluationTrace,
  IngestionOutcome,
  IngestionRuleSet,
  IngestionSubject,
  ResolvedLimits,
} from '@recueil/rules';

/** The trace of one subject, kept so the dry run and the verbose log can print it. */
export interface RecordedEvaluation {
  /** `IngestRef.externalId` — the same string the pipeline calls the candidate's path. */
  readonly subjectId: string;
  readonly trace: EvaluationTrace;
  readonly outcome: IngestionOutcome;
  /** Anything the adapter itself could not carry across, as sentences. */
  readonly warnings: readonly string[];
}

export interface RulesEngineOptions {
  recueil: Recueil;
  actor: Actor;
  ruleSet: IngestionRuleSet;
  limits?: Partial<ResolvedLimits>;
  /**
   * Create a collection a rule names but the library does not have.
   *
   * True in a run that may write. A dry run runs against a throwaway copy of the library, so it is
   * true there too: the collection is created in the copy, which is what makes the dry run's answer
   * the same answer the real run would give.
   */
  createCollections?: boolean;
}

/** The reason code a `stop` action produces, since the rule format carries none of its own. */
export const RULE_STOP_REASON = 'rule_stop';

/**
 * Turn a `@recueil/rules` ingestion set into something `IngestPipeline` can evaluate stage 8 with.
 *
 * Every evaluation is recorded, keyed by the subject id, because the trace is the interesting half
 * and the pipeline's own `RuleEvaluation` has nowhere to put it.
 */
export class RulesEngineAdapter implements RuleEvaluator {
  readonly evaluations: RecordedEvaluation[] = [];

  private readonly collectionIds = new Map<string, string | null>();

  constructor(private readonly options: RulesEngineOptions) {}

  /** The recorded evaluation for one candidate path, if it was evaluated. */
  forSubject(subjectId: string): RecordedEvaluation | undefined {
    return this.evaluations.find((entry) => entry.subjectId === subjectId);
  }

  evaluate(subject: RuleSubject): RuleEvaluation {
    const evaluation: Evaluation<IngestionOutcome> = evaluateIngestion(
      this.options.ruleSet,
      toIngestionSubject(subject),
      {
        ...(this.options.limits === undefined ? {} : { limits: this.options.limits }),
        subjectId: subject.path,
      },
    );

    const warnings: string[] = [];
    const result = this.translate(subject, evaluation.outcome, evaluation.trace, warnings);

    this.evaluations.push({
      subjectId: subject.path,
      trace: evaluation.trace,
      outcome: evaluation.outcome,
      warnings,
    });

    return result;
  }

  /* ---------------------------------------------------------------------------------------- */

  private translate(
    subject: RuleSubject,
    outcome: IngestionOutcome,
    trace: EvaluationTrace,
    warnings: string[],
  ): RuleEvaluation {
    const setFields: RuleEvaluation['setFields'] = {};
    const setCustomFields: RuleEvaluation['setCustomFields'] = {};

    if (outcome.correspondent !== undefined) {
      setFields['office.correspondent'] = {
        value: outcome.correspondent.value,
        ruleId: outcome.correspondent.ruleId,
      };
    }
    for (const field of outcome.customFields) {
      setCustomFields[field.field] = { value: field.value, ruleId: field.ruleId };
    }

    const addCollectionIds: string[] = [];
    for (const assignment of outcome.collections) {
      const id = this.resolveCollection(assignment.value, assignment.create);
      if (id === null) {
        warnings.push(
          `rule ${assignment.ruleId} asked for collection ${JSON.stringify(assignment.value)}, ` +
            'which is not in the library and which this run may not create; the assignment was not applied',
        );
        continue;
      }
      if (!addCollectionIds.includes(id)) addCollectionIds.push(id);
    }

    // An absolute score, expressed as the delta that reaches it from where the ledger stands.
    const confidenceDelta =
      outcome.confidence === undefined
        ? 0
        : clamp(outcome.confidence.value - subject.confidence, -1, 1);

    const first = outcome.review[0];
    const review: RuleEvaluation['review'] =
      first === undefined
        ? null
        : {
            ruleId: first.ruleId,
            action: {
              reasonCode: first.reasonCode,
              explanation: first.explanation,
              ...(first.proposedAction === undefined
                ? {}
                : { proposedAction: first.proposedAction as NonNullable<RuleEvaluation['review']>['action']['proposedAction'] }),
            },
          };
    for (const extra of outcome.review.slice(1)) {
      warnings.push(
        `rule ${extra.ruleId} also asked for review (${extra.reasonCode}); the pipeline records one ` +
          'reason per document, and the first in evaluation order is the one it carries',
      );
    }

    const stop: RuleEvaluation['stop'] = outcome.stopped
      ? {
          ruleId: trace.stoppedBy ?? 'unknown',
          action: {
            reasonCode: RULE_STOP_REASON,
            explanation:
              `Rule ${trace.stoppedBy ?? '(unnamed)'} of rule set ${JSON.stringify(trace.ruleSet)} ` +
              'refused this document outright with a `stop` action. Nothing was filed.',
          },
        }
      : null;

    for (const warning of trace.warnings) warnings.push(warning);
    for (const conflict of outcome.conflicts) {
      warnings.push(
        `${conflict.field}: ${conflict.next.ruleId} overwrote ${JSON.stringify(conflict.previous.value)} ` +
          `from ${conflict.previous.ruleId} with ${JSON.stringify(conflict.next.value)}`,
      );
    }

    return {
      matched: [...trace.matchedRuleIds],
      itemType: outcome.itemType?.value ?? null,
      addTags: outcome.tags.map((tag) => tag.value),
      addCollectionIds,
      setFields,
      setCustomFields,
      confidenceDelta,
      review,
      stop,
      // The two engines disagree about what a conflict is: `@recueil/ingest` calls two rules
      // wanting different values a conflict and applies neither, `@recueil/rules` lets precedence
      // decide and records the overwrite. Precedence is the documented behaviour of the format the
      // rule was written in, so it stands, and the overwrite is reported as a warning above rather
      // than escalated into a `rule_conflict` review entry the rule author did not ask for.
      conflicts: [],
    };
  }

  /**
   * A collection id for a slash-separated path, creating it when allowed.
   *
   * Memoised per adapter: a folder of four thousand invoices resolves `Office/Invoices` once.
   */
  private resolveCollection(path: string, create: boolean): string | null {
    const key = `${create ? 'create' : 'find'}:${path}`;
    const cached = this.collectionIds.get(key);
    if (cached !== undefined) return cached;

    const segments = path
      .split('/')
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);
    if (segments.length === 0) {
      this.collectionIds.set(key, null);
      return null;
    }

    let parentId: string | null = null;
    for (const segment of segments) {
      const existing: { id: string } | undefined = this.options.recueil.collections
        .list({ parentId, includeTrashed: false })
        .find((row) => row.name.localeCompare(segment, undefined, { sensitivity: 'accent' }) === 0);

      if (existing !== undefined) {
        parentId = existing.id;
        continue;
      }
      if (!create || this.options.createCollections !== true) {
        this.collectionIds.set(key, null);
        return null;
      }
      const created = this.options.recueil.collections.create(
        { name: segment, parentId },
        this.options.actor,
      );
      parentId = created.id;
    }

    this.collectionIds.set(key, parentId);
    return parentId;
  }
}

/**
 * The pipeline's subject, in the rule engine's vocabulary.
 *
 * `sourceMetadata` is where a mail source puts the sender and the subject line, and the two names
 * each of them goes by are both accepted: `@recueil/ingest-sources`' IMAP source writes `from` and
 * `subject`, and a caller building candidates by hand may write `sender`.
 */
export const toIngestionSubject = (subject: RuleSubject): IngestionSubject => {
  const metadata = subject.sourceMetadata;
  const sender = readString(metadata['sender']) ?? readString(metadata['from']);
  const mailSubject = readString(metadata['subject']);
  const recipients = readStrings(metadata['to']) ?? readStrings(metadata['recipients']);

  return {
    id: subject.path,
    source: subject.sourceKind,
    ...(sender === undefined ? {} : { sender }),
    ...(recipients === undefined ? {} : { recipients }),
    ...(mailSubject === undefined ? {} : { subject: mailSubject }),
    path: subject.path,
    ...(subject.filename === null ? {} : { filename: subject.filename }),
    mime: subject.mediaType,
    ...(subject.text === null ? {} : { text: subject.text }),
    itemType: subject.detectedType,
    tags: [],
    resolvers: subject.resolvedBy.map((resolver) => ({ resolver, outcome: 'hit' as const })),
  };
};

const readString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const readStrings = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : undefined;

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));
