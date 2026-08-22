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
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
export const migrate = (db: RecueilDatabase, options: MigrateOptions = {}): void => {
  drizzleMigrate(db, {
    migrationsFolder: options.migrationsFolder ?? findMigrationsFolder(),
    migrationsTable: '__drizzle_migrations',
  });
};
