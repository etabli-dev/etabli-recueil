/**
 * Configured remote storage backends, and a health check that actually touches them.
 *
 * **Configuring is not rebinding.** The store a process writes through is chosen at boot from
 * `RECUEIL_STORAGE_*`, and nothing here changes it. That is not a limitation to be worked around
 * later: a content-addressed store is only addressable if every blob is in it, and swapping the
 * backend under a live library would strand every blob written before the swap behind a
 * `documents.storage_backend` that no longer resolves. So a row here is a configuration an operator
 * can write, verify and then point the environment at — and `StorageBackend.active` says which one,
 * if any, the running process is using.
 *
 * **The health check has two modes and neither of them is a guess.** `read` asks the store for a
 * digest that is not there: a complete round trip through authentication, addressing and the
 * network that writes nothing. `roundtrip` writes a small probe blob, reads it back, verifies the
 * digest byte for byte and deletes it — the only check that proves the store can hold a document,
 * and the only one that can catch a WebDAV server that accepts a `PUT` and stores something else.
 * Both report every step, so a green result names its evidence.
 */
import { createHash, randomBytes } from 'node:crypto';

import { ConflictError, NotFoundError, newId, nowTimestamp } from '@recueil/core';
import type { Actor, Recueil, StorageBackend } from '@recueil/core';
import type { WebDavAuth } from '@recueil/storage-backends';
import { asc, eq } from 'drizzle-orm';
import * as z from 'zod';

import { SecretBox, SecretsUnavailableError } from './secrets.js';
import { storageBackends } from './tables.js';
import type { StorageBackendRow } from './tables.js';
import type { ConnectionCheck } from './sources.js';
import type {
  StorageBackendConfigSchema,
  StorageBackendCreateSchema,
  StorageBackendSchema,
  StorageBackendUpdateSchema,
} from '../schemas-ingestion.js';

export type BackendConfig = z.infer<typeof StorageBackendConfigSchema>;
export type BackendCreate = z.infer<typeof StorageBackendCreateSchema>;
export type BackendUpdate = z.infer<typeof StorageBackendUpdateSchema>;

export interface StorageServiceOptions {
  readonly recueil: Recueil;
  readonly secrets: SecretBox;
  /** Swapped by the tests, so a WebDAV probe runs against an in-process fake. */
  readonly fetch?: typeof fetch;
  /** Where a remote backend spools bytes while hashing them. Defaults to the OS temporary directory. */
  readonly scratchDirectory?: string;
}

export interface HealthResult {
  status: 'ok' | 'degraded' | 'failed';
  checks: ConnectionCheck[];
  detail: string;
}

export class StorageBackendService {
  private readonly recueil: Recueil;

  private readonly secrets: SecretBox;

  private readonly fetchImpl: typeof fetch | undefined;

  private readonly scratchDirectory: string | undefined;

  constructor(options: StorageServiceOptions) {
    this.recueil = options.recueil;
    this.secrets = options.secrets;
    this.fetchImpl = options.fetch;
    this.scratchDirectory = options.scratchDirectory;
  }

  list(): StorageBackendRow[] {
    return this.recueil.db.select().from(storageBackends).orderBy(asc(storageBackends.name)).all();
  }

  get(id: string): StorageBackendRow {
    const row = this.recueil.db.select().from(storageBackends).where(eq(storageBackends.id, id)).get();
    if (row === undefined) throw new NotFoundError('storage backend', id);
    return row;
  }

  /** True when the running library writes through a backend of this kind. */
  isActive(row: StorageBackendRow): boolean {
    return this.recueil.storage.backend === row.kind;
  }

  create(input: BackendCreate, actor: Actor): StorageBackendRow {
    this.assertNameFree(input.name, null);
    const secret = this.sealSecret(input.secret);
    const now = nowTimestamp();

    const row: StorageBackendRow = {
      id: newId(),
      name: input.name.trim(),
      kind: input.config.kind,
      enabled: input.enabled ?? true,
      config: JSON.stringify(input.config),
      secretCiphertext: secret.ciphertext,
      secretNames: JSON.stringify(secret.names),
      lastCheckedAt: null,
      lastStatus: null,
      lastDetail: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };

    this.recueil.db.transaction((tx) => {
      tx.insert(storageBackends).values(row).run();
      this.recueil.audit.record(
        {
          actor,
          action: 'storage_backend.created',
          entityType: 'storage_backend',
          entityId: row.id,
          after: { name: row.name, kind: row.kind, secretNames: secret.names },
        },
        tx,
      );
    });
    return row;
  }

