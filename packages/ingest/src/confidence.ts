/**
 * The running confidence, and why it is a ledger rather than a number.
 *
 * Stage 9 is a gate: "auto-accept above threshold, otherwise ReviewQueue with reason (P3)". A gate
 * that produces a bare 0.62 gives the operator nothing to act on — they see that the pipeline was
 * unsure and not what it was unsure about. So every contribution is recorded with the stage that
 * made it and a sentence saying why, the score is their sum, and the review entry's explanation is
 * assembled from the ledger. "0.62: type detection was ambivalent (+0.02), the metadata extractor
 * found only a title (+0.10), no identifier resolved (-0.15)" is a thing a person can fix.
 *
 * The weights are here, in one place, deliberately. They are judgement calls and they will be
 * tuned against the auto-accept rate that G2 measures; having them scattered through the stages
 * would make that impossible.
 */
import type { PipelineAnchor } from './types.js';

export interface ConfidenceEntry {
  stage: PipelineAnchor | 'plugin' | 'base';
  /** Who or what made the contribution: a detector, an extractor, a rule id, a hook id. */
  source: string;
  delta: number;
  reason: string;
}

/** How much each stage's own 0..1 belief is worth to the final score. */
export const CONFIDENCE_WEIGHTS = {
  /** Type detection contributes around its midpoint: certainty helps, ambivalence hurts. */
  detection: 0.4,
  /** Metadata extraction is the heaviest single signal, because it is the most informative. */
  metadata: 0.6,
  /** A resolved identifier is a fact from outside the document. */
  resolution: 0.25,
  /** OCR that produced usable text says the document is at least legible. */
  ocr: 0.1,
} as const;

export class ConfidenceLedger {
  private readonly entries: ConfidenceEntry[] = [];

  constructor(private readonly base: number) {
    this.entries.push({
      stage: 'base',
      source: 'pipeline',
      delta: base,
      reason: 'the score every candidate starts from',
    });
  }

  add(entry: Omit<ConfidenceEntry, 'delta'> & { delta: number }): this {
    if (entry.delta !== 0) this.entries.push(entry);
    return this;
  }

  /** The 0..1 score the gate compares against the threshold. */
  get score(): number {
    const total = this.entries.reduce((sum, entry) => sum + entry.delta, 0);
    return Math.min(1, Math.max(0, total));
  }

  get contributions(): readonly ConfidenceEntry[] {
    return this.entries;
  }

  /** The sentence the review entry carries, and the line the job log gets. */
  explain(): string {
    const parts = this.entries
      .filter((entry) => entry.stage !== 'base')
      .map((entry) => `${entry.reason} (${entry.delta >= 0 ? '+' : ''}${entry.delta.toFixed(2)})`);
    if (parts.length === 0) return `the score is ${this.score.toFixed(2)}; no stage had an opinion`;
    return `the score is ${this.score.toFixed(2)}: ${parts.join(', ')}`;
  }

  toJSON(): { score: number; contributions: ConfidenceEntry[] } {
    return { score: this.score, contributions: [...this.entries] };
  }
}
