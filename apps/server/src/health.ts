/**
 * `/health`, and the Phase 0 exit criterion.
 *
 * CONCEPT.md §7 sets the bar for Phase 0 at "`recueil serve` returns health with an empty library".
 * The word doing the work there is *empty*: zeroes have to be measured, not asserted. So every
 * number in this response is read from the library on the way past — the row counts come from the
 * database, the migration count from the migration ledger, and the store probe touches the actual
 * directory. A health endpoint that returns constants passes its own test and tells an operator
 * nothing.
 *
 * The response is a strict superset of `HealthResponseSchema` from `@recueil/schemas`: everything
 * the contract declares, plus the `database` and `storage` objects that carry the two facts an
 * operator reaches for first — whether the schema is up to date, and where the files are and
 * whether they can be written. `buildOpenApiDocument` publishes the widened schema, so the served
 * document and the served response stay the same thing (P6).
 *
 * Cost: four `count(*)` queries and one `access(2)`. That is cheap on a personal library and the
 * container health check runs every thirty seconds (deploy/docker-compose.yml). If it ever stops
 * being cheap, `LibrarySummary.countedAt` is already in the contract so the counts can be cached
 * and reported with their age without a breaking change.
 */
import { access, mkdir } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';

import type { Recueil } from '@recueil/core';
import { LocalFsBackend, schema } from '@recueil/core';
import { HealthResponseSchema } from '@recueil/schemas';
import { isNull } from 'drizzle-orm';
import * as z from 'zod';

/** The migration ledger drizzle keeps, named in `packages/core/src/db/migrate.ts`. */
const MIGRATIONS_TABLE = '__drizzle_migrations';

export const DatabaseHealthSchema = z
  .strictObject({
    ok: z.boolean().meta({ description: 'Whether the database answered a trivial query.' }),
    migrationsApplied: z
      .number()
      .int()
      .min(0)
      .meta({
        description:
          'Rows in the drizzle migration ledger. Zero on a database that has never been migrated, ' +
          'which for a server that migrates on boot means something went wrong.',
      }),
    latencyMs: z.number().min(0).optional(),
    detail: z.string().max(1024).optional(),
  })
  .meta({
    id: 'DatabaseHealth',
    title: 'DatabaseHealth',
    description: 'The state of the SQLite database behind this server (ADR-0003).',
  });

export const StorageHealthSchema = z
  .strictObject({
    ok: z.boolean().meta({ description: 'Whether the content-addressed store exists and is writable.' }),
    path: z.string().max(4096).meta({ description: 'The store root, as the server resolved it.' }),
    backend: z.enum(['local', 'webdav', 's3']),
    strayTempFiles: z
      .number()
      .int()
      .min(0)
      .optional()
      .meta({
        description:
          'Partial writes left in the store\'s `.tmp` directory by an interrupted upload. They are ' +
          'not blobs and are never restored or backed up, so nothing else would ever mention them ' +
          '— and a store quietly accumulating half-written scans until the disk fills is a fault ' +
          'nobody can diagnose. A non-zero count is not itself unhealthy: a `.part` file a few ' +
          'seconds old belongs to an upload still in flight. Local backend only.',
      }),
    strayTempBytes: z.number().int().min(0).optional(),
    detail: z.string().max(1024).optional(),
  })
  .meta({
    id: 'StorageHealth',
    title: 'StorageHealth',
    description: 'The state of the file store (ADR-0004).',
  });

export const SearchHealthSchema = z
  .strictObject({
    available: z
      .boolean()
      .meta({
        description:
          'Whether this database has an FTS5 index. False on a build of SQLite without the module, ' +
          'which ADR-0011 anticipates: the library serves, `/api/v1/search` answers 503.',
      }),
    backend: z.enum(['fts5', 'meilisearch', 'none']),
  })
  .meta({
    id: 'SearchHealth',
    title: 'SearchHealth',
    description: 'The state of the full-text index (ADR-0011).',
  });

export const ApiHealthSchema = z
  .strictObject({
    basePath: z.string().max(64),
    /** Open Server-Sent Event streams. Useful when a UI stops updating and nobody knows why. */
    eventSubscribers: z.number().int().min(0),
    /** Whether an unauthenticated call to `/api/v1` is refused (`RECUEIL_REQUIRE_AUTH`). */
    authRequired: z.boolean(),
  })
  .meta({
    id: 'ApiHealth',
    title: 'ApiHealth',
    description: 'What the REST surface is currently doing.',
  });

/**
 * The contract's health response, widened by the objects above.
 *
 * `.extend` keeps the strictness of the base object, so an unknown key is still a failure; the new
 * `id` is what stops it colliding with `HealthResponse` in the components section.
 */
