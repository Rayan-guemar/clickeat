CREATE TABLE `reservation_queue` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`request_key` text NOT NULL,
	`visitor_id` text NOT NULL,
	`request_id` text NOT NULL,
	`payload` text NOT NULL,
	`received_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reservation_queue_request_key_unique` ON `reservation_queue` (`request_key`);--> statement-breakpoint
CREATE TABLE `visitors` (
	`id` text PRIMARY KEY NOT NULL,
	`auth_key` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `visitors_auth_key_unique` ON `visitors` (`auth_key`);