--
-- Hand-written. The full-text index is deliberately outside `schema.ts`.
--
-- `spec/data-model.md` §9: the index is not part of the portable schema, because an FTS5 virtual
-- table and a Postgres `tsvector` column have nothing in common (ADR-0011). It is built by a
-- dialect-specific migration behind one interface, and it is derived data — it can be dropped and
-- rebuilt from the tables above at any time, which is what `SearchService.rebuild()` does.
--
-- Two objects, not one, and the split is the point:
--
--   * `search_entries` is an ordinary table. It owns the mapping from a rowid to the entity the
--     indexed document describes, so an update is "look up the rowid, replace that row" rather than
--     "find the old text and delete it by content". It also carries `item_id`, which is what lets a
--     hit on a note or on a document's extracted text roll up to the item a library list shows.
--   * `search_index` is the FTS5 table, content-bearing (no `content=` option), because a
--     contentless table cannot be deleted from without re-supplying the original text — which is
--     precisely the thing we would not have to hand at delete time.
--
-- The two share a rowid: `search_index.rowid = search_entries.id`, maintained by the service in one
-- transaction. There are no triggers, because the indexed document for an item is an aggregate over
-- six tables and a trigger per source table would fire six times for one logical change, in an
-- order SQLite does not promise.
--
-- `remove_diacritics 2` is the setting that makes `Muller` find `Müller`, which for a library whose
-- author names are German, French and Scandinavian is not a nicety.
--
CREATE TABLE `search_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`item_id` text,
	`indexed_at` text NOT NULL,
	CONSTRAINT "ck_search_entries_entity_type" CHECK("entity_type" in ('item', 'note', 'document'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_search_entries_entity` ON `search_entries` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `ix_search_entries_item` ON `search_entries` (`item_id`) WHERE item_id IS NOT NULL;--> statement-breakpoint
CREATE VIRTUAL TABLE `search_index` USING fts5(
	title,
	creators,
	container,
	identifiers,
	tags,
	body,
	text,
	tokenize = 'unicode61 remove_diacritics 2'
);
