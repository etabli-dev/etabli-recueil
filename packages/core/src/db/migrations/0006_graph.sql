CREATE TABLE `edge_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`edge_id` text NOT NULL,
	`kind` text NOT NULL,
	`document_id` text,
	`page_index` integer,
	`char_start` integer,
	`char_end` integer,
	`section` text,
	`text_excerpt` text,
	`intent` text,
	`intent_confidence` real,
	`model` text,
	`extracted_at` text NOT NULL,
	FOREIGN KEY (`edge_id`) REFERENCES `graph_edges`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_edge_evidence_kind" CHECK("kind" in ('citation_context', 'reference_string', 'api_record'))
);
--> statement-breakpoint
CREATE INDEX `ix_edge_evidence_edge_id` ON `edge_evidence` (`edge_id`);--> statement-breakpoint
CREATE INDEX `ix_edge_evidence_intent` ON `edge_evidence` (`intent`) WHERE intent is not null;--> statement-breakpoint
CREATE INDEX `ix_edge_evidence_document_id` ON `edge_evidence` (`document_id`) WHERE document_id is not null;--> statement-breakpoint
CREATE TABLE `graph_edges` (
	`id` text PRIMARY KEY NOT NULL,
	`edge_type` text NOT NULL,
	`source_node_id` text NOT NULL,
	`target_node_id` text NOT NULL,
	`directed` integer NOT NULL,
	`weight` real DEFAULT 1 NOT NULL,
	`normalised_weight` real,
	`normalisation` text,
	`occurrences` integer,
	`scheme` text,
	`scheme_key` text DEFAULT '' NOT NULL,
	`provenance_source` text NOT NULL,
	`provenance_fetched_at` text NOT NULL,
	`confidence` real,
	`derivation` text NOT NULL,
	`run_id` text,
	`run_key` text DEFAULT '' NOT NULL,
	`params_digest` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`source_node_id`) REFERENCES `graph_nodes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_node_id`) REFERENCES `graph_nodes`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_graph_edges_no_self" CHECK("source_node_id" <> "target_node_id"),
	CONSTRAINT "ck_graph_edges_derived_run" CHECK("derivation" <> 'derived' or "run_id" is not null),
	CONSTRAINT "ck_graph_edges_undirected_order" CHECK("directed" = 1 or "source_node_id" < "target_node_id"),
	CONSTRAINT "ck_graph_edges_confidence" CHECK("confidence" is null or ("confidence" >= 0 and "confidence" <= 1)),
	CONSTRAINT "ck_graph_edges_derivation" CHECK("derivation" in ('asserted', 'derived')),
	CONSTRAINT "ck_graph_edges_normalisation" CHECK("normalisation" is null or "normalisation" in ('none', 'association_strength', 'salton', 'jaccard', 'fractional', 'inclusion')),
	CONSTRAINT "ck_graph_edges_directed_bool" CHECK("directed" in (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_graph_edges_identity` ON `graph_edges` (`edge_type`,`source_node_id`,`target_node_id`,`provenance_source`,`scheme_key`,`run_key`);--> statement-breakpoint
