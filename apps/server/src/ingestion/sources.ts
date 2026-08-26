/**
 * Configured ingestion sources: the rows, the safety checks on the way in, and the live objects.
 *
 * Three jobs, deliberately in one place because they share the same distrust of what arrives.
 *
 * **A root is hostile until it has been resolved.** `config.root` on a folder source is a path from
 * a request body. It is resolved, `realpath`'d — so a symlink cannot point somewhere the allow-list
 * would have refused — required to be an existing directory, and, when `RECUEIL_INGEST_ALLOWED_ROOTS`
 * is set, required to be inside one of those roots. The consume destination is checked the same way
 * and additionally required to stay inside the root, because "move the original to `../../etc`" is
 * a sentence a configuration form should not be able to express.
 *
 * **A credential never comes back.** `toWire` has no path to the plaintext; `secretNames` is read
 * from its own column, so listing sources needs no key at all. A server with no `RECUEIL_SECRET_KEY`
 * can still hold and list a source that needs no credential.
 *
 * **A URL is an address, never a credential.** `https://user:pass@host/dav/` is the form a great
 * many people paste, and `z.url()` accepts it happily. Left alone the password is stored in
 * cleartext in `ingestion_sources.config`, returned verbatim by `GET /ingestion/sources`, and
 * interpolated into every error a WebDAV client raises — the Phase 2 review got it back twice in
 * one `test-connection` body. So the userinfo is split off at ingress, before anything is stored:
 * the address goes into `config.url` and the secret goes into the same AES-256-GCM box as every
 * other credential. `sourceToWire` strips it again on the way out, because a row written by an
 * older build is a real possibility, and `redactFor` scrubs the stored plaintext out of every
 * `detail`, log line and `last_error` this service produces. Three layers, because a credential
 * that escapes once is a credential that has to be rotated.
 *
 * **Where the server may connect is not the caller's decision.** A source URL comes out of a
 * request body, so an unrestricted one makes the server a proxy into its own loopback interface and
 * its operator's network — the review reached a metadata endpoint on `127.0.0.1` and got the
 * response body back in a check `detail`. `EgressGuard` (see `egress.ts`) refuses loopback,
 * link-local, unique-local, multicast and private ranges, at the socket rather than at the form, so
 * a name that rebinds between the two gains nothing. `RECUEIL_INGEST_ALLOW_PRIVATE_TARGETS=true` is
 * the operator's opt-in for a NAS that really is on 192.168.1.x.
 *
 * **A test is a set of checks, not an opinion.** `testConnection` returns each thing it tried with
 * what happened, and `ok` is the conjunction of those rows. A caller is never told "connected" by
 * something that only constructed a client object.
 */
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { ConflictError, NotFoundError, ValidationError, newId, nowTimestamp } from '@recueil/core';
import type { Actor, DocumentSourceKind, Recueil } from '@recueil/core';
import { FolderSource, ImapClient, ImapSource, WebDavClient, WebDavSource } from '@recueil/ingest-sources';
import type { ConsumePolicy, IngestSource } from '@recueil/ingest-sources';
import { and, asc, eq } from 'drizzle-orm';
import * as z from 'zod';

import { EgressGuard } from './egress.js';
import type { HostResolver } from './egress.js';
import { SecretBox, SecretsUnavailableError } from './secrets.js';
import { ingestionSources } from './tables.js';
import type { IngestionSourceRow } from './tables.js';
import type {
  IngestionSourceConfigSchema,
  IngestionSourceCreateSchema,
  IngestionSourceUpdateSchema,
} from '../schemas-ingestion.js';

export type SourceConfig = z.infer<typeof IngestionSourceConfigSchema>;
export type SourceCreate = z.infer<typeof IngestionSourceCreateSchema>;
export type SourceUpdate = z.infer<typeof IngestionSourceUpdateSchema>;

