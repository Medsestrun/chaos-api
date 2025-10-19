CREATE TABLE `metrics_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`strategy_id` text NOT NULL,
	`timestamp` integer DEFAULT (unixepoch()) NOT NULL,
	`total_profit` real DEFAULT 0 NOT NULL,
	`matched_profit` real DEFAULT 0 NOT NULL,
	`unmatched_profit` real DEFAULT 0 NOT NULL,
	`invested_margin` real DEFAULT 0 NOT NULL,
	`funding_fee` real DEFAULT 0 NOT NULL,
	`total_fees` real DEFAULT 0 NOT NULL,
	`current_price` real NOT NULL,
	`open_positions_count` integer DEFAULT 0 NOT NULL,
	`closed_positions_count` integer DEFAULT 0 NOT NULL,
	`total_trades_count` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`strategy_id`) REFERENCES `strategies`(`id`) ON UPDATE no action ON DELETE no action
);
