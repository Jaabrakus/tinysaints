PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_build_files` (
	`build_id` text NOT NULL,
	`path` text NOT NULL,
	`content` text NOT NULL,
	`language` text NOT NULL,
	`sha256` text NOT NULL,
	`byte_count` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`build_id`, `path`),
	FOREIGN KEY (`build_id`) REFERENCES `builds`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "build_files_path_length_check" CHECK(length("__new_build_files"."path") BETWEEN 1 AND 120),
	CONSTRAINT "build_files_path_start_check" CHECK("__new_build_files"."path" NOT LIKE '/%'),
	CONSTRAINT "build_files_path_end_check" CHECK("__new_build_files"."path" NOT LIKE '%/'),
	CONSTRAINT "build_files_path_slashes_check" CHECK("__new_build_files"."path" NOT LIKE '%//%'),
	CONSTRAINT "build_files_language_check" CHECK("__new_build_files"."language" IN ('html', 'css', 'javascript', 'json', 'markdown', 'text')),
	CONSTRAINT "build_files_byte_count_check" CHECK("__new_build_files"."byte_count" >= 0 AND "__new_build_files"."byte_count" <= 65536),
	CONSTRAINT "build_files_sha256_check" CHECK(length("__new_build_files"."sha256") = 64 AND "__new_build_files"."sha256" NOT GLOB '*[^0-9a-f]*')
);
--> statement-breakpoint
INSERT INTO `__new_build_files`("build_id", "path", "content", "language", "sha256", "byte_count", "created_at") SELECT "build_id", "path", "content", "language", "sha256", "byte_count", "created_at" FROM `build_files`;--> statement-breakpoint
DROP TABLE `build_files`;--> statement-breakpoint
ALTER TABLE `__new_build_files` RENAME TO `build_files`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `builds` ADD `agent_label` text;--> statement-breakpoint
ALTER TABLE `rooms` ADD `presented_at` text;