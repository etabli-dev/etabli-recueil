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
 *     matched to their `documents` row (`consume.ts`, `verify.ts`), *and* the file about to be
 *     destroyed has been shown to still be the file that was read.
 *   - **Recovery.** Everything that appeared while the process was down is found by the first poll,
 *     because a poll reads the tree rather than a queue of events, and anything whose
 *     acknowledgement was interrupted is replayed from the state table.
 *
 * **Consume is conditional on the revision the candidate was offered under** (H1,
 * `spec/hardening-2026-08.md`). The store verification in `consume.ts` queries the library and the
 * content store; neither of them is the far side about to be destroyed, so on its own it licenses
 * deleting whatever happens to be at the path now. Before the `rm` or the `rename`, therefore, this
 * source asks two further questions of the file itself:
 *
 *   1. Is its `(mtime, size, inode)` still the triple the candidate was offered under (`revision.ts`)?
 *   2. Do its bytes still hash to the digest the pipeline committed?
 *
 * The second is the one that matters and it is why the check is worth its cost: **what is
 * acknowledged is the digest the pipeline committed, not the path.** A file that has been replaced
 * hashes to something else, whatever its metadata says, and the acknowledgement refuses, routes the
 * reason to the review queue (P3) and leaves the original alone. The state row is closed as
 * `refused`, which `isHandled` treats as unhandled, so the next poll offers the replacement under
 * its own revision and it is ingested rather than lost.
 *
 * **What remains open, stated rather than implied.** `stat`-then-`unlink` and `stat`-then-`rename`
 * are two syscalls, and POSIX has no "unlink only if the inode is still this one": there is no
 * `funlink`, and `unlinkat` has no such flag. A writer that replaces the file in the microseconds
 * between the last check and the destructive call still loses that file. What the checks above
 * close is the window that was actually costing documents — the one spanning a pipeline run, an OCR
 * pass, a poll interval or, after a crash, the whole downtime until the next process replays the
 * acknowledgement. They narrow the residual window to two adjacent syscalls with no `await` between
 * them. They do not close it, and a `move` policy is the safer configuration for a folder a writer
 * is actively racing, because a wrongly moved file still exists.
 */
import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { ReviewQueueService, ensureIngestSchema, isInside } from '@recueil/ingest';
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
import { fileRevision, formatRevision, revisionDrift } from './revision.js';
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

/** `revision` for a file: the triple that changes when the bytes do. See `revision.ts`. */
const revisionOf = (entry: { byteSize: number; mtimeMs: number; inode: string }): string =>
  formatRevision({ mtimeMs: entry.mtimeMs, byteSize: entry.byteSize, inode: entry.inode });

/**
 * The reason code a refused acknowledgement raises (P3, `spec/data-model.md` §6.1).
 *
 * The vocabulary is open, so this is Recueil's own name for "the pipeline committed a document and
 * the file it came from is not the file at that path any more".
 */
export const SOURCE_CHANGED_BEFORE_CONSUME = 'source_changed_before_consume';

