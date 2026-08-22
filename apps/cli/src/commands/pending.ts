import type { Command } from 'commander';

import { CURRENT_PHASE, IMPLEMENTED_COMMANDS, phaseLabel, type CommandSpec } from '../catalogue.js';
import { CliError } from '../errors.js';
import { ExitCode } from '../exit.js';
import type { Ui } from '../ui.js';

/**
 * A command that is in the plan but not in the build.
 *
 * It exists so that `recueil check` answers with the phase it arrives in instead of "unknown
 * command", which is a different and much less useful thing to be told. It fails — exit code 1,
 * message on stderr — because a script that pipes it into something else must not mistake a
 * placeholder for a result. Nothing here half-works: there is no partial implementation to run
 * into, and no flag that quietly turns one on.
 *
 * Some of these belong to the phase this build is in. `recueil token` arrives in Phase 1 and Phase
 * 1 is under way, and the honest thing to say is exactly that: the phase it belongs to, and the
 * list of what this build does ship.
 */
export const notImplemented = (spec: CommandSpec, ui: Ui): never => {
  const label = phaseLabel(spec.phase);

  throw new CliError(`\`recueil ${spec.name}\` is not implemented yet.`, {
    exitCode: ExitCode.Usage,
    detail: [
      '',
      `  It arrives in ${label} (CONCEPT.md §7).`,
      `  This build is Phase ${CURRENT_PHASE}, and ships: ${IMPLEMENTED_COMMANDS.join(', ')}.`,
      '',
      `  What it will do: ${spec.promise}`,
      '',
      '  The intended command surface is documented in docs/cli.qmd.',
    ],
    payload: {
      error: 'not_implemented',
      command: spec.name,
      phase: spec.phase,
      phaseTitle: label,
      currentPhase: CURRENT_PHASE,
      implemented: IMPLEMENTED_COMMANDS,
      willDo: spec.promise,
    },
  });
};

export const registerPending = (
  parent: Command,
  spec: CommandSpec,
  describe: (name: string) => string,
  ui: () => Ui,
): Command =>
  parent
    .command(spec.name)
    .description(describe(spec.name))
    // A placeholder must not adjudicate arguments it has no implementation for: `recueil ingest
    // watch --folder ~/Scans` should be answered with the phase, not with a usage error about an
    // unknown flag.
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .argument('[arguments...]', 'accepted and ignored until this command exists')
    .addHelpText('after', ['', `Not implemented. Arrives in ${phaseLabel(spec.phase)} (CONCEPT.md §7).`].join('\n'))
    .action(() => {
      notImplemented(spec, ui());
    });
