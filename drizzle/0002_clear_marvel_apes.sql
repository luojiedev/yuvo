CREATE TABLE `transaction_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`ledger_id` text NOT NULL,
	`transaction_id` text NOT NULL,
	`object_key` text NOT NULL,
	`name` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`ledger_id`) REFERENCES `ledgers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transaction_attachments_object_key_unique` ON `transaction_attachments` (`object_key`);--> statement-breakpoint
CREATE INDEX `transaction_attachments_transaction_id_idx` ON `transaction_attachments` (`transaction_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `transaction_attachments_ledger_id_idx` ON `transaction_attachments` (`ledger_id`,`created_at`);