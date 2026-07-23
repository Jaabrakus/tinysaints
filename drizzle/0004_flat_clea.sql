CREATE TABLE `project_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`uploaded_by` text NOT NULL,
	`source_asset_id` text,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`content_type` text NOT NULL,
	`object_key` text NOT NULL,
	`sha256` text NOT NULL,
	`byte_count` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "project_assets_kind_check" CHECK("project_assets"."kind" IN ('image', 'audio')),
	CONSTRAINT "project_assets_byte_count_check" CHECK("project_assets"."byte_count" > 0 AND "project_assets"."byte_count" <= 5242880),
	CONSTRAINT "project_assets_sha256_check" CHECK(length("project_assets"."sha256") = 64 AND "project_assets"."sha256" NOT GLOB '*[^0-9a-f]*')
);
--> statement-breakpoint
CREATE INDEX `project_assets_room_idx` ON `project_assets` (`room_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `project_assets_object_idx` ON `project_assets` (`object_key`);