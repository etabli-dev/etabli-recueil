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
 * **Consume is conditional on the identity of the file, not on its name** (H1,
 * `spec/hardening-2026-08.md`). The store verification in `consume.ts` queries the library and the
 * content store; neither of them is the far side about to be destroyed, so on its own it licenses
 * deleting whatever happens to be at the path now. Before the `rm` or the `rename`, therefore, this
 * source asks three further questions of the file itself:
 *
 *   1. Is its `(mtime, size, inode)` still the triple the candidate was offered under (`revision.ts`)?
 *   2. Do its bytes still hash to the digest the pipeline committed?
 *   3. Was it the *same inode, unwritten to*, for the whole of that re-hash, and from then until
 *      the last look before the destructive call?
 *
 * The second is the one that makes "what is acknowledged is the digest the pipeline committed, not
 * the path" true rather than aspirational. The third is what makes the second mean anything, and it
 * is new, because the re-attack showed the second on its own was not load-bearing where it mattered
 * most.
 *
 * **Why the third question exists.** `hashFile` streamed the original from beginning to end and
 * compared the digest afterwards. A rewrite of a region the stream had already passed was therefore
 * invisible to it, so the blind window for the first bytes of a file was not two syscalls but the
 * whole duration of the re-hash: measured at 270 ms on a 128 MiB file, linear in size, seconds on
 * the 900 MB scan ADR-0022 names. A same-length in-place rewrite with the mtime put back — which is
 * one `open(…, 'r+')`, one `write` and one `utimensat` — left every field of the revision intact
 * and was deleted with `verified: true`, three times out of three.
 *
 * The answer is `st_ctime`. The re-hash now runs over an open descriptor rather than a path, so it
 * cannot be switched underneath by a rename, and the descriptor is `fstat`-ed before and after. A
 * write bumps the inode's change time, and unlike `st_mtime` that stamp is not settable from user
 * space: there is no `utimensat` field for it, and the call that restores an mtime updates the
 * ctime as a side effect. So a rewrite that hides from the mtime does not hide from this, and the
 * only ways to move a ctime backwards need the system clock, which needs root.
 *
 * **Where a consumed file goes.** `moveTarget` chose a free name with `stat` and then called
 * `rename`, and `rename(2)` replaces its destination silently. `ConsumePolicy.to` may be absolute,
 * so two watched folders sharing one processed directory is a supported configuration; two
 * acknowledgements interleave at their `await`s long before either renames, and an archived
 * original was destroyed ten times out of ten. The name is now *claimed* with `open(…, 'wx')`,
 * which is `O_CREAT|O_EXCL` — one atomic syscall that either reserves the name or says somebody
 * else has it — and the claim is held until the rename lands on top of it. A claim that is not
 * used, because the acknowledgement refused after taking it, is released.
 *
 * **A move the kernel cannot make.** An absolute `to` may name another mount, and `rename(2)`
 * cannot cross one; the call threw a raw `EXDEV` `Error` out of `acknowledge`, which is not a
 * `SourceError`, so it bypassed the review path entirely and left the state row `pending` for ever
 * while the file was re-offered and re-ingested on every poll. `EXDEV` now falls back to a copy
 * into the claimed destination, a re-hash of the copy against the digest the pipeline committed,
 * and only then the `unlink`; and every other failure of the destructive step is turned into a
 * refusal with a review entry, so the state row closes and the next poll can try again.
 *
 * **What remains open, stated rather than implied.** `stat`-then-`unlink` and `stat`-then-`rename`
 * are two syscalls, and POSIX has no "unlink only if the inode is still this one": there is no
 * `funlink`, and `unlinkat` has no such flag. A writer that replaces the file in the microseconds
 * between the last `stat` and the destructive call still loses that file. Measured on this
 * codebase over two hundred runs, that window is 15 µs at the median, 48 µs at the 95th percentile
 * and 143 µs at the worst — and, which is the point of the third check, it no longer grows with the
 * size of the file. What the checks above close is everything larger: the
 * window spanning a pipeline run, an OCR pass, a poll interval, a re-hash of a 900 MB scan or,
 * after a crash, the whole downtime until the next process replays the acknowledgement. A `move`
 * policy remains the safer configuration for a folder a writer is actively racing, because a
 * wrongly moved file still exists.
 */
