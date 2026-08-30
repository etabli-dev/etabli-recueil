/**
 * The ways a pattern can fail, kept apart because they mean different things to the caller.
 *
 * A `RegexSyntaxError` is the rule author's mistake and belongs in a validation message. It also
 * carries the compile-time refusals of a *hostile* pattern — one too long to read, nested too
 * deeply to parse without exhausting the stack, or written so that it costs more to compile than it
 * could ever cost to run — because those are facts about the pattern, visible before any document
 * is matched, and the place to refuse them is where the author can see the position.
 *
 * A `RegexBudgetError`, a `RegexTimeoutError` or a `RegexInputTooLongError` is a runtime refusal on
 * a specific input: the pattern is fine, the work it implied was not, and the ingestion pipeline
 * should route the subject to review rather than pretend the condition did not match.
 */

/** The pattern could not be parsed, or used a construct this engine deliberately does not have. */
export class RegexSyntaxError extends Error {
  override readonly name = 'RegexSyntaxError';

  constructor(
    message: string,
    readonly pattern: string,
    /** Index into the pattern, in code points, where the problem was found. */
    readonly position: number,
  ) {
    super(`${message} (at position ${position} of /${pattern}/)`);
  }
}

/** The match exceeded the step budget. Linear time is not the same as free. */
export class RegexBudgetError extends Error {
  override readonly name = 'RegexBudgetError';

  constructor(
    readonly pattern: string,
    readonly steps: number,
  ) {
    super(`regular expression exceeded its budget of ${steps} steps (/${pattern}/)`);
  }
}

/** The match exceeded its wall-clock allowance. */
export class RegexTimeoutError extends Error {
  override readonly name = 'RegexTimeoutError';

  constructor(
    readonly pattern: string,
    readonly timeoutMs: number,
  ) {
    super(`regular expression exceeded its allowance of ${timeoutMs} ms (/${pattern}/)`);
  }
}

/**
 * The haystack was longer than the matcher is allowed to read.
 *
 * This is the bound that has to be checked *first*, before anything proportional to the input is
 * allocated or scanned, because a clock consulted every few thousand simulation steps cannot bound
 * work that happens before the first step. ADR-0022 §2: bound the operation, not the result.
 */
export class RegexInputTooLongError extends Error {
  override readonly name = 'RegexInputTooLongError';

  constructor(
    readonly pattern: string,
    /** Length of the input offered, in UTF-16 code units. */
    readonly length: number,
    readonly maxInputLength: number,
  ) {
    super(
      `input of ${length} characters exceeds the matcher's limit of ${maxInputLength} characters ` +
        `(maxInputLength) (/${pattern}/)`,
    );
  }
}

/** Every runtime refusal, which a caller usually wants to treat the same way. */
export type RegexLimitError = RegexBudgetError | RegexTimeoutError | RegexInputTooLongError;

/**
 * True for the runtime refusals — never for a syntax error.
 *
 * The three are one category on purpose: each says "this pattern could not be decided against this
 * input", and P3 says an undecidable condition is a review-queue outcome rather than a silent
 * `false`. A caller that treats any of them as a non-match files documents by a rule that never ran.
 */
export const isRegexLimitError = (error: unknown): error is RegexLimitError =>
  error instanceof RegexBudgetError || error instanceof RegexTimeoutError || error instanceof RegexInputTooLongError;

/** Which limit a refusal hit, for a caller that wants to report or branch on it. */
export const regexLimitName = (error: RegexLimitError): 'steps' | 'time' | 'input-length' =>
  error instanceof RegexBudgetError ? 'steps' : error instanceof RegexTimeoutError ? 'time' : 'input-length';
