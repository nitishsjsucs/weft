-- Wave 4 (docs/wave4.md): compliance calendar, hand-offs, required training, life events and enrollment windows,
-- carrier submissions, agent mentions, email expense intake, routine waits and per-action agent overrides.
-- Additive only; owners in docs/wave4.md.
ALTER TABLE `notices` ADD `source` text NOT NULL DEFAULT 'simulated';
--> statement-breakpoint
ALTER TABLE `notices` ADD `upload_id` text;
--> statement-breakpoint
ALTER TABLE `filings` ADD `due_on` text;
--> statement-breakpoint
ALTER TABLE `filings` ADD `prepared_json` text;
--> statement-breakpoint
ALTER TABLE `filings` ADD `proposal_id` text;
--> statement-breakpoint
ALTER TABLE `expenses` ADD `source` text NOT NULL DEFAULT 'portal';
--> statement-breakpoint
CREATE TABLE `compliance_items` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`jurisdiction` text,
	`agency` text,
	`form` text,
	`period` text,
	`due_on` text NOT NULL,
	`status` text NOT NULL,
	`subject_ref` text,
	`owner_principal_id` text,
	`proposal_id` text,
	`created_at` text NOT NULL,
	`done_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `compliance_items_key` ON `compliance_items` (`company_id`, `kind`, `form`, `period`, `subject_ref`);
--> statement-breakpoint
CREATE INDEX `compliance_items_due` ON `compliance_items` (`company_id`, `due_on`);
--> statement-breakpoint
CREATE TABLE `handoff_cases` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`kind` text NOT NULL,
	`reason` text NOT NULL,
	`subject_ref` text,
	`worker_id` text,
	`summary` text NOT NULL,
	`evidence_json` text NOT NULL DEFAULT '[]',
	`status` text NOT NULL,
	`assignee_principal_id` text,
	`opened_by` text NOT NULL,
	`run_id` text,
	`created_at` text NOT NULL,
	`resolved_at` text,
	`resolution_note` text
);
--> statement-breakpoint
CREATE INDEX `handoff_cases_status` ON `handoff_cases` (`company_id`, `status`);
--> statement-breakpoint
CREATE TABLE `training_courses` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`code` text NOT NULL,
	`title` text NOT NULL,
	`jurisdiction` text,
	`audience` text NOT NULL,
	`minutes` integer NOT NULL,
	`due_within_days` integer NOT NULL,
	`repeat_months` integer,
	`source_url` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `training_courses_code` ON `training_courses` (`company_id`, `code`);
--> statement-breakpoint
CREATE TABLE `training_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`worker_id` text NOT NULL,
	`course_id` text NOT NULL,
	`due_on` text NOT NULL,
	`status` text NOT NULL,
	`assigned_at` text NOT NULL,
	`reminded_at` text,
	`completed_at` text,
	`certificate_upload_id` text,
	`proposal_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `training_assignments_worker_course_due` ON `training_assignments` (`worker_id`, `course_id`, `due_on`);
--> statement-breakpoint
CREATE TABLE `life_events` (
	`id` text PRIMARY KEY NOT NULL,
	`worker_id` text NOT NULL,
	`kind` text NOT NULL,
	`event_date` text NOT NULL,
	`note` text NOT NULL DEFAULT '',
	`status` text NOT NULL,
	`reported_by` text NOT NULL,
	`reported_at` text NOT NULL,
	`window_id` text
);
--> statement-breakpoint
CREATE INDEX `life_events_worker` ON `life_events` (`worker_id`);
--> statement-breakpoint
CREATE TABLE `enrollment_windows` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`worker_id` text,
	`kind` text NOT NULL,
	`life_event_id` text,
	`opens_on` text NOT NULL,
	`closes_on` text NOT NULL,
	`status` text NOT NULL,
	`reminders_sent` integer NOT NULL DEFAULT 0,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `enrollment_windows_worker` ON `enrollment_windows` (`worker_id`, `status`);
--> statement-breakpoint
CREATE TABLE `carrier_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`worker_id` text NOT NULL,
	`window_id` text,
	`carrier` text NOT NULL,
	`elections_json` text NOT NULL,
	`status` text NOT NULL,
	`sent_at` text,
	`confirmed_at` text,
	`receipt_ref` text,
	`proposal_id` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `carrier_submissions_worker` ON `carrier_submissions` (`worker_id`);
--> statement-breakpoint
CREATE TABLE `agent_mentions` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`channel` text NOT NULL,
	`message_ref` text NOT NULL,
	`thread_ref` text,
	`mentioned_by` text NOT NULL,
	`status` text NOT NULL,
	`run_id` text,
	`created_at` text NOT NULL,
	`answered_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_mentions_message` ON `agent_mentions` (`message_ref`);
--> statement-breakpoint
CREATE TABLE `expense_intake` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`source` text NOT NULL,
	`from_address` text NOT NULL,
	`worker_id` text,
	`message_ref` text NOT NULL,
	`upload_id` text,
	`status` text NOT NULL,
	`expense_id` text,
	`received_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `expense_intake_message` ON `expense_intake` (`message_ref`);
--> statement-breakpoint
CREATE TABLE `routine_waits` (
	`id` text PRIMARY KEY NOT NULL,
	`routine_run_id` text NOT NULL,
	`checklist_item_id` text NOT NULL,
	`kind` text NOT NULL,
	`event` text,
	`subject_ref` text,
	`until_at` text,
	`status` text NOT NULL,
	`follow_ups` integer NOT NULL DEFAULT 0,
	`next_follow_up_at` text,
	`created_at` text NOT NULL,
	`resumed_at` text
);
--> statement-breakpoint
CREATE INDEX `routine_waits_open` ON `routine_waits` (`status`, `event`, `subject_ref`);
--> statement-breakpoint
CREATE TABLE `agent_action_overrides` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`principal_id` text NOT NULL,
	`command` text NOT NULL,
	`mode` text NOT NULL,
	`set_by` text NOT NULL,
	`set_at` text NOT NULL,
	`proposal_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_action_overrides_key` ON `agent_action_overrides` (`company_id`, `principal_id`, `command`);