import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { copyFile, mkdir, open, realpath, rename, rm, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { ReviewQueueService, ensureIngestSchema, isInside } from '@recueil/ingest';
import type { DocumentSourceKind, HealthReport, IngestCandidate, IngestOutcome, IngestRef, IngestRule, JsonObject } from '@recueil/ingest';

import { decideConsume } from '../consume.js';
import { SourceError, SourceUnavailableError, UnsafeSourcePathError } from '../errors.js';
import { subjectDocumentId } from '../verify.js';
import { sourceState } from '../state.js';
import type { SourceStateStore } from '../state.js';
import { DEFAULT_MAX_SOURCE_BYTES } from '../types.js';
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

/**
 * The reason code for a consume that could not be carried out at all.
 *
 * Distinct from the one above, because they ask different things of a person: `source_changed…`
 * means the world moved and the next poll will pick the file up again, while this one means the
 * policy itself cannot work here — a processed directory on another mount, a read-only filesystem,
 * a full disk — and somebody has to change the configuration.
 */
export const SOURCE_CONSUME_FAILED = 'source_consume_failed';

/** How many times a short read is retried before the candidate is refused (ADR-0022: bounded). */
const READ_ATTEMPTS = 2;

/** How many alternative names a consumed file may be offered before the move is refused. */
const MOVE_NAME_ATTEMPTS = 1_000;

export class FolderSource implements IngestSource {
  readonly kind = 'watch' as const;
  readonly id: string;
  readonly sourceKind: DocumentSourceKind;
  readonly rules: readonly IngestRule[];

  private readonly options: FolderSourceOptions;
  private readonly policy: ConsumePolicy;
  /** ADR-0022: every source reads under a bound, and the bound has a default (see `types.ts`). */
  private readonly maxBytes: number;
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
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_SOURCE_BYTES;
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
      maxBytes: this.maxBytes,
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
   *
   * The read itself is bounded by the call rather than checked afterwards (ADR-0022 §2): the
   * descriptor is read in chunks against a running total and abandoned the moment it passes the
   * limit, so a file that grew between the `stat` and the read cannot buy an allocation the limit
   * was meant to forbid.
   */
  async fetch(ref: IngestRef, _ctx: SourceContext): Promise<{ bytes: Buffer; mediaType?: string }> {
    const path = await this.resolveInside(ref.externalId);
    let last = '';

    for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt += 1) {
      const before = await stat(path).catch(() => null);
      if (before === null) {
        throw new SourceError('source_vanished', `'${ref.externalId}' is no longer in the watched folder.`);
      }

      // The declared size informs a fast rejection; it never bounds the read (ADR-0022 §1).
      if (before.size > this.maxBytes) {
        throw new SourceError(
          'source_too_large',
          `'${ref.externalId}' is ${String(before.size)} bytes, over the ` +
            `${String(this.maxBytes)}-byte limit this source reads under.`,
          { externalId: ref.externalId, byteSize: before.size, limit: this.maxBytes },
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

      const read = await readWithin(path, this.maxBytes);
      if (read === 'over-limit') {
        throw new SourceError(
          'source_too_large',
          `'${ref.externalId}' passed the ${String(this.maxBytes)}-byte limit this source reads ` +
            'under while it was being read, so the read was abandoned.',
          { externalId: ref.externalId, limit: this.maxBytes },
        );
      }
      const after = await stat(path).catch(() => null);

      if (read.byteLength !== before.size) {
        last =
          `the read returned ${String(read.byteLength)} of the ${String(before.size)} bytes ` +
          'the file held when it was stat-ed, so it was truncated while it was being read';
      } else if (after === null) {
        last = 'it was removed while it was being read';
      } else {
        const readDrift = revisionDrift(formatRevision(fileRevision(before)), fileRevision(after));
        if (readDrift === null) return { bytes: read };
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

    const proof = await this.stillTheFileThatWasRead(ref, outcome, path, present);
    if (proof.objection !== null) {
      this.flagForReview(ctx, ref, outcome, proof.objection, SOURCE_CHANGED_BEFORE_CONSUME);
      return {
        action: 'refused',
        detail:
          `the original was kept: ${proof.objection}. The store verification passed ` +
          `(${decision.detail}), but it is about the bytes already in the library, not about the ` +
          'file at this path; it will be offered again under its own revision on the next poll',
        verified: false,
      };
    }
    const identity = proof.identity;

    // Everything from here can fail, and every one of those failures used to leave the runner
    // holding a raw errno: `EXDEV` out of `rename` was the case the re-attack found, and `EACCES`
    // out of the destination claim is the same shape. A raw throw leaves the state row `pending`
    // for ever with nothing in the review queue, so every later run replays it, throws again and
    // reports `ok: false` while the file is re-offered and re-ingested as a duplicate on each
    // poll. A consume that cannot be carried out is a refusal (P3): the original is untouched, the
    // reason is in front of a person, and the row closes so the next poll can try again.
    let destination: string | null = null;
    try {
      // The destination is claimed — atomically, with `O_CREAT|O_EXCL` — *before* the last look,
      // so that nothing awaits between that look and the `rename`, and so that no second source
      // can take the same name in the meantime. `claimMoveTarget` is several syscalls wide, and
      // every one of them was window while the name was merely being looked at rather than held.
      destination = this.policy.mode === 'move' ? await this.claimMoveTarget(ref.externalId) : null;

      // The last look before the destructive call, with no `await` between it and the call itself.
      // It is compared against the identity the re-hash proved, not against the earlier `stat`, so
      // that anything written to the file since the hash finished is caught here.
      const final = await stat(path).catch(() => null);
      if (final === null) {
        await releaseClaim(destination);
        return {
          action: 'vanished',
          detail: `'${ref.externalId}' was removed while its acknowledgement was being decided`,
          verified: true,
        };
      }
      const lateDrift = identityDrift(identity, identityOf(final));
      if (lateDrift !== null) {
        await releaseClaim(destination);
        const reason = `it was replaced while its acknowledgement was being decided (${lateDrift})`;
        this.flagForReview(ctx, ref, outcome, reason, SOURCE_CHANGED_BEFORE_CONSUME);
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
      const note = await this.completeMove(ctx, ref, outcome, path, destination, identity, proof.sha256);
      return {
        action: 'moved',
        detail: `moved to '${destination}' after verification: ${decision.detail}${note}`,
        verified: true,
      };
    } catch (error) {
      await releaseClaim(destination);
      const message = error instanceof Error ? error.message : String(error);
      const reason =
        `the '${this.policy.mode}' consume policy could not be carried out for ` +
        `'${ref.externalId}': ${message}`;
      this.flagForReview(ctx, ref, outcome, reason, SOURCE_CONSUME_FAILED);
      return { action: 'refused', detail: `the original was kept: ${reason}`, verified: false };
    }
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
        maxBytes: this.maxBytes,
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
   * `objection` is null when it is, and the sentence that says why not when it is not. Three
   * questions, cheapest first:
   *
   *   - The `(mtime, size, inode)` triple, which costs one `stat` and catches every ordinary
   *     replacement — a new upload, a `mv` over the name, a rewrite in place.
   *   - The digest, which costs a re-read of the file and catches the rest: a replacement that
   *     happens to have the same length and stamp, and — the composition the Phase 2 review
   *     found — a truncated read whose short bytes were committed while the whole file is still
   *     on disk. This is the check that makes the sentence "what is acknowledged is the digest
   *     the pipeline committed, not the path" true rather than aspirational, so it is not
   *     optional and there is no configuration to turn it off.
   *   - The stability of the inode across that re-read. See the module header: a streamed hash is
   *     blind to a rewrite behind its own cursor, so the descriptor is `fstat`-ed before and after
   *     and `st_ctime` — which a write bumps and user space cannot set — has to be unchanged.
   *
   * The file is streamed rather than read into memory: the acknowledgement path must not need a
   * buffer the size of the largest scan the operator owns. It is streamed from an open descriptor
   * rather than from the path, so a rename during the hash cannot swap the file underneath it, and
   * `identity` is what the caller compares its last look against.
   */
  private async stillTheFileThatWasRead(
    ref: IngestRef,
    outcome: IngestOutcome,
    path: string,
    present: Stats,
  ): Promise<{ objection: string | null; identity: FileIdentity; sha256: string | null }> {
    const fallback = identityOf(present);
    const drift = revisionDrift(ref.revision, fileRevision(present));
    if (drift !== null) {
      return {
        objection: `'${ref.externalId}' is not the file that was ingested (${drift})`,
        identity: fallback,
        sha256: null,
      };
    }

    const committed = 'sha256' in outcome ? outcome.sha256 : undefined;
    if (committed === undefined) {
      return {
        objection:
          `the '${outcome.status}' outcome names no digest, so '${ref.externalId}' cannot be shown ` +
          'to be the file the pipeline committed',
        identity: fallback,
        sha256: null,
      };
    }

    let digest: HashedFile;
    try {
      digest = await hashFile(path);
    } catch (error) {
      return {
        objection:
          `'${ref.externalId}' could not be re-read to confirm its identity: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        identity: fallback,
        sha256: null,
      };
    }

    // The descriptor was written to, or replaced, while it was being hashed. The digest below is
    // then a hash of a mixture of two versions and proves nothing about either.
    const duringDrift = identityDrift(digest.before, digest.after);
    if (duringDrift !== null) {
      return {
        objection:
          `'${ref.externalId}' was written to while it was being re-read to confirm its ` +
          `identity (${duringDrift}), so the digest that came out of the re-read describes ` +
          'neither the file that was ingested nor the file that is there now',
        identity: digest.after,
        sha256: null,
      };
    }

    // The path may name a different inode from the one that was just hashed: a rename can have
    // landed on it while the descriptor stayed open on the original.
    const stillHere = await stat(path).catch(() => null);
    if (stillHere === null) {
      return {
        objection: `'${ref.externalId}' was removed while it was being re-read`,
        identity: digest.after,
        sha256: null,
      };
    }
    const pathDrift = identityDrift(digest.after, identityOf(stillHere));
    if (pathDrift !== null) {
      return {
        objection:
          `'${ref.externalId}' does not name the file that was just re-read (${pathDrift})`,
        identity: identityOf(stillHere),
        sha256: null,
      };
    }

    if (digest.sha256 !== committed) {
      return {
        objection:
          `'${ref.externalId}' now holds ${String(digest.byteSize)} bytes hashing to ` +
          `${digest.sha256}, and the pipeline committed ${committed}`,
        identity: digest.after,
        sha256: digest.sha256,
      };
    }

    return { objection: null, identity: digest.after, sha256: digest.sha256 };
  }

  /**
   * Carry out a `move`, including the one the kernel will not do for us.
   *
   * `rename(2)` is the whole of it where source and destination share a filesystem: one atomic
   * call onto a name this source already holds. Across a mount boundary it answers `EXDEV`, and
   * there is no syscall that will do it — so the fallback is the only thing that can be done
   * safely: copy into the claimed destination, prove the copy hashes to the digest the pipeline
   * committed, prove the original is still the file that was verified, and only then unlink it.
   * A failure anywhere in that sequence leaves the original where it is, which is the direction
   * that cannot lose a document.
   *
   * Returns a sentence to append to the acknowledgement detail, empty for the ordinary case.
   */
  private async completeMove(
    ctx: SourceContext,
    ref: IngestRef,
    outcome: IngestOutcome,
    path: string,
    destination: string,
    identity: FileIdentity,
    committed: string | null,
  ): Promise<string> {
    try {
      await rename(path, destination);
      return '';
    } catch (error) {
      if ((error as { code?: string }).code !== 'EXDEV') throw error;
    }

    // The destination is on another mount. The claim is already ours, so the copy lands on top of
    // a placeholder nobody else can have taken.
    await copyFile(path, destination);
    const copied = await hashFile(destination);
    if (committed !== null && copied.sha256 !== committed) {
      await rm(destination, { force: true });
      throw new SourceError(
        'source_move_failed',
        `the copy to '${destination}' hashes to ${copied.sha256} and the pipeline committed ` +
          `${committed}, so the original was left where it is`,
        { externalId: ref.externalId, destination },
      );
    }

    // The copy is right. Is the thing we are about to unlink still the thing it is a copy of?
    const stillHere = await stat(path).catch(() => null);
    if (stillHere === null) {
      return ' (the original had already gone by the time the copy was complete)';
    }
    const drift = identityDrift(identity, identityOf(stillHere));
    if (drift !== null) {
      const reason =
        `'${ref.externalId}' was replaced while it was being copied across a filesystem ` +
        `boundary (${drift}); the copy is the file that was ingested and the replacement was left ` +
        'in the watched folder to be offered again';
      this.flagForReview(ctx, ref, outcome, reason, SOURCE_CHANGED_BEFORE_CONSUME);
      return ` (copied across a filesystem boundary; ${reason})`;
    }

    try {
      await rm(path, { force: true });
    } catch (error) {
      // The bytes are safely at the destination and the original is also still there. Nothing is
      // lost, but a person has to know, because the next poll will offer it again.
      const message = error instanceof Error ? error.message : String(error);
      const reason =
        `the copy to '${destination}' succeeded and was verified, but '${ref.externalId}' could ` +
        `not then be removed from the watched folder: ${message}`;
      this.flagForReview(ctx, ref, outcome, reason, SOURCE_CONSUME_FAILED);
      return ` (copied across a filesystem boundary; ${reason})`;
    }
    return ' (copied across a filesystem boundary, then verified against the committed digest)';
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
    reasonCode: string = SOURCE_CHANGED_BEFORE_CONSUME,
  ): void {
    const documentId = subjectDocumentId(outcome);
    if (documentId === null) return;
    try {
      ensureIngestSchema(ctx.recueil.connection);
      new ReviewQueueService(ctx.recueil.db, ctx.recueil.audit).raise({
        subjectType: 'document',
        subjectId: documentId,
        reasonCode,
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

  /**
   * Claim a name in the processed directory, atomically, and hold it until the move lands.
   *
   * `stat`-then-`rename` was a check and a destructive act separated by several `await`s, and
   * `rename(2)` overwrites its destination without a word: two watched folders sharing one
   * absolute `to` destroyed an archived original ten times out of ten. `open(…, 'wx')` is
   * `O_CREAT|O_EXCL`, which the kernel resolves atomically — either this call created the name or
   * somebody else holds it — so the choice and the reservation are one operation and the name
   * cannot be taken between them.
   *
   * The placeholder is empty and is overwritten by the `rename` (or the `copyFile`) that follows.
   * `releaseClaim` removes it on every path that decides not to move after all.
   */
  private async claimMoveTarget(externalId: string): Promise<string> {
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
    await mkdir(dirname(base), { recursive: true });

    const extension = extname(base);
    const stem = base.slice(0, base.length - extension.length);
    for (let index = 1; index < MOVE_NAME_ATTEMPTS; index += 1) {
      const attempt = index === 1 ? base : `${stem} (${String(index)})${extension}`;
      let handle: FileHandle;
      try {
        handle = await open(attempt, 'wx');
      } catch (error) {
        if ((error as { code?: string }).code === 'EEXIST') continue;
        throw error;
      }
      await handle.close();
      return attempt;
    }
    throw new SourceError(
      'source_move_failed',
      `${String(MOVE_NAME_ATTEMPTS)} files are already called '${basename(base)}' in the processed directory.`,
    );
  }

  private stateFor(ctx: SourceContext): SourceStateStore {
    this.state ??= sourceState(ctx.recueil);
    return this.state;
  }
}

/* --------------------------------------------------------------------------------------------- */
/* Identity                                                                                        */
/* --------------------------------------------------------------------------------------------- */

/**
 * What a file *is*, as opposed to what it is called or when it says it was written.
 *
 * `ctimeMs` is the one that earns its place. `st_mtime` is a claim the writer makes and can put
 * back with `utimensat`; `st_ctime` is the kernel's own record of when the inode last changed, it
 * is bumped by every write — including the `utimensat` that restores an mtime — and there is no
 * interface for setting it. So a same-length in-place rewrite that leaves size, mtime and inode
 * looking untouched still moves this, which is exactly the attack the re-attack demonstrated.
 */
interface FileIdentity {
  inode: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

const identityOf = (info: Pick<Stats, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs'>): FileIdentity => ({
  inode: `${String(info.dev)}/${String(info.ino)}`,
  size: info.size,
  mtimeMs: info.mtimeMs,
  ctimeMs: info.ctimeMs,
});

/** Null when the two describe the same unchanged file; a sentence naming every difference if not. */
const identityDrift = (was: FileIdentity, now: FileIdentity): string | null => {
  const differences: string[] = [];
  if (was.inode !== now.inode) {
    differences.push(`a different file altogether: inode ${was.inode} then, ${now.inode} now`);
  }
  if (was.size !== now.size) {
    differences.push(`${String(was.size)} bytes then, ${String(now.size)} now`);
  }
  if (was.mtimeMs !== now.mtimeMs) {
    differences.push(
      `last written ${new Date(was.mtimeMs).toISOString()} then, ${new Date(now.mtimeMs).toISOString()} now`,
    );
  }
  if (was.ctimeMs !== now.ctimeMs) {
    differences.push(
      `the inode changed at ${new Date(was.ctimeMs).toISOString()} then, ` +
        `${new Date(now.ctimeMs).toISOString()} now, which a write does and a restored mtime cannot hide`,
    );
  }
  return differences.length === 0 ? null : differences.join('; ');
};

interface HashedFile {
  sha256: string;
  byteSize: number;
  /** The descriptor's own identity before the first byte was read. */
  before: FileIdentity;
  /** And after the last one. Equal to `before` exactly when nothing wrote to it in between. */
  after: FileIdentity;
}

/**
 * Hash a file as it is now, streaming, counting the bytes on the way through.
 *
 * Streamed rather than `readFile`d because this runs on the acknowledgement path for every
 * consumed file, and a 900 MB scan must not need 900 MB of heap to be deleted safely. Streamed
 * from an open descriptor rather than from the path so that the answer is about one inode from
 * beginning to end, and `fstat`-ed either side of the read so that the caller can tell a digest
 * that describes a file from a digest that describes a file being edited (see `FileIdentity`).
 */
const hashFile = async (path: string): Promise<HashedFile> => {
  const handle = await open(path, 'r');
  try {
    const before = identityOf(await handle.stat());
    const hash = createHash('sha256');
    let byteSize = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) {
      const buffer = chunk as Buffer;
      byteSize += buffer.byteLength;
      hash.update(buffer);
    }
    const after = identityOf(await handle.stat());
    return { sha256: hash.digest('hex'), byteSize, before, after };
  } finally {
    await handle.close();
  }
};

/**
 * Read a whole file, bounded by the call.
 *
 * `fs.readFile` decides how much to allocate from its own `stat` and then reads to the end
 * regardless, so a file that grows under it buys an allocation nothing authorised. This reads in
 * chunks against a running total and gives up the moment the total passes the limit — ADR-0022 §2,
 * "bound the operation, not the result".
 */
const readWithin = async (path: string, limit: number): Promise<Buffer | 'over-limit'> => {
  const handle = await open(path, 'r');
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) {
      const buffer = chunk as Buffer;
      total += buffer.byteLength;
      if (total > limit) return 'over-limit';
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
};

/** Give back a claimed destination name that is not going to be used after all. */
const releaseClaim = async (destination: string | null): Promise<void> => {
  if (destination === null) return;
  await rm(destination, { force: true }).catch(() => undefined);
};