export interface ConnectionCheck {
  readonly check: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface SourceServiceOptions {
  readonly recueil: Recueil;
  readonly secrets: SecretBox;
  /** Absolute directories a folder source may watch. Empty means no allow-list is configured. */
  readonly allowedRoots: readonly string[];
  /** Swapped by the tests, so a WebDAV check can run against an in-process fake. */
  readonly fetch?: typeof fetch;
  /**
   * `RECUEIL_INGEST_ALLOW_PRIVATE_TARGETS`. Off unless the operator says otherwise, which is what
   * makes "point the server at 127.0.0.1" a refusal rather than a feature.
   */
  readonly allowPrivateTargets?: boolean;
  /** Swapped by the test that stages a DNS rebinding without owning a domain. */
  readonly resolve?: HostResolver;
}

/** The wire shape, assembled without ever touching the ciphertext. */
export interface SourceWire {
  id: string;
  name: string;
  kind: IngestionSourceRow['kind'];
  enabled: boolean;
  sourceKind: DocumentSourceKind;
  config: SourceConfig;
  consume: { mode: 'leave' | 'move' | 'delete'; to?: string };
  secretNames: string[];
  lastRunJobId: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

const DEFAULT_SOURCE_KIND: Record<IngestionSourceRow['kind'], DocumentSourceKind> = {
  folder: 'folder',
  webdav: 'webdav',
  imap: 'imap',
};

export class IngestionSourceService {
  private readonly recueil: Recueil;

  private readonly secrets: SecretBox;

  private readonly allowedRoots: readonly string[];

  /**
   * The one way out of this process.
   *
   * Every WebDAV request this service makes goes through `egress.fetch`, including the ones a test
   * points at an in-process fake, so there is no configuration in which the address rule is not
   * running. `fetch` is not held separately: a second reference to the unguarded one would be a
   * second way out.
   */
  private readonly egress: EgressGuard;

  constructor(options: SourceServiceOptions) {
    this.recueil = options.recueil;
    this.secrets = options.secrets;
    this.allowedRoots = options.allowedRoots;
    this.egress = new EgressGuard({
      allowPrivateTargets: options.allowPrivateTargets ?? allowPrivateTargetsFromEnvironment(),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.resolve === undefined ? {} : { resolve: options.resolve }),
    });
  }

  /* ---- reading ----------------------------------------------------------------------------- */

  list(filter: { kind?: IngestionSourceRow['kind']; enabled?: boolean } = {}): IngestionSourceRow[] {
    const clauses = [];
    if (filter.kind !== undefined) clauses.push(eq(ingestionSources.kind, filter.kind));
    if (filter.enabled !== undefined) clauses.push(eq(ingestionSources.enabled, filter.enabled));
    const query = this.recueil.db.select().from(ingestionSources);
    const filtered = clauses.length === 0 ? query : query.where(and(...clauses));
    return filtered.orderBy(asc(ingestionSources.name)).all();
  }

  get(id: string): IngestionSourceRow {
    const row = this.recueil.db.select().from(ingestionSources).where(eq(ingestionSources.id, id)).get();
    if (row === undefined) throw new NotFoundError('ingestion source', id);
    return row;
  }

  /* ---- writing ------------------------------------------------------------------------------ */

  async create(input: SourceCreate, actor: Actor): Promise<IngestionSourceRow> {
    const checked = await this.checkConfig(input.config);
    const config = checked.config;
    const consume = await this.checkConsume(config, input.consume);
    this.assertNameFree(input.name, null);

    const secret = this.sealSecret(
      mergeUrlCredentials(input.secret, checked.urlCredentials),
      input.config.kind,
    );
    const now = nowTimestamp();
    const row: IngestionSourceRow = {
      id: newId(),
      name: input.name.trim(),
      kind: config.kind,
      enabled: input.enabled ?? true,
      sourceKind: input.sourceKind ?? DEFAULT_SOURCE_KIND[config.kind],
      config: JSON.stringify(config),
      secretCiphertext: secret.ciphertext,
      secretNames: JSON.stringify(secret.names),
      consumeMode: consume.mode,
      consumeTo: consume.to ?? null,
      lastRunJobId: null,
      lastRunAt: null,
      lastError: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };

    this.recueil.db.transaction((tx) => {
      tx.insert(ingestionSources).values(row).run();
      this.recueil.audit.record(
        {
          actor,
          action: 'ingestion_source.created',
          entityType: 'ingestion_source',
          entityId: row.id,
          after: { name: row.name, kind: row.kind, sourceKind: row.sourceKind, secretNames: secret.names },
          reason: `configured a ${row.kind} source`,
        },
        tx,
      );
    });

    return row;
  }

