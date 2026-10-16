-- Wave 3 (docs/wave3.md): expenses, time off, check-ins and contractor tax forms, integrations (connections, links, deliveries,
-- sync items, screening, e-signature envelopes) and the vendor simulators. Additive only; owners in docs/wave3.md.
ALTER TABLE `paychecks` ADD `reimbursements_json` text NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE `departments` ADD `coverage_max_out_pct` integer DEFAULT 30 NOT NULL;
--> statement-breakpoint
ALTER TABLE `departments` ADD `coverage_min_present` integer DEFAULT 2 NOT NULL;
--> statement-breakpoint
ALTER TABLE `workers` ADD `birth_month_day` text;
--> statement-breakpoint
CREATE TABLE `expense_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`version` integer NOT NULL,
	`effective_from` text NOT NULL,
	`rules_json` text NOT NULL,
	`sources_json` text NOT NULL DEFAULT '[]'
);
--> statement-breakpoint
CREATE TABLE `expenses` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`worker_id` text NOT NULL,
	`category` text NOT NULL,
	`merchant` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`currency` text NOT NULL DEFAULT 'USD',
	`transaction_date` text NOT NULL,
	`submitted_at` text NOT NULL,
	`business_purpose` text NOT NULL,
	`attendees` text,
	`miles_x10` integer,
	`trip_ref` text,
	`pre_approval_ref` text,
	`receipt_upload_id` text,
	`receipt_extract_json` text,
	`status` text NOT NULL,
	`checks_json` text NOT NULL DEFAULT '[]',
	`explanation` text,
	`explanation_source` text,
	`explanation_run_id` text,
	`approver_principal_id` text,
	`decided_by` text,
	`decided_at` text,
	`decision_reason_code` text,
	`decision_note` text,
	`payroll_run_id` text,
	`paycheck_id` text,
	`policy_version` integer NOT NULL DEFAULT 1,
	`action_seq` integer
);
--> statement-breakpoint
CREATE INDEX `expenses_worker_status` ON `expenses` (`worker_id`, `status`);
--> statement-breakpoint
CREATE INDEX `expenses_status` ON `expenses` (`status`);
--> statement-breakpoint
CREATE TABLE `time_off_types` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`paid` integer NOT NULL,
	`counts_as_vacation` integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE `time_off_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`type_id` text NOT NULL,
	`name` text NOT NULL,
	`jurisdiction` text NOT NULL,
	`schedule` text NOT NULL,
	`minutes_per_period` integer,
	`tiers_json` text NOT NULL DEFAULT '[]',
	`worked_minutes_per_chunk` integer,
	`minutes_per_chunk` integer,
	`exempt_deemed_minutes_per_week` integer,
	`accrual_cap_minutes` integer,
	`annual_accrual_cap_minutes` integer,
	`carryover_cap_minutes` integer,
	`annual_use_cap_minutes` integer,
	`front_load_minutes` integer,
	`waiting_days_before_use` integer NOT NULL DEFAULT 0,
	`min_increment_minutes` integer NOT NULL DEFAULT 60,
	`allow_negative_minutes` integer NOT NULL DEFAULT 0,
	`pay_out_at_separation` integer NOT NULL DEFAULT 0,
	`reinstate_within_days` integer,
	`year_start` text NOT NULL DEFAULT '01-01',
	`effective_from` text NOT NULL,
	`effective_to` text,
	`sources_json` text NOT NULL DEFAULT '[]'
);
--> statement-breakpoint
CREATE TABLE `time_off_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`policy_id` text NOT NULL,
	`worker_id` text NOT NULL,
	`assigned_at` text NOT NULL,
	`effective_from` text NOT NULL,
	`effective_to` text,
	`accrual_remainder_minutes` integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE UNIQUE INDEX `time_off_assignments_key` ON `time_off_assignments` (`policy_id`, `worker_id`, `effective_from`);
--> statement-breakpoint
CREATE TABLE `time_off_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`assignment_id` text NOT NULL,
	`worker_id` text NOT NULL,
	`policy_id` text NOT NULL,
	`kind` text NOT NULL,
	`minutes` integer NOT NULL,
	`effective_date` text NOT NULL,
	`source_ref` text,
	`run_key` text,
	`note` text,
	`action_seq` integer,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `time_off_ledger_worker` ON `time_off_ledger` (`worker_id`, `policy_id`, `effective_date`);
