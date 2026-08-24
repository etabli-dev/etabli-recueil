/**
 * What the dedup rules proposed. A proposal, not an act.
 *
 * `decision` is what the rule set concluded; `winner` is which side a merge should keep. Both carry
 * the rule that produced them, because CONCEPT.md §5.6 keeps the loser in trash with a reversible
 * merge record, and a merge record that cannot name the rule behind it is not reversible in any
 * useful sense — it can be undone, but not understood.
 */
import type { Attributed, OutcomeConflict, ReviewRequest } from '../ingestion/outcome.js';
import type { MergeWinner } from '../schema/dedup.js';

export type DedupDecision = 'merge' | 'link' | 'flag' | 'ignore';

export interface DedupOutcome {
  readonly decision?: Attributed<DedupDecision>;
  readonly winner?: Attributed<MergeWinner>;
  readonly confidence?: Attributed<number>;
  readonly review: readonly ReviewRequest[];
  readonly stopped: boolean;
  readonly conflicts: readonly OutcomeConflict[];
  /** True when no rule matched: the pair is not a duplicate as far as this rule set knows. */
  readonly untouched: boolean;
}

export class DedupDraft {
  decision: Attributed<DedupDecision> | undefined;
  winner: Attributed<MergeWinner> | undefined;
  confidence: Attributed<number> | undefined;
  readonly review: ReviewRequest[] = [];
  readonly conflicts: OutcomeConflict[] = [];
  stopped = false;
  matched = false;

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

  finish(): DedupOutcome {
    return Object.freeze({
      ...(this.decision === undefined ? {} : { decision: this.decision }),
      ...(this.winner === undefined ? {} : { winner: this.winner }),
      ...(this.confidence === undefined ? {} : { confidence: this.confidence }),
      review: Object.freeze([...this.review]),
      stopped: this.stopped,
      conflicts: Object.freeze([...this.conflicts]),
      untouched: !this.matched,
    });
  }
}