/** How many times a short read is retried before the candidate is refused (ADR-0022: bounded). */
const READ_ATTEMPTS = 2;

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
    // A processed directory inside the watched root would otherwise be re-offered for ever. It is
    // excluded by its *whole* relative path, not by its first segment: `{ to: 'archive/processed' }`
    // must hide `archive/processed` and nothing else, and taking the first segment hid the entire
    // `archive` tree, so anything a person filed under `<root>/archive/…` was never offered for
    // ingestion at all (a Phase 2 finding, and a quiet one — it surfaced only as a debug line
    // naming the directory).
    if (this.destination !== null && isInside(root, this.destination)) {
      exclude.push(relative(root, this.destination).split(sep).join('/'));
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

  /**
   * Read the bytes, and prove they are the whole of the file the stat authorised.
   *
   * Three checks, in the order they can fail:
   *
   *   1. The file is still at the revision the candidate was offered under. The stability check
   *      happened at poll time; between then and now a writer may have started again, and reading
   *      the file anyway would file the hash of a half-written document for ever.
   *   2. The read returned exactly as many bytes as that stat said the file held. `fs.readFile`
   *      does not error when the file shrinks under it: it stats, allocates, reads until `read`
   *      returns 0, and hands back a **short buffer with no indication that it is short** (H1). A
   *      209 MB scan truncated mid-read came back as 2.8 MB and was filed as a document in its own
   *      right, with a digest of its own, permanently — content-addressed identity is what makes
   *      that mistake unrecoverable rather than self-correcting.
   *   3. The file is still at the same revision *after* the read, so that a change which began and
   *      ended inside the read window is caught even when the byte count happens to survive it.
   *
   * A mismatch is retried a bounded number of times, because the common cause is a writer that
   * finished during the read and whose next attempt will succeed; after that it is refused, and the
   * next poll offers the file again under its new revision.
   */
  async fetch(ref: IngestRef, _ctx: SourceContext): Promise<{ bytes: Buffer; mediaType?: string }> {
    const path = await this.resolveInside(ref.externalId);
    let last = '';

    for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt += 1) {
      const before = await stat(path).catch(() => null);
      if (before === null) {
        throw new SourceError('source_vanished', `'${ref.externalId}' is no longer in the watched folder.`);
      }

      // ADR-0022: the read is bounded by the call, not checked after the buffer exists. The scan
      // applies the same limit, but a ref also arrives from the state table and from a caller, so
      // the bound is enforced where the allocation happens rather than only where it was decided.
      if (this.options.maxBytes !== undefined && before.size > this.options.maxBytes) {
        throw new SourceError(
          'source_too_large',
          `'${ref.externalId}' is ${String(before.size)} bytes, over the ` +
            `${String(this.options.maxBytes)}-byte limit this source reads under.`,
          { externalId: ref.externalId, byteSize: before.size, limit: this.options.maxBytes },
        );
      }

      const offeredDrift = revisionDrift(ref.revision, fileRevision(before));
      if (offeredDrift !== null) {
        throw new SourceError(
          'source_changed',
          `'${ref.externalId}' changed between the poll and the read (${offeredDrift}); ` +
            'it will be offered again once it settles.',
          { was: ref.revision, is: formatRevision(fileRevision(before)), drift: offeredDrift },
        );
      }

      const bytes = await readFile(path);
      const after = await stat(path).catch(() => null);

      if (bytes.byteLength !== before.size) {
        last =
          `the read returned ${String(bytes.byteLength)} of the ${String(before.size)} bytes ` +
          'the file held when it was stat-ed, so it was truncated while it was being read';
      } else if (after === null) {
        last = 'it was removed while it was being read';
      } else {
        const readDrift = revisionDrift(formatRevision(fileRevision(before)), fileRevision(after));
        if (readDrift === null) return { bytes };
        last = `it changed while it was being read (${readDrift})`;
      }
    }

    // ADR-0022: the retry is bounded and the refusal names what it saw. Nothing is filed, so no
    // short document exists, and the state row is never written — the next poll offers it again.
    throw new SourceError(
      'source_truncated',
      `'${ref.externalId}' could not be read whole in ${String(READ_ATTEMPTS)} attempts: ${last}.`,
      { externalId: ref.externalId, attempts: READ_ATTEMPTS, detail: last },
    );
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

    const objection = await this.stillTheFileThatWasRead(ref, outcome, path, present);
    if (objection !== null) {
      this.flagForReview(ctx, ref, outcome, objection);
      return {
        action: 'refused',
        detail:
          `the original was kept: ${objection}. The store verification passed ` +
          `(${decision.detail}), but it is about the bytes already in the library, not about the ` +
          'file at this path; it will be offered again under its own revision on the next poll',
        verified: false,
      };
    }

    // The destination is chosen and its parent created *before* the last look, so that nothing
    // awaits between that look and the `rename` — `moveTarget` alone is several `stat`s wide, and
    // every one of them is window.
    const destination = this.policy.mode === 'move' ? await this.moveTarget(ref.externalId) : null;
    if (destination !== null) await mkdir(dirname(destination), { recursive: true });

    // The last look before the destructive call, with no `await` between it and the call itself.
    // The header says what this narrows and what it leaves open.
    const final = await stat(path).catch(() => null);
    if (final === null) {
      return {
        action: 'vanished',
        detail: `'${ref.externalId}' was removed while its acknowledgement was being decided`,
        verified: true,
      };
    }
    const lateDrift = revisionDrift(formatRevision(fileRevision(present)), fileRevision(final));
    if (lateDrift !== null) {
      const reason = `it was replaced while its acknowledgement was being decided (${lateDrift})`;
      this.flagForReview(ctx, ref, outcome, reason);
      return { action: 'refused', detail: `the original was kept: ${reason}`, verified: false };
    }

    if (this.policy.mode === 'delete') {
      await rm(path, { force: true });
      return {
        action: 'deleted',
        detail: `deleted after verification: ${decision.detail}`,
        verified: true,
      };
    }

    if (destination === null) {
      throw new SourceError('source_misconfigured', 'The consume policy is `move` with no destination.');
    }
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

  /**
   * Is the file about to be destroyed still the file the pipeline read?
   *
   * Null when it is, and the sentence that says why not when it is not. Two questions, cheapest
   * first:
   *
   *   - The `(mtime, size, inode)` triple, which costs one `stat` and catches every ordinary
   *     replacement — a new upload, a `mv` over the name, a rewrite in place.
   *   - The digest, which costs a re-read of the file and catches the rest: a replacement that
   *     happens to have the same length and stamp, and — the composition the Phase 2 review
   *     found — a truncated read whose short bytes were committed while the whole file is still
   *     on disk. This is the check that makes the sentence "what is acknowledged is the digest
   *     the pipeline committed, not the path" true rather than aspirational, so it is not
   *     optional and there is no configuration to turn it off.
   *
   * The file is streamed rather than read into memory: the acknowledgement path must not need a
   * buffer the size of the largest scan the operator owns.
   */
  private async stillTheFileThatWasRead(
    ref: IngestRef,
    outcome: IngestOutcome,
    path: string,
    present: Stats,
  ): Promise<string | null> {
    const drift = revisionDrift(ref.revision, fileRevision(present));
    if (drift !== null) {
      return `'${ref.externalId}' is not the file that was ingested (${drift})`;
    }

    const committed = 'sha256' in outcome ? outcome.sha256 : undefined;
    if (committed === undefined) {
      return (
        `the '${outcome.status}' outcome names no digest, so '${ref.externalId}' cannot be shown ` +
        'to be the file the pipeline committed'
      );
    }

    let digest: { sha256: string; byteSize: number };
    try {
      digest = await hashFile(path);
    } catch (error) {
      return (
        `'${ref.externalId}' could not be re-read to confirm its identity: ` +
        `${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (digest.sha256 === committed) return null;

    return (
      `'${ref.externalId}' now holds ${String(digest.byteSize)} bytes hashing to ` +
      `${digest.sha256}, and the pipeline committed ${committed}`
    );
  }

  /**
   * Route a refusal to the review queue (P3).
   *
   * A refused acknowledgement already makes the run not-ok and leaves a `refused` state row, but
   * neither of those is somewhere a person looks. The entry names the document that *was* filed,
   * because that is the library record the operator can act from; the explanation names the path,
   * the reason and the fact that nothing was destroyed. Raising it must never turn a data-safe
   * refusal into a throw, so a failure to raise is swallowed after being logged.
   */
  private flagForReview(
    ctx: SourceContext,
    ref: IngestRef,
    outcome: IngestOutcome,
    reason: string,
  ): void {
    const documentId = 'documentId' in outcome ? outcome.documentId : undefined;
    if (documentId === undefined) return;
    try {
      ensureIngestSchema(ctx.recueil.connection);
      new ReviewQueueService(ctx.recueil.db, ctx.recueil.audit).raise({
        subjectType: 'document',
        subjectId: documentId,
        reasonCode: SOURCE_CHANGED_BEFORE_CONSUME,
        explanation:
          `The '${this.policy.mode}' consume policy was refused for '${ref.externalId}' in ` +
          `'${this.root ?? '?'}' because ${reason}. Nothing was deleted or moved. The file at ` +
          'that path will be offered again under its own revision on the next poll; this entry ' +
          'is here because a source that had to refuse is worth a person knowing about.',
        proposedAction: 'none',
        severity: 'warning',
        sourceStage: 'source.acknowledge',
        actor: ctx.recueil.actor,
      });
    } catch (error) {
      ctx.log({
        level: 'warn',
        message: `the refusal could not be queued for review: ${error instanceof Error ? error.message : String(error)}`,
        externalId: ref.externalId,
      });
    }
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

/**
 * Hash a file as it is now, streaming, counting the bytes on the way through.
 *
 * Streamed rather than `readFile`d because this runs on the acknowledgement path for every
 * consumed file, and a 900 MB scan must not need 900 MB of heap to be deleted safely.
 */
const hashFile = async (path: string): Promise<{ sha256: string; byteSize: number }> => {
  const hash = createHash('sha256');
  let byteSize = 0;
  for await (const chunk of createReadStream(path)) {
    const buffer = chunk as Buffer;
    byteSize += buffer.byteLength;
    hash.update(buffer);
  }
  return { sha256: hash.digest('hex'), byteSize };
};
