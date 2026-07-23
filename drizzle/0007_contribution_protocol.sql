CREATE TABLE `contributions` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`kind` text NOT NULL CHECK(`kind` IN ('context', 'patch', 'asset', 'test', 'fork')),
	`visibility` text DEFAULT 'private' NOT NULL CHECK(`visibility` IN ('private', 'shared', 'published')),
	`status` text DEFAULT 'inbox' NOT NULL CHECK(`status` IN ('inbox', 'shared', 'accepted', 'rejected', 'superseded', 'conflicted')),
	`provider_label` text DEFAULT 'Human' NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`recommendation` text DEFAULT '' NOT NULL,
	`files_json` text DEFAULT '[]' NOT NULL,
	`line_refs_json` text DEFAULT '[]' NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`base_build_id` text,
	`parent_contribution_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`shared_at` text,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `contributions_room_visibility_idx` ON `contributions` (`room_id`,`visibility`,`created_at`);
--> statement-breakpoint
CREATE INDEX `contributions_owner_status_idx` ON `contributions` (`owner_id`,`status`,`created_at`);
--> statement-breakpoint
CREATE TABLE `contribution_reactions` (
	`contribution_id` text NOT NULL,
	`user_id` text NOT NULL,
	`reaction` text NOT NULL CHECK(`reaction` IN ('useful', 'test', 'implement', 'clarify')),
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`contribution_id`, `user_id`, `reaction`),
	FOREIGN KEY (`contribution_id`) REFERENCES `contributions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `contribution_reactions_user_idx` ON `contribution_reactions` (`user_id`);
--> statement-breakpoint
CREATE TABLE `contribution_links` (
	`source_id` text NOT NULL,
	`target_id` text NOT NULL,
	`relation` text NOT NULL CHECK(`relation` IN ('supports', 'conflicts', 'supersedes', 'implements', 'tests')),
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`source_id`, `target_id`, `relation`),
	FOREIGN KEY (`source_id`) REFERENCES `contributions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_id`) REFERENCES `contributions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `contribution_links_target_idx` ON `contribution_links` (`target_id`);
