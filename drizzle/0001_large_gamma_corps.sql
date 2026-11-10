CREATE TABLE `invitation_acceptances` (
	`invitation_id` text PRIMARY KEY NOT NULL,
	`accepted_by_user_id` text NOT NULL,
	`accepted_at` text NOT NULL,
	FOREIGN KEY (`invitation_id`) REFERENCES `ledger_invitations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `system_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`initialized_at` text NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
