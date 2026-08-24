/**
 * Drizzle definitions for the three tables `install.ts` creates.
 *
 * Kept beside the DDL rather than derived from it, and the DDL kept by hand rather than generated,
 * for the reason `@recueil/ingest` gives: drizzle-kit wants to own a whole migration series to emit
 * a statement, and these tables belong to a surface that has none. `install.ts` verifies every
 * column named here exists, so the two cannot drift silently.
 */
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const ingestionSources = sqliteTable('ingestion_sources', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['folder', 'webdav', 'imap'] }).notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  sourceKind: text('source_kind').notNull(),
  /** The shown half of the configuration, as JSON. Never holds a credential. */
  config: text('config').notNull().default('{}'),
  /** The unshown half: `SecretBox`-sealed JSON, or null when the source needs no credential. */
  secretCiphertext: text('secret_ciphertext'),
  /** Which credentials are held, by name. Readable without the key, which is the point. */
  secretNames: text('secret_names').notNull().default('[]'),
  consumeMode: text('consume_mode', { enum: ['leave', 'move', 'delete'] }).notNull().default('leave'),
  consumeTo: text('consume_to'),
  lastRunJobId: text('last_run_job_id'),
  lastRunAt: text('last_run_at'),
  lastError: text('last_error'),
  version: integer('version').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export type IngestionSourceRow = typeof ingestionSources.$inferSelect;

export const rules = sqliteTable('rules', {
  id: text('id').primaryKey(),
  /** The author's stable handle: what a trace names and what `item_tags.rule_ref` points at. */
  ruleId: text('rule_id').notNull(),
  kind: text('kind', { enum: ['ingestion', 'dedup'] }).notNull(),
  description: text('description'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  priority: integer('priority').notNull().default(0),
  /** `{ when, then }`, in `@recueil/rules`' own format, so the engine reads it unchanged. */
  definition: text('definition').notNull(),
  version: integer('version').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export type RuleRow = typeof rules.$inferSelect;

export const storageBackends = sqliteTable('storage_backends', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['webdav', 's3'] }).notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  config: text('config').notNull().default('{}'),
  secretCiphertext: text('secret_ciphertext'),
  secretNames: text('secret_names').notNull().default('[]'),
  lastCheckedAt: text('last_checked_at'),
  lastStatus: text('last_status'),
  lastDetail: text('last_detail'),
  version: integer('version').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export type StorageBackendRow = typeof storageBackends.$inferSelect;
