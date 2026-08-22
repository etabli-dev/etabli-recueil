import { Command } from 'commander';

import { COMMANDS, CURRENT_PHASE, isImplemented, phaseLabel } from './catalogue.js';
import { registerPending } from './commands/pending.js';
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
  `  Phase ${CURRENT_PHASE}: \`recueil serve\` works, and every other command reports the phase it`,
  `  arrives in and then exits non-zero. None of them half-works.`,
  '',
  'Connecting',
  '  RECUEIL_URL      server base URL for the API client commands',
  '  RECUEIL_TOKEN    scoped API token',
  '  RECUEIL_PROFILE  named profile from ~/.config/recueil/config.toml',
  '',
  '  `recueil serve` is the exception: it starts the server rather than talking to one, and reads',
  '  RECUEIL_HOST, RECUEIL_PORT, RECUEIL_DATABASE_URL and RECUEIL_STORAGE_PATH instead. See',
  '  deploy/.env.example.',
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
        'do, the REST API can do, because the CLI is a client of it (CONCEPT.md §5.12). The one ' +
        'exception is `recueil serve`, which starts the server.',
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

  for (const spec of COMMANDS) {
    if (spec.name === 'serve') {
      registerServe(program, describe, ui);
      continue;
    }
    if (isImplemented(spec)) {
      // Unreachable at Phase 0. A command whose phase has arrived must be given a real
      // implementation here rather than silently falling through to the placeholder.
      throw new Error(
        `\`${spec.name}\` is marked as ${phaseLabel(spec.phase)}, which this build claims to ship, but no implementation is registered.`,
      );
    }
    registerPending(program, spec, describe, ui);
  }

  return { program, ui };
};
