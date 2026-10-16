-- Wave 2 (docs/wave2.md): onboarding portal, offboarding, benefits reconciliation, contractor payouts, memory recall. Additive only.
ALTER TABLE `offers` ADD `created_at` text;
--> statement-breakpoint
ALTER TABLE `offers` ADD `sent_at` text;
--> statement-breakpoint
ALTER TABLE `offers` ADD `viewed_at` text;
--> statement-breakpoint
ALTER TABLE `offers` ADD `voided_at` text;
--> statement-breakpoint
ALTER TABLE `offers` ADD `expires_on` text;
--> statement-breakpoint
ALTER TABLE `offers` ADD `document_id` text;
--> statement-breakpoint
ALTER TABLE `contractor_payments` ADD `rail_status` text;
--> statement-breakpoint
ALTER TABLE `contractor_payments` ADD `rail_ref` text;
--> statement-breakpoint
ALTER TABLE `contractor_payments` ADD `sent_at` text;
--> statement-breakpoint
ALTER TABLE `contractor_payments` ADD `delivered_at` text;
--> statement-breakpoint
CREATE TABLE `documents` (`id` text PRIMARY KEY NOT NULL, `company_id` text NOT NULL, `worker_id` text, `offer_id` text, `kind` text NOT NULL, `title` text NOT NULL, `status` text NOT NULL, `body_text` text NOT NULL, `sha256` text NOT NULL, `created_at` text NOT NULL, `sent_at` text, `signed_at` text);
--> statement-breakpoint
CREATE INDEX `documents_worker` ON `documents` (`worker_id`,`status`);
--> statement-breakpoint
CREATE TABLE `signatures` (`id` text PRIMARY KEY NOT NULL, `document_id` text NOT NULL, `signer_principal_id` text NOT NULL, `signer_name` text NOT NULL, `typed_name` text NOT NULL, `signed_at` text NOT NULL, `document_sha256` text NOT NULL, `action_seq` integer);
--> statement-breakpoint
CREATE UNIQUE INDEX `signatures_document` ON `signatures` (`document_id`);
--> statement-breakpoint
CREATE TABLE `onboarding_submissions` (`id` text PRIMARY KEY NOT NULL, `worker_id` text NOT NULL, `kind` text NOT NULL, `masked_json` text NOT NULL, `document_id` text, `submitted_at` text NOT NULL, `action_seq` integer);
--> statement-breakpoint
CREATE INDEX `onboarding_submissions_worker` ON `onboarding_submissions` (`worker_id`,`kind`);
--> statement-breakpoint
CREATE TABLE `uploads` (`id` text PRIMARY KEY NOT NULL, `worker_id` text NOT NULL, `purpose` text NOT NULL, `file_name` text NOT NULL, `storage_path` text NOT NULL, `bytes` integer NOT NULL, `sha256` text NOT NULL, `created_at` text NOT NULL);
--> statement-breakpoint
CREATE TABLE `offboarding_cases` (`id` text PRIMARY KEY NOT NULL, `company_id` text NOT NULL, `worker_id` text NOT NULL, `kind` text NOT NULL, `last_day` text NOT NULL, `reason_note` text DEFAULT '' NOT NULL, `status` text NOT NULL, `created_at` text NOT NULL, `closed_at` text);
--> statement-breakpoint
CREATE INDEX `offboarding_cases_worker` ON `offboarding_cases` (`worker_id`);
--> statement-breakpoint
CREATE TABLE `offboarding_steps` (`id` text PRIMARY KEY NOT NULL, `case_id` text NOT NULL, `kind` text NOT NULL, `status` text NOT NULL, `proposal_id` text, `action_seq` integer, `detail` text DEFAULT '' NOT NULL, `done_at` text);
--> statement-breakpoint
CREATE UNIQUE INDEX `offboarding_steps_case_kind` ON `offboarding_steps` (`case_id`,`kind`);
--> statement-breakpoint
CREATE TABLE `benefit_recon_findings` (`id` text PRIMARY KEY NOT NULL, `company_id` text NOT NULL, `month` text NOT NULL, `carrier` text NOT NULL, `kind` text NOT NULL, `worker_id` text, `plan_id` text, `billed_cents` integer NOT NULL, `expected_cents` integer NOT NULL, `deducted_cents` integer NOT NULL, `status` text NOT NULL, `detail` text NOT NULL, `created_at` text NOT NULL);
--> statement-breakpoint
CREATE INDEX `benefit_recon_month` ON `benefit_recon_findings` (`company_id`,`month`);
--> statement-breakpoint
CREATE TABLE `open_enrollment` (`id` text PRIMARY KEY NOT NULL, `worker_id` text NOT NULL, `plan_year` integer NOT NULL, `status` text NOT NULL, `last_nudged_at` text, `nudges` integer DEFAULT 0 NOT NULL, `elected_at` text);
--> statement-breakpoint
CREATE UNIQUE INDEX `open_enrollment_worker_year` ON `open_enrollment` (`worker_id`,`plan_year`);
--> statement-breakpoint
CREATE TABLE `fx_rates` (`currency` text NOT NULL, `as_of` text NOT NULL, `usd_per_unit` text NOT NULL, `source` text NOT NULL, PRIMARY KEY(`currency`, `as_of`));
--> statement-breakpoint
CREATE TABLE `sim_email_messages` (`id` text PRIMARY KEY NOT NULL, `to_addr` text NOT NULL, `from_addr` text NOT NULL, `subject` text NOT NULL, `body` text NOT NULL, `kind` text NOT NULL, `related_ref` text, `ts` text NOT NULL);
--> statement-breakpoint
CREATE INDEX `sim_email_to` ON `sim_email_messages` (`to_addr`,`id`);
--> statement-breakpoint
CREATE TABLE `sim_rail_transfers` (`id` text PRIMARY KEY NOT NULL, `payment_id` text NOT NULL, `amount_minor` integer NOT NULL, `currency` text NOT NULL, `status` text NOT NULL, `sent_at` text NOT NULL, `deliver_at` text NOT NULL, `delivered_at` text);
--> statement-breakpoint
CREATE UNIQUE INDEX `sim_rail_payment` ON `sim_rail_transfers` (`payment_id`);
--> statement-breakpoint
CREATE TABLE `sim_bank_verifications` (`id` text PRIMARY KEY NOT NULL, `worker_id` text NOT NULL, `routing_last4` text NOT NULL, `account_last4` text NOT NULL, `status` text NOT NULL, `reason` text, `ts` text NOT NULL);
--> statement-breakpoint
CREATE TABLE `memory_recalls` (`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL, `run_id` text NOT NULL, `paths_json` text NOT NULL, `chars` integer NOT NULL, `ts` text NOT NULL);
--> statement-breakpoint
CREATE INDEX `memory_recalls_run` ON `memory_recalls` (`run_id`);
--> statement-breakpoint
CREATE TABLE `dossiers` (`subject_ref` text PRIMARY KEY NOT NULL, `path` text NOT NULL, `refreshed_at` text NOT NULL, `source_digest` text NOT NULL);
