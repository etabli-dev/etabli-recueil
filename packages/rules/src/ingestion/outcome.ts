/**
 * What the rules decided, and which rule decided each part of it.
 *
 * The attribution is not decoration. `spec/data-model.md` §3.13 gives `item_tags` a `rule_ref`
 * column so that "why is this tagged" has an answer, and §3.7 puts the office facet's fields under
 * the same field-provenance mechanism as the bibliographic ones. An outcome that said only
 * "tagged: acme, invoice" could not populate either. Every value here therefore arrives with the
 * rule that produced it.
 *
 * Conflicts are recorded rather than resolved twice. In `all-match` mode a later rule may overwrite
 * a scalar an earlier one set; the last writer wins, because precedence has already said who that
 * should be, and the overwrite is kept so the pipeline can queue a `rule_conflict` review entry
 * (§6.1) instead of the user discovering the disagreement months later.
 */
import type { RuleFieldValue } from '../schema/ingestion.js';

/** A value together with the rule that set it. */
export interface Attributed<Value> {
  readonly value: Value;
  readonly ruleId: string;
}

export interface AttributedField extends Attributed<RuleFieldValue> {
  readonly field: string;
}

export interface ReviewRequest {
  readonly reasonCode: string;
  readonly explanation: string;
  readonly severity: 'info' | 'warning' | 'blocker';
  readonly proposedAction?: string;
  readonly ruleId: string;
}

export interface OutcomeConflict {
  /** `itemType`, `correspondent`, `confidence`, or `customField:<slug>`. */
  readonly field: string;
  readonly previous: Attributed<string>;
  readonly next: Attributed<string>;
}

export interface CollectionAssignment extends Attributed<string> {
  /** Create the collection and its parents when it does not exist. */
  readonly create: boolean;
}

export interface IngestionOutcome {
  readonly itemType?: Attributed<string>;
  readonly correspondent?: Attributed<string>;
  readonly confidence?: Attributed<number>;
  readonly collections: readonly CollectionAssignment[];
  readonly tags: readonly Attributed<string>[];
  readonly customFields: readonly AttributedField[];
  readonly review: readonly ReviewRequest[];
  /** True when a `stop` action ran, or first-match mode ended the run. */
  readonly stopped: boolean;
  readonly conflicts: readonly OutcomeConflict[];
  /** True when no rule at all matched, which a dry-run report counts. */
  readonly untouched: boolean;
}

/** The accumulator the engine writes into while the rules run. */
export class IngestionDraft {
  itemType: Attributed<string> | undefined;
  correspondent: Attributed<string> | undefined;
  confidence: Attributed<number> | undefined;
  readonly collections: CollectionAssignment[] = [];
  readonly tags: Attributed<string>[] = [];
  readonly customFields: AttributedField[] = [];
  readonly review: ReviewRequest[] = [];
  readonly conflicts: OutcomeConflict[] = [];
  stopped = false;
  /** Set the first time an action is applied, which is the first time a rule matched. */
  matched = false;

  /** Record an overwrite of a scalar, when the new value actually differs from the old. */
  noteConflict(field: string, previous: Attributed<unknown> | undefined, next: Attributed<unknown>): void {
    if (previous === undefined) return;
    const before = String(previous.value);
    const after = String(next.value);
    if (before === after) return;
    this.conflicts.push({
      field,
      previous: { value: before, ruleId: previous.ruleId },
      next: { value: after, ruleId: next.ruleId },
    });
  }

  /** Tags and collections are a set: a second rule adding the same one is not a conflict. */
  hasTag(tag: string): boolean {
    return this.tags.some((entry) => entry.value.toLowerCase() === tag.toLowerCase());
  }

  hasCollection(collection: string): boolean {
    return this.collections.some((entry) => entry.value === collection);
  }

  finish(): IngestionOutcome {
    return Object.freeze({
      ...(this.itemType === undefined ? {} : { itemType: this.itemType }),
      ...(this.correspondent === undefined ? {} : { correspondent: this.correspondent }),
      ...(this.confidence === undefined ? {} : { confidence: this.confidence }),
      collections: Object.freeze([...this.collections]),
      tags: Object.freeze([...this.tags]),
      customFields: Object.freeze([...this.customFields]),
      review: Object.freeze([...this.review]),
      stopped: this.stopped,
      conflicts: Object.freeze([...this.conflicts]),
      untouched: !this.matched,
    });
  }
}
