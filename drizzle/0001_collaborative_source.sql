CREATE TABLE `build_files` (
	`build_id` text NOT NULL,
	`path` text NOT NULL,
	`content` text NOT NULL,
	`language` text NOT NULL,
	`sha256` text NOT NULL,
	`byte_count` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`build_id`, `path`),
	FOREIGN KEY (`build_id`) REFERENCES `builds`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "build_files_path_check" CHECK("build_files"."path" IN ('index.html', 'styles.css')),
	CONSTRAINT "build_files_language_check" CHECK(("build_files"."path" = 'index.html' AND "build_files"."language" = 'html') OR ("build_files"."path" = 'styles.css' AND "build_files"."language" = 'css')),
	CONSTRAINT "build_files_byte_count_check" CHECK("build_files"."byte_count" >= 0 AND "build_files"."byte_count" <= 65536),
	CONSTRAINT "build_files_sha256_check" CHECK(length("build_files"."sha256") = 64 AND "build_files"."sha256" NOT GLOB '*[^0-9a-f]*')
);
--> statement-breakpoint
ALTER TABLE `builds` ADD `source_kind` text DEFAULT 'legacy' NOT NULL;