CREATE TABLE `actions` (
	`seq` integer PRIMARY KEY NOT NULL,
	`action_id` text NOT NULL,
	`ts` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`on_behalf_of` text,
	`agent_run_id` text,
	`routine_run_id` text,
	`proposal_id` text,
	`command` text NOT NULL,
	`args_json` text NOT NULL,
	`args_hash` text NOT NULL,
	`result_id` text,
	`result_digest` text,
	`summary` text NOT NULL,
	`reversible` text NOT NULL,
	`reverse_json` text,
	`reverses_seq` integer,
	`prev_hash` text NOT NULL,
	`hash` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `actions_action_id` ON `actions` (`action_id`);--> statement-breakpoint
CREATE TABLE `agent_grants` (
	`company_id` text NOT NULL,
	`domain` text NOT NULL,
	`level` text NOT NULL,
	PRIMARY KEY(`company_id`, `domain`)
);
--> statement-breakpoint
CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`kind` text NOT NULL,
	`parent_run_id` text,
	`thread_id` text,
	`routine_run_id` text,
	`on_behalf_of` text,
	`trigger` text NOT NULL,
	`attended` integer NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`effort` text NOT NULL,
	`cache_key` text NOT NULL,
	`status` text NOT NULL,
	`terminal_reason` text,
	`tainted` integer DEFAULT false NOT NULL,
	`tainted_by` text,
	`checklist_json` text,
	`budget_json` text NOT NULL,
	`steps_used` integer DEFAULT 0 NOT NULL,
	`requeues` integer DEFAULT 0 NOT NULL,
	`consecutive_errors` integer DEFAULT 0 NOT NULL,
	`cost_usd_micros` integer DEFAULT 0 NOT NULL,
	`tokens_json` text NOT NULL,
	`summary` text,
	`created_at` text NOT NULL,
	`ended_at` text
);
--> statement-breakpoint
CREATE INDEX `agent_runs_status` ON `agent_runs` (`company_id`,`status`);--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`principal_id` text NOT NULL,
	`prefix` text NOT NULL,
	`hash` text NOT NULL,
	`label` text NOT NULL,
	`scope` text NOT NULL,
	`surface` text NOT NULL,
	`created_at` text NOT NULL,
	`revoked_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_hash` ON `api_keys` (`hash`);--> statement-breakpoint
