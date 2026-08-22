/**
 * The progress display.
 *
 * An import of a real library takes minutes, and a program that prints nothing for minutes is
 * indistinguishable from one that has hung. So there is a display — but it has to behave in three
 * different places, and the difference is not cosmetic:
 *
 * - **On a terminal** it is one line, rewritten in place. Fifty thousand lines of "item 41 991 of
 *   50 000" is not progress, it is a scrollback.
 * - **In a log** — a pipe, a systemd unit, a CI job — carriage returns produce an unreadable mess,
 *   so the same information goes out as ordinary lines, at most one every few seconds.
 * - **Under `--json` or `--quiet`** it does not exist at all. The contract of `--json` is that
 *   stdout is a document and stderr is not needed to read it; the contract of `--quiet` is silence
 *   short of an error.
 *
 * Everything goes to stderr, so `recueil export … > chapter3.bib` still produces a `.bib` file.
 */
import type { Ui } from './ui.js';

/** How often the line is rewritten on a terminal, and how often a line is emitted into a log. */
const TERMINAL_INTERVAL_MS = 100;
const LOG_INTERVAL_MS = 5_000;

export interface ProgressState {
  /** The stage: `items`, `attachments`, `storage`. */
  readonly label: string;
  readonly done: number;
  /** Zero when the total is not yet known; the bar then shows a count rather than a percentage. */
  readonly total: number;
  /** What is being worked on right now, if it is worth naming. */
  readonly detail?: string | null;
}

const bar = (done: number, total: number, cells = 24): string => {
  if (total <= 0) return '';
  const filled = Math.max(0, Math.min(cells, Math.round((done / total) * cells)));
  return `[${'#'.repeat(filled)}${'.'.repeat(cells - filled)}] `;
};

const percent = (done: number, total: number): string =>
  total <= 0 ? '' : ` ${String(Math.floor((done / total) * 100)).padStart(3)}%`;

const describe = (state: ProgressState): string => {
  const counts = state.total > 0 ? `${state.done}/${state.total}` : String(state.done);
  const detail = state.detail == null || state.detail === '' ? '' : `  ${state.detail}`;
  return `${state.label} ${counts}${percent(state.done, state.total)}${detail}`;
};

/**
 * A progress line.
 *
 * Nothing here throws and nothing here is required: a command that forgets to call `finish` gets a
 * stray line, not a broken run, and a command that calls `update` a million times pays for a clock
 * read and a comparison most of those times.
 */
export class Progress {
  readonly enabled: boolean;

  readonly #ui: Ui;

  readonly #interactive: boolean;

  #lastEmit = 0;

  #lastLength = 0;

  constructor(ui: Ui, options: { enabled?: boolean; interactive?: boolean } = {}) {
    this.#ui = ui;
    this.#interactive =
      options.interactive ?? (process.stderr.isTTY === true && process.env['NO_COLOR'] === undefined);
    this.enabled = (options.enabled ?? true) && !ui.quiet && !ui.json;
  }

  update(state: ProgressState): void {
    if (!this.enabled) return;
    const now = Date.now();
    const interval = this.#interactive ? TERMINAL_INTERVAL_MS : LOG_INTERVAL_MS;
    if (now - this.#lastEmit < interval) return;
    this.#lastEmit = now;
    this.#write(state);
  }

  /** Emit the state unconditionally — for the last record of a stage, which must not be swallowed. */
  flush(state: ProgressState): void {
    if (!this.enabled) return;
    this.#lastEmit = Date.now();
    this.#write(state);
  }

  /** Take the line down. Safe to call twice, and safe to call when nothing was ever drawn. */
  finish(): void {
    if (!this.enabled || !this.#interactive || this.#lastLength === 0) return;
    process.stderr.write(`\r${' '.repeat(this.#lastLength)}\r`);
    this.#lastLength = 0;
  }

  #write(state: ProgressState): void {
    const text = describe(state);
    if (!this.#interactive) {
      this.#ui.info(`  ${text}`);
      return;
    }
    const columns = process.stderr.columns ?? 80;
    const line = `${bar(state.done, state.total)}${text}`.slice(0, Math.max(20, columns - 1));
    const padding = ' '.repeat(Math.max(0, this.#lastLength - line.length));
    process.stderr.write(`\r${line}${padding}`);
    this.#lastLength = line.length;
  }
}
