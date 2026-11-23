/**
 * Applying the migrations.
 *
 * The series under `migrations/` is generated from `schema.ts` by drizzle-kit, committed, and
 * forward-only (`spec/data-model.md` §11). `migrate` applies whatever has not been applied yet and
 * is safe to call on every boot: drizzle records each applied migration's hash in
 * `__drizzle_migrations`, so a second call on an up-to-date database is a single `SELECT` and no
 * writes at all. That is what makes "run migrations on start" a sane default rather than a hazard —
 * the desktop shell starts the same server binary as the container, several times a day.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sql } from 'drizzle-orm';
import { migrate as drizzleMigrate } from 'drizzle-orm/better-sqlite3/migrator';

import type { RecueilDatabase } from './client.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Where the committed SQL lives.
 *
 * Two candidates, because the same code runs from `src` under Vitest and from `dist` in a build.
 * The build copies the folder next to the compiled module (see `scripts/copy-migrations.mjs`); the
 * second candidate is the source tree, which is what a test run and a `tsx`-style dev server see.
 */
export const findMigrationsFolder = (): string => {
  const candidates = [join(here, 'migrations'), resolve(here, '..', '..', 'src', 'db', 'migrations')];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'meta', '_journal.json'))) return candidate;
  }
  throw new Error(
    `No migration journal found. Looked in: ${candidates.join(', ')}. A packaged build must ` +
      'carry src/db/migrations; run `pnpm --filter @recueil/core build`.',
  );
};

export interface MigrateOptions {
  /** Override the folder. Only tests and the migration tool should need this. */
  migrationsFolder?: string;
}

/**
 * Bring a database up to the current schema. Idempotent: applying an already-current database is a
 * no-op, so this runs unconditionally on boot.
 */
/**
 * Refuse a library a newer Recueil has migrated: this build does not know its schema, and the
 * migrator would otherwise start on it silently (docs/upgrades.qmd). A downgrade is a restore.
 */
export class NewerLibraryError extends Error {
  constructor(readonly libraryMigratedAt: number, readonly newestKnown: number) {
    super(
      `This library was migrated by a newer Recueil (schema of ${new Date(libraryMigratedAt).toISOString()}; ` +
        `this build knows schemas up to ${new Date(newestKnown).toISOString()}). Upgrade Recueil, or restore a backup taken with this version.`,
    );
    this.name = 'NewerLibraryError';
  }
}

const refuseNewerLibrary = (db: RecueilDatabase, migrationsFolder: string): void => {
  const table = db.get<{ name: string } | undefined>(sql`select name from sqlite_master where type = 'table' and name = '__drizzle_migrations'`);
  if (table === undefined) return;
  const applied = db.get<{ newest: number | null }>(sql`select max(created_at) as newest from __drizzle_migrations`);
  const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as { entries: { when: number }[] };
  const newestKnown = Math.max(...journal.entries.map((entry) => entry.when));
  if (applied?.newest != null && Number(applied.newest) > newestKnown) throw new NewerLibraryError(Number(applied.newest), newestKnown);
};

export const migrate = (db: RecueilDatabase, options: MigrateOptions = {}): void => {
  const migrationsFolder = options.migrationsFolder ?? findMigrationsFolder();
  refuseNewerLibrary(db, migrationsFolder);
  drizzleMigrate(db, {
    migrationsFolder,
    migrationsTable: '__drizzle_migrations',
  });
};
