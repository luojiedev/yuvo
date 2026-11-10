CREATE TABLE `app_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`placement` text NOT NULL,
	`content` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `app_messages_placement_status_idx` ON `app_messages` (`placement`,`status`,`sort_order`);
--> statement-breakpoint
INSERT INTO `app_messages` (`id`, `placement`, `content`, `status`, `sort_order`) VALUES
	('launch-message-001', 'launch', '记下生活的每一笔，让日常更有条理。', 'active', 10),
	('launch-message-002', 'launch', '认真记录日常，从容安排生活。', 'active', 20);
