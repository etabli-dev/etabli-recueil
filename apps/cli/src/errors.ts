import { ExitCode, type ExitCodeValue } from './exit.js';

/**
 * An error the user is meant to read, carrying the exit code the shell is meant to see.
 *
 * Anything thrown that is not one of these is a bug in the CLI, and `main` prints it as such —
 * with a stack trace, because the person reading it is then a developer rather than a user.
 */
export class CliError extends Error {
  readonly exitCode: ExitCodeValue;

  /** Extra lines printed under the message, indented. Empty strings are blank lines. */
  readonly detail: readonly string[];

  /** Printed instead of the prose when `--json` is in force. */
  readonly payload: Record<string, unknown> | undefined;

  constructor(
    message: string,
    options: {
      exitCode?: ExitCodeValue;
      detail?: readonly string[];
      payload?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CliError';
    this.exitCode = options.exitCode ?? ExitCode.Usage;
    this.detail = options.detail ?? [];
    this.payload = options.payload;
  }
}
