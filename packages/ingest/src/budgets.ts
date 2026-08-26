/**
 * Resource budgets for untrusted input (ADR-0022).
 *
 * Every limit that bounds work done on bytes a stranger chose is gathered rather than scattered, so
 * that an operator with a 900 MB legitimate scan can raise one knowingly rather than hunting for
 * literals in four modules. The archive limits are `IngestConfig`'s `maxArchive*` fields, now
 * enforced against the bytes as well as against the declaration; the PDF limits are
 * `DEFAULT_PDF_BUDGET` below, taken as a parameter by `extractPdfText`. This file also holds the
 * machinery those numbers are spent through: the ledger that makes them compose, and the error a
 * refusal raises.
 *
 * Two rules govern their use, and both are the lesson of the Phase 2 review:
 *
 *   - **A declared size is input, not fact.** A zip's central directory, a PDF's `/Length` and a
 *     message's `Content-Length` are written by whoever built the file. They may inform a fast
 *     rejection — refusing early is cheaper than refusing late — but the operation itself must
 *     carry the bound, because a file that lies passes every check made against the lie.
 *   - **Budgets compose.** A per-member ceiling without a per-container ceiling permits a thousand
 *     small members. `BudgetLedger` is what makes them compose: the allowance handed to one
 *     inflate call is the *smaller* of the per-operation limit and what the container has left, so
 *     no operation can materialise more than the container still has to spend, and a nested
 *     container inherits the remainder rather than starting again.
 *
 * Exceeding one of these raises an `IngestError` — `ArchiveLimitError` for an archive,
 * `ResourceBudgetError` elsewhere — which the pipeline routes to the review queue with the reason
 * (P3). It is not a crash, and it is never a silent skip.
 */
import { IngestError } from './errors.js';

/**
 * A budget was exceeded on a path that is not archive extraction.
 *
 * It carries the name of the limit and the number, because a refusal that does not say what it
 * refused is a refusal an operator cannot act on — and ADR-0022 makes raising a limit knowingly the
 * intended response to a legitimate file that is genuinely too big.
 */
export class ResourceBudgetError extends IngestError {
  constructor(
    readonly limitName: string,
    readonly limit: number,
    message: string,
    detail: Record<string, unknown> = {},
  ) {
    super(message, 'resource_budget_exceeded', { limitName, limit, ...detail });
  }
}

export interface PdfBudget {
  /**
   * Ceiling on the size of a PDF this reader will look inside at all. A fast rejection: a file
   * past it is refused before a single stream is inflated, and before the two full-length
   * `latin1` copies that the stream scan and the page count would otherwise make of it — which is
   * why this number is well below what the per-stream ceiling would suggest.
   */
  maxInputBytes: number;

  /**
   * Ceiling on the bytes one `stream`…`endstream` pair may inflate to, passed to the decompressor
   * as `maxOutputLength`. Generous for a content stream, which is kilobytes, and for a 300 dpi
   * greyscale page image stored as Flate, which is about nine megabytes. A 600 dpi colour page
   * does not fit, which is deliberate: raise it knowingly rather than have every mailbox pay for
   * the possibility.
   */
  maxStreamOutputBytes: number;

  /** Ceiling on the bytes every stream of one PDF may inflate to, added up as they arrive. */
  maxTotalOutputBytes: number;

  /** Ceiling on how many `stream`…`endstream` pairs are examined. */
  maxStreams: number;

  /**
   * Wall-clock ceiling for one call, in milliseconds. The byte ceilings bound the memory; this
   * bounds the time, because `extractPdfText` is synchronous and the event loop stops with it.
   * Checked between streams, which is where the work is.
   */
  maxMillis: number;
}

const MIB = 1024 * 1024;

export const DEFAULT_PDF_BUDGET: PdfBudget = {
  maxInputBytes: 128 * MIB,
  maxStreamOutputBytes: 32 * MIB,
  maxTotalOutputBytes: 128 * MIB,
  maxStreams: 4_096,
  maxMillis: 15_000,
};

/**
 * A running total against a ceiling, with a `child` that inherits what is left.
 *
 * The ledger is the composition rule made concrete. `allowance()` is what a caller passes to a
 * decompressor as its `maxOutputLength`; `spend()` is called with what actually came out. Both are
 * needed: the allowance stops one member from over-allocating, the spend stops a thousand members
 * from doing it between them.
 */
export class BudgetLedger {
  #spent = 0;

  constructor(
    /** What this ledger may spend in total. */
    readonly ceiling: number,
    /** Named in the refusal, so the message says which limit was hit. */
    readonly label: string,
  ) {}

  get spent(): number {
    return this.#spent;
  }

  get remaining(): number {
    return Math.max(0, this.ceiling - this.#spent);
  }

  /**
   * The most a single operation may produce right now: the smaller of its own limit and what the
   * container has left. Never negative, and never larger than the remainder.
   */
  allowance(perOperationLimit: number): number {
    return Math.min(perOperationLimit, this.remaining);
  }

  /** Record bytes that were produced. Returns false when that puts the ledger over its ceiling. */
  spend(bytes: number): boolean {
    this.#spent += bytes;
    return this.#spent <= this.ceiling;
  }

  /**
   * A ledger for a container nested inside this one.
   *
   * It inherits the remaining allowance rather than a fresh ceiling, which is the difference
   * between "three levels of nesting cost three budgets" and "three levels of nesting cost one".
   */
  child(label: string): BudgetLedger {
    return new BudgetLedger(this.remaining, label);
  }
}
