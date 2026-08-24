/**
 * The three ways a pattern can fail, kept apart because they mean different things to the caller.
 *
 * A `RegexSyntaxError` is the rule author's mistake and belongs in a validation message. A
 * `RegexBudgetError` or a `RegexTimeoutError` is a runtime refusal on a specific input: the pattern
 * is fine, the work it implied was not, and the ingestion pipeline should route the subject to
 * review rather than pretend the condition did not match.
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

/** True for the two runtime refusals, which a caller usually wants to treat the same way. */
export const isRegexLimitError = (error: unknown): error is RegexBudgetError | RegexTimeoutError =>
  error instanceof RegexBudgetError || error instanceof RegexTimeoutError;
