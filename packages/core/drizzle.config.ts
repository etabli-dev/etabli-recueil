/**
 * drizzle-kit configuration.
 *
 * The migrations under `src/db/migrations` are generated from `src/db/schema.ts` and committed:
 * they are the artefact the server applies on boot, and they are forward-only (`spec/data-model.md`
 * §11). Regenerate with `pnpm --filter @recueil/core db:generate` after changing the schema, and
 * read the diff before committing it — a generated migration that drops a column is a data-loss
 * bug, not a formatting change.
 *
 * The dialect here is SQLite, the default deployment (ADR-0003). The schema is written to the
 * SQLite/Postgres intersection (§1.1), so the Postgres migration series is a second `out` directory
 * generated from the same tables when multi-user arrives (ADR-0015).
 */
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  strict: true,
  verbose: true,
  dbCredentials: {
    // Only used by the interactive `drizzle-kit studio`/`push` commands, never by `generate` and
    // never by the server: the server opens the database given to `createRecueil`.
    url: process.env['RECUEIL_DATABASE_URL'] ?? 'file:./.drizzle/dev.sqlite',
  },
});
