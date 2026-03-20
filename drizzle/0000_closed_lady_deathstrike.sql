CREATE TABLE `lap_analyses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lap_id` integer NOT NULL,
	`analysis` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`model` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`lap_id`) REFERENCES `laps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lap_analyses_lap_id_unique` ON `lap_analyses` (`lap_id`);--> statement-breakpoint
CREATE TABLE `laps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`lap_number` integer NOT NULL,
	`lap_time` real NOT NULL,
	`is_valid` integer DEFAULT true NOT NULL,
	`profile_id` integer,
	`pi` integer,
	`tune_id` integer,
	`telemetry` blob NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tune_id`) REFERENCES `tunes`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_laps_session` ON `laps` (`session_id`);--> statement-breakpoint
CREATE TABLE `profiles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`car_ordinal` integer NOT NULL,
	`track_ordinal` integer NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `track_corners` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`track_ordinal` integer NOT NULL,
	`corner_index` integer NOT NULL,
	`label` text NOT NULL,
	`distance_start` real NOT NULL,
	`distance_end` real NOT NULL,
	`is_auto` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_corners_track` ON `track_corners` (`track_ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `track_corners_track_ordinal_corner_index_unique` ON `track_corners` (`track_ordinal`,`corner_index`);--> statement-breakpoint
CREATE TABLE `track_outlines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`track_ordinal` integer NOT NULL,
	`outline` blob NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`sectors` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `track_outlines_track_ordinal_unique` ON `track_outlines` (`track_ordinal`);--> statement-breakpoint
CREATE INDEX `idx_outlines_track` ON `track_outlines` (`track_ordinal`);--> statement-breakpoint
CREATE TABLE `tune_assignments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`car_ordinal` integer NOT NULL,
	`track_ordinal` integer NOT NULL,
	`tune_id` integer NOT NULL,
	FOREIGN KEY (`tune_id`) REFERENCES `tunes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_assignments_tune` ON `tune_assignments` (`tune_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tune_assignments_car_ordinal_track_ordinal_unique` ON `tune_assignments` (`car_ordinal`,`track_ordinal`);--> statement-breakpoint
CREATE TABLE `tunes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`author` text NOT NULL,
	`car_ordinal` integer NOT NULL,
	`category` text NOT NULL,
	`track_ordinal` integer,
	`description` text DEFAULT '' NOT NULL,
	`strengths` text,
	`weaknesses` text,
	`best_tracks` text,
	`strategies` text,
	`settings` text NOT NULL,
	`source` text DEFAULT 'user' NOT NULL,
	`catalog_id` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_tunes_car` ON `tunes` (`car_ordinal`);