import { CommanderError } from 'commander';

import { CliError } from './errors.js';
import { ExitCode } from './exit.js';
import { buildProgram } from './program.js';
import { defaultUi, type Ui } from './ui.js';

const report = (error: unknown, ui: Ui): number => {
  if (error instanceof CliError) {
    if (ui.json && error.payload) {
      ui.outJson({ ...error.payload, message: error.message });
    } else {
      ui.error(error.message);
      for (const line of error.detail) ui.errorDetail(line);
    }
    return error.exitCode;
  }

  if (error instanceof CommanderError) {
    // Only reached when something has asked commander not to exit for itself.
    return error.exitCode || ExitCode.Usage;
  }

  // Not a failure the CLI anticipated, so the reader is now a developer: give them the stack.
  ui.error('an unexpected error occurred. This is a bug in Recueil.');
  ui.errorDetail('');
  ui.errorDetail(error instanceof Error ? (error.stack ?? error.message) : String(error));
  ui.errorDetail('');
  ui.errorDetail('  Please report it: https://github.com/etabli-dev/recueil/issues');
  return ExitCode.JobFailed;
};

/** Parse and run. Returns the exit code rather than setting it, so tests can call it directly. */
export const main = async (argv: readonly string[]): Promise<number> => {
  const { program, ui } = buildProgram();
  try {
    await program.parseAsync([...argv]);
    return typeof process.exitCode === 'number' ? process.exitCode : ExitCode.Success;
  } catch (error) {
    let current: Ui;
    try {
      current = ui();
    } catch {
      current = defaultUi();
    }
    return report(error, current);
  }
};
