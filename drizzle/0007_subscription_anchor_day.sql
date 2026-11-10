ALTER TABLE `recurring_subscriptions` ADD `anchor_day` integer;
--> statement-breakpoint
UPDATE `recurring_subscriptions` SET `anchor_day` = CAST(substr(`next_charge_on`, 9, 2) AS integer) WHERE `anchor_day` IS NULL;