--> statement-breakpoint
CREATE UNIQUE INDEX `time_off_ledger_run_key` ON `time_off_ledger` (`run_key`);
--> statement-breakpoint
CREATE TABLE `time_off_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`worker_id` text NOT NULL,
	`policy_id` text NOT NULL,
	`status` text NOT NULL,
	`start_at` text NOT NULL,
	`end_at` text NOT NULL,
	`range_type` text NOT NULL DEFAULT 'date',
	`time_zone` text NOT NULL,
	`requested_minutes` integer NOT NULL,
	`days_json` text NOT NULL,
	`reason` text NOT NULL DEFAULT '',
	`approver_principal_id` text,
	`routing_json` text NOT NULL DEFAULT '[]',
	`checks_json` text NOT NULL DEFAULT '[]',
	`decided_by` text,
	`decided_at` text,
	`decision_note` text,
	`payroll_run_id` text,
	`action_seq` integer,
	`source` text NOT NULL DEFAULT 'weft',
	`ext_ref` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `time_off_requests_worker` ON `time_off_requests` (`worker_id`, `status`);
--> statement-breakpoint
CREATE INDEX `time_off_requests_status` ON `time_off_requests` (`status`);
--> statement-breakpoint
CREATE TABLE `holiday_calendars` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`name` text NOT NULL,
	`year` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `holidays` (
	`id` text PRIMARY KEY NOT NULL,
	`calendar_id` text NOT NULL,
	`date` text NOT NULL,
	`name` text NOT NULL,
	`minutes` integer NOT NULL DEFAULT 480,
	`worker_types` text NOT NULL DEFAULT 'employee'
);
--> statement-breakpoint
CREATE UNIQUE INDEX `holidays_calendar_date` ON `holidays` (`calendar_id`, `date`);
--> statement-breakpoint
CREATE TABLE `checkins` (
	`id` text PRIMARY KEY NOT NULL,
	`worker_id` text NOT NULL,
	`due_on` text NOT NULL,
	`status` text NOT NULL,
	`answers_json` text,
	`sent_at` text,
	`nudged_at` text,
	`submitted_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `checkins_worker_due` ON `checkins` (`worker_id`, `due_on`);
