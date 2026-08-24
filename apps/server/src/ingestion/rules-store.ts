/**
 * The `rules` table, and the adapter that makes a stored rule actually run.
 *
 * `spec/data-model.md` O2 recommends "a table, with import/export to YAML", and this is it: one row
 * per rule, holding one `@recueil/rules` rule verbatim, assembled into a `RuleSetLike` on demand.
 * Storing the rule in the engine's own format is what keeps the dry run honest — the document the
 * API validated, the rows in the table and the value the engine evaluates are the same value, so a
 * dry run cannot be a prediction about a different rule than the one that will run.
 *
 * **The adapter is the part worth reading.** `@recueil/ingest` has a rule engine of its own and
 * takes a `ruleEngine` seam "because `@recueil/rules` is being built alongside this package as the
 * fuller, versioned, traced rule engine". `StoredRuleEvaluator` is that seam filled in: it converts
 * the pipeline's `RuleSubject` into an `IngestionSubject`, runs the stored set, and converts the
 * `IngestionOutcome` back. Without it the whole `/api/v1/rules` surface would be a form that stores
 * documents nothing reads.
 *
 * Two conversions are lossy in a way that must not be silent, and neither is:
 *
 * - **Collections are named, not identified.** A rule says `collection: Invoices`; the pipeline
 *   wants a collection id. The adapter resolves the name against the library, creates the
 *   collection when the rule asked it to, and — when it did not, and there is no such collection —
 *   reports through `onWarning`, which the caller writes into the run's job log. Nothing is
 *   dropped without a line saying so.
 * - **Confidence is absolute, the pipeline's is a delta.** `confidence: 0.9` becomes
 *   `0.9 - runningScore`, which lands the ledger exactly where the rule asked.
 */
import { ConflictError, NotFoundError, newId, nowTimestamp } from '@recueil/core';
import type { Actor, Recueil } from '@recueil/core';
import type { RuleEvaluation, RuleSubject } from '@recueil/ingest';
import {
  DedupRuleSchema,
  IngestionRuleSchema,
  evaluateIngestion,
  flattenIssues,
} from '@recueil/rules';
import type { IngestionRule, RuleKind, RuleLimits, RuleMode, RuleSetLike } from '@recueil/rules';
import type { IngestionAction, IngestionCondition } from '@recueil/rules';
import { and, asc, eq } from 'drizzle-orm';
import * as z from 'zod';

import { RequestValidationError } from '../validate.js';
import { rules as rulesTable } from './tables.js';
import type { RuleRow } from './tables.js';

/** What a row's `definition` column holds. */
interface StoredDefinition {
  when: unknown;
  then: unknown[];
}