CREATE INDEX `ix_graph_edges_source` ON `graph_edges` (`source_node_id`,`edge_type`);--> statement-breakpoint
CREATE INDEX `ix_graph_edges_target` ON `graph_edges` (`target_node_id`,`edge_type`);--> statement-breakpoint
CREATE INDEX `ix_graph_edges_type_run` ON `graph_edges` (`edge_type`,`run_id`);--> statement-breakpoint
CREATE INDEX `ix_graph_edges_asserted` ON `graph_edges` (`edge_type`) WHERE derivation = 'asserted';--> statement-breakpoint
CREATE TABLE `graph_nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`node_type` text NOT NULL,
	`item_id` text,
	`shadow_work_id` text,
	`creator_id` text,
	`term_id` text,
	`external_scheme` text,
	`external_id` text,
	`label` text NOT NULL,
	`external_ids` text DEFAULT '{}' NOT NULL,
	`first_seen_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`shadow_work_id`) REFERENCES `shadow_works`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`creator_id`) REFERENCES `creators`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`term_id`) REFERENCES `terms`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_graph_nodes_type" CHECK("node_type" in ('item', 'shadow_work', 'creator', 'venue', 'term', 'institution', 'funder')),
	CONSTRAINT "ck_graph_nodes_ref" CHECK((("item_id" is not null) + ("shadow_work_id" is not null) + ("creator_id" is not null) + ("term_id" is not null) + ("external_id" is not null)) = 1
        and ("node_type" <> 'item' or "item_id" is not null)
        and ("node_type" <> 'shadow_work' or "shadow_work_id" is not null)
        and ("node_type" <> 'creator' or "creator_id" is not null)
        and ("node_type" <> 'term' or "term_id" is not null)
        and ("node_type" not in ('venue', 'institution', 'funder') or ("external_scheme" is not null and "external_id" is not null))),
	CONSTRAINT "ck_graph_nodes_external_ids_json" CHECK(json_valid("external_ids"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_graph_nodes_item` ON `graph_nodes` (`item_id`) WHERE item_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `ux_graph_nodes_shadow_work` ON `graph_nodes` (`shadow_work_id`) WHERE shadow_work_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `ux_graph_nodes_creator` ON `graph_nodes` (`creator_id`) WHERE creator_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `ux_graph_nodes_term` ON `graph_nodes` (`term_id`) WHERE term_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `ux_graph_nodes_external` ON `graph_nodes` (`node_type`,`external_scheme`,`external_id`) WHERE external_id is not null;--> statement-breakpoint
CREATE INDEX `ix_graph_nodes_type_label` ON `graph_nodes` (`node_type`,`label`);--> statement-breakpoint
CREATE TABLE `item_terms` (
	`item_id` text NOT NULL,
	`term_id` text NOT NULL,
	`qualifier_key` text DEFAULT '' NOT NULL,
	`source` text NOT NULL,
	`weight` real,
	`position` integer,
	`is_major_topic` integer DEFAULT false NOT NULL,
	`qualifier_term_id` text,
	`confidence` real,
	`added_at` text NOT NULL,
	PRIMARY KEY(`item_id`, `term_id`, `qualifier_key`),
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`term_id`) REFERENCES `terms`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`qualifier_term_id`) REFERENCES `terms`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_item_terms_major_bool" CHECK("is_major_topic" in (0, 1))
);
--> statement-breakpoint
CREATE INDEX `ix_item_terms_term_id` ON `item_terms` (`term_id`,`item_id`);--> statement-breakpoint
CREATE INDEX `ix_item_terms_source` ON `item_terms` (`source`);--> statement-breakpoint
CREATE TABLE `shadow_works` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`source_id` text NOT NULL,
	`doi` text,
	`pmid` text,
	`arxiv_id` text,
	`openalex_id` text,
	`title` text,
	`normalised_title` text,
	`container_title` text,
	`issued_year` integer,
	`first_author_family` text,
	`authors` text DEFAULT '[]' NOT NULL,
	`raw_record` text,
	`raw_reference_string` text,
	`cited_by_count` integer,
	`discovered_via` text NOT NULL,
	`discovered_from_item_id` text,
	`discovered_in_job_id` text,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`seen_count` integer DEFAULT 1 NOT NULL,
	`promotion_status` text DEFAULT 'none' NOT NULL,
	`promoted_item_id` text,
	`promoted_at` text,
	`matched_item_id` text,
	FOREIGN KEY (`discovered_from_item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`discovered_in_job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`promoted_item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`matched_item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_shadow_works_discovered_via" CHECK("discovered_via" in ('reference_list', 'cited_by', 'deep_dive', 'search', 'import')),
	CONSTRAINT "ck_shadow_works_promotion_status" CHECK("promotion_status" in ('none', 'queued', 'promoted', 'rejected')),
	CONSTRAINT "ck_shadow_works_promotion" CHECK(("promotion_status" = 'promoted') = ("promoted_item_id" is not null)),
	CONSTRAINT "ck_shadow_works_authors_json" CHECK(json_valid("authors")),
	CONSTRAINT "ck_shadow_works_raw_json" CHECK("raw_record" is null or json_valid("raw_record"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_shadow_works_source` ON `shadow_works` (`source`,`source_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ux_shadow_works_doi` ON `shadow_works` (`doi`) WHERE doi is not null;--> statement-breakpoint
CREATE INDEX `ix_shadow_works_match` ON `shadow_works` (`normalised_title`,`issued_year`);--> statement-breakpoint
CREATE INDEX `ix_shadow_works_matched_item` ON `shadow_works` (`matched_item_id`) WHERE matched_item_id is not null;--> statement-breakpoint
CREATE INDEX `ix_shadow_works_seen_count` ON `shadow_works` (`seen_count`);--> statement-breakpoint
CREATE INDEX `ix_shadow_works_discovered_from` ON `shadow_works` (`discovered_from_item_id`) WHERE discovered_from_item_id is not null;--> statement-breakpoint
CREATE TABLE `terms` (
	`id` text PRIMARY KEY NOT NULL,
	`scheme` text NOT NULL,
	`code` text,
	`label` text NOT NULL,
	`normalised_label` text NOT NULL,
	`parent_id` text,
	`preferred_term_id` text,
	`tree_numbers` text,
	`depth` integer,
	`external_uri` text,
	`scope_note` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `terms`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`preferred_term_id`) REFERENCES `terms`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_terms_preferred_not_self" CHECK("preferred_term_id" is null or "preferred_term_id" <> "id"),
	CONSTRAINT "ck_terms_is_active_bool" CHECK("is_active" in (0, 1)),
	CONSTRAINT "ck_terms_tree_numbers_json" CHECK("tree_numbers" is null or json_valid("tree_numbers"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_terms_scheme_code` ON `terms` (`scheme`,`code`) WHERE code is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `ux_terms_scheme_label` ON `terms` (`scheme`,`normalised_label`);--> statement-breakpoint
CREATE INDEX `ix_terms_parent_id` ON `terms` (`parent_id`);--> statement-breakpoint
CREATE INDEX `ix_terms_preferred_term_id` ON `terms` (`preferred_term_id`) WHERE preferred_term_id is not null;--> statement-breakpoint
CREATE INDEX `ix_terms_normalised_label` ON `terms` (`normalised_label`);