  async update(id: string, input: SourceUpdate, actor: Actor): Promise<IngestionSourceRow> {
    const existing = this.get(id);
    if (input.config !== undefined && input.config.kind !== existing.kind) {
      throw new ConflictError(
        `Source '${id}' is a ${existing.kind} source and cannot become a ${input.config.kind} one. ` +
          'Create a new source instead: the state table keyed by the old one would be meaningless.',
        { sourceId: id, kind: existing.kind },
      );
    }

    const checked =
      input.config === undefined
        ? { config: this.configOf(existing), urlCredentials: null }
        : await this.checkConfig(input.config);
    const config = checked.config;
    const consume =
      input.consume === undefined
        ? { mode: existing.consumeMode, ...(existing.consumeTo === null ? {} : { to: existing.consumeTo }) }
        : await this.checkConsume(config, input.consume);
    if (input.name !== undefined) this.assertNameFree(input.name, id);

    // A password that arrived in the URL is a password the caller supplied, so it seals like any
    // other. Where neither an explicit secret nor a URL carried one, the stored ciphertext stands.
    const supplied = mergeUrlCredentials(input.secret, checked.urlCredentials);
    const secret =
      supplied === undefined
        ? { ciphertext: existing.secretCiphertext, names: JSON.parse(existing.secretNames) as string[] }
        : this.sealSecret(supplied, existing.kind);

    const now = nowTimestamp();
    const patch = {
      name: input.name === undefined ? existing.name : input.name.trim(),
      enabled: input.enabled ?? existing.enabled,
      sourceKind: input.sourceKind ?? existing.sourceKind,
      config: JSON.stringify(config),
      secretCiphertext: secret.ciphertext,
      secretNames: JSON.stringify(secret.names),
      consumeMode: consume.mode,
      consumeTo: consume.to ?? null,
      version: existing.version + 1,
      updatedAt: now,
    };

    this.recueil.db.transaction((tx) => {
      tx.update(ingestionSources).set(patch).where(eq(ingestionSources.id, id)).run();
      this.recueil.audit.record(
        {
          actor,
          action: 'ingestion_source.updated',
          entityType: 'ingestion_source',
          entityId: id,
          before: { name: existing.name, enabled: existing.enabled, consumeMode: existing.consumeMode },
          after: { name: patch.name, enabled: patch.enabled, consumeMode: patch.consumeMode, secretNames: secret.names },
        },
        tx,
      );
    });

    return { ...existing, ...patch };
  }

  setEnabled(id: string, enabled: boolean, actor: Actor): IngestionSourceRow {
    const existing = this.get(id);
    if (existing.enabled === enabled) return existing;

    const patch = { enabled, version: existing.version + 1, updatedAt: nowTimestamp() };
    this.recueil.db.transaction((tx) => {
      tx.update(ingestionSources).set(patch).where(eq(ingestionSources.id, id)).run();
      this.recueil.audit.record(
        {
          actor,
          action: enabled ? 'ingestion_source.enabled' : 'ingestion_source.disabled',
          entityType: 'ingestion_source',
          entityId: id,
          before: { enabled: existing.enabled },
          after: { enabled },
        },
        tx,
      );
    });
    return { ...existing, ...patch };
  }

  /**
   * Remove a source.
   *
   * A real delete rather than a trash row, and the exception to P5 is deliberate and bounded: a
   * source is configuration, not library content, and nothing it produced is touched — the
   * documents, items and `source_state` rows it created all survive it. The audit entry carries the
   * whole row as `before`, so the configuration is recoverable from the log.
   */
  remove(id: string, actor: Actor): void {
    const existing = this.get(id);
    this.recueil.db.transaction((tx) => {
      tx.delete(ingestionSources).where(eq(ingestionSources.id, id)).run();
      this.recueil.audit.record(
        {
          actor,
          action: 'ingestion_source.removed',
          entityType: 'ingestion_source',
          entityId: id,
          // The ciphertext is deliberately not copied into the log: the log is the artefact most
          // likely to be exported, and an audit row is not a backup of a credential. `configOf`
          // for the same reason — a legacy row's URL may carry one, and an audit row that
          // preserves it outlives the source it was removed with.
          before: {
            name: existing.name,
            kind: existing.kind,
            sourceKind: existing.sourceKind,
            config: this.configOf(existing) as unknown,
            consumeMode: existing.consumeMode,
            consumeTo: existing.consumeTo,
            secretNames: JSON.parse(existing.secretNames) as unknown,
          },
          reason: 'the source configuration was removed; nothing it ingested was touched',
        },
        tx,
      );
    });
  }