export interface RuleWire {
  id: string;
  ruleId: string;
  kind: RuleKind;
  description: string | null;
  enabled: boolean;
  priority: number;
  when: unknown;
  then: unknown[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export const ruleToWire = (row: RuleRow): RuleWire => {
  const definition = JSON.parse(row.definition) as StoredDefinition;
  return {
    id: row.id,
    ruleId: row.ruleId,
    kind: row.kind,
    description: row.description,
    enabled: row.enabled,
    priority: row.priority,
    when: definition.when,
    then: definition.then,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};

export interface RuleWriteInput {
  ruleId: string;
  kind: RuleKind;
  description?: string | undefined;
  enabled?: boolean | undefined;
  priority?: number | undefined;
  when: unknown;
  then: unknown[];
}

export class RuleStore {
  constructor(private readonly recueil: Recueil) {}

  list(filter: { kind?: RuleKind; enabled?: boolean } = {}): RuleRow[] {
    const clauses = [];
    if (filter.kind !== undefined) clauses.push(eq(rulesTable.kind, filter.kind));
    if (filter.enabled !== undefined) clauses.push(eq(rulesTable.enabled, filter.enabled));
    const query = this.recueil.db.select().from(rulesTable);
    const filtered = clauses.length === 0 ? query : query.where(and(...clauses));
    // Ascending by rule id after priority, matching `sortRules`' tie-break, so the list a UI
    // renders is the order the engine will use.
    return filtered.orderBy(asc(rulesTable.priority), asc(rulesTable.ruleId)).all();
  }

  get(id: string): RuleRow {
    const row = this.recueil.db.select().from(rulesTable).where(eq(rulesTable.id, id)).get();
    if (row === undefined) throw new NotFoundError('rule', id);
    return row;
  }

  create(input: RuleWriteInput, actor: Actor): RuleRow {
    validateRule(input.kind, {
      id: input.ruleId,
      when: input.when,
      then: input.then,
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(input.priority === undefined ? {} : { priority: input.priority }),
    });

    const clash = this.recueil.db
      .select()
      .from(rulesTable)
      .where(and(eq(rulesTable.kind, input.kind), eq(rulesTable.ruleId, input.ruleId)))
      .get();
    if (clash !== undefined) {
      throw new ConflictError(
        `A ${input.kind} rule with the id '${input.ruleId}' already exists. Rule ids are what a ` +
          'trace names and what `item_tags.rule_ref` points at, so they are unique per kind.',
        { ruleId: input.ruleId, kind: input.kind, existingId: clash.id },
      );
    }

    const now = nowTimestamp();
    const row: RuleRow = {
      id: newId(),
      ruleId: input.ruleId,
      kind: input.kind,
      description: input.description ?? null,
      enabled: input.enabled ?? true,
      priority: input.priority ?? 0,
      definition: JSON.stringify({ when: input.when, then: input.then }),
      version: 1,
      createdAt: now,
      updatedAt: now,
    };

    this.recueil.db.transaction((tx) => {
      tx.insert(rulesTable).values(row).run();
      this.recueil.audit.record(
        {
          actor,
          action: 'rule.created',
          entityType: 'rule',
          entityId: row.id,
          after: { ruleId: row.ruleId, kind: row.kind, priority: row.priority, enabled: row.enabled },
        },
        tx,
      );
    });
    return row;
  }

  update(
    id: string,
    patch: {
      description?: string | null | undefined;
      enabled?: boolean | undefined;
      priority?: number | undefined;
      when?: unknown;
      then?: unknown[] | undefined;
    },
    actor: Actor,
  ): RuleRow {
    const existing = this.get(id);
    const definition = JSON.parse(existing.definition) as StoredDefinition;
    const next: StoredDefinition = {
      when: patch.when === undefined ? definition.when : patch.when,
      then: patch.then === undefined ? definition.then : patch.then,
    };

    validateRule(existing.kind, {
      id: existing.ruleId,
      when: next.when,
      then: next.then,
      enabled: patch.enabled ?? existing.enabled,
      priority: patch.priority ?? existing.priority,
    });

    const changes = {
      description:
        patch.description === undefined ? existing.description : patch.description,
      enabled: patch.enabled ?? existing.enabled,
      priority: patch.priority ?? existing.priority,
      definition: JSON.stringify(next),
      version: existing.version + 1,
      updatedAt: nowTimestamp(),
    };

    this.recueil.db.transaction((tx) => {
      tx.update(rulesTable).set(changes).where(eq(rulesTable.id, id)).run();
      this.recueil.audit.record(
        {
          actor,
          action: 'rule.updated',
          entityType: 'rule',
          entityId: id,
          before: { enabled: existing.enabled, priority: existing.priority, definition: definition as never },
          after: { enabled: changes.enabled, priority: changes.priority, definition: next as never },
        },
        tx,
      );
    });

    return { ...existing, ...changes };
  }

  /**
   * Remove a rule.
   *
   * A real delete, with the whole definition in the audit log's `before` — the same reasoning as
   * `IngestionSourceService.remove`. What a rule already did is untouched: the tags it applied keep
   * their `rule_ref`, which now names a rule that is only in the log, and that is the correct
   * record of history.
   */
  remove(id: string, actor: Actor): void {
    const existing = this.get(id);
    this.recueil.db.transaction((tx) => {
      tx.delete(rulesTable).where(eq(rulesTable.id, id)).run();
      this.recueil.audit.record(
        {
          actor,
          action: 'rule.removed',
          entityType: 'rule',
          entityId: id,
          before: {
            ruleId: existing.ruleId,
            kind: existing.kind,
            priority: existing.priority,
            definition: JSON.parse(existing.definition) as never,
          },
        },
        tx,
      );
    });
  }

  /** The stored rules of one kind, as a set the engine can evaluate. */
  ruleSet(
    kind: RuleKind,
    options: { includeDisabled?: boolean; mode?: RuleMode; limits?: RuleLimits; name?: string } = {},
  ): RuleSetLike<IngestionCondition, IngestionAction> {
    const rows = this.list({
      kind,
      ...(options.includeDisabled === true ? {} : { enabled: true }),
    });
    return {
      kind,
      name: options.name ?? `stored:${kind}`,
      ...(options.mode === undefined ? {} : { mode: options.mode }),
      ...(options.limits === undefined ? {} : { limits: options.limits }),
      rules: rows.map((row) => toRuleLike(row)),
    };
  }
}

/** One stored row as the engine's `RuleLike`. */
export const toRuleLike = (row: RuleRow): IngestionRule => {
  const definition = JSON.parse(row.definition) as StoredDefinition;
  return {
    id: row.ruleId,
    ...(row.description === null ? {} : { description: row.description }),
    enabled: row.enabled,
    priority: row.priority,
    when: definition.when,
    then: definition.then,
  } as IngestionRule;
};

/**
 * Validate one rule against the engine's own schema.
 *
 * Against `IngestionRuleSchema`/`DedupRuleSchema` rather than a hand-written check, so that what
 * the API accepts and what the engine can run are the same set by construction. The issues are
 * flattened with `flattenIssues`, which picks the union branch that failed by the least — the
 * difference between one actionable line and seven unreadable ones.
 */
export const validateRule = (kind: RuleKind, rule: Record<string, unknown>): void => {
  const schema: z.ZodType = kind === 'ingestion' ? IngestionRuleSchema : DedupRuleSchema;
  const parsed = schema.safeParse(rule);
  if (parsed.success) return;

  const issues = flattenIssues(parsed.error.issues);
  throw new RequestValidationError(
    `The rule is not valid: ${issues[0]?.path ?? ''} ${issues[0]?.message ?? ''}`.trim(),
    issues.map((issue) => ({
      path: issue.path === '' ? 'body' : `body.${issue.path}`,
      message: issue.message,
      code: 'invalid_rule',
    })),
  );
};

/* -------------------------------------------------------------------------------------------- */
/* The pipeline adapter                                                                            */
/* -------------------------------------------------------------------------------------------- */

export interface StoredRuleEvaluatorOptions {
  readonly recueil: Recueil;
  readonly store: RuleStore;
  readonly actor: Actor;
  /** Called for anything the conversion could not carry across. Never swallowed. */
  readonly onWarning?: (message: string) => void;
  readonly includeDisabled?: boolean;
}

/**
 * `@recueil/rules` in the seat `@recueil/ingest` left for it.
 *
 * The rule set is read once per construction, which means once per run: a rule edited mid-run does
 * not take effect halfway through a folder scan, and every document in one run is filed by the same
 * rules. That is the property that makes a dry run over a corpus mean anything.
 */
export class StoredRuleEvaluator {
  private readonly ruleSet: RuleSetLike<IngestionCondition, IngestionAction>;

  private readonly recueil: Recueil;

  private readonly actor: Actor;

  private readonly onWarning: (message: string) => void;

  constructor(options: StoredRuleEvaluatorOptions) {
    this.recueil = options.recueil;
    this.actor = options.actor;
    this.onWarning = options.onWarning ?? (() => undefined);
    this.ruleSet = options.store.ruleSet('ingestion', {
      ...(options.includeDisabled === undefined ? {} : { includeDisabled: options.includeDisabled }),
    });
  }

  /** How many rules will run. Zero is a legitimate answer and worth logging at the start of a run. */
  get size(): number {
    return this.ruleSet.rules.length;
  }

  evaluate(subject: RuleSubject): RuleEvaluation {
    const evaluation = evaluateIngestion(this.ruleSet, toIngestionSubject(subject));
    const outcome = evaluation.outcome;

    const setFields: RuleEvaluation['setFields'] = {};
    if (outcome.correspondent !== undefined) {
      setFields['office.correspondent'] = {
        value: outcome.correspondent.value,
        ruleId: outcome.correspondent.ruleId,
      };
    }

    const setCustomFields: RuleEvaluation['setCustomFields'] = {};
    for (const field of outcome.customFields) {
      setCustomFields[field.field] = { value: field.value, ruleId: field.ruleId };
    }

    return {
      matched: [...evaluation.trace.matchedRuleIds],
      itemType: outcome.itemType?.value ?? null,
      addTags: outcome.tags.map((tag) => tag.value),
      addCollectionIds: this.resolveCollections(outcome.collections),
      setFields,
      setCustomFields,
      // The rule format sets an absolute score; the pipeline's ledger takes a delta. The difference
      // from the running score is the delta that lands it exactly where the rule asked.
      confidenceDelta:
        outcome.confidence === undefined ? 0 : clampDelta(outcome.confidence.value - subject.confidence),
      review:
        outcome.review[0] === undefined
          ? null
          : {
              ruleId: outcome.review[0].ruleId,
              action: {
                reasonCode: outcome.review[0].reasonCode,
                explanation: outcome.review[0].explanation,
                ...(outcome.review[0].proposedAction === undefined
                  ? {}
                  : { proposedAction: outcome.review[0].proposedAction as never }),
              },
            },
      stop: outcome.stopped
        ? {
            ruleId: evaluation.trace.stoppedBy ?? (evaluation.trace.matchedRuleIds[0] ?? 'unknown'),
            action: {
              reasonCode: 'rule_stopped',
              explanation:
                'A rule asked for this document to be refused outright. It is not filed and no ' +
                'item was created.',
            },
          }
        : null,
      conflicts: outcome.conflicts.map((conflict) => ({
        field: conflict.field,
        candidates: [
          { ruleId: conflict.previous.ruleId, value: conflict.previous.value },
          { ruleId: conflict.next.ruleId, value: conflict.next.value },
        ],
      })),
    };
  }

  /**
   * Names to ids, creating what the rule asked to have created.
   *
   * A name that does not exist and was not to be created is reported rather than dropped: the
   * caller writes the line into the run's job log, so "why is this not in Invoices?" has an answer
   * in the same place as everything else about the run.
   */
  private resolveCollections(
    assignments: readonly { value: string; ruleId: string; create: boolean }[],
  ): string[] {
    const ids: string[] = [];
    for (const assignment of assignments) {
      const existing = this.recueil.collections
        .list({ includeTrashed: false })
        .find((collection) => collection.name === assignment.value);
      if (existing !== undefined) {
        ids.push(existing.id);
        continue;
      }
      if (!assignment.create) {
        this.onWarning(
          `rule '${assignment.ruleId}' asked to file this in the collection '${assignment.value}', ` +
            'which does not exist and which the rule declined to create; the assignment was skipped',
        );
        continue;
      }
      const created = this.recueil.collections.create(
        { name: assignment.value, ownerUserId: this.recueil.user.id },
        this.actor,
      );
      ids.push(created.id);
    }
    return ids;
  }
}

/** The pipeline's subject, in the rule engine's vocabulary. */
export const toIngestionSubject = (subject: RuleSubject): Parameters<typeof evaluateIngestion>[1] => {
  const metadata = subject.sourceMetadata;
  const sender = readString(metadata['from']) ?? readString(metadata['sender']);
  const mailSubject = readString(metadata['subject']);
  return {
    id: subject.path,
    source: subject.sourceKind,
    ...(sender === undefined ? {} : { sender }),
    ...(mailSubject === undefined ? {} : { subject: mailSubject }),
    path: subject.path,
    ...(subject.filename === null ? {} : { filename: subject.filename }),
    mime: subject.mediaType,
    ...(subject.text === null ? {} : { text: subject.text }),
    // `detectedType` is not the item type: the item type is what a rule sets, and starting the
    // subject with `scan` in that field would let a condition on `itemType` match a value no rule
    // and no importer ever wrote.
    resolvers: subject.resolvedBy.map((resolver) => ({ resolver, outcome: 'hit' as const })),
  };
};

const clampDelta = (delta: number): number => Math.max(-1, Math.min(1, delta));

const readString = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;
