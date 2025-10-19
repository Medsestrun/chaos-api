PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_positions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`size` real NOT NULL,
	`strategy_id` text NOT NULL,
	`status` text NOT NULL,
	`gridOpenPrice` real NOT NULL,
	`avgOpenPrice` real NOT NULL,
	`gridClosePrice` real NOT NULL,
	`avgClosePrice` real,
	FOREIGN KEY (`strategy_id`) REFERENCES `strategies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_positions`("id", "size", "strategy_id", "status", "gridOpenPrice", "avgOpenPrice", "gridClosePrice", "avgClosePrice") SELECT "id", "size", "strategy_id", "status", "gridOpenPrice", "avgOpenPrice", "gridClosePrice", "avgClosePrice" FROM `positions`;--> statement-breakpoint
DROP TABLE `positions`;--> statement-breakpoint
ALTER TABLE `__new_positions` RENAME TO `positions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `orders` ADD `gridPrice` real;