CREATE TABLE `approval_audit` (
	`seq` integer PRIMARY KEY NOT NULL,
	`proposal_id` text NOT NULL,
	`principal_id` text NOT NULL,
	`attempt` text NOT NULL,
	`outcome` text NOT NULL,
	`ts` text NOT NULL,
	`prev_hash` text NOT NULL,
	`hash` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `bank_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`worker_id` text NOT NULL,
	`bank_name` text NOT NULL,
	`account_last4` text NOT NULL,
	`routing_last4` text NOT NULL,
	`credential_ref` text NOT NULL,
	`status` text NOT NULL,
	`source` text NOT NULL,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `bank_accounts_worker` ON `bank_accounts` (`worker_id`);--> statement-breakpoint
CREATE TABLE `benefit_enrollments` (
	`id` text PRIMARY KEY NOT NULL,
	`worker_id` text NOT NULL,
	`plan_id` text NOT NULL,
	`tier` text,
	`employee_cents` integer,
	`deferral_bps` integer,
	`status` text NOT NULL,
	`effective_from` text NOT NULL,
	`effective_to` text
);
--> statement-breakpoint
CREATE INDEX `benefit_enrollments_worker` ON `benefit_enrollments` (`worker_id`);--> statement-breakpoint
CREATE TABLE `benefit_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`carrier` text NOT NULL,
	`category` text NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`pretax_code` text NOT NULL,
	`prices_json` text NOT NULL,
	`match_json` text
);
--> statement-breakpoint
CREATE TABLE `companies` (
	`id` text PRIMARY KEY NOT NULL,
	`legal_name` text NOT NULL,
	`domain` text NOT NULL,
	`ein` text NOT NULL,
	`hq_state` text NOT NULL,
	`founded_on` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `contractor_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`worker_id` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`fx_rate` text NOT NULL,
	`usd_cents` integer NOT NULL,
	`status` text NOT NULL,
	`scheduled_for` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `departments` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`name` text NOT NULL,
	`lead_worker_id` text,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`worker_id` text NOT NULL,
	`model` text NOT NULL,
	`status` text NOT NULL,
	`order_ref` text,
	`price_cents` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `employer_tax_rates` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`jurisdiction` text NOT NULL,
	`code` text NOT NULL,
	`rate` text NOT NULL,
	`wage_base_cents` integer NOT NULL,
	`effective_from` text NOT NULL,
	`effective_to` text,
	`source` text NOT NULL,
	`created_action_seq` integer,
	`superseded_action_seq` integer
);
--> statement-breakpoint
CREATE INDEX `employer_tax_rates_lookup` ON `employer_tax_rates` (`company_id`,`jurisdiction`,`code`,`effective_from`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`ts` text NOT NULL,
	`subject_ref` text NOT NULL,
	`payload_json` text NOT NULL,
	`attended` integer DEFAULT false NOT NULL,
	`requested_by` text,
	`consumed_json` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_type` ON `events` (`type`,`id`);--> statement-breakpoint
CREATE TABLE `exec_calls` (
	`run_id` text NOT NULL,
	`call_id` text NOT NULL,
	`command` text NOT NULL,
	`outcome_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `exec_calls_run_call` ON `exec_calls` (`run_id`,`call_id`);--> statement-breakpoint
CREATE TABLE `exec_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`company_id` text NOT NULL,
	`principal_id` text NOT NULL,
	`on_behalf_of` text,
	`agent_kind` text NOT NULL,
	`surface` text NOT NULL,
	`routine_id` text,
	`routine_run_id` text,
	`parent_run_id` text,
	`attended` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `filings` (
	`id` text PRIMARY KEY NOT NULL,
	`tax_account_id` text NOT NULL,
	`form` text NOT NULL,
	`period` text NOT NULL,
	`status` text NOT NULL,
	`filed_at` text,
	`confirmation` text
);
--> statement-breakpoint
CREATE TABLE `id_counters` (
	`prefix` text PRIMARY KEY NOT NULL,
	`next` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `it_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`worker_id` text NOT NULL,
	`system` text NOT NULL,
	`handle` text NOT NULL,
	`groups_json` text DEFAULT '[]' NOT NULL,
	`status` text NOT NULL,
	`sim_ref` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `it_accounts_worker_system` ON `it_accounts` (`worker_id`,`system`);--> statement-breakpoint
CREATE TABLE `leases` (
	`resource` text PRIMARY KEY NOT NULL,
	`holder_run_id` text NOT NULL,
	`acquired_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `limits` (
	`company_id` text NOT NULL,
	`key` text NOT NULL,
	`cents` integer NOT NULL,
	PRIMARY KEY(`company_id`, `key`)
);
--> statement-breakpoint
CREATE TABLE `notices` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`agency` text NOT NULL,
	`kind` text NOT NULL,
	`form_code` text NOT NULL,
	`title` text NOT NULL,
	`received_at` text NOT NULL,
	`respond_by` text,
	`status` text NOT NULL,
	`tax_account_id` text,
	`file_name` text NOT NULL,
	`body_text` text NOT NULL,
	`extracted_json` text,
	`drafts_json` text DEFAULT '[]' NOT NULL,
	`resolution_json` text,
	`response_confirmation` text
);
--> statement-breakpoint
CREATE TABLE `offers` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`candidate_first` text NOT NULL,
	`candidate_last` text NOT NULL,
	`candidate_email` text NOT NULL,
	`title` text NOT NULL,
	`department_id` text NOT NULL,
	`workplace_id` text NOT NULL,
	`work_state` text NOT NULL,
	`manager_id` text,
	`base_cents` integer NOT NULL,
	`pay_kind` text NOT NULL,
	`start_date` text NOT NULL,
	`status` text NOT NULL,
	`accepted_at` text,
	`worker_id` text,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `onboarding_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`worker_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`owner` text NOT NULL,
	`due_on` text,
	`done_at` text,
	`blocked_reason` text,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `onboarding_tasks_worker` ON `onboarding_tasks` (`worker_id`);--> statement-breakpoint
CREATE TABLE `pay_rates` (
	`id` text PRIMARY KEY NOT NULL,
	`worker_id` text NOT NULL,
	`kind` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`effective_from` text NOT NULL,
	`effective_to` text,
	`created_action_seq` integer,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `pay_rates_worker` ON `pay_rates` (`worker_id`);--> statement-breakpoint
CREATE TABLE `pay_schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`name` text NOT NULL,
	`frequency` text NOT NULL,
	`region` text NOT NULL,
	`autopay` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `paychecks` (
	`id` text PRIMARY KEY NOT NULL,
	`payroll_run_id` text NOT NULL,
	`worker_id` text NOT NULL,
	`status` text NOT NULL,
	`review_group` text NOT NULL,
	`hours_x100` integer,
	`gross_cents` integer NOT NULL,
	`net_cents` integer NOT NULL,
	`reimbursements_cents` integer DEFAULT 0 NOT NULL,
	`earnings_json` text NOT NULL,
	`deductions_json` text NOT NULL,
	`benefits_json` text NOT NULL,
	`taxes_json` text NOT NULL,
	`flags_json` text DEFAULT '[]' NOT NULL,
	`explanation` text,
	`explanation_source` text,
	`explanation_run_id` text,
	FOREIGN KEY (`payroll_run_id`) REFERENCES `payroll_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `paychecks_run_worker` ON `paychecks` (`payroll_run_id`,`worker_id`);--> statement-breakpoint
CREATE TABLE `payroll_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`pay_schedule_id` text NOT NULL,
	`type` text NOT NULL,
	`subtype` text NOT NULL,
	`status` text NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`payday` text NOT NULL,
	`approval_deadline` text NOT NULL,
	`funding_method` text DEFAULT 'ach' NOT NULL,
	`totals_json` text,
	`anomaly_summary_json` text,
	`subject_hash` text,
	`tax_data_version` text NOT NULL,
	`previous_run_id` text,
	`excluded_worker_ids_json` text DEFAULT '[]' NOT NULL,
	`approved_by` text,
	`approved_at` text,
	`submitted_action_seq` integer,
	`bank_batch_id` text,
	`settle_at` text,
	`processed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `payroll_runs_schedule` ON `payroll_runs` (`pay_schedule_id`,`period_end`);--> statement-breakpoint
CREATE TABLE `principals` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`kind` text NOT NULL,
	`worker_id` text,
	`display` text NOT NULL,
	`email` text,
	`role` text,
	`grants_json` text NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`kind` text NOT NULL,
	`command` text,
	`args_json` text,
	`args_hash` text,
	`subject_ref` text,
	`subject_hash` text,
	`risk` text,
	`headline` text NOT NULL,
	`diff_json` text DEFAULT '[]' NOT NULL,
	`content_json` text DEFAULT '[]' NOT NULL,
	`evidence_json` text DEFAULT '[]' NOT NULL,
	`agent_note` text,
	`tainted_by` text,
	`proposer_run_id` text,
	`routine_run_id` text,
	`on_behalf_of` text,
	`domain` text,
	`money_cents` integer,
	`reversible` integer DEFAULT false NOT NULL,
	`supersedes` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`status` text NOT NULL,
	`decided_by` text,
	`decided_at` text,
	`decision_code` text,
	`decision_note` text,
	`executed_action_seq` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `proposals_executed_action_seq` ON `proposals` (`executed_action_seq`);--> statement-breakpoint
CREATE INDEX `proposals_status` ON `proposals` (`company_id`,`status`);--> statement-breakpoint
CREATE TABLE `routine_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`routine_id` text NOT NULL,
	`run_key` text NOT NULL,
	`trigger_ref` text NOT NULL,
	`status` text NOT NULL,
	`agent_run_id` text,
	`precheck_json` text,
	`summary` text,
	`left_for_human_json` text DEFAULT '[]' NOT NULL,
	`surface_hash` text,
	`overdue` integer DEFAULT false NOT NULL,
	`attended` integer DEFAULT false NOT NULL,
	`cost_usd_micros` integer DEFAULT 0 NOT NULL,
	`started_at` text,
	`ended_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `routine_runs_run_key` ON `routine_runs` (`run_key`);--> statement-breakpoint
CREATE INDEX `routine_runs_routine` ON `routine_runs` (`routine_id`);--> statement-breakpoint
CREATE TABLE `routines` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`owner_principal_id` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`autonomy` text DEFAULT 'approve' NOT NULL,
	`trigger_json` text NOT NULL,
	`filter_json` text,
	`instructions` text NOT NULL,
	`tools_json` text NOT NULL,
	`precheck` text,
	`checklist_json` text DEFAULT '[]' NOT NULL,
	`budget_json` text NOT NULL,
	`surface_json` text NOT NULL,
	`source` text NOT NULL,
	`tainted_by` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `run_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`step_n` integer NOT NULL,
	`path` text NOT NULL,
	`bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`summary` text NOT NULL,
	`domain` text NOT NULL,
	`needs` text NOT NULL,
	`tainted_by` text
);
--> statement-breakpoint
CREATE INDEX `run_artifacts_run` ON `run_artifacts` (`run_id`);--> statement-breakpoint
CREATE TABLE `run_steps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`n` integer NOT NULL,
	`parent_n` integer,
	`stage` text NOT NULL,
	`kind` text NOT NULL,
	`call_id` text,
	`attempt` integer DEFAULT 1 NOT NULL,
	`tool_name` text,
	`tool_args_json` text,
	`outcome` text,
	`result_json` text,
	`native_json` text,
	`usage_json` text,
	`cost_usd_micros` integer DEFAULT 0 NOT NULL,
	`request_id` text,
	`prefix_hash` text,
	`timings_json` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `run_steps_run` ON `run_steps` (`run_id`,`n`);--> statement-breakpoint
CREATE TABLE `run_taint` (
	`run_id` text PRIMARY KEY NOT NULL,
	`tainted` integer DEFAULT false NOT NULL,
	`tainted_by` text,
	`since_step` integer
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sim_agency_mail` (
	`id` text PRIMARY KEY NOT NULL,
	`agency` text NOT NULL,
	`direction` text NOT NULL,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`related_notice_id` text,
	`confirmation` text,
	`credential_name` text,
	`ts` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sim_bank_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`payroll_run_id` text NOT NULL,
	`total_cents` integer NOT NULL,
	`entries_json` text NOT NULL,
	`status` text NOT NULL,
	`settle_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sim_carrier_invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`month` text NOT NULL,
	`carrier` text NOT NULL,
	`lines_json` text NOT NULL,
	`total_cents` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sim_chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`channel` text NOT NULL,
	`author` text NOT NULL,
	`text` text NOT NULL,
	`inbound` integer DEFAULT false NOT NULL,
	`card_json` text,
	`ts` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sim_chat_channel` ON `sim_chat_messages` (`channel`,`id`);--> statement-breakpoint
CREATE TABLE `sim_device_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`worker_id` text NOT NULL,
	`sku` text NOT NULL,
	`ship_to` text NOT NULL,
	`price_cents` integer NOT NULL,
	`status` text NOT NULL,
	`eta` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sim_faults` (
	`target` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`mode` text NOT NULL,
	`armed` integer DEFAULT true NOT NULL,
	`fired_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sim_idp_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`worker_id` text NOT NULL,
	`system` text NOT NULL,
	`handle` text NOT NULL,
	`groups_json` text DEFAULT '[]' NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sim_registrations` (
	`id` text PRIMARY KEY NOT NULL,
	`agency` text NOT NULL,
	`company_id` text NOT NULL,
	`account_type` text NOT NULL,
	`request_json` text NOT NULL,
	`status` text NOT NULL,
	`complete_at` text NOT NULL,
	`account_number` text,
	`fault` text
);
--> statement-breakpoint
CREATE TABLE `tax_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`jurisdiction` text NOT NULL,
	`agency` text NOT NULL,
	`account_type` text NOT NULL,
	`account_number` text,
	`status` text NOT NULL,
	`deposit_schedule` text,
	`credential_ref` text,
	`registered_at` text,
	`sim_application_id` text
);
--> statement-breakpoint
CREATE TABLE `tax_profiles` (
	`worker_id` text PRIMARY KEY NOT NULL,
	`w4_version` text NOT NULL,
	`filing_status` text NOT NULL,
	`step2_checkbox` integer DEFAULT false NOT NULL,
	`step3_cents` integer DEFAULT 0 NOT NULL,
	`step4a_cents` integer DEFAULT 0 NOT NULL,
	`step4b_cents` integer DEFAULT 0 NOT NULL,
	`step4c_cents` integer DEFAULT 0 NOT NULL,
	`allowances` integer DEFAULT 0 NOT NULL,
	`state_filing_status` text,
	`state_allowances` integer DEFAULT 0 NOT NULL,
	`exempt` integer DEFAULT false NOT NULL,
	`source` text NOT NULL,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `time_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`worker_id` text NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`regular_hours_x100` integer NOT NULL,
	`overtime_hours_x100` integer DEFAULT 0 NOT NULL,
	`source` text NOT NULL,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `time_entries_worker` ON `time_entries` (`worker_id`,`period_start`);--> statement-breakpoint
CREATE TABLE `vault_secrets` (
	`name` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`description` text NOT NULL,
	`ciphertext` text NOT NULL,
	`iv` text NOT NULL,
	`tag` text NOT NULL,
	`fingerprint` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text
);
--> statement-breakpoint
CREATE TABLE `workers` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`employee_number` text,
	`type` text NOT NULL,
	`worker_type` text NOT NULL,
	`status` text NOT NULL,
	`first_name` text NOT NULL,
	`last_name` text NOT NULL,
	`preferred_name` text,
	`personal_email` text,
	`home_address_json` text,
	`work_email` text NOT NULL,
	`title` text NOT NULL,
	`department_id` text,
	`manager_id` text,
	`workplace_id` text,
	`work_state` text,
	`country` text DEFAULT 'US' NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`timezone` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text,
	`ssn_last4` text,
	`pay_schedule_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `workers_company_status` ON `workers` (`company_id`,`status`);--> statement-breakpoint
CREATE INDEX `workers_state` ON `workers` (`work_state`);--> statement-breakpoint
CREATE TABLE `workplaces` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`city` text,
	`state` text,
	`country` text DEFAULT 'US' NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `ytd_ledger` (
	`worker_id` text NOT NULL,
	`year` integer NOT NULL,
	`code` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`source` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ytd_ledger_unique` ON `ytd_ledger` (`worker_id`,`year`,`code`,`source`);