  /**
   * Record the outcome of a run against the source, so the list view can show it.
   *
   * `last_error` is a stored, API-visible copy of an exception message from somewhere below this
   * package, so it is redacted before it is written rather than before it is read: a secret in a
   * column is a secret in every backup of that column.
   */
  recordRun(id: string, outcome: { jobId: string; at: string; error?: string }): void {
    const error =
      outcome.error === undefined ? null : this.redactFor(this.get(id), outcome.error);
    this.recueil.db
      .update(ingestionSources)
      .set({
        lastRunJobId: outcome.jobId,
        lastRunAt: outcome.at,
        lastError: error,
        updatedAt: nowTimestamp(),
      })
      .where(eq(ingestionSources.id, id))
      .run();
  }

  /* ---- the live object ----------------------------------------------------------------------- */

  /**
   * Build the `IngestSource` this row describes.
   *
   * The secrets are opened here and nowhere else, and the object is not cached: a source holds a
   * socket and a state cursor, and handing two runs the same one would have them fight over both.
   */
  buildSource(row: IngestionSourceRow): IngestSource {
    const config = this.configOf(row);
    const secrets = this.openSecret(row);
    const consume: ConsumePolicy =
      row.consumeMode === 'move'
        ? { mode: 'move', to: row.consumeTo ?? '.processed' }
        : row.consumeMode === 'delete'
          ? { mode: 'delete' }
          : { mode: 'leave' };

    // The column is `TEXT`; the contract narrows it to `DocumentSourceKind` on the way in, so
    // every value that reaches here came through that enum.
    const common = { id: row.id, sourceKind: row.sourceKind as DocumentSourceKind, consume };

    if (config.kind === 'folder') {
      return new FolderSource({
        ...common,
        root: config.root,
        ...(config.recursive === undefined ? {} : { recursive: config.recursive }),
        ...(config.skipHidden === undefined ? {} : { skipHidden: config.skipHidden }),
        ...(config.exclude === undefined ? {} : { exclude: config.exclude }),
        ...(config.minimumAgeMillis === undefined
          ? {}
          : { stability: { quietMillis: config.minimumAgeMillis } }),
        ...(config.watch === undefined ? {} : { watch: { enabled: config.watch } }),
      });
    }

    if (config.kind === 'webdav') {
      return new WebDavSource({
        ...common,
        url: config.url,
        auth: webDavAuth(config.authKind, config.username, secrets),
        ...(config.recursive === undefined ? {} : { recursive: config.recursive }),
        ...(config.maxDepth === undefined ? {} : { maxDepth: config.maxDepth }),
        ...(config.timeoutMillis === undefined ? {} : { timeoutMillis: config.timeoutMillis }),
        // Always the guarded one. A poll runs unattended, hours after the configuration was
        // checked, which is exactly when a rebind pays.
        fetch: this.egress.fetch,
      });
    }

    return new ImapSource({
      ...common,
      host: config.host,
      username: config.username,
      password: secrets['password'] ?? '',
      ...(config.port === undefined ? {} : { port: config.port }),
      ...(config.secure === undefined ? {} : { secure: config.secure }),
      ...(config.mailbox === undefined ? {} : { mailbox: config.mailbox }),
      ...(config.search === undefined ? {} : { search: config.search }),
      ...(config.markSeen === undefined ? {} : { markSeen: config.markSeen }),
      ...(config.batchSize === undefined ? {} : { batchSize: config.batchSize }),
      ...(config.timeoutMillis === undefined ? {} : { timeoutMillis: config.timeoutMillis }),
    });
  }

  /* ---- the connection test -------------------------------------------------------------------- */

  /**
   * Try the source, and report each thing that was tried.
   *
   * Every branch below reaches the far side: the folder check `stat`s and reads the directory, the
   * WebDAV check issues an `OPTIONS` and a `PROPFIND`, the IMAP check connects, logs in and selects
   * the mailbox. A check that only inspected the stored configuration would pass on a server that
   * has been switched off, which makes it worse than no check.
   */
  async testConnection(row: IngestionSourceRow, signal?: AbortSignal): Promise<ConnectionCheck[]> {
    const config = this.configOf(row);
    const checks =
      config.kind === 'folder'
        ? await this.testFolder(config.root, row.consumeTo)
        : config.kind === 'webdav'
          ? await this.testWebDav(row, config, signal)
          : await this.testImap(row, config);
    // One place, on the way out, rather than at each of the fourteen sites that build a `detail`:
    // a redaction that has to be remembered is a redaction that will be forgotten.
    return checks.map((check) => ({ ...check, detail: this.redactFor(row, check.detail) }));
  }

