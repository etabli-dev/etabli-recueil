CREATE TABLE `curated_network_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`network_id` text NOT NULL,
	`version` integer NOT NULL,
	`parent_version_id` text,
	`document` text NOT NULL,
	`is_frozen` integer DEFAULT false NOT NULL,
	`frozen_at` text,
	`frozen_snapshot` text,
	`message` text,
	`created_by_user_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`network_id`) REFERENCES `curated_networks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_version_id`) REFERENCES `curated_network_versions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_curated_network_versions_frozen" CHECK(("is_frozen" = 1) = ("frozen_snapshot" is not null)),
	CONSTRAINT "ck_curated_network_versions_version" CHECK("version" >= 1),
	CONSTRAINT "ck_curated_network_versions_frozen_bool" CHECK("is_frozen" in (0, 1)),
	CONSTRAINT "ck_curated_network_versions_document_json" CHECK(json_valid("document")),
	CONSTRAINT "ck_curated_network_versions_snapshot_json" CHECK("frozen_snapshot" is null or json_valid("frozen_snapshot"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_curated_network_versions_number` ON `curated_network_versions` (`network_id`,`version`);--> statement-breakpoint
CREATE TABLE `curated_networks` (
	`id` text PRIMARY KEY NOT NULL,
	`public_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`owner_user_id` text NOT NULL,
	`review_id` text,
	`current_version_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`trashed_at` text,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_curated_networks_public_id` ON `curated_networks` (`public_id`);--> statement-breakpoint
CREATE INDEX `ix_curated_networks_owner` ON `curated_networks` (`owner_user_id`);