--> statement-breakpoint
CREATE TABLE `contractor_tax_forms` (
	`id` text PRIMARY KEY NOT NULL,
	`worker_id` text NOT NULL,
	`form` text NOT NULL,
	`signed_on` text NOT NULL,
	`expires_on` text,
	`document_id` text,
	`status` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `contractor_tax_forms_worker` ON `contractor_tax_forms` (`worker_id`);
--> statement-breakpoint
CREATE TABLE `integration_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`vendor` text NOT NULL,
	`mode` text NOT NULL,
	`last_sync_at` text,
	`cursor` text,
	`health` text NOT NULL DEFAULT 'ok',
	`detail` text,
	`ownership_json` text,
	`settings_json` text NOT NULL DEFAULT '{}',
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `integration_connections_vendor` ON `integration_connections` (`company_id`, `vendor`);
--> statement-breakpoint
CREATE TABLE `ext_links` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`vendor` text NOT NULL,
	`ext_type` text NOT NULL,
	`ext_id` text NOT NULL,
	`weft_type` text NOT NULL,
	`weft_id` text NOT NULL,
	`ext_version` integer,
	`status` text NOT NULL DEFAULT 'linked',
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ext_links_ext` ON `ext_links` (`vendor`, `ext_type`, `ext_id`);
--> statement-breakpoint
CREATE INDEX `ext_links_weft` ON `ext_links` (`weft_type`, `weft_id`);
--> statement-breakpoint
CREATE TABLE `ext_snapshots` (
	`vendor` text NOT NULL,
	`ext_type` text NOT NULL,
	`ext_id` text NOT NULL,
	`field` text NOT NULL,
	`value_hash` text NOT NULL,
	`seen_at` text NOT NULL,
	PRIMARY KEY(`vendor`, `ext_type`, `ext_id`, `field`)
);
--> statement-breakpoint
CREATE TABLE `integration_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`vendor` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`action` text,
	`received_at` text NOT NULL,
	`verified` integer NOT NULL,
	`raw_sha256` text NOT NULL,
	`applied_at` text,
	`error` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `integration_deliveries_key` ON `integration_deliveries` (`vendor`, `dedupe_key`);
--> statement-breakpoint
CREATE TABLE `sync_items` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`vendor` text NOT NULL,
	`kind` text NOT NULL,
	`subject_ref` text NOT NULL,
	`status` text NOT NULL,
	`detail_json` text NOT NULL,
	`created_at` text NOT NULL,
	`resolved_at` text,
	`resolved_by` text
);
--> statement-breakpoint
CREATE INDEX `sync_items_status` ON `sync_items` (`status`);
--> statement-breakpoint
CREATE TABLE `screening_packages` (
	`id` text PRIMARY KEY NOT NULL,
	`vendor` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`price_cents` integer NOT NULL,
	`screenings_json` text NOT NULL,
	`phase` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `screening_packages_slug` ON `screening_packages` (`vendor`, `slug`);
--> statement-breakpoint
CREATE TABLE `screening_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`offer_id` text NOT NULL,
	`worker_id` text,
	`vendor` text NOT NULL,
	`mode` text NOT NULL,
	`package_slug` text NOT NULL,
	`price_cents` integer NOT NULL,
	`phase` text NOT NULL,
	`status` text NOT NULL,
	`result` text,
	`adjudication` text NOT NULL DEFAULT 'none',
	`timer_paused` integer NOT NULL DEFAULT 0,
	`vendor_candidate_id` text,
	`vendor_order_id` text,
	`vendor_report_id` text,
	`apply_url` text,
	`eta_on` text,
	`last_polled_at` text,
	`created_at` text NOT NULL,
	`completed_at` text,
	`proposal_id` text,
	`action_seq` integer
);
--> statement-breakpoint
CREATE INDEX `screening_orders_offer` ON `screening_orders` (`offer_id`);
--> statement-breakpoint
CREATE TABLE `esign_envelopes` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`offer_id` text NOT NULL,
	`provider` text NOT NULL,
	`mode` text NOT NULL,
	`envelope_id` text NOT NULL,
	`status` text NOT NULL,
	`sent_at` text NOT NULL,
	`delivered_at` text,
	`completed_at` text,
	`voided_at` text,
	`last_polled_at` text,
	`combined_sha256` text,
	`certificate_sha256` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `esign_envelopes_envelope` ON `esign_envelopes` (`provider`, `envelope_id`);
--> statement-breakpoint
CREATE INDEX `esign_envelopes_offer` ON `esign_envelopes` (`offer_id`);
--> statement-breakpoint
CREATE TABLE `signature_evidence` (
	`signature_id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`envelope_id` text,
	`ip` text,
	`user_agent` text
);
--> statement-breakpoint
CREATE TABLE `sim_vendor_records` (
	`id` text PRIMARY KEY NOT NULL,
	`vendor` text NOT NULL,
	`kind` text NOT NULL,
	`ext_id` text NOT NULL,
	`version` integer NOT NULL DEFAULT 1,
	`body_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sim_vendor_records_ext` ON `sim_vendor_records` (`vendor`, `kind`, `ext_id`);
--> statement-breakpoint
CREATE TABLE `sim_webhook_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`vendor` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`body_json` text NOT NULL,
	`signature` text NOT NULL,
	`attempt` integer NOT NULL DEFAULT 0,
	`next_at` text NOT NULL,
	`status` text NOT NULL,
	`delivered_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sim_webhook_outbox_key` ON `sim_webhook_outbox` (`vendor`, `dedupe_key`);