  private async testFolder(root: string, consumeTo: string | null): Promise<ConnectionCheck[]> {
    const checks: ConnectionCheck[] = [];
    let resolved: string;
    try {
      resolved = await this.resolveRoot(root);
      checks.push({ check: 'resolve', ok: true, detail: `resolves to '${resolved}'` });
    } catch (error) {
      return [{ check: 'resolve', ok: false, detail: describe(error) }];
    }

    try {
      const info = await stat(resolved);
      checks.push({
        check: 'directory',
        ok: info.isDirectory(),
        detail: info.isDirectory() ? 'is a directory' : 'exists but is not a directory',
      });
    } catch (error) {
      checks.push({ check: 'directory', ok: false, detail: describe(error) });
      return checks;
    }

    try {
      const { readdir } = await import('node:fs/promises');
      const entries = await readdir(resolved);
      checks.push({ check: 'read', ok: true, detail: `readable; ${String(entries.length)} entr(y|ies) present` });
    } catch (error) {
      checks.push({ check: 'read', ok: false, detail: describe(error) });
    }

    if (consumeTo !== null) {
      try {
        const destination = this.resolveInside(resolved, consumeTo);
        checks.push({ check: 'consume_destination', ok: true, detail: `'${destination}' is inside the root` });
      } catch (error) {
        checks.push({ check: 'consume_destination', ok: false, detail: describe(error) });
      }
    }

    return checks;
  }

  private async testWebDav(
    row: IngestionSourceRow,
    config: Extract<SourceConfig, { kind: 'webdav' }>,
    signal?: AbortSignal,
  ): Promise<ConnectionCheck[]> {
    const checks: ConnectionCheck[] = [];
    let secrets: Record<string, string>;
    try {
      secrets = this.openSecret(row);
    } catch (error) {
      return [{ check: 'credentials', ok: false, detail: describe(error) }];
    }

    const client = new WebDavClient({
      url: config.url,
      auth: webDavAuth(config.authKind, config.username, secrets),
      ...(config.timeoutMillis === undefined ? {} : { timeoutMillis: config.timeoutMillis }),
      fetch: this.egress.fetch,
    });

    try {
      const capabilities = await client.options(signal);
      checks.push({
        check: 'options',
        ok: capabilities.dav !== null,
        detail:
          capabilities.dav === null
            ? 'the server answered OPTIONS without a DAV header, so it is not a WebDAV collection'
            : `DAV: ${capabilities.dav}`,
      });
    } catch (error) {
      checks.push({ check: 'options', ok: false, detail: describe(error) });
      return checks;
    }

    try {
      const entries = await client.list('', '1', signal);
      checks.push({
        check: 'list',
        ok: true,
        detail: `PROPFIND returned ${String(entries.length)} entr(y|ies)`,
      });
    } catch (error) {
      checks.push({ check: 'list', ok: false, detail: describe(error) });
    }

    return checks;
  }

  private async testImap(
    row: IngestionSourceRow,
    config: Extract<SourceConfig, { kind: 'imap' }>,
  ): Promise<ConnectionCheck[]> {
    const checks: ConnectionCheck[] = [];
    let secrets: Record<string, string>;
    try {
      secrets = this.openSecret(row);
    } catch (error) {
      return [{ check: 'credentials', ok: false, detail: describe(error) }];
    }
    if (secrets['password'] === undefined) {
      return [{ check: 'credentials', ok: false, detail: 'no password is stored for this mailbox' }];
    }

    const client = new ImapClient({
      host: config.host,
      username: config.username,
      password: secrets['password'],
      ...(config.port === undefined ? {} : { port: config.port }),
      ...(config.secure === undefined ? {} : { secure: config.secure }),
      ...(config.timeoutMillis === undefined ? {} : { timeoutMillis: config.timeoutMillis }),
    });

    try {
      await client.connect();
      checks.push({ check: 'connect', ok: true, detail: `connected to ${config.host}` });
    } catch (error) {
      return [{ check: 'connect', ok: false, detail: describe(error) }];
    }

    // Login and SELECT are checked separately, and not because it reads better. A single `try`
    // around both reports a mailbox that is not there as a failed *login*, which sends an operator
    // to reset a password that was never wrong. A check names the step that failed or it is not
    // evidence.
    try {
      await client.login();
      checks.push({ check: 'login', ok: true, detail: `authenticated as ${config.username}` });
    } catch (error) {
      checks.push({ check: 'login', ok: false, detail: describe(error) });
      await client.logout().catch(() => undefined);
      return checks;
    }

    const mailbox = config.mailbox ?? 'INBOX';
    try {
      const status = await client.select(mailbox);
      checks.push({
        check: 'select',
        ok: true,
        detail: `mailbox '${status.mailbox}' holds ${String(status.exists)} message(s)`,
      });
    } catch (error) {
      checks.push({ check: 'select', ok: false, detail: describe(error) });
    } finally {
      await client.logout().catch(() => undefined);
    }

    return checks;
  }

