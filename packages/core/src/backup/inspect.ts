/**
 * Reading the facts a manifest records about a database file.
 *
 * Every one of these is taken from the *snapshot*, never from the live database. The manifest has
 * to describe the file that is in the backup: a page count read from the original would be wrong
 * the moment the backup API folded the WAL in, and an integrity check run against the original
 * would say nothing about whether the copy arrived intact.
 */
import BetterSqlite3 from 'better-sqlite3';

import type { BackupSchemaState } from './manifest.js';

/** The drizzle migration table, in the shape `db/migrate.ts` asks the migrator to write it. */
const MIGRATIONS_TABLE = '__drizzle_migrations';

export interface DatabaseFacts {
  readonly sqliteVersion: string;
  readonly pageSize: number;
  readonly pageCount: number;
  readonly integrityCheck: string;
  readonly schema: BackupSchemaState;
  readonly tableCounts: Record<string, number>;
}

/** `"table name"`, with any embedded quote doubled — sqlite_master names are not trusted input. */
const quoteIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;

const scalar = <T>(connection: BetterSqlite3.Database, sql: string): T | undefined => {
  const row = connection.prepare(sql).get() as Record<string, unknown> | undefined;
  if (row === undefined) return undefined;
  const values = Object.values(row);
  return values.length === 0 ? undefined : (values[0] as T);
};

/** Row counts for every table in the file, including the FTS shadow tables. */
export const tableCounts = (connection: BetterSqlite3.Database): Record<string, number> => {
  const names = connection
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
    )
    .all() as Array<{ name: string }>;

  const counts: Record<string, number> = {};
  for (const { name } of names) {
    counts[name] = scalar<number>(connection, `SELECT count(*) FROM ${quoteIdentifier(name)}`) ?? 0;
  }
  return counts;
};

const schemaState = (connection: BetterSqlite3.Database): BackupSchemaState => {
  const present = connection
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(MIGRATIONS_TABLE);
  if (present === undefined) return { applied: 0, latestHash: null, latestCreatedAt: null };

  const applied = scalar<number>(connection, `SELECT count(*) FROM ${quoteIdentifier(MIGRATIONS_TABLE)}`) ?? 0;
  const latest = connection
    .prepare(`SELECT hash, created_at FROM ${quoteIdentifier(MIGRATIONS_TABLE)} ORDER BY created_at DESC LIMIT 1`)
    .get() as { hash?: unknown; created_at?: unknown } | undefined;

  return {
    applied,
    latestHash: typeof latest?.hash === 'string' ? latest.hash : null,
    latestCreatedAt: typeof latest?.created_at === 'number' ? latest.created_at : null,
  };
};

/**
 * Open a database file read-only and describe it.
 *
 * `integrity_check` is the expensive one — it reads every page — and it is here rather than
 * optional because the point of taking the snapshot with the backup API is to know that the file
 * in the backup is a coherent database. Discovering otherwise a year later, at restore time, is
 * the failure this whole module exists to prevent.
 */
export const inspectDatabaseFile = (path: string, options: { counts?: boolean } = {}): DatabaseFacts => {
  const connection = new BetterSqlite3(path, { readonly: true, fileMustExist: true });
  try {
    return {
      sqliteVersion: scalar<string>(connection, 'SELECT sqlite_version()') ?? 'unknown',
      pageSize: Number(connection.pragma('page_size', { simple: true })),
      pageCount: Number(connection.pragma('page_count', { simple: true })),
      integrityCheck: String(connection.pragma('integrity_check', { simple: true })),
      schema: schemaState(connection),
      tableCounts: options.counts === false ? {} : tableCounts(connection),
    };
  } finally {
    connection.close();
  }
};
