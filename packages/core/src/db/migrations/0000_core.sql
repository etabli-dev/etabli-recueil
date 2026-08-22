CREATE TABLE `annotation_tags` (
	`annotation_id` text NOT NULL,
	`tag_id` text NOT NULL,
	`added_at` text NOT NULL,
	PRIMARY KEY(`annotation_id`, `tag_id`),
	FOREIGN KEY (`annotation_id`) REFERENCES `annotations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_annotation_tags_tag_id` ON `annotation_tags` (`tag_id`);--> statement-breakpoint
CREATE TABLE `annotations` (
	`id` text PRIMARY KEY NOT NULL,
	`public_id` text NOT NULL,
	`document_id` text NOT NULL,
	`item_id` text,
	`attachment_id` text,
	`annotation_type` text NOT NULL,
	`motivation` text NOT NULL,
	`selector` text DEFAULT '{}' NOT NULL,
	`quoted_text` text,
	`prefix_text` text,
	`suffix_text` text,
	`body_text` text,
	`body_format` text DEFAULT 'markdown' NOT NULL,
	`colour` text,
	`page_index` integer,
	`page_label` text,
	`position_sort_key` text NOT NULL,
	`author_user_id` text,
	`author_name` text,
	`is_external` integer DEFAULT false NOT NULL,
	`external_ref` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`trashed_at` text,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`attachment_id`) REFERENCES `attachments`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`author_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_annotations_type" CHECK("annotation_type" in ('highlight', 'underline', 'strikeout', 'note', 'area', 'ink', 'text')),
	CONSTRAINT "ck_annotations_motivation" CHECK("motivation" in ('highlighting', 'commenting', 'describing', 'questioning', 'bookmarking')),
	CONSTRAINT "ck_annotations_body_format" CHECK("body_format" in ('markdown', 'text')),
	CONSTRAINT "ck_annotations_body" CHECK("annotation_type" <> 'note' or "body_text" is not null),
	CONSTRAINT "ck_annotations_version" CHECK("version" >= 1),
	CONSTRAINT "ck_annotations_is_external_bool" CHECK("is_external" in (0, 1)),
	CONSTRAINT "ck_annotations_selector_json" CHECK(json_valid("selector"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_annotations_public_id` ON `annotations` (`public_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ux_annotations_external` ON `annotations` (`document_id`,`external_ref`) WHERE external_ref is not null;--> statement-breakpoint
CREATE INDEX `ix_annotations_document_sort` ON `annotations` (`document_id`,`position_sort_key`) WHERE trashed_at is null;--> statement-breakpoint
CREATE INDEX `ix_annotations_item` ON `annotations` (`item_id`) WHERE item_id is not null;--> statement-breakpoint
CREATE INDEX `ix_annotations_author` ON `annotations` (`author_user_id`);--> statement-breakpoint
CREATE TABLE `api_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`token_prefix` text NOT NULL,
	`token_hash` text NOT NULL,
	`scopes` text DEFAULT '[]' NOT NULL,
	`client` text NOT NULL,
	`created_at` text NOT NULL,
	`created_by_user_id` text,
	`expires_at` text,
	`last_used_at` text,
	`revoked_at` text,
	`note` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_api_tokens_client" CHECK("client" in ('cli', 'mcp', 'connector', 'r', 'python', 'web_session', 'bib_feed', 'other')),
	CONSTRAINT "ck_api_tokens_scopes_json" CHECK(json_valid("scopes"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_api_tokens_token_hash` ON `api_tokens` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `ux_api_tokens_token_prefix` ON `api_tokens` (`token_prefix`);--> statement-breakpoint
CREATE INDEX `ix_api_tokens_user_id` ON `api_tokens` (`user_id`);--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`document_id` text,
	`role` text NOT NULL,
	`link_mode` text DEFAULT 'stored' NOT NULL,
	`title` text,
	`url` text,
	`linked_path` text,
	`content_type_hint` text,
	`has_annotations` integer DEFAULT false NOT NULL,
	`annotation_count` integer DEFAULT 0 NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`added_at` text NOT NULL,
	`added_by_user_id` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`updated_at` text NOT NULL,
	`trashed_at` text,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`added_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_attachments_role" CHECK("role" in ('primary', 'supplement', 'snapshot', 'scan', 'preprint', 'accepted_manuscript', 'data', 'code', 'cover', 'source_export', 'other')),
	CONSTRAINT "ck_attachments_link_mode_vocab" CHECK("link_mode" in ('stored', 'linked_file', 'linked_url')),
	CONSTRAINT "ck_attachments_source" CHECK("source" in ('manual', 'ingest', 'import', 'connector', 'resolver', 'merge')),
	CONSTRAINT "ck_attachments_link_mode" CHECK(("link_mode" = 'linked_url' and "document_id" is null and "url" is not null)
        or ("link_mode" = 'linked_file' and "document_id" is null and "linked_path" is not null)
        or ("link_mode" = 'stored' and "document_id" is not null)),
	CONSTRAINT "ck_attachments_annotation_count" CHECK("annotation_count" >= 0),
	CONSTRAINT "ck_attachments_has_annotations_bool" CHECK("has_annotations" in (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_attachments_item_document` ON `attachments` (`item_id`,`document_id`) WHERE document_id is not null and trashed_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX `ux_attachments_primary` ON `attachments` (`item_id`) WHERE role = 'primary' and trashed_at is null;--> statement-breakpoint
CREATE INDEX `ix_attachments_document_id` ON `attachments` (`document_id`) WHERE trashed_at is null;--> statement-breakpoint
CREATE INDEX `ix_attachments_item_position` ON `attachments` (`item_id`,`position`);--> statement-breakpoint
CREATE INDEX `ix_attachments_role` ON `attachments` (`role`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`occurred_at` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_user_id` text,
	`actor_token_id` text,
	`actor_plugin_id` text,
	`actor_job_id` text,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`before` text,
	`after` text,
	`reason` text,
	`request_id` text,
	`api_route` text,
	`ip_address` text,
	`user_agent` text,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`actor_token_id`) REFERENCES `api_tokens`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`actor_job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_audit_log_actor_type" CHECK("actor_type" in ('user', 'token', 'system', 'plugin', 'job', 'mcp', 'import')),
	CONSTRAINT "ck_audit_log_before_json" CHECK("before" is null or json_valid("before")),
	CONSTRAINT "ck_audit_log_after_json" CHECK("after" is null or json_valid("after"))
);
--> statement-breakpoint
CREATE INDEX `ix_audit_log_entity` ON `audit_log` (`entity_type`,`entity_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `ix_audit_log_occurred_at` ON `audit_log` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `ix_audit_log_actor_user` ON `audit_log` (`actor_user_id`) WHERE actor_user_id is not null;--> statement-breakpoint
CREATE INDEX `ix_audit_log_request` ON `audit_log` (`request_id`) WHERE request_id is not null;--> statement-breakpoint
CREATE INDEX `ix_audit_log_action` ON `audit_log` (`action`);--> statement-breakpoint
CREATE TABLE `collection_items` (
	`collection_id` text NOT NULL,
	`item_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`added_at` text NOT NULL,
	`added_by_user_id` text,
	`source` text DEFAULT 'manual' NOT NULL,
	PRIMARY KEY(`collection_id`, `item_id`),
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`added_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_collection_items_source" CHECK("source" in ('manual', 'rule', 'import', 'connector', 'merge', 'plugin'))
);
--> statement-breakpoint
CREATE INDEX `ix_collection_items_item_id` ON `collection_items` (`item_id`);--> statement-breakpoint
CREATE TABLE `collections` (
	`id` text PRIMARY KEY NOT NULL,
	`public_id` text NOT NULL,
	`name` text NOT NULL,
	`name_normalised` text NOT NULL,
	`parent_id` text,
	`parent_key` text DEFAULT '' NOT NULL,
	`owner_user_id` text NOT NULL,
	`kind` text DEFAULT 'manual' NOT NULL,
	`query` text,
	`query_backend` text,
	`description` text,
	`colour` text,
	`depth` integer DEFAULT 0 NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`trashed_at` text,
	FOREIGN KEY (`parent_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_collections_kind" CHECK("kind" in ('manual', 'smart')),
	CONSTRAINT "ck_collections_query_backend" CHECK("query_backend" is null or "query_backend" in ('fts5', 'meilisearch', 'sql')),
	CONSTRAINT "ck_collections_smart" CHECK(("kind" = 'smart') = ("query" is not null)),
	CONSTRAINT "ck_collections_depth" CHECK("depth" >= 0),
	CONSTRAINT "ck_collections_parent_key" CHECK("parent_key" = coalesce("parent_id", '')),
	CONSTRAINT "ck_collections_query_json" CHECK("query" is null or json_valid("query"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_collections_public_id` ON `collections` (`public_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ux_collections_sibling_name` ON `collections` (`owner_user_id`,`parent_key`,`name_normalised`) WHERE trashed_at is null;--> statement-breakpoint
CREATE INDEX `ix_collections_parent` ON `collections` (`parent_id`,`position`);--> statement-breakpoint
CREATE INDEX `ix_collections_owner_live` ON `collections` (`owner_user_id`,`position`) WHERE trashed_at is null;--> statement-breakpoint
CREATE TABLE `creators` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`family_name` text,
	`given_name` text,
	`name_prefix` text,
	`name_suffix` text,
	`literal_name` text,
	`display_name` text NOT NULL,
	`sort_name` text NOT NULL,
	`initials` text,
	`name_variants` text DEFAULT '[]' NOT NULL,
	`orcid` text,
	`openalex_author_id` text,
	`semantic_scholar_author_id` text,
	`scopus_author_id` text,
	`researcher_id` text,
	`isni` text,
	`viaf` text,
	`ror` text,
	`wikidata_id` text,
	`disambiguation_status` text DEFAULT 'unreviewed' NOT NULL,
	`merged_into_creator_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`trashed_at` text,
	FOREIGN KEY (`merged_into_creator_id`) REFERENCES `creators`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_creators_kind" CHECK("kind" in ('person', 'organisation')),
	CONSTRAINT "ck_creators_disambiguation" CHECK("disambiguation_status" in ('unreviewed', 'confirmed', 'ambiguous', 'merged')),
	CONSTRAINT "ck_creators_name" CHECK("literal_name" is not null or "family_name" is not null),
	CONSTRAINT "ck_creators_org" CHECK("kind" <> 'organisation' or "literal_name" is not null),
	CONSTRAINT "ck_creators_merged" CHECK(("disambiguation_status" = 'merged') = ("merged_into_creator_id" is not null)),
	CONSTRAINT "ck_creators_name_variants_json" CHECK(json_valid("name_variants"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_creators_orcid` ON `creators` (`orcid`) WHERE orcid is not null and trashed_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX `ux_creators_openalex` ON `creators` (`openalex_author_id`) WHERE openalex_author_id is not null and trashed_at is null;--> statement-breakpoint
CREATE INDEX `ix_creators_sort_name` ON `creators` (`sort_name`) WHERE trashed_at is null;--> statement-breakpoint
CREATE INDEX `ix_creators_ror` ON `creators` (`ror`) WHERE ror is not null;--> statement-breakpoint
CREATE INDEX `ix_creators_disambiguation` ON `creators` (`disambiguation_status`) WHERE disambiguation_status = 'ambiguous';--> statement-breakpoint
CREATE TABLE `custom_fields` (
	`id` text PRIMARY KEY NOT NULL,
	`field_key` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`data_type` text NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`applies_to_item_types` text,
	`is_required` integer DEFAULT false NOT NULL,
	`is_repeatable` integer DEFAULT false NOT NULL,
	`scope` text DEFAULT 'library' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "ck_custom_fields_data_type" CHECK("data_type" in ('text', 'long_text', 'number', 'integer', 'boolean', 'date', 'datetime', 'choice', 'multi_choice', 'json', 'item_reference', 'url', 'monetary')),
	CONSTRAINT "ck_custom_fields_scope" CHECK("scope" in ('library', 'review')),
	CONSTRAINT "ck_custom_fields_is_required_bool" CHECK("is_required" in (0, 1)),
	CONSTRAINT "ck_custom_fields_is_repeatable_bool" CHECK("is_repeatable" in (0, 1)),
	CONSTRAINT "ck_custom_fields_config_json" CHECK(json_valid("config")),
	CONSTRAINT "ck_custom_fields_applies_json" CHECK("applies_to_item_types" is null or json_valid("applies_to_item_types"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_custom_fields_field_key` ON `custom_fields` (`field_key`);--> statement-breakpoint
CREATE TABLE `document_provenance` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`sha256` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_ref` text,
	`source_detail` text DEFAULT '{}' NOT NULL,
	`original_filename` text,
	`declared_mime_type` text,
	`is_first` integer DEFAULT false NOT NULL,
	`observed_at` text NOT NULL,
	`job_id` text,
	`created_by_user_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_document_provenance_source_kind" CHECK("source_kind" in ('upload', 'folder', 'webdav', 'imap', 'scanner', 'connector', 'mobile', 'import', 'api', 'plugin', 'derived')),
	CONSTRAINT "ck_document_provenance_is_first_bool" CHECK("is_first" in (0, 1)),
	CONSTRAINT "ck_document_provenance_source_detail_json" CHECK(json_valid("source_detail"))
);
--> statement-breakpoint
CREATE INDEX `ix_document_provenance_document` ON `document_provenance` (`document_id`,`observed_at`);--> statement-breakpoint
CREATE INDEX `ix_document_provenance_sha256` ON `document_provenance` (`sha256`);--> statement-breakpoint
CREATE INDEX `ix_document_provenance_source` ON `document_provenance` (`source_kind`,`source_ref`);--> statement-breakpoint
CREATE UNIQUE INDEX `ux_document_provenance_first` ON `document_provenance` (`document_id`) WHERE is_first = 1;--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`sha256` text NOT NULL,
	`byte_size` integer NOT NULL,
	`mime_type` text NOT NULL,
	`mime_source` text NOT NULL,
	`original_filename` text,
	`storage_backend` text NOT NULL,
	`storage_key` text NOT NULL,
	`storage_verified_at` text,
	`storage_ok` integer DEFAULT true NOT NULL,
	`page_count` integer,
	`has_text_layer` integer,
	`text_extracted_at` text,
	`text_char_count` integer,
	`ocr_status` text DEFAULT 'not_applicable' NOT NULL,
	`simhash` text,
	`source_kind` text NOT NULL,
	`source_ref` text,
	`source_detail` text DEFAULT '{}' NOT NULL,
	`parent_document_id` text,
	`ingested_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`trashed_at` text,
	FOREIGN KEY (`parent_document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_documents_sha256_shape" CHECK(length("sha256") = 64),
	CONSTRAINT "ck_documents_byte_size" CHECK("byte_size" >= 0),
	CONSTRAINT "ck_documents_storage" CHECK("storage_key" <> ''),
	CONSTRAINT "ck_documents_mime_source" CHECK("mime_source" in ('sniffed', 'declared', 'extension', 'manual')),
	CONSTRAINT "ck_documents_storage_backend" CHECK("storage_backend" in ('local', 'webdav', 's3')),
	CONSTRAINT "ck_documents_ocr_status" CHECK("ocr_status" in ('not_applicable', 'not_needed', 'pending', 'done', 'failed', 'skipped')),
	CONSTRAINT "ck_documents_source_kind" CHECK("source_kind" in ('upload', 'folder', 'webdav', 'imap', 'scanner', 'connector', 'mobile', 'import', 'api', 'plugin', 'derived')),
	CONSTRAINT "ck_documents_storage_ok_bool" CHECK("storage_ok" in (0, 1)),
	CONSTRAINT "ck_documents_has_text_layer_bool" CHECK("has_text_layer" in (0, 1)),
	CONSTRAINT "ck_documents_source_detail_json" CHECK(json_valid("source_detail"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_documents_sha256` ON `documents` (`sha256`);--> statement-breakpoint
CREATE INDEX `ix_documents_mime_type` ON `documents` (`mime_type`);--> statement-breakpoint
CREATE INDEX `ix_documents_ingested_at` ON `documents` (`ingested_at`);--> statement-breakpoint
CREATE INDEX `ix_documents_simhash` ON `documents` (`simhash`) WHERE simhash is not null and trashed_at is null;--> statement-breakpoint
CREATE INDEX `ix_documents_source` ON `documents` (`source_kind`,`source_ref`);--> statement-breakpoint
CREATE INDEX `ix_documents_parent_document_id` ON `documents` (`parent_document_id`) WHERE parent_document_id is not null;--> statement-breakpoint
CREATE INDEX `ix_documents_live` ON `documents` (`ingested_at`) WHERE trashed_at is null;--> statement-breakpoint
CREATE TABLE `field_values` (
	`id` text PRIMARY KEY NOT NULL,
	`field_id` text NOT NULL,
	`item_id` text NOT NULL,
	`group_key` text,
	`group_scope_key` text DEFAULT '' NOT NULL,
	`ordinal` integer DEFAULT 0 NOT NULL,
	`value_text` text,
	`value_number` real,
	`value_integer` integer,
	`value_boolean` integer,
	`value_date` text,
	`value_json` text,
	`value_item_id` text,
	`is_blank` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`created_by_user_id` text,
	FOREIGN KEY (`field_id`) REFERENCES `custom_fields`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`value_item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_field_values_ordinal" CHECK("ordinal" >= 0),
	CONSTRAINT "ck_field_values_group_scope_key" CHECK("group_scope_key" = coalesce("group_key", '')),
	CONSTRAINT "ck_field_values_one_value" CHECK((
        (case when "value_text" is null then 0 else 1 end)
        + (case when "value_number" is null then 0 else 1 end)
        + (case when "value_integer" is null then 0 else 1 end)
        + (case when "value_boolean" is null then 0 else 1 end)
        + (case when "value_date" is null then 0 else 1 end)
        + (case when "value_json" is null then 0 else 1 end)
        + (case when "value_item_id" is null then 0 else 1 end)
      ) = case when "is_blank" = 1 then 0 else 1 end),
	CONSTRAINT "ck_field_values_value_boolean_bool" CHECK("value_boolean" in (0, 1)),
	CONSTRAINT "ck_field_values_is_blank_bool" CHECK("is_blank" in (0, 1)),
	CONSTRAINT "ck_field_values_value_json" CHECK("value_json" is null or json_valid("value_json"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_field_values_slot` ON `field_values` (`field_id`,`item_id`,`group_scope_key`,`ordinal`);--> statement-breakpoint
CREATE INDEX `ix_field_values_item` ON `field_values` (`item_id`,`field_id`);--> statement-breakpoint
CREATE INDEX `ix_field_values_field_text` ON `field_values` (`field_id`,`value_text`) WHERE value_text is not null;--> statement-breakpoint
CREATE INDEX `ix_field_values_field_number` ON `field_values` (`field_id`,`value_number`) WHERE value_number is not null;--> statement-breakpoint
CREATE INDEX `ix_field_values_value_item_id` ON `field_values` (`value_item_id`) WHERE value_item_id is not null;--> statement-breakpoint
CREATE TABLE `item_bibliographic` (
	`item_id` text PRIMARY KEY NOT NULL,
	`csl_type` text,
	`title` text,
	`subtitle` text,
	`short_title` text,
	`container_title` text,
	`container_short` text,
	`collection_title` text,
	`collection_number` text,
	`publisher` text,
	`publisher_place` text,
	`edition` text,
	`volume` text,
	`issue` text,
	`pages` text,
	`page_first` integer,
	`page_last` integer,
	`number_of_pages` integer,
	`issued_date` text,
	`issued_year` integer,
	`issued_month` integer,
	`available_date` text,
	`accessed_at` text,
	`doi` text,
	`pmid` text,
	`pmcid` text,
	`arxiv_id` text,
	`isbn` text,
	`issn` text,
	`eissn` text,
	`issn_l` text,
	`openalex_id` text,
	`semantic_scholar_id` text,
	`datacite_doi` text,
	`handle` text,
	`url` text,
	`abstract` text,
	`language_code` text,
	`citation_key` text,
	`citation_key_locked` integer DEFAULT false NOT NULL,
	`citation_key_formula` text,
	`licence` text,
	`oa_status` text,
	`oa_url` text,
	`oa_checked_at` text,
	`is_preprint` integer DEFAULT false NOT NULL,
	`published_version_doi` text,
	`preprint_checked_at` text,
	`version_label` text,
	`retraction_status` text DEFAULT 'unknown' NOT NULL,
	`retraction_notice_doi` text,
	`retraction_checked_at` text,
	`item_trashed_at` text,
	`verification_status` text DEFAULT 'unverified' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_item_bibliographic_pages" CHECK("page_last" is null or "page_first" is null or "page_last" >= "page_first"),
	CONSTRAINT "ck_item_bibliographic_issued_month" CHECK("issued_month" is null or ("issued_month" between 1 and 12)),
	CONSTRAINT "ck_item_bibliographic_oa_status" CHECK("oa_status" is null or "oa_status" in ('closed', 'green', 'bronze', 'hybrid', 'gold', 'diamond', 'unknown')),
	CONSTRAINT "ck_item_bibliographic_retraction_status" CHECK("retraction_status" in ('none', 'retracted', 'corrected', 'expression_of_concern', 'withdrawn', 'unknown')),
	CONSTRAINT "ck_item_bibliographic_verification" CHECK("verification_status" in ('unverified', 'verified', 'disputed', 'unverifiable')),
	CONSTRAINT "ck_item_bibliographic_key_locked_bool" CHECK("citation_key_locked" in (0, 1)),
	CONSTRAINT "ck_item_bibliographic_is_preprint_bool" CHECK("is_preprint" in (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_item_bibliographic_doi` ON `item_bibliographic` (`doi`) WHERE doi is not null and item_trashed_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX `ux_item_bibliographic_citation_key` ON `item_bibliographic` (`citation_key`) WHERE citation_key is not null and item_trashed_at is null;--> statement-breakpoint
CREATE INDEX `ix_item_bib_issued_year` ON `item_bibliographic` (`issued_year`);--> statement-breakpoint
CREATE INDEX `ix_item_bib_container_title` ON `item_bibliographic` (`container_title`);--> statement-breakpoint
CREATE INDEX `ix_item_bib_pmid` ON `item_bibliographic` (`pmid`) WHERE pmid is not null;--> statement-breakpoint
CREATE INDEX `ix_item_bib_openalex_id` ON `item_bibliographic` (`openalex_id`) WHERE openalex_id is not null;--> statement-breakpoint
CREATE INDEX `ix_item_bib_arxiv_id` ON `item_bibliographic` (`arxiv_id`) WHERE arxiv_id is not null;--> statement-breakpoint
CREATE INDEX `ix_item_bib_isbn` ON `item_bibliographic` (`isbn`) WHERE isbn is not null;--> statement-breakpoint
CREATE INDEX `ix_item_bib_issn_l` ON `item_bibliographic` (`issn_l`) WHERE issn_l is not null;--> statement-breakpoint
CREATE INDEX `ix_item_bib_retraction_status` ON `item_bibliographic` (`retraction_status`) WHERE retraction_status not in ('none', 'unknown');--> statement-breakpoint
CREATE TABLE `item_creators` (
	`item_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`creator_id` text NOT NULL,
	`role` text DEFAULT 'author' NOT NULL,
	`raw_name` text,
	`affiliation_raw` text,
	`affiliation_ror` text,
	`affiliation_creator_id` text,
	`country_code` text,
	`is_corresponding` integer DEFAULT false NOT NULL,
	`contribution_roles` text,
	`created_at` text NOT NULL,
	PRIMARY KEY(`item_id`, `ordinal`),
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`creator_id`) REFERENCES `creators`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`affiliation_creator_id`) REFERENCES `creators`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_item_creators_ordinal" CHECK("ordinal" >= 0),
	CONSTRAINT "ck_item_creators_role" CHECK("role" in ('author', 'editor', 'translator', 'contributor', 'series_editor', 'recipient', 'interviewer', 'director', 'reviewed_author', 'sender', 'correspondent')),
	CONSTRAINT "ck_item_creators_is_corresponding_bool" CHECK("is_corresponding" in (0, 1)),
	CONSTRAINT "ck_item_creators_contribution_roles_json" CHECK("contribution_roles" is null or json_valid("contribution_roles"))
);
--> statement-breakpoint
CREATE INDEX `ix_item_creators_creator_id` ON `item_creators` (`creator_id`,`item_id`);--> statement-breakpoint
CREATE INDEX `ix_item_creators_role` ON `item_creators` (`item_id`,`role`,`ordinal`);--> statement-breakpoint
CREATE INDEX `ix_item_creators_ror` ON `item_creators` (`affiliation_ror`) WHERE affiliation_ror is not null;--> statement-breakpoint
CREATE TABLE `item_office` (
	`item_id` text PRIMARY KEY NOT NULL,
	`correspondent` text NOT NULL,
	`correspondent_normalised` text,
	`correspondent_creator_id` text,
	`office_document_type` text,
	`document_date` text,
	`asn` integer,
	`reference_number` text,
	`amount_minor` integer,
	`amount_currency` text,
	`due_date` text,
	`period_start` text,
	`period_end` text,
	`item_trashed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`correspondent_creator_id`) REFERENCES `creators`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_item_office_amount" CHECK(("amount_minor" is null) = ("amount_currency" is null)),
	CONSTRAINT "ck_item_office_period" CHECK("period_end" is null or "period_start" is null or "period_end" >= "period_start"),
	CONSTRAINT "ck_item_office_currency_shape" CHECK("amount_currency" is null or length("amount_currency") = 3)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_item_office_asn` ON `item_office` (`asn`) WHERE asn is not null and item_trashed_at is null;--> statement-breakpoint
CREATE INDEX `ix_item_office_correspondent_normalised` ON `item_office` (`correspondent_normalised`);--> statement-breakpoint
CREATE INDEX `ix_item_office_document_date` ON `item_office` (`document_date`);--> statement-breakpoint
CREATE INDEX `ix_item_office_type_date` ON `item_office` (`office_document_type`,`document_date`);--> statement-breakpoint
CREATE TABLE `item_tags` (
	`item_id` text NOT NULL,
	`tag_id` text NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`rule_ref` text,
	`confidence` real,
	`added_at` text NOT NULL,
	`added_by_user_id` text,
	PRIMARY KEY(`item_id`, `tag_id`),
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`added_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_item_tags_source" CHECK("source" in ('manual', 'rule', 'resolver', 'import', 'plugin', 'merge')),
	CONSTRAINT "ck_item_tags_confidence" CHECK("confidence" is null or ("confidence" >= 0 and "confidence" <= 1))
);
--> statement-breakpoint
CREATE INDEX `ix_item_tags_tag_id` ON `item_tags` (`tag_id`);--> statement-breakpoint
CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`public_id` text NOT NULL,
	`item_type` text NOT NULL,
	`title` text,
	`owner_user_id` text NOT NULL,
	`library_state` text DEFAULT 'normal' NOT NULL,
	`merged_into_item_id` text,
	`source_system` text,
	`source_id` text,
	`extra` text,
	`version` integer DEFAULT 1 NOT NULL,
	`date_added` text NOT NULL,
	`date_modified` text NOT NULL,
	`trashed_at` text,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`merged_into_item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_items_library_state" CHECK("library_state" in ('normal', 'merged', 'template')),
	CONSTRAINT "ck_items_version" CHECK("version" >= 1),
	CONSTRAINT "ck_items_merged" CHECK(("library_state" = 'merged') = ("merged_into_item_id" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_items_public_id` ON `items` (`public_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ux_items_source` ON `items` (`source_system`,`source_id`) WHERE source_system is not null and source_id is not null;--> statement-breakpoint
CREATE INDEX `ix_items_item_type` ON `items` (`item_type`);--> statement-breakpoint
CREATE INDEX `ix_items_owner_live` ON `items` (`owner_user_id`,`date_modified`) WHERE trashed_at is null;--> statement-breakpoint
CREATE INDEX `ix_items_date_added` ON `items` (`date_added`);--> statement-breakpoint
CREATE INDEX `ix_items_merged_into` ON `items` (`merged_into_item_id`) WHERE merged_into_item_id is not null;--> statement-breakpoint
CREATE TABLE `job_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`logged_at` text NOT NULL,
	`level` text NOT NULL,
	`message` text NOT NULL,
	`data` text,
	`subject_type` text,
	`subject_id` text,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_job_logs_level" CHECK("level" in ('debug', 'info', 'warn', 'error')),
	CONSTRAINT "ck_job_logs_data_json" CHECK("data" is null or json_valid("data"))
);
--> statement-breakpoint
CREATE INDEX `ix_job_logs_job` ON `job_logs` (`job_id`,`id`);--> statement-breakpoint
CREATE INDEX `ix_job_logs_subject` ON `job_logs` (`subject_id`) WHERE subject_id is not null;--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`job_type` text NOT NULL,
	`idempotency_key` text,
	`params` text DEFAULT '{}' NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`run_after` text NOT NULL,
	`started_at` text,
	`finished_at` text,
	`heartbeat_at` text,
	`lease_expires_at` text,
	`worker_id` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 5 NOT NULL,
	`progress_done` integer DEFAULT 0 NOT NULL,
	`progress_total` integer,
	`cursor` text,
	`result` text,
	`error_code` text,
	`error_message` text,
	`error_detail` text,
	`parent_job_id` text,
	`root_job_id` text,
	`batch_id` text,
	`created_by_user_id` text,
	`created_by_token_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`parent_job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`root_job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by_token_id`) REFERENCES `api_tokens`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_jobs_state" CHECK("state" in ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'waiting_review', 'dead')),
	CONSTRAINT "ck_jobs_attempts" CHECK("attempts" >= 0 and "attempts" <= "max_attempts"),
	CONSTRAINT "ck_jobs_progress" CHECK("progress_done" >= 0),
	CONSTRAINT "ck_jobs_params_json" CHECK(json_valid("params")),
	CONSTRAINT "ck_jobs_cursor_json" CHECK("cursor" is null or json_valid("cursor")),
	CONSTRAINT "ck_jobs_result_json" CHECK("result" is null or json_valid("result")),
	CONSTRAINT "ck_jobs_error_detail_json" CHECK("error_detail" is null or json_valid("error_detail"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_jobs_idempotency_key` ON `jobs` (`idempotency_key`) WHERE idempotency_key is not null;--> statement-breakpoint
CREATE INDEX `ix_jobs_claim` ON `jobs` (`priority`,`run_after`) WHERE state = 'queued';--> statement-breakpoint
CREATE INDEX `ix_jobs_state_updated` ON `jobs` (`state`,`updated_at`);--> statement-breakpoint
CREATE INDEX `ix_jobs_root` ON `jobs` (`root_job_id`) WHERE root_job_id is not null;--> statement-breakpoint
CREATE INDEX `ix_jobs_type_created` ON `jobs` (`job_type`,`created_at`);--> statement-breakpoint
CREATE TABLE `notes` (
	`id` text PRIMARY KEY NOT NULL,
	`public_id` text NOT NULL,
	`item_id` text,
	`parent_annotation_id` text,
	`owner_user_id` text NOT NULL,
	`title` text,
	`content_markdown` text NOT NULL,
	`source_format` text DEFAULT 'markdown' NOT NULL,
	`content_original` text,
	`note_kind` text DEFAULT 'note' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`trashed_at` text,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`parent_annotation_id`) REFERENCES `annotations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_notes_source_format" CHECK("source_format" in ('markdown', 'html')),
	CONSTRAINT "ck_notes_note_kind" CHECK("note_kind" in ('note', 'quote', 'thought', 'summary', 'email_body')),
	CONSTRAINT "ck_notes_version" CHECK("version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_notes_public_id` ON `notes` (`public_id`);--> statement-breakpoint
CREATE INDEX `ix_notes_item_id` ON `notes` (`item_id`) WHERE item_id is not null and trashed_at is null;--> statement-breakpoint
CREATE INDEX `ix_notes_owner_updated` ON `notes` (`owner_user_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`name_normalised` text NOT NULL,
	`colour` text,
	`scheme` text DEFAULT 'manual' NOT NULL,
	`owner_user_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`trashed_at` text,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_tags_scheme" CHECK("scheme" in ('manual', 'automatic', 'imported'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_tags_owner_name` ON `tags` (`owner_user_id`,`name_normalised`) WHERE trashed_at is null;--> statement-breakpoint
CREATE INDEX `ix_tags_scheme` ON `tags` (`scheme`);--> statement-breakpoint
CREATE TABLE `trash` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`group_id` text,
	`trashed_at` text NOT NULL,
	`trashed_by_user_id` text,
	`reason` text DEFAULT 'user' NOT NULL,
	`reason_detail` text,
	`restore_payload` text DEFAULT '{}' NOT NULL,
	`merge_target_item_id` text,
	`merge_record` text,
	`expires_at` text,
	`restored_at` text,
	`restored_by_user_id` text,
	`purged_at` text,
	`purged_by_user_id` text,
	FOREIGN KEY (`trashed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`merge_target_item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`restored_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`purged_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_trash_entity_type" CHECK("entity_type" in ('item', 'document', 'attachment', 'collection', 'note', 'annotation', 'tag', 'creator', 'review', 'curated_network')),
	CONSTRAINT "ck_trash_reason" CHECK("reason" in ('user', 'merge', 'import_rollback', 'cascade', 'plugin')),
	CONSTRAINT "ck_trash_merge" CHECK("reason" <> 'merge' or "merge_target_item_id" is not null),
	CONSTRAINT "ck_trash_restore_payload_json" CHECK(json_valid("restore_payload")),
	CONSTRAINT "ck_trash_merge_record_json" CHECK("merge_record" is null or json_valid("merge_record"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_trash_open` ON `trash` (`entity_type`,`entity_id`) WHERE restored_at is null and purged_at is null;--> statement-breakpoint
CREATE INDEX `ix_trash_open` ON `trash` (`trashed_at`) WHERE restored_at is null and purged_at is null;--> statement-breakpoint
CREATE INDEX `ix_trash_group` ON `trash` (`group_id`) WHERE group_id is not null;--> statement-breakpoint
CREATE INDEX `ix_trash_merge_target` ON `trash` (`merge_target_item_id`) WHERE merge_target_item_id is not null;--> statement-breakpoint
CREATE INDEX `ix_trash_expires` ON `trash` (`expires_at`) WHERE expires_at is not null and purged_at is null;--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`username_normalised` text NOT NULL,
	`email` text,
	`display_name` text,
	`password_hash` text,
	`is_active` integer DEFAULT true NOT NULL,
	`is_admin` integer DEFAULT true NOT NULL,
	`locale` text,
	`timezone` text,
	`settings` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_seen_at` text,
	`trashed_at` text,
	CONSTRAINT "ck_users_is_active_bool" CHECK("is_active" in (0, 1)),
	CONSTRAINT "ck_users_is_admin_bool" CHECK("is_admin" in (0, 1)),
	CONSTRAINT "ck_users_settings_json" CHECK(json_valid("settings"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_users_username_normalised` ON `users` (`username_normalised`);--> statement-breakpoint
--
-- Hand-written tail. drizzle-kit does not manage triggers, and `spec/data-model.md` §6.5 (AL1)
-- requires the audit log to be insert-only in the database and not merely by convention: no
-- update, no delete, no retention policy. This is one of the three deliberately dialect-specific
-- fragments the spec names -- `RAISE(ABORT, ...)` here, a `RAISE EXCEPTION` function in Postgres.
--
CREATE TRIGGER `audit_log_is_append_only_update`
BEFORE UPDATE ON `audit_log`
BEGIN
	SELECT RAISE(ABORT, 'audit_log is append-only (spec/data-model.md AL1)');
END;
--> statement-breakpoint
CREATE TRIGGER `audit_log_is_append_only_delete`
BEFORE DELETE ON `audit_log`
BEGIN
	SELECT RAISE(ABORT, 'audit_log is append-only (spec/data-model.md AL1)');
END;