  /* ---- validation --------------------------------------------------------------------------- */

  /** Resolve, follow symlinks and check the allow-list. Throws a `ValidationError` on refusal. */
  async resolveRoot(root: string): Promise<string> {
    if (!isAbsolute(root)) {
      throw new ValidationError(
        `The watched folder must be an absolute path; '${root}' is relative and would move with ` +
          "the server process's working directory.",
        { path: 'config.root' },
      );
    }

    const resolved = resolve(root);
    let real: string;
    try {
      // `realpath` before the allow-list check, not after: a symlink inside an allowed root that
      // points outside it must be refused, and the only way to see that is to follow it.
      real = await realpath(resolved);
    } catch (error) {
      throw new ValidationError(
        `The watched folder '${resolved}' cannot be resolved: ${describe(error)}`,
        { path: 'config.root' },
      );
    }

    if (this.allowedRoots.length > 0 && !this.allowedRoots.some((allowed) => isInside(allowed, real))) {
      throw new ValidationError(
        `'${real}' is not inside any directory named by RECUEIL_INGEST_ALLOWED_ROOTS ` +
          `(${this.allowedRoots.join(', ')}).`,
        { path: 'config.root' },
      );
    }

    return real;
  }

  /** A consume destination, resolved against the root and refused if it escapes. */
  resolveInside(root: string, destination: string): string {
    if (isAbsolute(destination)) {
      throw new ValidationError(
        `The consume destination must be relative to the source root; '${destination}' is absolute.`,
        { path: 'consume.to' },
      );
    }
    const resolved = resolve(root, destination);
    if (!isInside(root, resolved)) {
      throw new ValidationError(
        `The consume destination '${destination}' resolves to '${resolved}', which is outside the ` +
          `source root '${root}'.`,
        { path: 'consume.to' },
      );
    }
    return resolved;
  }

  /**
   * Everything that has to be true of a configuration before it is written down.
   *
   * Returns the credentials it took out of the URL rather than storing them itself, because the
   * only correct place for them is the same sealed box every other credential lives in and this
   * method has no business writing rows.
   */
  private async checkConfig(
    config: SourceConfig,
  ): Promise<{ config: SourceConfig; urlCredentials: UrlCredentials | null }> {
    if (config.kind === 'folder') {
      const real = await this.resolveRoot(config.root);
      const info = await stat(real);
      if (!info.isDirectory()) {
        throw new ValidationError(`'${real}' is not a directory.`, { path: 'config.root' });
      }
      return { config: { ...config, root: real }, urlCredentials: null };
    }

    if (config.kind === 'webdav') {
      let split: { url: URL; credentials: UrlCredentials | null };
      try {
        split = splitUserinfo(config.url);
      } catch {
        throw new ValidationError(`'${config.url}' is not a URL.`, { path: 'config.url' });
      }
      if (split.url.protocol !== 'http:' && split.url.protocol !== 'https:') {
        throw new ValidationError(
          `A WebDAV collection must be http or https; '${split.url.protocol}' is neither.`,
          { path: 'config.url' },
        );
      }
      // The address, never the string that was sent: nothing downstream should have to remember
      // that `config.url` might still carry a password.
      await this.egress.checkAtConfigTime(split.url.toString(), 'config.url');
      return {
        config: {
          ...config,
          url: split.url.toString(),
          ...(split.credentials === null || config.username !== undefined
            ? {}
            : { username: split.credentials.username, authKind: 'basic' as const }),
        },
        urlCredentials: split.credentials,
      };
    }

    return { config, urlCredentials: null };
  }

  private async checkConsume(
    config: SourceConfig,
    consume: SourceCreate['consume'],
  ): Promise<{ mode: 'leave' | 'move' | 'delete'; to?: string }> {
    if (consume === undefined) return { mode: 'leave' };
    if (consume.mode !== 'move') return { mode: consume.mode };

    const to = (consume.to ?? '').trim();
    if (to === '') {
      throw new ValidationError("The 'move' consume policy needs a destination.", { path: 'consume.to' });
    }
    if (config.kind === 'folder') {
      // Checked now, against the resolved root, so a destination that escapes is refused at
      // configuration time rather than discovered by the first file that moves.
      this.resolveInside(config.root, to);
    }
    return { mode: 'move', to };
  }