  update(id: string, input: BackendUpdate, actor: Actor): StorageBackendRow {
    const existing = this.get(id);
    if (input.config !== undefined && input.config.kind !== existing.kind) {
      throw new ConflictError(
        `Backend '${id}' is a ${existing.kind} backend and cannot become a ${input.config.kind} one.`,
        { backendId: id, kind: existing.kind },
      );
    }
    if (input.name !== undefined) this.assertNameFree(input.name, id);

    const secret =
      input.secret === undefined
        ? { ciphertext: existing.secretCiphertext, names: JSON.parse(existing.secretNames) as string[] }
        : this.sealSecret(input.secret);

    const patch = {
      name: input.name === undefined ? existing.name : input.name.trim(),
      enabled: input.enabled ?? existing.enabled,
      config: input.config === undefined ? existing.config : JSON.stringify(input.config),
      secretCiphertext: secret.ciphertext,
      secretNames: JSON.stringify(secret.names),
      version: existing.version + 1,
      updatedAt: nowTimestamp(),
    };

    this.recueil.db.transaction((tx) => {
      tx.update(storageBackends).set(patch).where(eq(storageBackends.id, id)).run();
      this.recueil.audit.record(
        {
          actor,
          action: 'storage_backend.updated',
          entityType: 'storage_backend',
          entityId: id,
          before: { name: existing.name, enabled: existing.enabled },
          after: { name: patch.name, enabled: patch.enabled, secretNames: secret.names },
        },
        tx,
      );
    });

    return { ...existing, ...patch };
  }

  remove(id: string, actor: Actor): void {
    const existing = this.get(id);
    if (this.isActive(existing)) {
      throw new ConflictError(
        `Backend '${existing.name}' is the store this process is writing through. Point ` +
          'RECUEIL_STORAGE_* elsewhere and restart before removing its configuration.',
        { backendId: id, kind: existing.kind },
      );
    }
    this.recueil.db.transaction((tx) => {
      tx.delete(storageBackends).where(eq(storageBackends.id, id)).run();
      this.recueil.audit.record(
        {
          actor,
          action: 'storage_backend.removed',
          entityType: 'storage_backend',
          entityId: id,
          before: {
            name: existing.name,
            kind: existing.kind,
            config: JSON.parse(existing.config) as never,
          },
        },
        tx,
      );
    });
  }

  /* ---- the probe ------------------------------------------------------------------------------ */

