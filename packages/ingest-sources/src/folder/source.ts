/**
 * The watched folder (CONCEPT §5.3, first source in the list).
 *
 * A directory somebody drops files into. The scanner path is this source with `sourceKind:
 * 'scanner'` and a different directory — see `README.md` for the Brother ADS-4700W mapping — and
 * the Nextcloud-share path is `WebDavSource` when the share is remote and this one when the share
 * is mounted locally.
 *
 * Four things make it more than a `readdir`:
 *
 *   - **Safety.** Every name is resolved and checked to be inside the watched root before it is
 *     opened (`scan.ts`).
 *   - **Stability.** A file still being written is not offered (`stability.ts`), and the check is
 *     made again at `fetch` time, because the gap between deciding a file has settled and reading
 *     it is a gap a slow writer can fill.
 *   - **A consume policy.** Leave it, move it to a processed directory, or delete it — and the
 *     delete happens only after the bytes have been re-read out of the content store, re-hashed and
 *     matched to their `documents` row (`consume.ts`, `verify.ts`).
 *   - **Recovery.** Everything that appeared while the process was down is found by the first poll,
 *     because a poll reads the tree rather than a queue of events, and anything whose
 *     acknowledgement was interrupted is replayed from the state table.
 */
import { mkdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';

import { isInside } from '@recueil/ingest';
import type { DocumentSourceKind, HealthReport, IngestCandidate, IngestOutcome, IngestRef, IngestRule, JsonObject } from '@recueil/ingest';

import { decideConsume } from '../consume.js';
import { SourceError, SourceUnavailableError, UnsafeSourcePathError } from '../errors.js';
import { sourceState } from '../state.js';
import type { SourceStateStore } from '../state.js';
import type {
  Acknowledgement,
  CommonSourceOptions,
  ConsumePolicy,
  IngestSource,
  SourceContext,
  SourcePage,
} from '../types.js';
import { scanFolder } from './scan.js';
import type { FolderEntry } from './scan.js';
import { selectStable } from './stability.js';
import type { StabilityOptions } from './stability.js';
import { FolderWatcher } from './watcher.js';

export interface FolderSourceOptions extends CommonSourceOptions {
  /** The watched directory. Resolved at `start`; a symlinked root is followed, once. */
  root: string;
  recursive?: boolean;
  skipHidden?: boolean;
  stability?: StabilityOptions;
  /** Push notification. On by default; the poll is the truth either way. */
  watch?: { enabled?: boolean; debounceMillis?: number; sweepMillis?: number };
  /** Directory names never descended into, on top of the consume destination. */
  exclude?: readonly string[];
}

/** `revision` for a file: the pair that changes when the bytes do. */
const revisionOf = (entry: { byteSize: number; mtimeMs: number }): string =>
  `${String(Math.trunc(entry.mtimeMs))}:${String(entry.byteSize)}`;

export class FolderSource implements IngestSource {
  readonly kind = 'watch' as const;
  readonly id: string;
  readonly sourceKind: DocumentSourceKind;
  readonly rules: readonly IngestRule[];

  private readonly options: FolderSourceOptions;
  private readonly policy: ConsumePolicy;
  private root: string | null = null;
  private destination: string | null = null;
  private watcher: FolderWatcher | null = null;
  private state: SourceStateStore | null = null;
  private watcherError: string | null = null;

  constructor(options: FolderSourceOptions) {
    this.options = options;
    this.id = options.id ?? `folder:${resolve(options.root)}`;
    this.sourceKind = options.sourceKind ?? 'folder';
    this.rules = options.rules ?? [];
    this.policy = options.consume ?? { mode: 'leave' };
  }

  async start(ctx: SourceContext): Promise<void> {
    this.state = sourceState(ctx.recueil);

    const resolved = resolve(this.options.root);
    const info = await stat(resolved).catch(() => null);
    if (info === null) throw new SourceUnavailableError(`The watched folder '${resolved}' does not exist.`);
    if (!info.isDirectory()) throw new SourceUnavailableError(`'${resolved}' is not a directory.`);
    this.root = await realpath(resolved);

    if (this.policy.mode === 'move') {
      const target = isAbsolute(this.policy.to) ? this.policy.to : join(this.root, this.policy.to);
      await mkdir(target, { recursive: true });
      this.destination = await realpath(target);
      if (this.destination === this.root) {
        throw new SourceError(
          'source_misconfigured',
          `The processed directory '${this.destination}' is the watched folder itself; moving a ` +
            'file there would offer it again on the next poll.',
        );
      }
    }

    if (this.options.watch?.enabled !== false) {
      const watcher = new FolderWatcher({
        root: this.root,
        recursive: this.options.recursive !== false,
        ...(this.options.watch?.debounceMillis === undefined
          ? {}
          : { debounceMillis: this.options.watch.debounceMillis }),
        ...(this.options.watch?.sweepMillis === undefined
          ? {}
          : { sweepMillis: this.options.watch.sweepMillis }),
        onError: (error) => {
          this.watcherError = error.message;
          ctx.log({ level: 'warn', message: `the folder watcher reported an error: ${error.message}` });
        },
      });
      await watcher.start();
      this.watcher = watcher;
    }

    ctx.log({
      level: 'info',
      message: `watching '${this.root}' with the '${this.policy.mode}' consume policy`,
      data: { recursive: this.options.recursive !== false, watching: this.watcher !== null },
    });
  }

  async poll(request: { cursor?: string; limit: number }, ctx: SourceContext): Promise<SourcePage> {
    const root = this.requireRoot();
    const state = this.stateFor(ctx);

    const exclude = [...(this.options.exclude ?? [])];
    // A processed directory inside the watched root would otherwise be re-offered for ever.
    if (this.destination !== null && isInside(root, this.destination)) {
      exclude.push(this.destination.slice(root.length + 1).split(sep)[0] ?? '');
    }

    const scan = await scanFolder(root, {
      ...(this.options.recursive === undefined ? {} : { recursive: this.options.recursive }),
      ...(this.options.skipHidden === undefined ? {} : { skipHidden: this.options.skipHidden }),
      ...(this.options.maxBytes === undefined ? {} : { maxBytes: this.options.maxBytes }),
      excludeDirectories: exclude.filter((name) => name.length > 0),
    });

    const fresh = scan.entries.filter(
      (entry) => !state.isHandled(this.id, entry.relativePath, revisionOf(entry)),
    );
    const known = scan.entries.length - fresh.length;

    const { stable, unsettled } = await selectStable(fresh, this.options.stability ?? {}, ctx.signal);

    const offered = stable.slice(0, request.limit);
    const deferred = stable.slice(request.limit);

    return {
      candidates: offered.map((entry) => this.candidate(entry, ctx)),
      more: deferred.length > 0,
      skipped: [
        ...scan.skipped,
        ...unsettled,
        ...deferred.map((entry) => ({
          externalId: entry.relativePath,
          reason: 'the page was full; it will be offered on the next poll',
        })),
        ...(known === 0
          ? []
          : [
              {
                externalId: `(${String(known)} file(s))`,
                reason: 'already ingested at this revision, per the source state table',
              },
            ]),
      ],
    };
  }

  async fetch(ref: IngestRef, _ctx: SourceContext): Promise<{ bytes: Buffer; mediaType?: string }> {
    const path = await this.resolveInside(ref.externalId);
    const info = await stat(path).catch(() => null);
    if (info === null) {
      throw new SourceError('source_vanished', `'${ref.externalId}' is no longer in the watched folder.`);
    }

    // The stability check happened at poll time. Between then and now a writer may have started
    // again, and reading the file anyway would file the hash of a half-written document for ever.
    const now = revisionOf({ byteSize: info.size, mtimeMs: info.mtimeMs });
    if (ref.revision !== undefined && ref.revision !== now) {
      throw new SourceError(
        'source_changed',
        `'${ref.externalId}' changed between the poll and the read (${ref.revision} → ${now}); ` +
          'it will be offered again once it settles.',
        { was: ref.revision, is: now },
      );
    }

    return { bytes: await readFile(path) };
  }

  async acknowledge(
    ref: IngestRef,
    outcome: IngestOutcome,
    ctx: SourceContext,
  ): Promise<Acknowledgement> {
    const decision = await decideConsume({
      recueil: ctx.recueil,
      outcome,
      policy: this.policy,
      ...(this.options.consumeOn === undefined ? {} : { consumeOn: this.options.consumeOn }),
    });

    if (!decision.consume) {
      return { action: decision.action, detail: decision.detail, verified: false };
    }

    const path = await this.resolveInside(ref.externalId);
    const present = await stat(path).catch(() => null);
    if (present === null) {
      // A repeated acknowledgement after a crash, or a person who tidied up. Both are fine, and
      // saying so is better than pretending to have done the work.
      return {
        action: 'vanished',
        detail: `'${ref.externalId}' was already gone from the watched folder`,
        verified: true,
      };
    }

    if (this.policy.mode === 'delete') {
      await rm(path, { force: true });
      return {
        action: 'deleted',
        detail: `deleted after verification: ${decision.detail}`,
        verified: true,
      };
    }

    const destination = await this.moveTarget(ref.externalId);
    await mkdir(dirname(destination), { recursive: true });
    await rename(path, destination);
    return {
      action: 'moved',
      detail: `moved to '${destination}' after verification: ${decision.detail}`,
      verified: true,
    };
  }

  async stop(_ctx: SourceContext): Promise<void> {
    this.watcher?.close();
    this.watcher = null;
  }

  async health(ctx: SourceContext): Promise<HealthReport> {
    const checkedAt = ctx.now();
    if (this.root === null) {
      return { status: 'unavailable', message: 'the source has not been started', checkedAt };
    }
    const info = await stat(this.root).catch(() => null);
    if (info === null || !info.isDirectory()) {
      return { status: 'unavailable', message: `'${this.root}' is not a directory any more`, checkedAt };
    }
    if (this.watcherError !== null) {
      return {
        status: 'degraded',
        message: `the watcher reported '${this.watcherError}'; polling still works`,
        checkedAt,
      };
    }
    return {
      status: 'ok',
      message: `watching '${this.root}'`,
      checkedAt,
      detail: {
        watching: this.watcher !== null,
        recursiveWatch: this.watcher?.recursive ?? false,
        consume: this.policy.mode,
      },
    };
  }

  subscribe(listener: () => void): () => void {
    if (this.watcher === null) return () => undefined;
    return this.watcher.onChange(listener);
  }

  /* ---------------------------------------------------------------------------------------- */

  private candidate(entry: FolderEntry, ctx: SourceContext): IngestCandidate {
    const ref: IngestRef = {
      sourceId: this.id,
      externalId: entry.relativePath,
      revision: revisionOf(entry),
    };
    const metadata: JsonObject = {
      ...(this.options.sourceMetadata ?? {}),
      path: entry.relativePath,
      folder: this.root,
      byteSize: entry.byteSize,
    };
    return {
      ref,
      sourceKind: this.sourceKind,
      suggestedFilename: basename(entry.relativePath),
      observedAt: new Date(entry.mtimeMs).toISOString(),
      sourceMetadata: metadata,
      read: async () => (await this.fetch(ref, ctx)).bytes,
    };
  }

  private requireRoot(): string {
    if (this.root === null) throw new SourceError('source_not_started', 'Call `start` before polling.');
    return this.root;
  }

  /**
   * Turn an `externalId` back into a path, refusing anything that leaves the watched folder.
   *
   * `externalId` is produced by the scan, but it also arrives from the state table and from a
   * caller, and a value that has been through a database row is exactly the kind of path the
   * Phase 1 review warns about. It is therefore resolved and checked here rather than trusted.
   */
  private async resolveInside(externalId: string): Promise<string> {
    const root = this.requireRoot();
    const target = resolve(root, externalId);
    if (!isInside(root, target)) {
      throw new UnsafeSourcePathError(
        `'${externalId}' resolves to '${target}', outside the watched folder '${root}'.`,
        { externalId, target, root },
      );
    }
    const real = await realpath(target).catch(() => target);
    if (!isInside(root, real)) {
      throw new UnsafeSourcePathError(
        `'${externalId}' is a link to '${real}', outside the watched folder '${root}'.`,
        { externalId, real, root },
      );
    }
    return real;
  }

  /** Where a consumed file goes, without ever overwriting something already there. */
  private async moveTarget(externalId: string): Promise<string> {
    if (this.destination === null) {
      throw new SourceError('source_misconfigured', 'The consume policy is `move` with no destination.');
    }
    const base = resolve(this.destination, externalId);
    if (!isInside(this.destination, base)) {
      throw new UnsafeSourcePathError(
        `'${externalId}' would land at '${base}', outside the processed directory.`,
        { externalId, base },
      );
    }
    if ((await stat(base).catch(() => null)) === null) return base;

    const extension = extname(base);
    const stem = base.slice(0, base.length - extension.length);
    for (let index = 2; index < 1_000; index += 1) {
      const attempt = `${stem} (${String(index)})${extension}`;
      if ((await stat(attempt).catch(() => null)) === null) return attempt;
    }
    throw new SourceError(
      'source_move_failed',
      `A thousand files are already called '${basename(base)}' in the processed directory.`,
    );
  }

  private stateFor(ctx: SourceContext): SourceStateStore {
    this.state ??= sourceState(ctx.recueil);
    return this.state;
  }
}
