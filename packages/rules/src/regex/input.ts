/**
 * The haystack, read as code points, without a copy of it wherever one can be avoided.
 *
 * This file exists because of a measured defect. `SafeRegex.exec` used to begin with
 * `Array.from(input, (char) => char.codePointAt(0)!)` — a boxed `number[]` one entry per code point
 * — and only then enter the simulation, where the wall clock is consulted every few thousand steps.
 * The clock therefore could not bound the allocation: a trivial literal pattern cost 57 ms in
 * `Array.from` alone at 1 MB, 848 ms at 16 MB (the rule engine's own `maxTextLength` ceiling) and
 * 407 MB of resident memory at 64 MB, all of it spent before the first step and none of it visible
 * to the 250 ms allowance. ADR-0022 §2: the size is bounded by the call, not checked afterwards.
 *
 * Two things fix it, and both are here:
 *
 * 1. **A length limit that is part of the contract.** `SafeRegexOptions.maxInputLength` is checked
 *    against `input.length` — an O(1) property of a JavaScript string — before anything else, and
 *    over it the call is refused by name.
 * 2. **No copy in the common case.** A string with no surrogate code unit in it has one code point
 *    per UTF-16 unit, so a code-point index *is* a string index and the simulation can read
 *    `charCodeAt` straight off the string: zero allocation, whatever the size. Only a string that
 *    actually carries an astral character pays for an index, and it pays four bytes per code point
 *    in a `Int32Array` rather than the eight-plus of a boxed array.
 *
 * The surrogate scan and the index build are themselves chunked against the deadline, so every part
 * of the preparation is inside the same clock as the match.
 */
import { RegexTimeoutError } from './errors.js';

/** How many code units are scanned between two readings of the clock. */
const SCAN_CHUNK = 65_536;

/**
 * The haystack as the VM sees it: a random-access sequence of code points that can hand back a
 * substring by code-point span.
 */
export interface CodePointInput {
  /** Length in code points. */
  readonly length: number;
  /** The code point at `index`, or `undefined` outside the string. */
  at(index: number): number | undefined;
  /** The text between two code-point indices. */
  slice(from: number, to: number): string;
}

export interface PrepareOptions {
  /** Absolute epoch milliseconds after which the preparation is abandoned, or `undefined` for none. */
  readonly deadline: number | undefined;
  /** For the error message. */
  readonly timeoutMs: number | undefined;
  readonly pattern: string;
}

const expire = (options: PrepareOptions): void => {
  if (options.deadline !== undefined && Date.now() > options.deadline) {
    throw new RegexTimeoutError(options.pattern, options.timeoutMs ?? 0);
  }
};

/**
 * A string with no surrogate in it. Code-point index and code-unit index are the same number, so
 * nothing is allocated and `slice` is the string's own.
 */
class DirectInput implements CodePointInput {
  readonly length: number;

  constructor(private readonly text: string) {
    this.length = text.length;
  }

  at(index: number): number | undefined {
    return index >= 0 && index < this.length ? this.text.charCodeAt(index) : undefined;
  }

  slice(from: number, to: number): string {
    return this.text.slice(from, to);
  }
}

/**
 * A string carrying at least one surrogate. `starts[i]` is the code-unit index at which code point
 * `i` begins, with one extra entry at the end so that `slice` is a plain pair of lookups.
 *
 * A lone surrogate — which a filename or a mail header may perfectly well contain — is one code
 * point of its own, exactly as `String.prototype[Symbol.iterator]` treats it.
 */
class IndexedInput implements CodePointInput {
  readonly length: number;

  constructor(
    private readonly text: string,
    private readonly starts: Int32Array,
  ) {
    this.length = starts.length - 1;
  }

  at(index: number): number | undefined {
    if (index < 0 || index >= this.length) return undefined;
    return this.text.codePointAt(this.starts[index]!);
  }

  slice(from: number, to: number): string {
    return this.text.slice(this.starts[from]!, this.starts[to]!);
  }
}

/**
 * Prepare `text` for the simulation.
 *
 * The caller has already refused an over-long input; this is where the remaining, bounded work is
 * done, chunk by chunk against the same deadline the match runs under.
 */
export const prepareInput = (text: string, options: PrepareOptions): CodePointInput => {
  const units = text.length;

  // Pass one: is there a surrogate anywhere? Almost always not, and then there is nothing to build.
  let firstSurrogate = -1;
  for (let base = 0; base < units; base += SCAN_CHUNK) {
    const end = Math.min(base + SCAN_CHUNK, units);
    for (let index = base; index < end; index += 1) {
      const unit = text.charCodeAt(index);
      if (unit >= 0xd800 && unit <= 0xdfff) {
        firstSurrogate = index;
        break;
      }
    }
    if (firstSurrogate >= 0) break;
    expire(options);
  }
  if (firstSurrogate < 0) return new DirectInput(text);

  // Pass two: one entry per code point. `units + 1` is an upper bound on what is needed, and the
  // array is trimmed to the real count once it is known, so nothing grows while it is being filled.
  const starts = new Int32Array(units + 1);
  let count = 0;
  let index = 0;
  let sinceClock = 0;
  while (index < units) {
    starts[count] = index;
    count += 1;
    const unit = text.charCodeAt(index);
    const paired = unit >= 0xd800 && unit <= 0xdbff && index + 1 < units;
    const next = paired ? text.charCodeAt(index + 1) : 0;
    index += paired && next >= 0xdc00 && next <= 0xdfff ? 2 : 1;
    sinceClock += 1;
    if (sinceClock >= SCAN_CHUNK) {
      sinceClock = 0;
      expire(options);
    }
  }
  starts[count] = units;
  return new IndexedInput(text, starts.subarray(0, count + 1));
};