  /**
   * Build the backend this row describes. Not cached: a probe should construct what it tests.
   *
   * The implementations are imported here rather than at the top of the module, and the reason is
   * the AWS SDK: `@recueil/storage-backends` pulls in `@aws-sdk/client-s3`, which is tens of
   * megabytes of JavaScript to parse. Its own README makes the point — "a deployment that only ever
   * writes to a local disk does not pull in the AWS SDK" — and a top-level import here would have
   * put it in the boot path of every server, including the overwhelming majority that never
   * configure a remote store at all.
   */
  async buildBackend(row: StorageBackendRow): Promise<StorageBackend> {
    const config = JSON.parse(row.config) as BackendConfig;
    const secrets = this.openSecret(row);
    const { S3Backend, WebDavBackend } = await import('@recueil/storage-backends');

    if (config.kind === 'webdav') {
      return new WebDavBackend({
        url: config.url,
        auth: webDavAuth(config.authKind, config.username, secrets),
        ...(this.scratchDirectory === undefined ? {} : { scratchDirectory: this.scratchDirectory }),
        ...(config.writeStrategy === undefined ? {} : { writeStrategy: config.writeStrategy }),
        ...(config.verifyOnWrite === undefined ? {} : { verifyOnWrite: config.verifyOnWrite }),
        ...(config.sendContentMd5 === undefined ? {} : { sendContentMd5: config.sendContentMd5 }),
        ...(config.sendOcChecksum === undefined ? {} : { sendOcChecksum: config.sendOcChecksum }),
        ...(this.fetchImpl === undefined ? {} : { fetch: this.fetchImpl }),
      });
    }

    return new S3Backend({
      bucket: config.bucket,
      ...(config.region === undefined ? {} : { region: config.region }),
      ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
      ...(config.forcePathStyle === undefined ? {} : { forcePathStyle: config.forcePathStyle }),
      ...(config.prefix === undefined ? {} : { prefix: config.prefix }),
      ...(config.accessKeyId === undefined || secrets['secretAccessKey'] === undefined
        ? {}
        : {
            credentials: {
              accessKeyId: config.accessKeyId,
              secretAccessKey: secrets['secretAccessKey'],
              ...(secrets['sessionToken'] === undefined ? {} : { sessionToken: secrets['sessionToken'] }),
            },
          }),
      ...(this.scratchDirectory === undefined ? {} : { scratchDirectory: this.scratchDirectory }),
      ...(config.verifyOnWrite === undefined ? {} : { verifyOnWrite: config.verifyOnWrite }),
      ...(config.multipartThreshold === undefined ? {} : { multipartThreshold: config.multipartThreshold }),
      ...(config.serverSideChecksums === undefined
        ? {}
        : { serverSideChecksums: config.serverSideChecksums }),
    });
  }

  /**
   * Probe the store, and say what was tried.
   *
   * `roundtrip` is the mode worth reading. It writes random bytes, reads them back through the
   * store's own `get`, and compares the digest of what came back with the digest of what went in —
   * so a store that accepted the write and returned something else fails here rather than at the
   * first read of a real document, which might be in eighteen months. The probe blob is deleted
   * whatever the outcome, in a `finally`, because a health check that litters the store is a health
   * check people turn off.
   */
  async probe(row: StorageBackendRow, mode: 'read' | 'roundtrip'): Promise<HealthResult> {
    const checks: ConnectionCheck[] = [];
    let backend: StorageBackend;
    try {
      backend = await this.buildBackend(row);
      checks.push({ check: 'configure', ok: true, detail: `${row.kind} backend constructed` });
    } catch (error) {
      return this.summarise([{ check: 'configure', ok: false, detail: describe(error) }]);
    }

    // A digest that is certainly not in the store: random bytes, hashed. `has` is a full round trip
    // — resolve, authenticate, address, ask — that writes nothing, and `false` is the right answer.
    const absent = createHash('sha256').update(randomBytes(32)).digest('hex');
    try {
      const present = await backend.has(absent);
      checks.push({
        check: 'read',
        ok: !present,
        detail: present
          ? 'the store claims to hold a digest of random bytes, which means it is answering ' +
            'something other than the truth'
          : 'reachable; the store correctly reports an absent digest as absent',
      });
    } catch (error) {
      checks.push({ check: 'read', ok: false, detail: describe(error) });
      return this.summarise(checks);
    }

    if (mode === 'read') return this.summarise(checks);

    const bytes = randomBytes(64);
    const digest = createHash('sha256').update(bytes).digest('hex');
    try {
      const put = await backend.put(bytes);
      checks.push({
        check: 'write',
        ok: put.sha256 === digest,
        detail:
          put.sha256 === digest
            ? `wrote ${String(bytes.byteLength)} bytes as ${digest.slice(0, 12)}…`
            : `the store hashed the bytes as ${put.sha256.slice(0, 12)}… and they hash to ${digest.slice(0, 12)}…`,
      });

      const readBack = await backend.getBuffer(digest);
      const readDigest = createHash('sha256').update(readBack).digest('hex');
      checks.push({
        check: 'verify',
        ok: readDigest === digest,
        detail:
          readDigest === digest
            ? 'the bytes read back hash to the digest they were written under'
            : `the bytes read back hash to ${readDigest.slice(0, 12)}…, not ${digest.slice(0, 12)}…`,
      });
    } catch (error) {
      checks.push({ check: 'write', ok: false, detail: describe(error) });
    } finally {
      try {
        await backend.delete(digest);
        checks.push({ check: 'cleanup', ok: true, detail: 'the probe blob was removed' });
      } catch (error) {
        checks.push({
          check: 'cleanup',
          ok: false,
          detail: `the probe blob ${digest.slice(0, 12)}… could not be removed: ${describe(error)}`,
        });
      }
    }

    return this.summarise(checks);
  }

