/**
 * The WebDAV feed (CONCEPT §5.3): "WebDAV feed (e.g. a Nextcloud share)".
 *
 * A remote directory somebody drops files into, polled rather than watched, because WebDAV has no
 * push that is worth the complexity budget. It is the same job as `FolderSource` across a network,
 * and the differences are all in what a network makes untrustworthy:
 *
 *   - **What has been seen is `(path, etag, size)`.** A remote listing has no inode and no mtime
 *     that can be relied on to the millisecond, so the revision is the ETag when the server gives
 *     one and `lastModified:size` when it does not. Either way it is only ever a *hint* that the
 *     content changed; identity remains the SHA-256 the pipeline computes (P2), so the worst a
 *     recycled ETag can cost is a re-ingest that stage 2 recognises as a duplicate.
 *   - **A path in a listing is hostile.** `WebDavClient` refuses any `href` that does not land
 *     inside the polled collection, and this source refuses any `externalId` that does not either.
 *   - **The bytes may change between the listing and the read.** `fetch` compares the ETag the
 *     `GET` came back with against the one the candidate was offered under, and refuses the read
 *     when they disagree, so a file rewritten mid-poll is offered again rather than filed half old
 *     and half new.
 *   - **Nothing is deleted on the strength of a status code.** The consume policy runs through
 *     `decideConsume`, which re-reads the blob out of the content store and re-hashes it first —
 *     and then, because that check is about the bytes already in the library and not about the
 *     object on the share, through the revision guard below.
 *
 * **Consume is conditional on the revision the candidate was offered under** (H1,
 * `spec/hardening-2026-08.md`). The window here is not a millisecond: it is a whole poll interval,
 * and after a crash the whole downtime until the next process replays the acknowledgement. Two
 * mechanisms close it, and both are used because neither is sufficient alone:
 *
 *   1. **The client's own check.** A `HEAD` immediately before the destructive call, and a refusal
 *      when the ETag — or, on a share that sends none, the `(Last-Modified, size)` pair — is not
 *      the one the candidate was offered under. This is a check, so it has a race: the object can
 *      change between the `HEAD` and the `DELETE`.
 *   2. **The server's decision.** `If-Match` on the `DELETE` and on the `MOVE`, carrying that same
 *      ETag. RFC 7232 §3.1 makes the far side evaluate the condition atomically with the operation,
 *      which is the only thing that closes the race rather than narrowing it, and it is the one
 *      mechanism WebDAV provides for exactly this. A 412 is a refusal, not an error.
 *
 * What remains open, stated rather than implied: a share that ignores `If-Match` — a plain
 * `mod_dav` without preconditions, or a proxy that strips the header — leaves only mechanism 1,
 * and mechanism 1 has a window of one round trip. There is no way for a client to detect that from
 * the outside, so the refusal wording never claims the precondition was honoured. A share that will
 * not answer `HEAD` at all leaves neither, and the acknowledgement refuses rather than guessing.
 */
import { basename, extname } from 'node:path/posix';

import type {
  DocumentSourceKind,
  HealthReport,
  IngestCandidate,
  IngestOutcome,
  IngestRef,
  IngestRule,
  JsonObject,
} from '@recueil/ingest';

import { ReviewQueueService, ensureIngestSchema } from '@recueil/ingest';

import { decideConsume } from '../consume.js';
import { SourceError, UnsafeSourcePathError } from '../errors.js';
import { sourceState } from '../state.js';
import type { SourceStateStore } from '../state.js';
import type {
  Acknowledgement,
  CommonSourceOptions,
  ConsumePolicy,
  IngestSource,
  SkippedEntry,
  SourceContext,
  SourcePage,
} from '../types.js';
import { WebDavClient } from './client.js';
import type { WebDavAuth, WebDavEntry } from './client.js';

export interface WebDavStabilityOptions {
  /**
   * Only offer an entry whose `Last-Modified` is at least this old. Default 0, i.e. off.
   *
   * Nextcloud assembles a chunked upload into its final name in one move, so a file that is
   * visible is complete. A plain `mod_dav` target has no such guarantee, and a scanner writing
   * straight over WebDAV certainly does not; set a quiet period there.
   */
  quietMillis?: number;
  /**
   * Require an entry to have been seen unchanged in a previous poll before offering it. Default
   * off, because it doubles the latency of every arrival; it is the belt to `quietMillis`'s braces
   * for a server whose `Last-Modified` cannot be trusted.
   */
  requireSecondSighting?: boolean;
}

