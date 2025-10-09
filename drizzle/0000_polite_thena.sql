CREATE TABLE `credentials` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`exchange` text NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `fundings` (
	`time` integer PRIMARY KEY NOT NULL,
	`size` real NOT NULL,
	`rate` real NOT NULL,
	`fee` real DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`id` integer PRIMARY KEY NOT NULL,
	`size` real NOT NULL,
	`side` text NOT NULL,
	`status` text NOT NULL,
	`price` real NOT NULL,
	`fee` real DEFAULT 0 NOT NULL,
	`closedPnl` real DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`closed_at` text
);
--> statement-breakpoint
CREATE TABLE `positions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`size` real NOT NULL,
	`strategy_id` text NOT NULL,
	`status` text NOT NULL,
	FOREIGN KEY (`strategy_id`) REFERENCES `strategies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `strategies` (
	`id` text PRIMARY KEY NOT NULL,
	`credentials_id` integer,
	`enabled` integer NOT NULL,
	`settings` text NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`started_at` text,
	`description` text,
	`margin` real DEFAULT 0 NOT NULL,
	`balance` real DEFAULT 0 NOT NULL,
	FOREIGN KEY (`credentials_id`) REFERENCES `credentials`(`id`) ON UPDATE no action ON DELETE no action
);