  /** Record what a probe found, so a list view can show the last known state without re-probing. */
  recordProbe(id: string, result: HealthResult): void {
    this.recueil.db
      .update(storageBackends)
      .set({
        lastCheckedAt: nowTimestamp(),
        lastStatus: result.status,
        lastDetail: result.detail,
        updatedAt: nowTimestamp(),
      })
      .where(eq(storageBackends.id, id))
      .run();
  }

  /* ---- internals ------------------------------------------------------------------------------ */

  /**
   * The status is the conjunction of the checks, not a separate opinion.
   *
   * `degraded` is reserved for the one case where the store works and something else did not: the
   * probe blob could not be removed. Everything else is `ok` or `failed`.
   */
  private summarise(checks: ConnectionCheck[]): HealthResult {
    const failed = checks.filter((check) => !check.ok);
    if (failed.length === 0) {
      return { status: 'ok', checks, detail: `${String(checks.length)} check(s) passed` };
    }
    const onlyCleanup = failed.every((check) => check.check === 'cleanup');
    return {
      status: onlyCleanup ? 'degraded' : 'failed',
      checks,
      detail: failed.map((check) => `${check.check}: ${check.detail}`).join('; '),
    };
  }

  private assertNameFree(name: string, exceptId: string | null): void {
    const clash = this.recueil.db
      .select()
      .from(storageBackends)
      .where(eq(storageBackends.name, name.trim()))
      .get();
    if (clash !== undefined && clash.id !== exceptId) {
      throw new ConflictError(`A storage backend named '${name.trim()}' already exists.`, {
        name: name.trim(),
        backendId: clash.id,
      });
    }
  }

  private sealSecret(secret: BackendCreate['secret']): { ciphertext: string | null; names: string[] } {
    const entries = Object.entries(secret ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '',
    );
    if (entries.length === 0) return { ciphertext: null, names: [] };
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

  private openSecret(row: StorageBackendRow): Record<string, string> {
    if (row.secretCiphertext === null) return {};
    if (!this.secrets.available) {
      throw new SecretsUnavailableError(
        `Backend '${row.name}' holds a credential and this server has no RECUEIL_SECRET_KEY to ` +
          'decrypt it with.',
      );
    }
    return this.secrets.open(row.secretCiphertext);
  }
}

/**
 * How the credentials become a `WebDavAuth`.
 *
 * The three shapes are exclusive and each requires its own fields, so an incomplete credential
 * becomes `none` rather than a half-populated `basic` that would send `Authorization: Basic dW5kZWZpbmVk`.
 * The probe then fails with a 401 the operator can read, which is the honest outcome.
 */
const webDavAuth = (
  kind: 'basic' | 'bearer' | 'none' | undefined,
  username: string | undefined,
  secrets: Record<string, string>,
): WebDavAuth => {
  const resolved =
    kind ?? (secrets['token'] !== undefined ? 'bearer' : username !== undefined ? 'basic' : 'none');
  if (resolved === 'bearer' && secrets['token'] !== undefined) {
    return { kind: 'bearer', token: secrets['token'] };
  }
  if (resolved === 'basic' && username !== undefined && secrets['password'] !== undefined) {
    return { kind: 'basic', username, password: secrets['password'] };
  }
  return { kind: 'none' };
};

/** The wire shape, assembled without touching the ciphertext. */
export const backendToWire = (
  row: StorageBackendRow,
  active: boolean,
): z.input<typeof StorageBackendSchema> => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  enabled: row.enabled,
  config: JSON.parse(row.config) as z.input<typeof StorageBackendSchema>['config'],
  secretNames: JSON.parse(row.secretNames) as string[],
  active,
  lastCheckedAt: row.lastCheckedAt,
  lastStatus: row.lastStatus as 'ok' | 'degraded' | 'failed' | null,
  lastDetail: row.lastDetail,
  version: row.version,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
