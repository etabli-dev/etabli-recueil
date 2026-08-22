/**
 * Opening the database.
 *
 * SQLite is the default deployment (ADR-0003), and `spec/data-model.md` §1.1 fixes the pragmas a
 * Recueil database runs with. They are not optional and they are not tuning knobs:
 *
 * - `foreign_keys = ON` — SQLite disables foreign keys per connection by default, so every
 *   `ON DELETE RESTRICT` in the schema is inert until this is set. The whole P5 design rests on it.
 * - `journal_mode = WAL` — the reader-during-write behaviour the job queue needs (ADR-0010).
 * - `busy_timeout = 5000` — a worker that meets the single writer waits rather than failing.
 * - `synchronous = NORMAL` — the usual WAL pairing: durable across process death, and across
 *   machine death to the last checkpoint.
 *
 * The driver is better-sqlite3 rather than Node's built-in `node:sqlite`. `node:sqlite` is
 * attractive — no native build, no dependency — but on Node 22 LTS, the version Recueil targets, it
 * is behind `--experimental-sqlite` and prints a runtime warning, which is not something a
 * self-hosted server should require of its operator; drizzle-kit and the drizzle migrator also
 * treat better-sqlite3 as the first-class SQLite driver. The dependency is confined to this module
 * and `migrate.ts`, so swapping it when `node:sqlite` stabilises is a two-file change.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import BetterSqlite3 from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import * as schema from './schema.js';

export type RecueilDatabase = BetterSQLite3Database<typeof schema>;
export type SqliteConnection = BetterSqlite3.Database;

/** An in-memory database: no file, nothing to clean up, gone when the connection closes. */
export const MEMORY_DATABASE = ':memory:';

/**
 * Turn a database URL into a better-sqlite3 filename.
 *
 * Accepted forms, all of which people actually type: `:memory:`, a bare path, `file:./library.db`,
 * `file:///var/lib/recueil/library.db` and `sqlite:` with either of the last two shapes. A Postgres
 * URL is rejected here rather than half-working: Postgres support is a second driver (ADR-0003,
 * ADR-0015), not a different string.
 */
export const resolveDatabaseFile = (databaseUrl: string): string => {
  const value = databaseUrl.trim();
  if (value === '' || value === MEMORY_DATABASE) return MEMORY_DATABASE;

  if (/^postgres(ql)?:/iu.test(value)) {
    throw new Error(
      `Postgres is not wired up yet: '${value}'. ADR-0003 keeps the schema portable, but the ` +
        'Postgres driver arrives with multi-user (ADR-0015). Use a SQLite path or :memory:.',
    );
  }

  const withoutScheme = value.replace(/^sqlite:(\/\/)?/iu, '');
  if (withoutScheme === MEMORY_DATABASE) return MEMORY_DATABASE;

  if (/^file:/iu.test(withoutScheme)) {
    // `file:./x.db` is a relative URL that `new URL` cannot parse as a file URL, so only the
    // absolute `file://` form goes through the URL parser.
    if (/^file:\/\//iu.test(withoutScheme)) return new URL(withoutScheme).pathname;
    return withoutScheme.slice('file:'.length);
  }

  return withoutScheme;
};

export interface OpenDatabaseOptions {
  /** `:memory:`, a path, or a `file:`/`sqlite:` URL. */
  databaseUrl: string;
  /** Create the parent directory of a file database. Default true. */
  createDirectory?: boolean;
  /** Passed through to better-sqlite3; useful in tests. */
  readonly?: boolean;
}

export interface OpenedDatabase {
  db: RecueilDatabase;
  connection: SqliteConnection;
  /** The resolved filename, or `:memory:`. */
  file: string;
}

/** Open a connection with the pragmas §1.1 requires, and wrap it in Drizzle. */
export const openDatabase = (options: OpenDatabaseOptions): OpenedDatabase => {
  const file = resolveDatabaseFile(options.databaseUrl);
  if (file !== MEMORY_DATABASE && options.createDirectory !== false) {
    mkdirSync(dirname(file), { recursive: true });
  }

  const connection = new BetterSqlite3(file, { readonly: options.readonly === true });
  applyPragmas(connection, file);

  return { db: drizzle(connection, { schema }), connection, file };
};

/** The pragmas of §1.1. Exported so that a test or a repair tool can assert them. */
export const applyPragmas = (connection: SqliteConnection, file: string): void => {
  connection.pragma('foreign_keys = ON');
  // WAL needs a file on disk; an in-memory database stays in the default rollback journal.
  if (file !== MEMORY_DATABASE) connection.pragma('journal_mode = WAL');
  connection.pragma('busy_timeout = 5000');
  connection.pragma('synchronous = NORMAL');
};
