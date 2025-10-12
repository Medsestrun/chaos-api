CREATE TABLE `fundings` (
	`time` integer PRIMARY KEY NOT NULL,
	`size` real NOT NULL,
	`rate` real NOT NULL,
	`fee` real DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `order_size_levels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`strategy_id` text NOT NULL,
	`size` real DEFAULT 0 NOT NULL,
	`level_start` integer NOT NULL,
	`level_end` integer NOT NULL,
	FOREIGN KEY (`strategy_id`) REFERENCES `strategies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`id` integer PRIMARY KEY NOT NULL,
	`size` real NOT NULL,
	`side` text NOT NULL,
	`position_id` integer,
	`status` text NOT NULL,
	`averagePrice` real NOT NULL,
	`fee` real DEFAULT 0 NOT NULL,
	`closedPnl` real DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`closed_at` text,
	FOREIGN KEY (`position_id`) REFERENCES `positions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `positions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`size` real NOT NULL,
	`strategy_id` text NOT NULL,
	`status` text NOT NULL,
	`gridOpenPrice` real NOT NULL,
	`gridClosePrice` real,
	FOREIGN KEY (`strategy_id`) REFERENCES `strategies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `strategies` (
	`id` text PRIMARY KEY NOT NULL,
	`enabled` integer NOT NULL,
	`settings` text NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`started_at` text,
	`description` text,
	`margin` real DEFAULT 0 NOT NULL,
	`balance` real DEFAULT 0 NOT NULL
);
