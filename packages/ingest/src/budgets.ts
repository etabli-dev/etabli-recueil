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
 * What a message may cost to parse (ADR-0022 §2, §3).
 *
 * The Phase 2 review left this one open and the re-attack confirmed it still reproducing:
 * `parseEmail(raw)` took no limits argument at all, so "every part is bounded by the caller's
 * limits before it is decoded" — the sentence in `archive/eml.ts`'s own header — was the reverse of
 * what happened. A 24 MB quoted-printable message decoded 8.8 MB of payload and moved resident
 * memory by 166 MB on the way, because the decoder accumulated into a JS `number[]` at roughly
 * eight bytes per decoded byte; a 16.6 MB message built two hundred thousand `EmailPart` objects,
 * each with its own `Buffer`, before the 2 048-entry check downstream was reached.
 *
 * Five ceilings, because each bounds a different way a message can be expensive: the raw input, the
 * header block (a message with no blank line makes the whole file one header), the number of parts,
 * the decoded size of one part, and the decoded size of all of them together. `extractArchive`
 * derives the last three from `IngestConfig` and from what the containing archive has left to
 * spend, so a message inside a zip decodes out of the zip's budget rather than opening its own.
 */
export interface EmailBudget {
  /** Ceiling on the raw message this parser will look inside at all. */
  maxInputBytes: number;
  /**
   * Ceiling on one header block, in bytes.
   *
   * `findHeaderEnd` returns the whole buffer when there is no blank line anywhere, so without this
   * a body-less blob becomes one `latin1` string and one `split` over the entire file.
   */
  maxHeaderBytes: number;
  /** Ceiling on how many parts the MIME tree may yield, counted as they are built. */
  maxParts: number;
  /** Ceiling on the decoded bytes of one part, enforced by the decode rather than after it. */
  maxPartBytes: number;
  /** Ceiling on the decoded bytes of every part of one message, added up as they arrive. */
  maxTotalBytes: number;
}

export const DEFAULT_EMAIL_BUDGET: EmailBudget = {
  maxInputBytes: 128 * MIB,
  maxHeaderBytes: MIB,
  maxParts: 2_048,
  maxPartBytes: 64 * MIB,
  maxTotalBytes: 128 * MIB,
};

/**
 * How much extracted text the near-duplicate blocking key is computed over.
 *
 * `simhash` hashes one SHA-1 per three-word shingle and holds a map of every distinct shingle, so
 * its cost is linear in the text with a large constant: 4 MB of extracted text cost 2.76 s, 16 MB
 * 11.33 s and 64 MB 52.92 s with +260 MB of resident memory — synchronously, on the ingest worker,
 * with no bound of any kind. Nobody had named it, and the input is reachable: `pdf.maxTotalOutputBytes`
 * permits 128 MiB of inflated stream text, and an OCR sidecar's output has no ceiling of its own.
 *
 * A prefix rather than a refusal, and that is the one place in this file where truncation is the
 * right answer. `documents.simhash` is a *blocking key* for near-duplicate detection (CONCEPT §5.6),
 * not an identity — identity is the SHA-256 over the bytes — so a key computed over the first four
 * mebibytes of a document is a usable key, whereas refusing the document over it would lose a file
 * to protect a heuristic.
 */
export const DEFAULT_SIMHASH_MAX_CHARS = 4 * MIB;

/**
 * A running total against a ceiling, with a `child` that spends from its parent.
 *
 * The ledger is the composition rule made concrete. `allowance()` is what a caller passes to a
 * decompressor as its `maxOutputLength`; `spend()` is called with what actually came out. Both are
 * needed: the allowance stops one member from over-allocating, the spend stops a thousand members
 * from doing it between them.
 *
 * **A child is a view of its parent, not a copy of its remainder.** The first version of `child()`
 * returned `new BudgetLedger(this.remaining, label)` — a fresh, unconnected ledger seeded with what
 * was left. That reads like inheritance and is not: forty sibling containers each take a snapshot
 * of the same remainder and each spend it in full, so the total across the tree is (siblings ×
 * remainder) rather than the remainder. The re-attack measured exactly that — a 357 KB file
 * producing 40.6 MiB against a 4 MiB container ceiling — and it would have measured it even if the
 * pipeline had been calling `child()`, which it was not. So a child now holds a reference to its
 * parent: `spend()` charges both, and `remaining` is the smaller of the two. One budget spans the
 * whole archive tree, at any breadth and any depth, which is what ADR-0022 §3 asks for.
 */
export class BudgetLedger {
  #spent = 0;

  readonly #parent: BudgetLedger | null;

  constructor(
    /** What this ledger may spend in total. */
    readonly ceiling: number,
    /** Named in the refusal, so the message says which limit was hit. */
    readonly label: string,
    /** The container this one is nested inside, when it is nested inside one. */
    parent: BudgetLedger | null = null,
  ) {
    this.#parent = parent;
  }

  /** What this ledger itself has been charged. A child's parent carries the same bytes again. */
  get spent(): number {
    return this.#spent;
  }

  /** What may still be produced under this ledger *and* under every ledger above it. */
  get remaining(): number {
    const own = Math.max(0, this.ceiling - this.#spent);
    return this.#parent === null ? own : Math.min(own, this.#parent.remaining);
  }

  /**
   * The most a single operation may produce right now: the smaller of its own limit and what the
   * container has left. Never negative, and never larger than the remainder.
   */
  allowance(perOperationLimit: number): number {
    return Math.min(perOperationLimit, this.remaining);
  }

  /**
   * Record bytes that were produced. Returns false when that puts this ledger — or any ledger
   * above it — over its ceiling.
   *
   * The parent is charged whether or not this ledger is still inside its own ceiling, and before
   * the verdict is computed, because a refusal that forgot to charge upwards would let the next
   * sibling start from a total that never happened.
   */
  spend(bytes: number): boolean {
    this.#spent += bytes;
    const withinParent = this.#parent === null ? true : this.#parent.spend(bytes);
    return this.#spent <= this.ceiling && withinParent;
  }

  /**
   * A ledger for a container nested inside this one.
   *
   * It starts at this ledger's remaining allowance and every byte it spends is also spent here, so
   * three levels of nesting cost one budget rather than three, and forty siblings at one level cost
   * one budget rather than forty.
   */
  child(label: string): BudgetLedger {
    return new BudgetLedger(this.remaining, label, this);
  }
}
