ALTER TABLE `transactions` ADD `base_amount_minor` integer;
--> statement-breakpoint
ALTER TABLE `transactions` ADD `exchange_rate_micros` integer NOT NULL DEFAULT 1000000;
--> statement-breakpoint
ALTER TABLE `transactions` ADD `exchange_rate_source` text NOT NULL DEFAULT 'fixed';
--> statement-breakpoint
ALTER TABLE `transactions` ADD `exchange_rate_at` text;
--> statement-breakpoint
ALTER TABLE `transactions` ADD `subscription_id` text;
--> statement-breakpoint
ALTER TABLE `transactions` ADD `subscription_period_key` text;
--> statement-breakpoint
UPDATE `transactions` SET `base_amount_minor` = `amount_minor` WHERE `base_amount_minor` IS NULL;
--> statement-breakpoint
UPDATE `transactions` SET `exchange_rate_at` = `created_at` WHERE `exchange_rate_at` IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_subscription_period_unique` ON `transactions` (`subscription_id`,`subscription_period_key`);
--> statement-breakpoint
CREATE TABLE `recurring_subscriptions` (
  `id` text PRIMARY KEY NOT NULL,
  `ledger_id` text NOT NULL,
  `name` text NOT NULL,
  `beneficiary` text NOT NULL DEFAULT '',
  `account_id` text NOT NULL,
  `category_id` text NOT NULL,
  `amount_minor` integer NOT NULL,
  `currency` text NOT NULL,
  `base_amount_minor` integer NOT NULL,
  `exchange_rate_micros` integer NOT NULL,
  `exchange_rate_source` text NOT NULL,
  `exchange_rate_at` text NOT NULL,
  `frequency` text NOT NULL,
  `interval` integer NOT NULL DEFAULT 1,
  `next_charge_on` text NOT NULL,
  `remind_days_before` integer NOT NULL DEFAULT 3,
  `status` text NOT NULL DEFAULT 'active',
  `last_generated_period_key` text,
  `version` integer NOT NULL DEFAULT 1,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`ledger_id`) REFERENCES `ledgers`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `recurring_subscriptions_ledger_status_idx` ON `recurring_subscriptions` (`ledger_id`,`status`,`next_charge_on`);
