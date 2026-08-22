CREATE TABLE `field_provenance` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`field_path` text NOT NULL,
	`source` text NOT NULL,
	`source_record_id` text,
	`source_version` text,
	`confidence` real,
	`fetched_at` text NOT NULL,
	`applied_at` text NOT NULL,
	`locked` integer DEFAULT false NOT NULL,
	`locked_at` text,
	`locked_by_user_id` text,
	`previous_value` text,
	FOREIGN KEY (`locked_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_field_provenance_entity_type" CHECK("entity_type" in ('item_bibliographic', 'item_office', 'creator', 'item_creator')),
	CONSTRAINT "ck_field_provenance_field_path" CHECK("field_path" <> ''),
	CONSTRAINT "ck_field_provenance_source" CHECK("source" <> ''),
	CONSTRAINT "ck_field_provenance_confidence" CHECK("confidence" is null or ("confidence" >= 0 and "confidence" <= 1)),
	CONSTRAINT "ck_field_provenance_locked_bool" CHECK("locked" in (0, 1)),
	CONSTRAINT "ck_field_provenance_locked_at" CHECK(("locked" = 0) = ("locked_at" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_field_provenance_current` ON `field_provenance` (`entity_type`,`entity_id`,`field_path`);--> statement-breakpoint
CREATE INDEX `ix_field_provenance_entity` ON `field_provenance` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `ix_field_provenance_locked` ON `field_provenance` (`entity_type`,`entity_id`) WHERE locked = 1;--> statement-breakpoint
CREATE INDEX `ix_field_provenance_source` ON `field_provenance` (`source`);