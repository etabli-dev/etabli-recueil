import picocolors from 'picocolors';

type Formatter = (input: string) => string;

/** The subset of picocolors this CLI uses, named so that `--no-colour` can swap in a no-op set. */
export interface Palette {
  bold: Formatter;
  dim: Formatter;
  red: Formatter;
  green: Formatter;
  yellow: Formatter;
  cyan: Formatter;
}

const paletteFor = (enabled: boolean): Palette => {
  const c = picocolors.createColors(enabled);
  return {
    bold: (input) => String(c.bold(input)),
    dim: (input) => String(c.dim(input)),
    red: (input) => String(c.red(input)),
    green: (input) => String(c.green(input)),
    yellow: (input) => String(c.yellow(input)),
    cyan: (input) => String(c.cyan(input)),
  };
};

export interface UiOptions {
  /** Machine-readable output on stdout; prose is suppressed. */
  json: boolean;
  /** Only errors. */
  quiet: boolean;
  /** Everything, including the resolution steps behind a decision. */
  verbose: boolean;
  /** `false` disables ANSI even on a terminal. */
  colour: boolean;
}

/**
 * Where output goes.
 *
 * The rule is the one every pipeline expects: stdout carries the answer, stderr carries the
 * commentary. `recueil export ... > chapter3.bib` has to produce a `.bib` file and not a `.bib`
 * file with a progress line at the top, and `recueil serve` logs to stderr for the same reason.
 */
export class Ui {
  readonly json: boolean;
  readonly quiet: boolean;
  readonly verbose: boolean;
  readonly colour: Palette;

  constructor(options: UiOptions) {
    this.json = options.json;
    this.quiet = options.quiet;
    this.verbose = options.verbose;
    this.colour = paletteFor(options.colour && picocolors.isColorSupported);
  }

  /** The answer. Always printed, `--quiet` included: suppressing it would defeat the command. */
  out(line = ''): void {
    process.stdout.write(`${line}\n`);
  }

  /** The answer, as JSON. */
  outJson(value: unknown): void {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  }

  /** Commentary. Suppressed by `--quiet` and by `--json`. */
  info(line = ''): void {
    if (this.quiet || this.json) return;
    process.stderr.write(`${line}\n`);
  }

  /** Commentary only a `--verbose` run asked for. */
  detail(line: string): void {
    if (!this.verbose || this.json) return;
    process.stderr.write(`${this.colour.dim(line)}\n`);
  }

  warn(line: string): void {
    if (this.quiet) return;
    process.stderr.write(`${this.colour.yellow('warning')} ${line}\n`);
  }

  /** Errors survive `--quiet`: a silent failure is worse than a noisy one. */
  error(line: string): void {
    process.stderr.write(`${this.colour.red('error')} ${line}\n`);
  }

  /** A bare line on stderr, for the indented detail under an error. */
  errorDetail(line: string): void {
    process.stderr.write(`${line}\n`);
  }
}

/**
 * The UI in force before the global flags have been parsed.
 *
 * Commander can fail on the command line itself, which happens before any action handler runs, so
 * something has to exist to print that failure with.
 */
export const defaultUi = (): Ui =>
  new Ui({
    json: false,
    quiet: false,
    verbose: false,
    // NO_COLOR and non-TTY detection are picocolors' job; this only handles the explicit flag.
    colour: true,
  });
