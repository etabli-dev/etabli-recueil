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

  private readonly fetchImpl: typeof fetch | undefined;

  constructor(options: SourceServiceOptions) {
    this.recueil = options.recueil;
    this.secrets = options.secrets;
    this.allowedRoots = options.allowedRoots;
    this.fetchImpl = options.fetch;
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
    const config = await this.checkConfig(input.config);
    const consume = await this.checkConsume(config, input.consume);
    this.assertNameFree(input.name, null);

    const secret = this.sealSecret(input.secret, input.config.kind);
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

    const config =
      input.config === undefined
        ? (JSON.parse(existing.config) as SourceConfig)
        : await this.checkConfig(input.config);
    const consume =
      input.consume === undefined
        ? { mode: existing.consumeMode, ...(existing.consumeTo === null ? {} : { to: existing.consumeTo }) }
        : await this.checkConsume(config, input.consume);
    if (input.name !== undefined) this.assertNameFree(input.name, id);

    const secret =
      input.secret === undefined
        ? { ciphertext: existing.secretCiphertext, names: JSON.parse(existing.secretNames) as string[] }
        : this.sealSecret(input.secret, existing.kind);

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
          // likely to be exported, and an audit row is not a backup of a credential.
          before: {
            name: existing.name,
            kind: existing.kind,
            sourceKind: existing.sourceKind,
            config: JSON.parse(existing.config) as unknown,
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

  /** Record the outcome of a run against the source, so the list view can show it. */
  recordRun(id: string, outcome: { jobId: string; at: string; error?: string }): void {
    this.recueil.db
      .update(ingestionSources)
      .set({
        lastRunJobId: outcome.jobId,
        lastRunAt: outcome.at,
        lastError: outcome.error ?? null,
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
    const config = JSON.parse(row.config) as SourceConfig;
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
        ...(this.fetchImpl === undefined ? {} : { fetch: this.fetchImpl }),
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
    const config = JSON.parse(row.config) as SourceConfig;
    if (config.kind === 'folder') return this.testFolder(config.root, row.consumeTo);
    if (config.kind === 'webdav') return this.testWebDav(row, config, signal);
    return this.testImap(row, config);
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
      ...(this.fetchImpl === undefined ? {} : { fetch: this.fetchImpl }),
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

    try {
      await client.login();
      checks.push({ check: 'login', ok: true, detail: `authenticated as ${config.username}` });

      const status = await client.select(config.mailbox ?? 'INBOX');
      checks.push({
        check: 'select',
        ok: true,
        detail: `mailbox '${status.mailbox}' holds ${String(status.exists)} message(s)`,
      });
    } catch (error) {
      checks.push({ check: 'login', ok: false, detail: describe(error) });
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

  private async checkConfig(config: SourceConfig): Promise<SourceConfig> {
    if (config.kind === 'folder') {
      const real = await this.resolveRoot(config.root);
      const info = await stat(real);
      if (!info.isDirectory()) {
        throw new ValidationError(`'${real}' is not a directory.`, { path: 'config.root' });
      }
      return { ...config, root: real };
    }

    if (config.kind === 'webdav') {
      const url = new URL(config.url);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new ValidationError(
          `A WebDAV collection must be http or https; '${url.protocol}' is neither.`,
          { path: 'config.url' },
        );
      }
      return config;
    }

    return config;
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

/** The wire shape. Takes the row and nothing else, so there is no path to a plaintext secret. */
export const sourceToWire = (row: IngestionSourceRow): SourceWire => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  enabled: row.enabled,
  sourceKind: row.sourceKind as DocumentSourceKind,
  config: JSON.parse(row.config) as SourceConfig,
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