export interface WebDavSourceOptions extends CommonSourceOptions {
  /** The collection to poll. */
  url: string;
  auth?: WebDavAuth;
  headers?: Record<string, string>;
  timeoutMillis?: number;
  /** Descend into subcollections. Default true. */
  recursive?: boolean;
  /** How deep to descend. Default 8: a share with a deeper tree than that is a mistake. */
  maxDepth?: number;
  stability?: WebDavStabilityOptions;
  /** Injected in tests. */
  fetch?: typeof fetch;
}

interface Sighting {
  revision: string;
  seenAt: number;
}

export class WebDavSource implements IngestSource {
  readonly kind = 'poll' as const;
  readonly id: string;
  readonly sourceKind: DocumentSourceKind;
  readonly rules: readonly IngestRule[];

  readonly client: WebDavClient;
  private readonly options: WebDavSourceOptions;
  private readonly policy: ConsumePolicy;
  private readonly destination: string | null;
  /** In-memory only, and deliberately: a second sighting is about *this* process's evidence. */
  private readonly sightings = new Map<string, Sighting>();
  private state: SourceStateStore | null = null;
  private started = false;

  constructor(options: WebDavSourceOptions) {
    this.options = options;
    this.client = new WebDavClient({
      url: options.url,
      ...(options.auth === undefined ? {} : { auth: options.auth }),
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      ...(options.timeoutMillis === undefined ? {} : { timeoutMillis: options.timeoutMillis }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    this.id = options.id ?? `webdav:${this.client.base.toString()}`;
    this.sourceKind = options.sourceKind ?? 'webdav';
    this.rules = options.rules ?? [];
    this.policy = options.consume ?? { mode: 'leave' };
    this.destination =
      this.policy.mode === 'move' ? this.policy.to.replace(/^\/+|\/+$/gu, '') : null;
  }

  async start(ctx: SourceContext): Promise<void> {
    this.state = sourceState(ctx.recueil);
    // Connect lazily, says §6.4 — but a `MKCOL` for the processed collection is cheap and it is
    // far better to find out at activation that the credentials are wrong than at the first
    // acknowledgement, when a document is already in the library and waiting to be filed away.
    if (this.destination !== null) {
      await this.client.ensureCollection(this.destination, ctx.signal);
    }
    this.started = true;
    ctx.log({
      level: 'info',
      message: `polling '${this.client.base.toString()}' with the '${this.policy.mode}' consume policy`,
    });
  }

  async poll(request: { cursor?: string; limit: number }, ctx: SourceContext): Promise<SourcePage> {
    const state = this.stateFor(ctx);
    const skipped: SkippedEntry[] = [];
    const files: WebDavEntry[] = [];

    const maxDepth = this.options.maxDepth ?? 8;
    const queue: Array<{ path: string; depth: number }> = [{ path: '', depth: 0 }];
    let known = 0;

    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined) break;
      const listing = await this.client.list(next.path, '1', ctx.signal);

      for (const entry of listing) {
        if (this.destination !== null && isUnder(entry.path, this.destination)) {
          continue; // The processed collection is ours; re-offering it would be a loop.
        }
        if (entry.isCollection) {
          if (this.options.recursive === false) {
            skipped.push({ externalId: entry.path, reason: 'it is a collection and the poll is not recursive' });
            continue;
          }
          if (next.depth + 1 > maxDepth) {
            skipped.push({ externalId: entry.path, reason: `it is deeper than the ${String(maxDepth)}-level limit` });
            continue;
          }
          queue.push({ path: entry.path, depth: next.depth + 1 });
          continue;
        }
        if (entry.byteSize === 0) {
          skipped.push({ externalId: entry.path, reason: 'it is empty' });
          continue;
        }
        if (this.options.maxBytes !== undefined && (entry.byteSize ?? 0) > this.options.maxBytes) {
          skipped.push({
            externalId: entry.path,
            reason: `it is ${String(entry.byteSize)} bytes, over the ${String(this.options.maxBytes)}-byte limit`,
          });
          continue;
        }
        files.push(entry);
      }
    }

    const ready: WebDavEntry[] = [];
    for (const entry of files) {
      const revision = revisionOf(entry);
      if (state.isHandled(this.id, entry.path, revision)) {
        known += 1;
        continue;
      }
      const settled = this.settled(entry, revision);
      if (settled !== null) {
        skipped.push({ externalId: entry.path, reason: settled });
        continue;
      }
      ready.push(entry);
    }

    const offered = ready.slice(0, request.limit);
    const deferred = ready.slice(request.limit);
    for (const entry of deferred) {
      skipped.push({ externalId: entry.path, reason: 'the page was full; it will be offered on the next poll' });
    }
    if (known > 0) {
      skipped.push({
        externalId: `(${String(known)} file(s))`,
        reason: 'already ingested at this revision, per the source state table',
      });
    }

    return {
      candidates: offered.map((entry) => this.candidate(entry, ctx)),
      more: deferred.length > 0,
      skipped,
    };
  }

  async fetch(ref: IngestRef, ctx: SourceContext): Promise<{ bytes: Buffer; mediaType?: string }> {
    const path = this.checkPath(ref.externalId);
    const response = await this.client.get(path, ctx.signal);

    // The listing said one thing; the `GET` is the thing that actually happened. When the server
    // sends an ETag with the body, the two have to agree, or these are not the bytes that were
    // offered — the file was rewritten between the poll and the read — and the candidate has to be
    // offered again rather than filed as a mixture of the two versions.
    if (response.etag !== null && ref.revision !== undefined && ref.revision.startsWith('etag:')) {
      const offered = ref.revision.slice('etag:'.length);
      if (offered !== response.etag) {
        throw new SourceError(
          'source_changed',
          `'${path}' changed between the poll and the read (etag ${offered} → ${response.etag}); ` +
            'it will be offered again under its new revision.',
          { was: offered, is: response.etag },
        );
      }
    }

    return {
      bytes: response.bytes,
      ...(response.contentType === null ? {} : { mediaType: response.contentType.split(';')[0]?.trim() }),
    };
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

    const path = this.checkPath(ref.externalId);

    const current = await this.client.head(path, ctx.signal);
    if (current.kind === 'absent') {
      return { action: 'vanished', detail: `'${path}' was already gone from the share`, verified: true };
    }
    if (current.kind === 'unsupported') {
      const reason =
        `the share answered ${String(current.status)} to HEAD '${path}', so there is no way to ` +
        'check that the object about to be consumed is still the one that was ingested';
      this.flagForReview(ctx, ref, outcome, reason);
      return { action: 'refused', detail: `the original was kept: ${reason}`, verified: false };
    }

    const drift = this.revisionDrift(ref.revision, current);
    if (drift !== null) {
      this.flagForReview(ctx, ref, outcome, drift);
      return {
        action: 'refused',
        detail:
          `the original was kept: ${drift}. The store verification passed (${decision.detail}), ` +
          'but it is about the bytes already in the library, not about the object on the share; ' +
          'it will be offered again under its own revision on the next poll',
        verified: false,
      };
    }

    // The ETag goes back to the server as a precondition, so the decision is the server's rather
    // than a guess made one round trip ago. Null on a share that sends no ETags: the header is then
    // omitted and the check above is all there is, which the refusal wording is careful about.
    const ifMatch = current.etag;

    if (this.policy.mode === 'delete') {
      const result = await this.client.delete(path, ctx.signal, { ifMatch });
      if (result === 'absent') {
        return { action: 'vanished', detail: `'${path}' was already gone from the share`, verified: true };
      }
      if (result === 'stale') return this.refuseStale(ctx, ref, outcome, path, 'DELETE', ifMatch);
      return {
        action: 'deleted',
        detail: `deleted after verification: ${decision.detail}${matchNote(ifMatch)}`,
        verified: true,
      };
    }

    const target = await this.moveTarget(path, ctx);
    const result = await this.client.move(path, target, ctx.signal, { ifMatch });
    if (result === 'absent') {
      return { action: 'vanished', detail: `'${path}' was already gone from the share`, verified: true };
    }
    if (result === 'stale') return this.refuseStale(ctx, ref, outcome, path, 'MOVE', ifMatch);
    return {
      action: 'moved',
      detail: `moved to '${target}' after verification: ${decision.detail}${matchNote(ifMatch)}`,
      verified: true,
    };
  }

  async stop(_ctx: SourceContext): Promise<void> {
    this.sightings.clear();
    this.started = false;
  }

  async health(ctx: SourceContext): Promise<HealthReport> {
    const checkedAt = ctx.now();
    try {
      const { dav, allow } = await this.client.options(ctx.signal);
      // `HEAD` is in the list for the destructive policies because the acknowledgement refuses
      // without it (see the header), and a share that will never consume anything should say so at
      // activation rather than at the first file that is ready to be filed away.
      const needed =
        this.policy.mode === 'move'
          ? ['PROPFIND', 'GET', 'HEAD', 'MOVE']
          : this.policy.mode === 'delete'
            ? ['PROPFIND', 'GET', 'HEAD', 'DELETE']
            : ['PROPFIND', 'GET'];
      const missing = allow.length === 0 ? [] : needed.filter((method) => !allow.includes(method));
      if (dav === null) {
        return {
          status: 'degraded',
          message: 'the endpoint answered OPTIONS without a DAV header; it may not be a WebDAV share',
          checkedAt,
        };
      }
      if (missing.length > 0) {
        return {
          status: 'degraded',
          message: `the share does not allow ${missing.join(', ')}, which the '${this.policy.mode}' policy needs`,
          checkedAt,
        };
      }
      return { status: 'ok', message: `DAV ${dav}`, checkedAt, detail: { allow, started: this.started } };
    } catch (error) {
      return {
        status: 'unavailable',
        message: error instanceof Error ? error.message : String(error),
        checkedAt,
      };
    }
  }

  /* ---------------------------------------------------------------------------------------- */

  private candidate(entry: WebDavEntry, ctx: SourceContext): IngestCandidate {
    const revision = revisionOf(entry);
    const ref: IngestRef = { sourceId: this.id, externalId: entry.path, revision };
    const metadata: JsonObject = {
      ...(this.options.sourceMetadata ?? {}),
      path: entry.path,
      collection: this.client.base.toString(),
      etag: entry.etag,
      byteSize: entry.byteSize,
      lastModified: entry.lastModified,
    };
    return {
      ref,
      sourceKind: this.sourceKind,
      suggestedFilename: basename(entry.path),
      ...(entry.contentType === null ? {} : { mediaType: entry.contentType.split(';')[0]?.trim() }),
      observedAt: entry.lastModified === null ? ctx.now() : isoOrNow(entry.lastModified, ctx),
      sourceMetadata: metadata,
      read: async () => (await this.fetch(ref, ctx)).bytes,
    };
  }

  /**
   * Compare the revision a candidate was offered under with what a `HEAD` says is there now.
   *
   * Null when they agree, and the sentence that says how they differ when they do not. The two
   * revision shapes are handled separately on purpose: an `etag:` revision is compared against the
   * ETag alone, because that is what an ETag is for, and a `mtime:` revision — a share that sends
   * no ETags — is compared against `Last-Modified` and the size, which is the weaker evidence the
   * fallback revision was built from in the first place. A candidate offered under an ETag against
   * a share that has stopped sending them is a refusal: the evidence got weaker between the poll
   * and the consume, and the consume is the destructive half.
   */
  private revisionDrift(
    offered: string | undefined,
    current: { etag: string | null; byteSize: number | null; lastModified: string | null },
  ): string | null {
    if (offered === undefined || offered === '') {
      // Consume is conditional on a revision, so no revision is no licence. Unreachable through
      // this source's own `poll` — `revisionOf` always produces one — but a ref also arrives from
      // the state table, and a row that lost its revision must not become permission to delete.
      return 'it was offered under no revision at all, so there is nothing to check it against';
    }

    if (offered.startsWith('etag:')) {
      const was = offered.slice('etag:'.length);
      if (current.etag === null) {
        return `it was offered under etag ${was} and the share no longer reports one`;
      }
      return current.etag === was
        ? null
        : `it was offered under etag ${was} and the share now holds ${current.etag}`;
    }

    if (offered.startsWith('mtime:')) {
      const now = `mtime:${current.lastModified ?? 'unknown'}:${String(current.byteSize ?? -1)}`;
      return offered === now ? null : `it was offered as '${offered}' and the share now holds '${now}'`;
    }

    return `the revision it was offered under ('${offered}') cannot be read as one`;
  }

  /** The share evaluated the precondition and refused. Not an error: the mechanism working. */
  private refuseStale(
    ctx: SourceContext,
    ref: IngestRef,
    outcome: IngestOutcome,
    path: string,
    method: string,
    ifMatch: string | null,
  ): Acknowledgement {
    const reason =
      `the share answered 412 to a conditional ${method} of '${path}' carrying ` +
      `If-Match: "${ifMatch ?? ''}"` +
      (method === 'MOVE'
        ? ', which means either that the object changed between the check and the request or ' +
          'that something arrived at the destination; either way the original was not touched'
        : ', so it changed between the check and the request');
    this.flagForReview(ctx, ref, outcome, reason);
    return { action: 'refused', detail: `the original was kept: ${reason}`, verified: false };
  }

  /**
   * Route a refusal to the review queue (P3).
   *
   * The subject is the document that *was* filed, because that is the library record an operator
   * can act from. Raising it must never turn a data-safe refusal into a throw, so a failure to
   * raise is logged and swallowed.
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
          `The '${this.policy.mode}' consume policy was refused for '${ref.externalId}' on ` +
          `'${this.client.base.toString()}' because ${reason}. Nothing was deleted or moved. The ` +
          'object will be offered again under its own revision on the next poll; this entry is ' +
          'here because a source that had to refuse is worth a person knowing about.',
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

  /** Null when the entry may be offered; a sentence when it may not, yet. */
  private settled(entry: WebDavEntry, revision: string): string | null {
    const quiet = this.options.stability?.quietMillis ?? 0;
    if (quiet > 0 && entry.lastModified !== null) {
      const modified = Date.parse(entry.lastModified);
      if (!Number.isNaN(modified)) {
        const age = Date.now() - modified;
        if (age >= 0 && age < quiet) {
          return `it was last modified ${String(age)} ms ago and the quiet period is ${String(quiet)} ms`;
        }
      }
    }

    if (this.options.stability?.requireSecondSighting === true) {
      const previous = this.sightings.get(entry.path);
      this.sightings.set(entry.path, { revision, seenAt: Date.now() });
      if (previous === undefined) return 'this is the first poll that has seen it; it is offered on the next one';
      if (previous.revision !== revision) {
        return `it changed between polls (${previous.revision} → ${revision}), so it is still being written`;
      }
    }
    return null;
  }

  private async moveTarget(path: string, ctx: SourceContext): Promise<string> {
    if (this.destination === null) {
      throw new SourceError('source_misconfigured', 'The consume policy is `move` with no destination.');
    }
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const collection = parent === '' ? this.destination : `${this.destination}/${parent}`;
    await this.client.ensureCollection(collection, ctx.signal);

    const name = basename(path);
    const extension = extname(name);
    const stem = name.slice(0, name.length - extension.length);
    const first = `${collection}/${name}`;

    const existing = new Set(
      (await this.client.list(collection, '1', ctx.signal)).map((entry) => entry.path),
    );
    if (!existing.has(first)) return first;

    for (let index = 2; index < 1_000; index += 1) {
      const attempt = `${collection}/${stem} (${String(index)})${extension}`;
      if (!existing.has(attempt)) return attempt;
    }
    throw new SourceError(
      'source_move_failed',
      `A thousand files are already called '${name}' in '${collection}'.`,
    );
  }

  /** An `externalId` is a path from a listing or a database row; it is checked, never trusted. */
  private checkPath(externalId: string): string {
    const segments = externalId.split('/');
    if (
      externalId.startsWith('/') ||
      segments.some((segment) => segment === '' || segment === '.' || segment === '..')
    ) {
      throw new UnsafeSourcePathError(
        `'${externalId}' is not a path inside the collection '${this.client.base.toString()}'.`,
        { externalId },
      );
    }
    return externalId;
  }

  private stateFor(ctx: SourceContext): SourceStateStore {
    this.state ??= sourceState(ctx.recueil);
    return this.state;
  }
}

/**
 * The reason code a refused acknowledgement raises (P3, `spec/data-model.md` §6.1).
 *
 * The same string the watched folder uses, because it is the same failure at network distance and
 * an operator filtering the queue should not have to know which source raised it.
 */
export const SOURCE_CHANGED_BEFORE_CONSUME = 'source_changed_before_consume';

/**
 * What the acknowledgement is allowed to claim about the precondition.
 *
 * A share that sends no ETag gets no `If-Match`, and the record must not read as though the far
 * side agreed to something it was never asked.
 */
const matchNote = (ifMatch: string | null): string =>
  ifMatch === null
    ? ' (the share sends no ETag, so the request carried no precondition and the check before it ' +
      'is the only evidence)'
    : ` (conditional on If-Match: "${ifMatch}")`;

/** The `(path, etag, size)` key of §5.3, as a revision string. */
const revisionOf = (entry: WebDavEntry): string =>
  entry.etag !== null
    ? `etag:${entry.etag}`
    : `mtime:${entry.lastModified ?? 'unknown'}:${String(entry.byteSize ?? -1)}`;

const isUnder = (path: string, prefix: string): boolean =>
  path === prefix || path.startsWith(`${prefix}/`);

const isoOrNow = (value: string, ctx: SourceContext): string => {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? ctx.now() : new Date(parsed).toISOString();
};
