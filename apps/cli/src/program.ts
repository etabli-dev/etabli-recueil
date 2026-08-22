import { Command } from 'commander';

import { COMMANDS, CURRENT_PHASE, IMPLEMENTED_COMMANDS, isImplemented, phaseLabel } from './catalogue.js';
import { registerBackup } from './commands/backup.js';
import { registerExport } from './commands/export.js';
import { registerImport } from './commands/import.js';
import { registerPending } from './commands/pending.js';
import { registerRestore } from './commands/restore.js';
import { registerServe } from './commands/serve.js';
import { Ui } from './ui.js';
import { VERSION } from './version.js';

export interface GlobalFlags {
  json: boolean;
  quiet: boolean;
  verbose: boolean;
  colour: boolean;
  color: boolean;
  yes: boolean;
}

export interface BuiltProgram {
  program: Command;
  /** The UI implied by the global flags. Valid once parsing has begun; memoised after that. */
  ui: () => Ui;
}

const HELP_EPILOGUE = [
  '',
  'Phases',
  `  Commands are listed with the roadmap phase that delivers them (CONCEPT.md §7). This build is`,
  `  Phase ${CURRENT_PHASE} and ships ${IMPLEMENTED_COMMANDS.join(', ')}; every other command reports the`,
  `  phase it arrives in and then exits non-zero. None of them half-works.`,
  '',
  'Connecting',
  '  RECUEIL_URL      server base URL for the API client commands',
  '  RECUEIL_TOKEN    scoped API token',
  '  RECUEIL_PROFILE  named profile from ~/.config/recueil/config.toml',
  '',
  '  `serve`, `import`, `export`, `backup` and `restore` work on the library directly rather than',
  '  through the API, and read RECUEIL_HOST, RECUEIL_PORT, RECUEIL_DATABASE_URL and',
  '  RECUEIL_STORAGE_PATH instead. See deploy/.env.example.',
  '',
  'Exit codes',
  '  0 success · 1 usage or unimplemented · 2 auth · 3 server unreachable · 4 items routed to the',
  '  review queue · 5 job failed',
  '',
  'Documentation  https://github.com/etabli-dev/recueil',
].join('\n');

export const buildProgram = (): BuiltProgram => {
  const program = new Command();

  let cached: Ui | undefined;
  const ui = (): Ui => {
    if (!cached) {
      const flags = program.opts<GlobalFlags>();
      cached = new Ui({
        json: flags.json === true,
        quiet: flags.quiet === true,
        verbose: flags.verbose === true,
        colour: flags.colour !== false && flags.color !== false,
      });
    }
    return cached;
  };

  program
    .name('recueil')
    // One paragraph, unwrapped: commander does its own wrapping to the terminal width, and hard
    // line breaks here fight it.
    .description(
      'Recueil — a self-hosted, API-first document and reference manager. Everything the CLI can ' +
        'do, the REST API can do, because there is one implementation of each of them ' +
        '(CONCEPT.md §5.12). The data commands — serve, import, export, backup, restore — open ' +
        'the library directly rather than talking to a server; the rest are API clients.',
    )
    .version(VERSION, '-V, --version', 'print the version and exit')
    .option('--json', 'machine-readable output on stdout', false)
    .option('-q, --quiet', 'errors only', false)
    .option('-v, --verbose', 'explain what is being resolved and why', false)
    .option('--no-colour', 'disable coloured output')
    // The American spelling, accepted silently. Prose in this project is British; a command line
    // should not be a spelling test.
    .option('--no-color', 'alias for --no-colour')
    .option('-y, --yes', 'assume yes for every confirmation', false)
    .showHelpAfterError('(run `recueil --help` for the command list)')
    .addHelpText('after', HELP_EPILOGUE);

  // Commander hides negated options' positive twin; `--no-color` is documented by `--no-colour`.
  const colorOption = program.options.find((option) => option.long === '--no-color');
  if (colorOption) colorOption.hidden = true;

  /** `Start the server (Phase 0)` — the phase is part of the description so help cannot omit it. */
  const describe = (name: string): string => {
    const spec = COMMANDS.find((candidate) => candidate.name === name);
    if (!spec) return name;
    const phase = `(Phase ${spec.phase})`;
    return isImplemented(spec) ? `${spec.summary} ${phase}` : `${spec.summary} ${phase} — not implemented`;
  };

  /**
   * The commands with a real implementation, by name.
   *
   * The map and the `implemented` flag in the catalogue are checked against each other below.
   * Either one on its own could drift — a command marked as shipping with nothing behind it, or an
   * implementation the help text still calls unimplemented — and both mistakes produce a CLI that
   * lies about itself, which is the one thing a phased build must not do.
   */
  const registrars: Record<string, (parent: Command, describe: (name: string) => string, ui: () => Ui) => Command> = {
    serve: registerServe,
    import: registerImport,
    export: registerExport,
    backup: registerBackup,
    restore: registerRestore,
  };

  for (const spec of COMMANDS) {
    const register = registrars[spec.name];

    if (isImplemented(spec) && register === undefined) {
      throw new Error(
        `\`${spec.name}\` is marked as implemented (${phaseLabel(spec.phase)}), but no implementation is registered.`,
      );
    }
    if (!isImplemented(spec) && register !== undefined) {
      throw new Error(
        `\`${spec.name}\` has an implementation registered but the catalogue still calls it unimplemented.`,
      );
    }

    if (register !== undefined) register(program, describe, ui);
    else registerPending(program, spec, describe, ui);
  }

  return { program, ui };
};