  private assertNameFree(name: string, exceptId: string | null): void {
    const clash = this.recueil.db
      .select()
      .from(ingestionSources)
      .where(eq(ingestionSources.name, name.trim()))
      .get();
    if (clash !== undefined && clash.id !== exceptId) {
      throw new ConflictError(`An ingestion source named '${name.trim()}' already exists.`, {
        name: name.trim(),
        sourceId: clash.id,
      });
    }
  }

  private sealSecret(
    secret: SourceCreate['secret'],
    kind: IngestionSourceRow['kind'],
  ): { ciphertext: string | null; names: string[] } {
    const entries = Object.entries(secret ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '',
    );
    if (entries.length === 0) return { ciphertext: null, names: [] };

    if (kind === 'folder') {
      throw new ValidationError('A watched folder has no credential to store.', { path: 'secret' });
    }
    if (!this.secrets.available) {
      throw new ConflictError(
        'This server has no RECUEIL_SECRET_KEY, so it will not store a credential. Set one — ' +
          '`openssl rand -base64 32` — and restart.',
        { variable: 'RECUEIL_SECRET_KEY' },
      );
    }

    return {
      ciphertext: this.secrets.seal(Object.fromEntries(entries)),
      names: entries.map(([name]) => name).sort(),
    };
  }

  /**
   * The stored configuration, with any userinfo an older build wrote taken back off the URL.
   *
   * Every read of `row.config` in this class goes through here. A row written before the ingress
   * split existed still carries `https://user:pass@host/dav/`, and the guarantee "a credential
   * never comes back" has to hold for those rows too — not only for the ones created since.
   */
  configOf(row: IngestionSourceRow): SourceConfig {
    return sanitiseConfig(JSON.parse(row.config) as SourceConfig);
  }

  /**
   * Take this source's stored secrets out of a string that is about to leave the process.
   *
   * The point is not that any particular message is known to carry one. It is that a `detail`, a
   * job log line and a `last_error` are all assembled from an exception raised somewhere below
   * this package, and "does that library interpolate the password" is not a question this service
   * can keep answering correctly as the libraries change. So it answers it once, here, on the way
   * out. A secret too short to be distinguishable from ordinary prose is left alone: redacting
   * every `a` would destroy the message and protect nothing.
   */
  redactFor(row: IngestionSourceRow, text: string): string {
    let secrets: Record<string, string>;
    try {
      secrets = this.openSecret(row);
    } catch {
      // No key, so no plaintext — and equally, nothing below could have interpolated one.
      return text;
    }
    return redact(text, Object.values(secrets));
  }

