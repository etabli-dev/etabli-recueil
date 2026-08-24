/**
 * The push half of a watched folder.
 *
 * `fs.watch` rather than chokidar, and the reason is not weight: it is that the watcher is only
 * ever a *hint*. Every filesystem event this class emits does one thing — ask the runner to poll —
 * and the poll is the part that decides anything, because the poll re-reads the tree, re-checks
 * stability and consults the state table. That makes a missed event a delay rather than a lost
 * document, which in turn is what makes the periodic sweep an adequate safety net and what makes a
 * dependency on a watching library unnecessary.
 *
 * Recursive watching is used where the platform has it and per-directory watchers are set up where
 * it does not, with the tree re-read whenever a directory appears. Both paths converge on the same
 * behaviour: something changed, debounce, tell the listener.
 */
import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface FolderWatcherOptions {
  root: string;
  recursive?: boolean;
  /** Coalesce a burst of events into one poll. Default 300 ms. */
  debounceMillis?: number;
  /** Poll anyway on this interval, in case an event was missed. Default 30 s. Zero disables it. */
  sweepMillis?: number;
  /** Reported rather than thrown: a watcher that dies must not take the runner with it. */
  onError?: (error: Error) => void;
}

export class FolderWatcher {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly listeners = new Set<() => void>();
  private readonly debounceMillis: number;
  private readonly sweepMillis: number;
  private debounce: NodeJS.Timeout | null = null;
  private sweep: NodeJS.Timeout | null = null;
  private root: string | null = null;
  private recursiveWatch = false;
  private closed = false;

  constructor(private readonly options: FolderWatcherOptions) {
    this.debounceMillis = options.debounceMillis ?? 300;
    this.sweepMillis = options.sweepMillis ?? 30_000;
  }

  /** True when one recursive watcher is covering the whole tree. Exposed for the health report. */
  get recursive(): boolean {
    return this.recursiveWatch;
  }

  get watching(): number {
    return this.watchers.size;
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error('This watcher has been closed.');
    this.root = await realpath(resolve(this.options.root));

    if (this.options.recursive !== false) {
      try {
        this.add(this.root, true);
        this.recursiveWatch = true;
      } catch {
        // Linux before Node 20.13 and some network filesystems. Fall back to one watcher per
        // directory, which is what chokidar does on the same platforms.
        this.recursiveWatch = false;
      }
    }
    if (!this.recursiveWatch) await this.watchTree(this.root);

    if (this.sweepMillis > 0) {
      this.sweep = setInterval(() => this.fire(), this.sweepMillis);
      this.sweep.unref?.();
    }
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.closed = true;
    if (this.debounce !== null) clearTimeout(this.debounce);
    if (this.sweep !== null) clearInterval(this.sweep);
    this.debounce = null;
    this.sweep = null;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.listeners.clear();
  }

  private add(directory: string, recursive: boolean): void {
    if (this.watchers.has(directory)) return;
    const watcher = watch(directory, { recursive, persistent: false }, (_event, name) => {
      if (this.closed) return;
      // A new directory under a non-recursive watch needs a watcher of its own before anything
      // inside it can be seen.
      if (!this.recursiveWatch && name !== null) {
        void this.watchTree(join(directory, name.toString())).catch(() => undefined);
      }
      this.fire();
    });
    watcher.on('error', (error: Error) => this.options.onError?.(error));
    this.watchers.set(directory, watcher);
  }

  private async watchTree(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return; // Not a directory, or gone again already. Either way there is nothing to watch.
    }
    try {
      this.add(directory, false);
    } catch (error) {
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) await this.watchTree(join(directory, entry.name));
    }
  }

  private fire(): void {
    if (this.closed) return;
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      for (const listener of this.listeners) listener();
    }, this.debounceMillis);
    this.debounce.unref?.();
  }
}
