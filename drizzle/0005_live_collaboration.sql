CREATE TABLE `editor_presence` (
	`room_id` text NOT NULL,
	`user_id` text NOT NULL,
	`path` text NOT NULL,
	`cursor_line` integer DEFAULT 1 NOT NULL,
	`cursor_column` integer DEFAULT 1 NOT NULL,
	`selection_end_line` integer DEFAULT 1 NOT NULL,
	`selection_end_column` integer DEFAULT 1 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`room_id`, `user_id`),
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `editor_presence_room_idx` ON `editor_presence` (`room_id`,`updated_at`);
--> statement-breakpoint
CREATE TABLE `live_file_drafts` (
	`room_id` text NOT NULL,
	`path` text NOT NULL,
	`base_build_id` text NOT NULL,
	`content` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`room_id`, `path`),
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`base_build_id`) REFERENCES `builds`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `live_file_drafts_room_idx` ON `live_file_drafts` (`room_id`,`updated_at`);
--> statement-breakpoint
CREATE TABLE `file_leases` (
	`room_id` text NOT NULL,
	`path` text NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`room_id`, `path`),
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `file_leases_user_idx` ON `file_leases` (`user_id`);
--> statement-breakpoint
CREATE TABLE `playtest_links` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`build_id` text NOT NULL,
	`created_by` text NOT NULL,
	`label` text DEFAULT 'External playtest' NOT NULL,
	`token_hash` text NOT NULL,
	`token_prefix` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`build_id`) REFERENCES `builds`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `playtest_links_token_unique` ON `playtest_links` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `playtest_links_room_idx` ON `playtest_links` (`room_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `playtest_feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`link_id` text NOT NULL,
	`display_name` text DEFAULT 'Playtester' NOT NULL,
	`rating` integer NOT NULL CHECK(`rating` BETWEEN 1 AND 5),
	`body` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`link_id`) REFERENCES `playtest_links`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `playtest_feedback_link_idx` ON `playtest_feedback` (`link_id`,`created_at`);