export const ServerHealthResponseSchema = HealthResponseSchema.extend({
  database: DatabaseHealthSchema,
  storage: StorageHealthSchema,
  search: SearchHealthSchema,
  api: ApiHealthSchema,
}).meta({
  id: 'ServerHealthResponse',
  title: 'ServerHealthResponse',
  description:
    'The response of `GET /health` as this server sends it: every member of `HealthResponse`, ' +
    'plus `database`, `storage`, `search` and `api`.',
});

export type DatabaseHealth = z.infer<typeof DatabaseHealthSchema>;
export type StorageHealth = z.infer<typeof StorageHealthSchema>;
export type SearchHealth = z.infer<typeof SearchHealthSchema>;
export type ApiHealth = z.infer<typeof ApiHealthSchema>;
export type ServerHealthResponse = z.infer<typeof ServerHealthResponseSchema>;

/**
 * Make sure the store root is there.
 *
 * Called from the app's `onReady` hook rather than from the probe, because a health check should
 * observe and not repair. Creating one's own data directory at start-up is not repair: it is the
 * difference between a first run that works and a first run that reports `degraded` until somebody
 * uploads a file.
 */
export const ensureStoragePath = async (path: string): Promise<void> => {
  await mkdir(path, { recursive: true });
};

/**
 * Probe the full-text index.
 *
 * Optional, not required: a library with no FTS5 module is degraded rather than down (ADR-0011).
 * `search.available` probes once and caches, so this is free after the first call.
 */
export const checkSearch = (recueil: Recueil): SearchHealth => {
  const available = recueil.search.available;
  return { available, backend: available ? 'fts5' : 'none' };
};

/** Probe the database: one trivial query, then the migration ledger. */
export const checkDatabase = (recueil: Recueil): DatabaseHealth => {
  const startedAt = process.hrtime.bigint();
  const elapsed = (): number => Number(process.hrtime.bigint() - startedAt) / 1e6;

  try {
    recueil.connection.prepare('select 1').get();
  } catch (error) {
    return { ok: false, migrationsApplied: 0, latencyMs: elapsed(), detail: describe(error) };
  }

  // The ledger is drizzle's, not ours, so it is not in `schema.ts` and this is the one raw query in
  // the server. A database that has never been migrated has no such table, which is a legitimate
  // answer to "how many migrations are applied" and not an error to propagate.
  let migrationsApplied = 0;
  try {
    const row = recueil.connection
      .prepare(`select count(*) as applied from ${MIGRATIONS_TABLE}`)
      .get() as { applied?: number } | undefined;
    migrationsApplied = Number(row?.applied ?? 0);
  } catch {
    return {
      ok: false,
      migrationsApplied: 0,
      latencyMs: elapsed(),
      detail: `No ${MIGRATIONS_TABLE} table: this database has never been migrated.`,
    };
  }

  return migrationsApplied > 0
    ? { ok: true, migrationsApplied, latencyMs: elapsed() }
    : {
        ok: false,
        migrationsApplied,
        latencyMs: elapsed(),
        detail: 'The migration ledger is empty, so the schema is not the one this server expects.',
      };
};

/** Probe the store: does the root exist, and can this process write into it? */
export const checkStorage = async (recueil: Recueil, path: string): Promise<StorageHealth> => {
  const backend = recueil.storage.backend;

  // Only the local backend has a directory to look at. WebDAV and S3 arrive in Phase 2 and will
  // probe themselves; until then, reporting `ok` for a backend nobody can configure is honest.
  if (backend !== 'local') {
    return { ok: true, path, backend, detail: `The ${backend} backend reports no local path.` };
  }

  try {
    await access(path, fsConstants.W_OK | fsConstants.X_OK);
  } catch (error) {
    return { ok: false, path, backend, detail: describe(error) };
  }

  // Surfaced, not swept: this is a health probe, and a probe observes rather than repairs. The
  // sweep is `LocalFsBackend.sweepTempFiles`, for an operator or a maintenance job to call.
  const stray =
    recueil.storage instanceof LocalFsBackend ? await recueil.storage.listStrayTempFiles() : [];

  return {
    ok: true,
    path,
    backend,
    strayTempFiles: stray.length,
    strayTempBytes: stray.reduce((sum, file) => sum + file.size, 0),
  };
};

/** The live record counts. Trashed rows are excluded: the trash is not the library (P5). */
export const countLibrary = async (
  recueil: Recueil,
): Promise<{ items: number; documents: number; attachments: number; collections: number }> => {
  const { db } = recueil;
  return {
    items: await db.$count(schema.items, isNull(schema.items.trashedAt)),
    documents: await db.$count(schema.documents, isNull(schema.documents.trashedAt)),
    attachments: await db.$count(schema.attachments, isNull(schema.attachments.trashedAt)),
    collections: await db.$count(schema.collections, isNull(schema.collections.trashedAt)),
  };
};

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
