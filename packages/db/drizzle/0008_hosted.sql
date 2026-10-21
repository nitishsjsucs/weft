-- Weft on Cloudflare (docs/cloudflare/design.md 4.1): the hosted tables. Additive only; owner cf0-contracts.
-- Present on Node too and empty there unless a hosted option is on (WEFT_MEMORY=sqlite, WEFT_BLOBS=sqlite); the
-- world digest skips them while they are empty, so the base digest and every pinned eval digest are unchanged.
CREATE TABLE `mem_objects` (
	`sha` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`body` blob NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mem_refs` (
	`name` text PRIMARY KEY NOT NULL,
	`sha` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mem_log` (
	`seq` integer PRIMARY KEY NOT NULL,
	`sha` text NOT NULL,
	`parent` text,
	`date` text NOT NULL,
	`chain_seq` integer,
	`chain_hash` text
);
--> statement-breakpoint
CREATE TABLE `blobs` (
	`key` text NOT NULL,
	`idx` integer NOT NULL,
	`bytes` blob NOT NULL,
	PRIMARY KEY(`key`, `idx`)
);
--> statement-breakpoint
CREATE TABLE `run_files` (
	`path` text PRIMARY KEY NOT NULL,
	`body` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `run_handles` (
	`run_id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`nonce` text
);
--> statement-breakpoint
CREATE TABLE `kv_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`created_at` text NOT NULL
);