  private openSecret(row: IngestionSourceRow): Record<string, string> {
    if (row.secretCiphertext === null) return {};
    if (!this.secrets.available) {
      throw new SecretsUnavailableError(
        `Source '${row.name}' holds a credential and this server has no RECUEIL_SECRET_KEY to ` +
          'decrypt it with.',
      );
    }
    return this.secrets.open(row.secretCiphertext);
  }
}

/**
 * The wire shape. Takes the row and nothing else, so there is no path to a plaintext secret.
 *
 * "No path to the ciphertext" was never quite the same as "no path to a credential": the `url`
 * field was outside that guarantee until the ingress split, and a row written by an older build
 * still carries whatever was pasted into it. `sanitiseConfig` is therefore applied here as well as
 * at ingress — this function is the last thing between the row and the response body.
 */
export const sourceToWire = (row: IngestionSourceRow): SourceWire => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  enabled: row.enabled,
  sourceKind: row.sourceKind as DocumentSourceKind,
  config: sanitiseConfig(JSON.parse(row.config) as SourceConfig),
  consume: {
    mode: row.consumeMode,
    ...(row.consumeTo === null ? {} : { to: row.consumeTo }),
  },
  secretNames: JSON.parse(row.secretNames) as string[],
  lastRunJobId: row.lastRunJobId,
  lastRunAt: row.lastRunAt,
  lastError: row.lastError,
  version: row.version,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const webDavAuth = (
  kind: 'basic' | 'bearer' | 'none' | undefined,
  username: string | undefined,
  secrets: Record<string, string>,
): { kind: 'basic' | 'bearer' | 'none'; username?: string; password?: string; token?: string } => {
  const resolved =
    kind ?? (secrets['token'] !== undefined ? 'bearer' : username !== undefined ? 'basic' : 'none');
  if (resolved === 'bearer') {
    return { kind: 'bearer', ...(secrets['token'] === undefined ? {} : { token: secrets['token'] }) };
  }
  if (resolved === 'basic') {
    return {
      kind: 'basic',
      ...(username === undefined ? {} : { username }),
      ...(secrets['password'] === undefined ? {} : { password: secrets['password'] }),
    };
  }
  return { kind: 'none' };
};

/** True when `candidate` is `root` itself or lies beneath it. Both must already be resolved. */
export const isInside = (root: string, candidate: string): boolean => {
  if (candidate === root) return true;
  const rel = relative(root, candidate);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..');
};

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/* -------------------------------------------------------------------------------------------- */
/* Credentials that arrived somewhere they should not have                                         */
/* -------------------------------------------------------------------------------------------- */

/** What a `user:pass@` prefix carried, decoded. */
export interface UrlCredentials {
  readonly username: string;
  readonly password: string;
}

/**
 * Split a URL into the part that may be stored and the part that may not.
 *
 * `URL` keeps userinfo percent-encoded — a password with an `@` or a `:` in it has to be written
 * that way — so it is decoded here rather than passed on as typed. `WebDavClient` makes the same
 * split for its own protection; this one exists because the decision has to be made *before* a row
 * is written, and a client the row is built from is too late.
 */
export const splitUserinfo = (raw: string): { url: URL; credentials: UrlCredentials | null } => {
  const url = new URL(raw);
  if (url.username === '' && url.password === '') return { url, credentials: null };
  const credentials: UrlCredentials = {
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
  url.username = '';
  url.password = '';
  return { url, credentials };
};

/** Strip userinfo from whatever address a stored configuration carries. */
export const sanitiseConfig = (config: SourceConfig): SourceConfig => {
  if (config.kind !== 'webdav') return config;
  try {
    return { ...config, url: splitUserinfo(config.url).url.toString() };
  } catch {
    // Not a URL at all. Returning it unchanged is right: it holds no credential to leak, and a
    // configuration this service cannot parse is something the operator has to be able to see.
    return config;
  }
};

/**
 * Fold a password taken out of a URL into the secret the caller sent, without overwriting one.
 *
 * An explicit `secret.password` wins: somebody who filled in both fields meant the field, and
 * silently preferring the one they pasted into the address bar would be a surprising place to lose
 * a credential.
 */
const mergeUrlCredentials = (
  secret: SourceCreate['secret'],
  credentials: UrlCredentials | null,
): SourceCreate['secret'] => {
  if (credentials === null || credentials.password === '') return secret;
  if (secret?.['password'] !== undefined && secret['password'] !== '') return secret;
  return { ...(secret ?? {}), password: credentials.password };
};

/**
 * Replace every occurrence of a stored secret, in the forms it plausibly travels in.
 *
 * Two forms per secret: itself, and percent-encoded, which is how it looks once something has put
 * it back into a URL. Anything shorter than three characters is left alone — see `redactFor`.
 *
 * Plus one form that belongs to no particular secret: an `Authorization` header value. Basic
 * carries `base64(user:pass)`, so the password is in there but the *password* is not the string to
 * search for, and Bearer carries a token this service may not even hold. Both are scrubbed
 * wholesale by shape, because there is no case in which the correct thing to do with a credential
 * header quoted back inside an exception is to print it.
 */
export const redact = (text: string, secrets: readonly string[]): string => {
  let out = text.replace(/\b(Basic|Bearer)\s+[\w+/=._~-]+/giu, '$1 [redacted]');
  for (const secret of secrets) {
    if (secret.length < 3) continue;
    for (const form of [secret, encodeURIComponent(secret)]) {
      out = out.split(form).join('[redacted]');
    }
  }
  return out;
};

/**
 * The operator's opt-in for deliberately internal targets, read where an operator sets it.
 *
 * Read at construction rather than per request: this is a property of the deployment, and a value
 * that could change between the check and the connection would be one more thing to race.
 */
const allowPrivateTargetsFromEnvironment = (): boolean => {
  const raw = (process.env['RECUEIL_INGEST_ALLOW_PRIVATE_TARGETS'] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
};
