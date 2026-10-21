// Drizzle schema for SPEC 6 (frozen after the scaffold commit). Ids are prefixed text; timestamps are ISO-8601 UTC
// strings from the sim clock (spend uses the wall clock); money columns end in _cents; JSON columns end in _json.
import { sqliteTable, text, integer, blob, primaryKey, uniqueIndex, index } from "drizzle-orm/sqlite-core";

const ts = (n: string) => text(n);
const json = (n: string) => text(n);
const bool = (n: string) => integer(n, { mode: "boolean" });

// 6.1 Company, people, access
export const companies = sqliteTable("companies", {
  id: text("id").primaryKey(), legalName: text("legal_name").notNull(), domain: text("domain").notNull(), ein: text("ein").notNull(),
  hqState: text("hq_state").notNull(), foundedOn: text("founded_on").notNull(), createdAt: ts("created_at").notNull(),
});
export const workplaces = sqliteTable("workplaces", {
  id: text("id").primaryKey(), companyId: text("company_id").notNull().references(() => companies.id), name: text("name").notNull(),
  kind: text("kind").notNull(), city: text("city"), state: text("state"), country: text("country").notNull().default("US"),
});
export const departments = sqliteTable("departments", {
  id: text("id").primaryKey(), companyId: text("company_id").notNull().references(() => companies.id), name: text("name").notNull(),
  leadWorkerId: text("lead_worker_id"),
  coverageMaxOutPct: integer("coverage_max_out_pct").notNull().default(30), coverageMinPresent: integer("coverage_min_present").notNull().default(2),   // wave 3 (w3-timeoff)
});
export const workers = sqliteTable("workers", {
  id: text("id").primaryKey(), companyId: text("company_id").notNull().references(() => companies.id), employeeNumber: text("employee_number"),
  type: text("type").notNull(), workerType: text("worker_type").notNull(), status: text("status").notNull(),
  firstName: text("first_name").notNull(), lastName: text("last_name").notNull(),
  preferredName: text("preferred_name"), personalEmail: text("personal_email"), homeAddressJson: json("home_address_json"),   // untrusted
  workEmail: text("work_email").notNull(), title: text("title").notNull(), departmentId: text("department_id"), managerId: text("manager_id"),
  workplaceId: text("workplace_id"), workState: text("work_state"), country: text("country").notNull().default("US"),
  currency: text("currency").notNull().default("USD"), timezone: text("timezone").notNull(), startDate: text("start_date").notNull(),
  endDate: text("end_date"), ssnLast4: text("ssn_last4"), payScheduleId: text("pay_schedule_id"),
  birthMonthDay: text("birth_month_day"),   // wave 3 (w3-parity-routines): synthetic MM-DD, never a year
  createdAt: ts("created_at").notNull(), updatedAt: ts("updated_at").notNull(),
}, (t) => [index("workers_company_status").on(t.companyId, t.status), index("workers_state").on(t.workState)]);
export const payRates = sqliteTable("pay_rates", {
  id: text("id").primaryKey(), workerId: text("worker_id").notNull().references(() => workers.id), kind: text("kind").notNull(),
  amountCents: integer("amount_cents").notNull(), currency: text("currency").notNull().default("USD"), effectiveFrom: text("effective_from").notNull(),
  effectiveTo: text("effective_to"), createdActionSeq: integer("created_action_seq"),
}, (t) => [index("pay_rates_worker").on(t.workerId)]);
export const paySchedules = sqliteTable("pay_schedules", {
  id: text("id").primaryKey(), companyId: text("company_id").notNull().references(() => companies.id), name: text("name").notNull(),
  frequency: text("frequency").notNull(), region: text("region").notNull(), autopay: bool("autopay").notNull().default(false),
});
export const timeEntries = sqliteTable("time_entries", {
  id: text("id").primaryKey(), workerId: text("worker_id").notNull().references(() => workers.id), periodStart: text("period_start").notNull(),
  periodEnd: text("period_end").notNull(), regularHoursX100: integer("regular_hours_x100").notNull(), overtimeHoursX100: integer("overtime_hours_x100").notNull().default(0),
  source: text("source").notNull(),
}, (t) => [index("time_entries_worker").on(t.workerId, t.periodStart)]);
export const taxProfiles = sqliteTable("tax_profiles", {
  workerId: text("worker_id").primaryKey().references(() => workers.id), w4Version: text("w4_version").notNull(), filingStatus: text("filing_status").notNull(),
  step2Checkbox: bool("step2_checkbox").notNull().default(false), step3Cents: integer("step3_cents").notNull().default(0),
  step4aCents: integer("step4a_cents").notNull().default(0), step4bCents: integer("step4b_cents").notNull().default(0), step4cCents: integer("step4c_cents").notNull().default(0),
  allowances: integer("allowances").notNull().default(0), stateFilingStatus: text("state_filing_status"), stateAllowances: integer("state_allowances").notNull().default(0),
  stateExtraCents: integer("state_extra_cents").notNull().default(0),
  exempt: bool("exempt").notNull().default(false), source: text("source").notNull(),
});
export const bankAccounts = sqliteTable("bank_accounts", {
  id: text("id").primaryKey(), workerId: text("worker_id").notNull().references(() => workers.id), bankName: text("bank_name").notNull(),
  accountLast4: text("account_last4").notNull(), routingLast4: text("routing_last4").notNull(), credentialRef: text("credential_ref").notNull(),
  status: text("status").notNull(), source: text("source").notNull(),
}, (t) => [index("bank_accounts_worker").on(t.workerId)]);
export const offers = sqliteTable("offers", {
  id: text("id").primaryKey(), companyId: text("company_id").notNull().references(() => companies.id), candidateFirst: text("candidate_first").notNull(),
  candidateLast: text("candidate_last").notNull(), candidateEmail: text("candidate_email").notNull(), title: text("title").notNull(),
  departmentId: text("department_id").notNull(), workplaceId: text("workplace_id").notNull(), workState: text("work_state").notNull(),
  managerId: text("manager_id"), baseCents: integer("base_cents").notNull(), payKind: text("pay_kind").notNull(), startDate: text("start_date").notNull(),
  status: text("status").notNull(), acceptedAt: ts("accepted_at"), workerId: text("worker_id"),
  // wave 2 offer lifecycle
  createdAt: ts("created_at"), sentAt: ts("sent_at"), viewedAt: ts("viewed_at"), voidedAt: ts("voided_at"), expiresOn: text("expires_on"), documentId: text("document_id"),
});
export const onboardingTasks = sqliteTable("onboarding_tasks", {
  id: text("id").primaryKey(), workerId: text("worker_id").notNull().references(() => workers.id), kind: text("kind").notNull(),
  status: text("status").notNull(), owner: text("owner").notNull(), dueOn: text("due_on"), doneAt: ts("done_at"), blockedReason: text("blocked_reason"),
}, (t) => [index("onboarding_tasks_worker").on(t.workerId)]);
export const principals = sqliteTable("principals", {
  id: text("id").primaryKey(), companyId: text("company_id").notNull().references(() => companies.id), kind: text("kind").notNull(),
  workerId: text("worker_id"), display: text("display").notNull(), email: text("email"), role: text("role"), grantsJson: json("grants_json").notNull(),
});
export const agentGrants = sqliteTable("agent_grants", {
  companyId: text("company_id").notNull(), domain: text("domain").notNull(), level: text("level").notNull(),
}, (t) => [primaryKey({ columns: [t.companyId, t.domain] })]);
export const limits = sqliteTable("limits", {
  companyId: text("company_id").notNull(), key: text("key").notNull(), cents: integer("cents").notNull(),
}, (t) => [primaryKey({ columns: [t.companyId, t.key] })]);
export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey(), companyId: text("company_id").notNull(), principalId: text("principal_id").notNull(), prefix: text("prefix").notNull(),
  hash: text("hash").notNull(), label: text("label").notNull(), scope: text("scope").notNull(), surface: text("surface").notNull(),
  createdAt: ts("created_at").notNull(), revokedAt: ts("revoked_at"),
}, (t) => [uniqueIndex("api_keys_hash").on(t.hash)]);
export const settings = sqliteTable("settings", { key: text("key").primaryKey(), valueJson: json("value_json").notNull() });
export const idCounters = sqliteTable("id_counters", { prefix: text("prefix").primaryKey(), next: integer("next").notNull() });

// 6.2 Payroll
export const payrollRuns = sqliteTable("payroll_runs", {
  id: text("id").primaryKey(), companyId: text("company_id").notNull(), payScheduleId: text("pay_schedule_id").notNull(), type: text("type").notNull(),
  subtype: text("subtype").notNull(), status: text("status").notNull(), periodStart: text("period_start").notNull(), periodEnd: text("period_end").notNull(),
  payday: text("payday").notNull(), approvalDeadline: ts("approval_deadline").notNull(), fundingMethod: text("funding_method").notNull().default("ach"),
  totalsJson: json("totals_json"), anomalySummaryJson: json("anomaly_summary_json"), subjectHash: text("subject_hash"), taxDataVersion: text("tax_data_version").notNull(),
  previousRunId: text("previous_run_id"), excludedWorkerIdsJson: json("excluded_worker_ids_json").notNull().default("[]"), approvedBy: text("approved_by"),
  approvedAt: ts("approved_at"), submittedActionSeq: integer("submitted_action_seq"), bankBatchId: text("bank_batch_id"), settleAt: ts("settle_at"),
  processedAt: ts("processed_at"), createdAt: ts("created_at").notNull(), updatedAt: ts("updated_at").notNull(),
}, (t) => [index("payroll_runs_schedule").on(t.payScheduleId, t.periodEnd)]);
export const paychecks = sqliteTable("paychecks", {
  id: text("id").primaryKey(), payrollRunId: text("payroll_run_id").notNull().references(() => payrollRuns.id), workerId: text("worker_id").notNull(),
  status: text("status").notNull(), reviewGroup: text("review_group").notNull(), hoursX100: integer("hours_x100"), grossCents: integer("gross_cents").notNull(),
  netCents: integer("net_cents").notNull(), reimbursementsCents: integer("reimbursements_cents").notNull().default(0),
  reimbursementsJson: json("reimbursements_json").notNull().default("[]"),   // wave 3 (w3-expenses): [{ expenseId, category, amountCents }]
  earningsJson: json("earnings_json").notNull(),
  deductionsJson: json("deductions_json").notNull(), benefitsJson: json("benefits_json").notNull(), taxesJson: json("taxes_json").notNull(),
  flagsJson: json("flags_json").notNull().default("[]"), explanation: text("explanation"), explanationSource: text("explanation_source"), explanationRunId: text("explanation_run_id"),
}, (t) => [uniqueIndex("paychecks_run_worker").on(t.payrollRunId, t.workerId)]);
export const ytdLedger = sqliteTable("ytd_ledger", {
  workerId: text("worker_id").notNull(), year: integer("year").notNull(), code: text("code").notNull(), amountCents: integer("amount_cents").notNull(), source: text("source").notNull(),
}, (t) => [uniqueIndex("ytd_ledger_unique").on(t.workerId, t.year, t.code, t.source)]);

// 6.3 Tax and compliance
export const taxAccounts = sqliteTable("tax_accounts", {
  id: text("id").primaryKey(), companyId: text("company_id").notNull(), jurisdiction: text("jurisdiction").notNull(), agency: text("agency").notNull(),
  accountType: text("account_type").notNull(), accountNumber: text("account_number"), status: text("status").notNull(), depositSchedule: text("deposit_schedule"),
  credentialRef: text("credential_ref"), registeredAt: ts("registered_at"), simApplicationId: text("sim_application_id"),
});
export const employerTaxRates = sqliteTable("employer_tax_rates", {
  id: text("id").primaryKey(), companyId: text("company_id").notNull(), jurisdiction: text("jurisdiction").notNull(), code: text("code").notNull(),
  rate: text("rate").notNull(), wageBaseCents: integer("wage_base_cents").notNull(), effectiveFrom: text("effective_from").notNull(), effectiveTo: text("effective_to"),
  source: text("source").notNull(), createdActionSeq: integer("created_action_seq"), supersededActionSeq: integer("superseded_action_seq"),
}, (t) => [index("employer_tax_rates_lookup").on(t.companyId, t.jurisdiction, t.code, t.effectiveFrom)]);
export const notices = sqliteTable("notices", {
  id: text("id").primaryKey(), companyId: text("company_id").notNull(), agency: text("agency").notNull(), kind: text("kind").notNull(), formCode: text("form_code").notNull(),
  title: text("title").notNull(), receivedAt: ts("received_at").notNull(), respondBy: text("respond_by"), status: text("status").notNull(),
  taxAccountId: text("tax_account_id"), fileName: text("file_name").notNull(), bodyText: text("body_text").notNull(), extractedJson: json("extracted_json"),
  draftsJson: json("drafts_json").notNull().default("[]"), resolutionJson: json("resolution_json"), responseConfirmation: text("response_confirmation"),
  source: text("source").notNull().default("simulated"), uploadId: text("upload_id"),   // wave 4 (0007_wave4.sql, w4-parity-compliance)
});
export const filings = sqliteTable("filings", {
  id: text("id").primaryKey(), taxAccountId: text("tax_account_id").notNull(), form: text("form").notNull(), period: text("period").notNull(),
  status: text("status").notNull(), filedAt: ts("filed_at"), confirmation: text("confirmation"),
  dueOn: text("due_on"), preparedJson: json("prepared_json"), proposalId: text("proposal_id"),   // wave 4 (0007_wave4.sql, w4-parity-compliance)
});

// 6.4 Benefits, IT, contractors
export const benefitPlans = sqliteTable("benefit_plans", {
  id: text("id").primaryKey(), companyId: text("company_id").notNull(), carrier: text("carrier").notNull(), category: text("category").notNull(), type: text("type").notNull(),
  name: text("name").notNull(), pretaxCode: text("pretax_code").notNull(), pricesJson: json("prices_json").notNull(), matchJson: json("match_json"),
});
export const benefitEnrollments = sqliteTable("benefit_enrollments", {
  id: text("id").primaryKey(), workerId: text("worker_id").notNull(), planId: text("plan_id").notNull(), tier: text("tier"), employeeCents: integer("employee_cents"),
  deferralBps: integer("deferral_bps"), status: text("status").notNull(), effectiveFrom: text("effective_from").notNull(), effectiveTo: text("effective_to"),
}, (t) => [index("benefit_enrollments_worker").on(t.workerId)]);
export const itAccounts = sqliteTable("it_accounts", {
  id: text("id").primaryKey(), workerId: text("worker_id").notNull(), system: text("system").notNull(), handle: text("handle").notNull(),
  groupsJson: json("groups_json").notNull().default("[]"), status: text("status").notNull(), simRef: text("sim_ref"),
}, (t) => [uniqueIndex("it_accounts_worker_system").on(t.workerId, t.system)]);
export const devices = sqliteTable("devices", {
  id: text("id").primaryKey(), workerId: text("worker_id").notNull(), model: text("model").notNull(), status: text("status").notNull(),
  orderRef: text("order_ref"), priceCents: integer("price_cents").notNull(),
});
export const contractorPayments = sqliteTable("contractor_payments", {
  id: text("id").primaryKey(), workerId: text("worker_id").notNull(), amountMinor: integer("amount_minor").notNull(), currency: text("currency").notNull(),
  fxRate: text("fx_rate").notNull(), usdCents: integer("usd_cents").notNull(), status: text("status").notNull(), scheduledFor: text("scheduled_for").notNull(),
  // wave 2 payment rail
  railStatus: text("rail_status"), railRef: text("rail_ref"), sentAt: ts("sent_at"), deliveredAt: ts("delivered_at"),
});

// 6.5 Agent, governance, routines
export const execRuns = sqliteTable("exec_runs", {
  id: text("id").primaryKey(), tokenHash: text("token_hash").notNull(), companyId: text("company_id").notNull(), principalId: text("principal_id").notNull(),
  onBehalfOf: text("on_behalf_of"), agentKind: text("agent_kind").notNull(), surface: text("surface").notNull(), routineId: text("routine_id"),
  routineRunId: text("routine_run_id"), parentRunId: text("parent_run_id"), attended: bool("attended").notNull(), createdAt: ts("created_at").notNull(),
  allowlistJson: json("allowlist_json"),   // registry names the run may call; null only for test handles opened without one
});
export const runTaint = sqliteTable("run_taint", {
  runId: text("run_id").primaryKey(), tainted: bool("tainted").notNull().default(false), taintedBy: text("tainted_by"), sinceStep: integer("since_step"),
});
export const execCalls = sqliteTable("exec_calls", {
  runId: text("run_id").notNull(), callId: text("call_id").notNull(), command: text("command").notNull(), outcomeJson: json("outcome_json").notNull(),
  createdAt: ts("created_at").notNull(),
}, (t) => [uniqueIndex("exec_calls_run_call").on(t.runId, t.callId)]);
export const runArtifacts = sqliteTable("run_artifacts", {
  id: text("id").primaryKey(), runId: text("run_id").notNull(), stepN: integer("step_n").notNull(), path: text("path").notNull(), bytes: integer("bytes").notNull(),
  sha256: text("sha256").notNull(), summary: text("summary").notNull(), domain: text("domain").notNull(), needs: text("needs").notNull(), taintedBy: text("tainted_by"),
}, (t) => [index("run_artifacts_run").on(t.runId)]);
export const agentRuns = sqliteTable("agent_runs", {
  id: text("id").primaryKey(), companyId: text("company_id").notNull(), kind: text("kind").notNull(), parentRunId: text("parent_run_id"), threadId: text("thread_id"),
  routineRunId: text("routine_run_id"), onBehalfOf: text("on_behalf_of"), trigger: text("trigger").notNull(), attended: bool("attended").notNull(),
  provider: text("provider").notNull(), model: text("model").notNull(), effort: text("effort").notNull(), cacheKey: text("cache_key").notNull(),
  status: text("status").notNull(), terminalReason: text("terminal_reason"), tainted: bool("tainted").notNull().default(false), taintedBy: text("tainted_by"),
  checklistJson: json("checklist_json"), budgetJson: json("budget_json").notNull(), stepsUsed: integer("steps_used").notNull().default(0),
  requeues: integer("requeues").notNull().default(0), consecutiveErrors: integer("consecutive_errors").notNull().default(0),
  costUsdMicros: integer("cost_usd_micros").notNull().default(0), tokensJson: json("tokens_json").notNull(), summary: text("summary"),
  createdAt: ts("created_at").notNull(), endedAt: ts("ended_at"),
}, (t) => [index("agent_runs_status").on(t.companyId, t.status)]);
export const runSteps = sqliteTable("run_steps", {
  id: integer("id").primaryKey({ autoIncrement: true }), runId: text("run_id").notNull(), n: integer("n").notNull(), parentN: integer("parent_n"),
  stage: text("stage").notNull(), kind: text("kind").notNull(), callId: text("call_id"), attempt: integer("attempt").notNull().default(1),
  toolName: text("tool_name"), toolArgsJson: json("tool_args_json"), outcome: text("outcome"), resultJson: json("result_json"), nativeJson: json("native_json"),
  usageJson: json("usage_json"), costUsdMicros: integer("cost_usd_micros").notNull().default(0), requestId: text("request_id"), prefixHash: text("prefix_hash"),
  timingsJson: json("timings_json"), createdAt: ts("created_at").notNull(),
}, (t) => [index("run_steps_run").on(t.runId, t.n)]);
export const actions = sqliteTable("actions", {
  seq: integer("seq").primaryKey(), actionId: text("action_id").notNull(), ts: ts("ts").notNull(), actorKind: text("actor_kind").notNull(), actorId: text("actor_id").notNull(),
  onBehalfOf: text("on_behalf_of"), agentRunId: text("agent_run_id"), routineRunId: text("routine_run_id"), proposalId: text("proposal_id"), command: text("command").notNull(),
  argsJson: json("args_json").notNull(), argsHash: text("args_hash").notNull(), resultId: text("result_id"), resultDigest: text("result_digest"), summary: text("summary").notNull(),
  reversible: text("reversible").notNull(), reverseJson: json("reverse_json"), reversesSeq: integer("reverses_seq"), prevHash: text("prev_hash").notNull(), hash: text("hash").notNull(),
}, (t) => [uniqueIndex("actions_action_id").on(t.actionId)]);
export const proposals = sqliteTable("proposals", {
  id: text("id").primaryKey(), companyId: text("company_id").notNull(), kind: text("kind").notNull(), command: text("command"), argsJson: json("args_json"), argsHash: text("args_hash"),
  subjectRef: text("subject_ref"), subjectHash: text("subject_hash"), risk: text("risk"), headline: text("headline").notNull(), diffJson: json("diff_json").notNull().default("[]"),
  contentJson: json("content_json").notNull().default("[]"), evidenceJson: json("evidence_json").notNull().default("[]"), agentNote: text("agent_note"), taintedBy: text("tainted_by"),
  proposerRunId: text("proposer_run_id"), routineRunId: text("routine_run_id"), onBehalfOf: text("on_behalf_of"), domain: text("domain"), moneyCents: integer("money_cents"),
  reversible: bool("reversible").notNull().default(false), supersedes: text("supersedes"), createdAt: ts("created_at").notNull(), expiresAt: ts("expires_at").notNull(),
  status: text("status").notNull(), decidedBy: text("decided_by"), decidedAt: ts("decided_at"), decisionCode: text("decision_code"), decisionNote: text("decision_note"),
  executedActionSeq: integer("executed_action_seq"),
}, (t) => [uniqueIndex("proposals_executed_action_seq").on(t.executedActionSeq), index("proposals_status").on(t.companyId, t.status)]);
export const approvalAudit = sqliteTable("approval_audit", {
  seq: integer("seq").primaryKey(), proposalId: text("proposal_id").notNull(), principalId: text("principal_id").notNull(), attempt: text("attempt").notNull(),
  outcome: text("outcome").notNull(), ts: ts("ts").notNull(), prevHash: text("prev_hash").notNull(), hash: text("hash").notNull(),
});
export const routines = sqliteTable("routines", {
  id: text("id").primaryKey(), companyId: text("company_id").notNull(), name: text("name").notNull(), description: text("description").notNull(),
  ownerPrincipalId: text("owner_principal_id").notNull(), enabled: bool("enabled").notNull().default(false), autonomy: text("autonomy").notNull().default("approve"),
  triggerJson: json("trigger_json").notNull(), filterJson: json("filter_json"), instructions: text("instructions").notNull(), toolsJson: json("tools_json").notNull(),
  precheck: text("precheck"), checklistJson: json("checklist_json").notNull().default("[]"), budgetJson: json("budget_json").notNull(), surfaceJson: json("surface_json").notNull(),
  source: text("source").notNull(), taintedBy: text("tainted_by"), createdAt: ts("created_at").notNull(),
});
export const routineRuns = sqliteTable("routine_runs", {
  id: text("id").primaryKey(), routineId: text("routine_id").notNull(), runKey: text("run_key").notNull(), triggerRef: text("trigger_ref").notNull(), status: text("status").notNull(),
  agentRunId: text("agent_run_id"), precheckJson: json("precheck_json"), summary: text("summary"), leftForHumanJson: json("left_for_human_json").notNull().default("[]"),
  surfaceHash: text("surface_hash"), overdue: bool("overdue").notNull().default(false), attended: bool("attended").notNull().default(false),
  costUsdMicros: integer("cost_usd_micros").notNull().default(0), startedAt: ts("started_at"), endedAt: ts("ended_at"),
}, (t) => [uniqueIndex("routine_runs_run_key").on(t.runKey), index("routine_runs_routine").on(t.routineId)]);
export const events = sqliteTable("events", {
  id: text("id").primaryKey(), type: text("type").notNull(), ts: ts("ts").notNull(), subjectRef: text("subject_ref").notNull(), payloadJson: json("payload_json").notNull(),
  attended: bool("attended").notNull().default(false), requestedBy: text("requested_by"), consumedJson: json("consumed_json").notNull().default("[]"),
}, (t) => [index("events_type").on(t.type, t.id)]);
export const leases = sqliteTable("leases", {
  resource: text("resource").primaryKey(), holderRunId: text("holder_run_id").notNull(), acquiredAt: ts("acquired_at").notNull(), expiresAt: ts("expires_at").notNull(),
});
export const vaultSecrets = sqliteTable("vault_secrets", {
  name: text("name").primaryKey(), kind: text("kind").notNull(), description: text("description").notNull(), ciphertext: text("ciphertext").notNull(), iv: text("iv").notNull(),
  tag: text("tag").notNull(), fingerprint: text("fingerprint").notNull(), createdBy: text("created_by").notNull(), createdAt: ts("created_at").notNull(), lastUsedAt: ts("last_used_at"),
});

// 6.6 Simulator state (owned by T2). No sim_* table stores a resolved credential.
export const simRegistrations = sqliteTable("sim_registrations", {
  id: text("id").primaryKey(), agency: text("agency").notNull(), companyId: text("company_id").notNull(), accountType: text("account_type").notNull(),
  requestJson: json("request_json").notNull(), status: text("status").notNull(), completeAt: ts("complete_at").notNull(), accountNumber: text("account_number"), fault: text("fault"),
});
export const simAgencyMail = sqliteTable("sim_agency_mail", {
  id: text("id").primaryKey(), agency: text("agency").notNull(), direction: text("direction").notNull(), kind: text("kind").notNull(), body: text("body").notNull(),
  relatedNoticeId: text("related_notice_id"), confirmation: text("confirmation"), credentialName: text("credential_name"), ts: ts("ts").notNull(),
});
export const simBankBatches = sqliteTable("sim_bank_batches", {
  id: text("id").primaryKey(), payrollRunId: text("payroll_run_id").notNull(), totalCents: integer("total_cents").notNull(), entriesJson: json("entries_json").notNull(),
  status: text("status").notNull(), settleAt: ts("settle_at").notNull(),
});
export const simIdpAccounts = sqliteTable("sim_idp_accounts", {
  id: text("id").primaryKey(), workerId: text("worker_id").notNull(), system: text("system").notNull(), handle: text("handle").notNull(),
  groupsJson: json("groups_json").notNull().default("[]"), status: text("status").notNull(), createdAt: ts("created_at").notNull(),
});
export const simDeviceOrders = sqliteTable("sim_device_orders", {
  id: text("id").primaryKey(), workerId: text("worker_id").notNull(), sku: text("sku").notNull(), shipTo: text("ship_to").notNull(), priceCents: integer("price_cents").notNull(),
  status: text("status").notNull(), eta: ts("eta").notNull(), createdAt: ts("created_at").notNull(),
});
export const simChatMessages = sqliteTable("sim_chat_messages", {
  id: text("id").primaryKey(), channel: text("channel").notNull(), author: text("author").notNull(), text: text("text").notNull(), inbound: bool("inbound").notNull().default(false),
  cardJson: json("card_json"), ts: ts("ts").notNull(),
}, (t) => [index("sim_chat_channel").on(t.channel, t.id)]);
export const simCarrierInvoices = sqliteTable("sim_carrier_invoices", {
  id: text("id").primaryKey(), month: text("month").notNull(), carrier: text("carrier").notNull(), linesJson: json("lines_json").notNull(), totalCents: integer("total_cents").notNull(),
});
export const simFaults = sqliteTable("sim_faults", {
  target: text("target").primaryKey(), kind: text("kind").notNull(), mode: text("mode").notNull(), armed: bool("armed").notNull().default(true), firedCount: integer("fired_count").notNull().default(0),
});

// 6.7 Wave 2 (docs/wave2.md, migration 0003_wave2.sql). Additive only; owners in docs/wave2.md.
// w2-onboarding: offer lifecycle columns live on offers (see the migration); documents, signatures, form submissions, uploads.
export const documents = sqliteTable("documents", {
  id: text("id").primaryKey(), companyId: text("company_id").notNull(), workerId: text("worker_id"), offerId: text("offer_id"), kind: text("kind").notNull(),
  title: text("title").notNull(), status: text("status").notNull(), bodyText: text("body_text").notNull(), sha256: text("sha256").notNull(),
  createdAt: ts("created_at").notNull(), sentAt: ts("sent_at"), signedAt: ts("signed_at"),
}, (t) => [index("documents_worker").on(t.workerId, t.status)]);
export const signatures = sqliteTable("signatures", {
  id: text("id").primaryKey(), documentId: text("document_id").notNull(), signerPrincipalId: text("signer_principal_id").notNull(), signerName: text("signer_name").notNull(),
  typedName: text("typed_name").notNull(), signedAt: ts("signed_at").notNull(), documentSha256: text("document_sha256").notNull(), actionSeq: integer("action_seq"),
}, (t) => [uniqueIndex("signatures_document").on(t.documentId)]);
export const onboardingSubmissions = sqliteTable("onboarding_submissions", {
  id: text("id").primaryKey(), workerId: text("worker_id").notNull(), kind: text("kind").notNull(), maskedJson: json("masked_json").notNull(),   // never full account or id numbers
  documentId: text("document_id"), submittedAt: ts("submitted_at").notNull(), actionSeq: integer("action_seq"),
}, (t) => [index("onboarding_submissions_worker").on(t.workerId, t.kind)]);
export const uploads = sqliteTable("uploads", {
  id: text("id").primaryKey(), workerId: text("worker_id").notNull(), purpose: text("purpose").notNull(), fileName: text("file_name").notNull(),
  storagePath: text("storage_path").notNull(), bytes: integer("bytes").notNull(), sha256: text("sha256").notNull(), createdAt: ts("created_at").notNull(),
});
// w2-offboarding
export const offboardingCases = sqliteTable("offboarding_cases", {
  id: text("id").primaryKey(), companyId: text("company_id").notNull(), workerId: text("worker_id").notNull(), kind: text("kind").notNull(), lastDay: text("last_day").notNull(),
  reasonNote: text("reason_note").notNull().default(""), status: text("status").notNull(), createdAt: ts("created_at").notNull(), closedAt: ts("closed_at"),
}, (t) => [index("offboarding_cases_worker").on(t.workerId)]);
export const offboardingSteps = sqliteTable("offboarding_steps", {
  id: text("id").primaryKey(), caseId: text("case_id").notNull(), kind: text("kind").notNull(), status: text("status").notNull(), proposalId: text("proposal_id"),
  actionSeq: integer("action_seq"), detail: text("detail").notNull().default(""), doneAt: ts("done_at"),
}, (t) => [uniqueIndex("offboarding_steps_case_kind").on(t.caseId, t.kind)]);
// w2-benefits-contractors
export const benefitReconFindings = sqliteTable("benefit_recon_findings", {
  id: text("id").primaryKey(), companyId: text("company_id").notNull(), month: text("month").notNull(), carrier: text("carrier").notNull(), kind: text("kind").notNull(),
  workerId: text("worker_id"), planId: text("plan_id"), billedCents: integer("billed_cents").notNull(), expectedCents: integer("expected_cents").notNull(),
  deductedCents: integer("deducted_cents").notNull(), status: text("status").notNull(), detail: text("detail").notNull(), createdAt: ts("created_at").notNull(),
}, (t) => [index("benefit_recon_month").on(t.companyId, t.month)]);
export const openEnrollment = sqliteTable("open_enrollment", {
  id: text("id").primaryKey(), workerId: text("worker_id").notNull(), planYear: integer("plan_year").notNull(), status: text("status").notNull(),
  lastNudgedAt: ts("last_nudged_at"), nudges: integer("nudges").notNull().default(0), electedAt: ts("elected_at"),
}, (t) => [uniqueIndex("open_enrollment_worker_year").on(t.workerId, t.planYear)]);
export const fxRates = sqliteTable("fx_rates", {
  currency: text("currency").notNull(), asOf: text("as_of").notNull(), usdPerUnit: text("usd_per_unit").notNull(), source: text("source").notNull(),
}, (t) => [primaryKey({ columns: [t.currency, t.asOf] })]);
// Wave 2 simulators: email, payment rail, bank account verification. Same rule: no resolved credential.
export const simEmailMessages = sqliteTable("sim_email_messages", {
  id: text("id").primaryKey(), toAddr: text("to_addr").notNull(), fromAddr: text("from_addr").notNull(), subject: text("subject").notNull(), body: text("body").notNull(),
  kind: text("kind").notNull(), relatedRef: text("related_ref"), ts: ts("ts").notNull(),
}, (t) => [index("sim_email_to").on(t.toAddr, t.id)]);
export const simRailTransfers = sqliteTable("sim_rail_transfers", {
  id: text("id").primaryKey(), paymentId: text("payment_id").notNull(), amountMinor: integer("amount_minor").notNull(), currency: text("currency").notNull(),
  status: text("status").notNull(), sentAt: ts("sent_at").notNull(), deliverAt: ts("deliver_at").notNull(), deliveredAt: ts("delivered_at"),
}, (t) => [uniqueIndex("sim_rail_payment").on(t.paymentId)]);
export const simBankVerifications = sqliteTable("sim_bank_verifications", {
  id: text("id").primaryKey(), workerId: text("worker_id").notNull(), routingLast4: text("routing_last4").notNull(), accountLast4: text("account_last4").notNull(),
  status: text("status").notNull(), reason: text("reason"), ts: ts("ts").notNull(),
});
// w2-memory: recall log (what a run was shown at start) and dossier index; memory file bodies stay where harness memory keeps them.
export const memoryRecalls = sqliteTable("memory_recalls", {
  id: integer("id").primaryKey({ autoIncrement: true }), runId: text("run_id").notNull(), pathsJson: json("paths_json").notNull(), chars: integer("chars").notNull(), ts: ts("ts").notNull(),
}, (t) => [index("memory_recalls_run").on(t.runId)]);
export const dossiers = sqliteTable("dossiers", {
  subjectRef: text("subject_ref").primaryKey(), path: text("path").notNull(), refreshedAt: ts("refreshed_at").notNull(), sourceDigest: text("source_digest").notNull(),
});

// 6.8 Wave 3 (docs/wave3.md, migration 0006_wave3.sql). Additive only; owners in docs/wave3.md.
// Columns added to existing tables: paychecks.reimbursements_json (w3-expenses), departments.coverage_max_out_pct and
// coverage_min_present (w3-timeoff), workers.birth_month_day (w3-parity-routines, synthetic MM-DD, never a year); see the migration.
// w3-expenses
export const expensePolicies = sqliteTable("expense_policies", {
  id: text("id").primaryKey(), companyId: text("company_id").notNull(), version: integer("version").notNull(),
  effectiveFrom: text("effective_from").notNull(), rulesJson: json("rules_json").notNull(),
  sourcesJson: json("sources_json").notNull().default("[]")
});
export const expenses = sqliteTable("expenses", {
  id: text("id").primaryKey(), companyId: text("company_id").notNull(), workerId: text("worker_id").notNull(),
  category: text("category").notNull(), merchant: text("merchant").notNull(), amountCents: integer("amount_cents").notNull(),
  currency: text("currency").notNull().default("USD"), transactionDate: text("transaction_date").notNull(),
  submittedAt: ts("submitted_at").notNull(), businessPurpose: text("business_purpose").notNull(), attendees: text("attendees"),
  milesX10: integer("miles_x10"), tripRef: text("trip_ref"), preApprovalRef: text("pre_approval_ref"),
  receiptUploadId: text("receipt_upload_id"), receiptExtractJson: json("receipt_extract_json"), status: text("status").notNull(),
  checksJson: json("checks_json").notNull().default("[]"), explanation: text("explanation"), explanationSource: text("explanation_source"),
  explanationRunId: text("explanation_run_id"), approverPrincipalId: text("approver_principal_id"), decidedBy: text("decided_by"),
  decidedAt: ts("decided_at"), decisionReasonCode: text("decision_reason_code"), decisionNote: text("decision_note"),
  payrollRunId: text("payroll_run_id"), paycheckId: text("paycheck_id"), policyVersion: integer("policy_version").notNull().default(1),
  actionSeq: integer("action_seq"),
  source: text("source").notNull().default("portal")   // wave 4 (0007_wave4.sql, w4-parity-agent): portal, email or chat
}, (t) => [index("expenses_worker_status").on(t.workerId, t.status), index("expenses_status").on(t.status)]);
// w3-timeoff
export const timeOffTypes = sqliteTable("time_off_types", {
  id: text("id").primaryKey(), companyId: text("company_id").notNull(), kind: text("kind").notNull(), name: text("name").notNull(),
  paid: bool("paid").notNull(), countsAsVacation: bool("counts_as_vacation").notNull().default(false)
});
export const timeOffPolicies = sqliteTable("time_off_policies", {
  id: text("id").primaryKey(), companyId: text("company_id").notNull(), typeId: text("type_id").notNull(), name: text("name").notNull(),
  jurisdiction: text("jurisdiction").notNull(), schedule: text("schedule").notNull(), minutesPerPeriod: integer("minutes_per_period"),
  tiersJson: json("tiers_json").notNull().default("[]"), workedMinutesPerChunk: integer("worked_minutes_per_chunk"),
  minutesPerChunk: integer("minutes_per_chunk"), exemptDeemedMinutesPerWeek: integer("exempt_deemed_minutes_per_week"),
  accrualCapMinutes: integer("accrual_cap_minutes"), annualAccrualCapMinutes: integer("annual_accrual_cap_minutes"),
  carryoverCapMinutes: integer("carryover_cap_minutes"), annualUseCapMinutes: integer("annual_use_cap_minutes"),
  frontLoadMinutes: integer("front_load_minutes"), waitingDaysBeforeUse: integer("waiting_days_before_use").notNull().default(0),
  minIncrementMinutes: integer("min_increment_minutes").notNull().default(60),
  allowNegativeMinutes: integer("allow_negative_minutes").notNull().default(0),
  payOutAtSeparation: bool("pay_out_at_separation").notNull().default(false), reinstateWithinDays: integer("reinstate_within_days"),
  yearStart: text("year_start").notNull().default("01-01"), effectiveFrom: text("effective_from").notNull(), effectiveTo: text("effective_to"),
  sourcesJson: json("sources_json").notNull().default("[]")
});
export const timeOffAssignments = sqliteTable("time_off_assignments", {
  id: text("id").primaryKey(), policyId: text("policy_id").notNull(), workerId: text("worker_id").notNull(),
  assignedAt: ts("assigned_at").notNull(), effectiveFrom: text("effective_from").notNull(), effectiveTo: text("effective_to"),
  accrualRemainderMinutes: integer("accrual_remainder_minutes").notNull().default(0)
}, (t) => [uniqueIndex("time_off_assignments_key").on(t.policyId, t.workerId, t.effectiveFrom)]);
export const timeOffLedger = sqliteTable("time_off_ledger", {
  id: text("id").primaryKey(), assignmentId: text("assignment_id").notNull(), workerId: text("worker_id").notNull(),
  policyId: text("policy_id").notNull(), kind: text("kind").notNull(), minutes: integer("minutes").notNull(),
  effectiveDate: text("effective_date").notNull(), sourceRef: text("source_ref"), runKey: text("run_key"), note: text("note"),
  actionSeq: integer("action_seq"), createdAt: ts("created_at").notNull()
}, (t) => [index("time_off_ledger_worker").on(t.workerId, t.policyId, t.effectiveDate), uniqueIndex("time_off_ledger_run_key").on(t.runKey)]);
export const timeOffRequests = sqliteTable("time_off_requests", {
  id: text("id").primaryKey(), companyId: text("company_id").notNull(), workerId: text("worker_id").notNull(),
  policyId: text("policy_id").notNull(), status: text("status").notNull(), startAt: text("start_at").notNull(),
  endAt: text("end_at").notNull(), rangeType: text("range_type").notNull().default("date"), timeZone: text("time_zone").notNull(),
  requestedMinutes: integer("requested_minutes").notNull(), daysJson: json("days_json").notNull(),
  reason: text("reason").notNull().default(""), approverPrincipalId: text("approver_principal_id"),
  routingJson: json("routing_json").notNull().default("[]"), checksJson: json("checks_json").notNull().default("[]"),
  decidedBy: text("decided_by"), decidedAt: ts("decided_at"), decisionNote: text("decision_note"), payrollRunId: text("payroll_run_id"),
  actionSeq: integer("action_seq"), source: text("source").notNull().default("weft"), extRef: text("ext_ref"), createdAt: ts("created_at").notNull()
}, (t) => [index("time_off_requests_worker").on(t.workerId, t.status), index("time_off_requests_status").on(t.status)]);
export const holidayCalendars = sqliteTable("holiday_calendars", {
  id: text("id").primaryKey(), companyId: text("company_id").notNull(), name: text("name").notNull(), year: integer("year").notNull()
});
export const holidays = sqliteTable("holidays", {
  id: text("id").primaryKey(), calendarId: text("calendar_id").notNull(), date: text("date").notNull(), name: text("name").notNull(),
  minutes: integer("minutes").notNull().default(480), workerTypes: text("worker_types").notNull().default("employee")
}, (t) => [uniqueIndex("holidays_calendar_date").on(t.calendarId, t.date)]);
// w3-parity-routines
export const checkins = sqliteTable("checkins", {
  id: text("id").primaryKey(), workerId: text("worker_id").notNull(), dueOn: text("due_on").notNull(), status: text("status").notNull(),
  answersJson: json("answers_json"), sentAt: ts("sent_at"), nudgedAt: ts("nudged_at"), submittedAt: ts("submitted_at"),
  createdAt: ts("created_at").notNull()
}, (t) => [uniqueIndex("checkins_worker_due").on(t.workerId, t.dueOn)]);
export const contractorTaxForms = sqliteTable("contractor_tax_forms", {
  id: text("id").primaryKey(), workerId: text("worker_id").notNull(), form: text("form").notNull(), signedOn: text("signed_on").notNull(),
  expiresOn: text("expires_on"), documentId: text("document_id"), status: text("status").notNull(), createdAt: ts("created_at").notNull()
}, (t) => [index("contractor_tax_forms_worker").on(t.workerId)]);
// w3-integrations-hr
export const integrationConnections = sqliteTable("integration_connections", {
  id: text("id").primaryKey(), companyId: text("company_id").notNull(), vendor: text("vendor").notNull(), mode: text("mode").notNull(),
  lastSyncAt: ts("last_sync_at"), cursor: text("cursor"), health: text("health").notNull().default("ok"), detail: text("detail"),
  ownershipJson: json("ownership_json"), settingsJson: json("settings_json").notNull().default("{}"), updatedAt: ts("updated_at").notNull()
}, (t) => [uniqueIndex("integration_connections_vendor").on(t.companyId, t.vendor)]);
export const extLinks = sqliteTable("ext_links", {
  id: text("id").primaryKey(), companyId: text("company_id").notNull(), vendor: text("vendor").notNull(), extType: text("ext_type").notNull(),
  extId: text("ext_id").notNull(), weftType: text("weft_type").notNull(), weftId: text("weft_id").notNull(),
  extVersion: integer("ext_version"), status: text("status").notNull().default("linked"), createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull()
}, (t) => [uniqueIndex("ext_links_ext").on(t.vendor, t.extType, t.extId), index("ext_links_weft").on(t.weftType, t.weftId)]);
export const extSnapshots = sqliteTable("ext_snapshots", {
  vendor: text("vendor").notNull(), extType: text("ext_type").notNull(), extId: text("ext_id").notNull(), field: text("field").notNull(),
  valueHash: text("value_hash").notNull(), seenAt: ts("seen_at").notNull()
}, (t) => [primaryKey({ columns: [t.vendor, t.extType, t.extId, t.field] })]);
export const integrationDeliveries = sqliteTable("integration_deliveries", {
  id: text("id").primaryKey(), vendor: text("vendor").notNull(), dedupeKey: text("dedupe_key").notNull(), action: text("action"),
  receivedAt: ts("received_at").notNull(), verified: bool("verified").notNull(), rawSha256: text("raw_sha256").notNull(),
  appliedAt: ts("applied_at"), error: text("error")
}, (t) => [uniqueIndex("integration_deliveries_key").on(t.vendor, t.dedupeKey)]);
export const syncItems = sqliteTable("sync_items", {
  id: text("id").primaryKey(), companyId: text("company_id").notNull(), vendor: text("vendor").notNull(), kind: text("kind").notNull(),
  subjectRef: text("subject_ref").notNull(), status: text("status").notNull(), detailJson: json("detail_json").notNull(),
  createdAt: ts("created_at").notNull(), resolvedAt: ts("resolved_at"), resolvedBy: text("resolved_by")
}, (t) => [index("sync_items_status").on(t.status)]);
// w3-integrations-screening-esign
export const screeningPackages = sqliteTable("screening_packages", {
  id: text("id").primaryKey(), vendor: text("vendor").notNull(), slug: text("slug").notNull(), name: text("name").notNull(),
  priceCents: integer("price_cents").notNull(), screeningsJson: json("screenings_json").notNull(), phase: text("phase").notNull()
}, (t) => [uniqueIndex("screening_packages_slug").on(t.vendor, t.slug)]);
export const screeningOrders = sqliteTable("screening_orders", {
  id: text("id").primaryKey(), companyId: text("company_id").notNull(), offerId: text("offer_id").notNull(), workerId: text("worker_id"),
  vendor: text("vendor").notNull(), mode: text("mode").notNull(), packageSlug: text("package_slug").notNull(),
  priceCents: integer("price_cents").notNull(), phase: text("phase").notNull(), status: text("status").notNull(), result: text("result"),
  adjudication: text("adjudication").notNull().default("none"), timerPaused: bool("timer_paused").notNull().default(false),
  vendorCandidateId: text("vendor_candidate_id"), vendorOrderId: text("vendor_order_id"), vendorReportId: text("vendor_report_id"),
  applyUrl: text("apply_url"), etaOn: text("eta_on"), lastPolledAt: ts("last_polled_at"), createdAt: ts("created_at").notNull(),
  completedAt: ts("completed_at"), proposalId: text("proposal_id"), actionSeq: integer("action_seq")
}, (t) => [index("screening_orders_offer").on(t.offerId)]);
export const esignEnvelopes = sqliteTable("esign_envelopes", {
  id: text("id").primaryKey(), companyId: text("company_id").notNull(), offerId: text("offer_id").notNull(),
  provider: text("provider").notNull(), mode: text("mode").notNull(), envelopeId: text("envelope_id").notNull(),
  status: text("status").notNull(), sentAt: ts("sent_at").notNull(), deliveredAt: ts("delivered_at"), completedAt: ts("completed_at"),
  voidedAt: ts("voided_at"), lastPolledAt: ts("last_polled_at"), combinedSha256: text("combined_sha256"),
  certificateSha256: text("certificate_sha256")
}, (t) => [uniqueIndex("esign_envelopes_envelope").on(t.provider, t.envelopeId), index("esign_envelopes_offer").on(t.offerId)]);
export const signatureEvidence = sqliteTable("signature_evidence", {
  signatureId: text("signature_id").primaryKey(), provider: text("provider").notNull(), envelopeId: text("envelope_id"), ip: text("ip"),
  userAgent: text("user_agent")
});
// w3-integrations-hr
export const simVendorRecords = sqliteTable("sim_vendor_records", {
  id: text("id").primaryKey(), vendor: text("vendor").notNull(), kind: text("kind").notNull(), extId: text("ext_id").notNull(),
  version: integer("version").notNull().default(1), bodyJson: json("body_json").notNull(), createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull()
}, (t) => [uniqueIndex("sim_vendor_records_ext").on(t.vendor, t.kind, t.extId)]);
export const simWebhookOutbox = sqliteTable("sim_webhook_outbox", {
  id: text("id").primaryKey(), vendor: text("vendor").notNull(), dedupeKey: text("dedupe_key").notNull(),
  bodyJson: json("body_json").notNull(), signature: text("signature").notNull(), attempt: integer("attempt").notNull().default(0),
  nextAt: ts("next_at").notNull(), status: text("status").notNull(), deliveredAt: ts("delivered_at")
}, (t) => [uniqueIndex("sim_webhook_outbox_key").on(t.vendor, t.dedupeKey)]);

// 6.9 Wave 4 (docs/wave4.md, migration 0007_wave4.sql). Additive only; owners in docs/wave4.md.
// Columns added to existing tables: notices.source and upload_id, filings.due_on, prepared_json and proposal_id
// (w4-parity-compliance), expenses.source (w4-parity-agent); see the migration.
// w4-parity-compliance
export const complianceItems = sqliteTable("compliance_items", {
  id: text("id").primaryKey(), companyId: text("company_id").notNull(), kind: text("kind").notNull(), title: text("title").notNull(),
  jurisdiction: text("jurisdiction"), agency: text("agency"), form: text("form"), period: text("period"), dueOn: text("due_on").notNull(),
  status: text("status").notNull(), subjectRef: text("subject_ref"), ownerPrincipalId: text("owner_principal_id"), proposalId: text("proposal_id"),
  createdAt: ts("created_at").notNull(), doneAt: ts("done_at")
}, (t) => [uniqueIndex("compliance_items_key").on(t.companyId, t.kind, t.form, t.period, t.subjectRef), index("compliance_items_due").on(t.companyId, t.dueOn)]);
export const handoffCases = sqliteTable("handoff_cases", {
  id: text("id").primaryKey(), companyId: text("company_id").notNull(), kind: text("kind").notNull(), reason: text("reason").notNull(),
  subjectRef: text("subject_ref"), workerId: text("worker_id"), summary: text("summary").notNull(), evidenceJson: json("evidence_json").notNull().default("[]"),
  status: text("status").notNull(), assigneePrincipalId: text("assignee_principal_id"), openedBy: text("opened_by").notNull(), runId: text("run_id"),
  createdAt: ts("created_at").notNull(), resolvedAt: ts("resolved_at"), resolutionNote: text("resolution_note")
}, (t) => [index("handoff_cases_status").on(t.companyId, t.status)]);
export const trainingCourses = sqliteTable("training_courses", {
  id: text("id").primaryKey(), companyId: text("company_id").notNull(), code: text("code").notNull(), title: text("title").notNull(),
  jurisdiction: text("jurisdiction"), audience: text("audience").notNull(), minutes: integer("minutes").notNull(),
  dueWithinDays: integer("due_within_days").notNull(), repeatMonths: integer("repeat_months"), sourceUrl: text("source_url").notNull()
}, (t) => [uniqueIndex("training_courses_code").on(t.companyId, t.code)]);
export const trainingAssignments = sqliteTable("training_assignments", {
  id: text("id").primaryKey(), workerId: text("worker_id").notNull(), courseId: text("course_id").notNull(), dueOn: text("due_on").notNull(),
  status: text("status").notNull(), assignedAt: ts("assigned_at").notNull(), remindedAt: ts("reminded_at"), completedAt: ts("completed_at"),
  certificateUploadId: text("certificate_upload_id"), proposalId: text("proposal_id")
}, (t) => [uniqueIndex("training_assignments_worker_course_due").on(t.workerId, t.courseId, t.dueOn)]);
// w4-parity-people
export const lifeEvents = sqliteTable("life_events", {
  id: text("id").primaryKey(), workerId: text("worker_id").notNull(), kind: text("kind").notNull(), eventDate: text("event_date").notNull(),
  note: text("note").notNull().default(""), status: text("status").notNull(), reportedBy: text("reported_by").notNull(),
  reportedAt: ts("reported_at").notNull(), windowId: text("window_id")
}, (t) => [index("life_events_worker").on(t.workerId)]);
export const enrollmentWindows = sqliteTable("enrollment_windows", {
  id: text("id").primaryKey(), companyId: text("company_id").notNull(), workerId: text("worker_id"), kind: text("kind").notNull(),
  lifeEventId: text("life_event_id"), opensOn: text("opens_on").notNull(), closesOn: text("closes_on").notNull(), status: text("status").notNull(),
  remindersSent: integer("reminders_sent").notNull().default(0), createdAt: ts("created_at").notNull()
}, (t) => [index("enrollment_windows_worker").on(t.workerId, t.status)]);
export const carrierSubmissions = sqliteTable("carrier_submissions", {
  id: text("id").primaryKey(), workerId: text("worker_id").notNull(), windowId: text("window_id"), carrier: text("carrier").notNull(),
  electionsJson: json("elections_json").notNull(), status: text("status").notNull(), sentAt: ts("sent_at"), confirmedAt: ts("confirmed_at"),
  receiptRef: text("receipt_ref"), proposalId: text("proposal_id"), createdAt: ts("created_at").notNull()
}, (t) => [index("carrier_submissions_worker").on(t.workerId)]);
// w4-parity-agent
export const agentMentions = sqliteTable("agent_mentions", {
  id: text("id").primaryKey(), companyId: text("company_id").notNull(), channel: text("channel").notNull(), messageRef: text("message_ref").notNull(),
  threadRef: text("thread_ref"), mentionedBy: text("mentioned_by").notNull(), status: text("status").notNull(), runId: text("run_id"),
  createdAt: ts("created_at").notNull(), answeredAt: ts("answered_at")
}, (t) => [uniqueIndex("agent_mentions_message").on(t.messageRef)]);
export const expenseIntake = sqliteTable("expense_intake", {
  id: text("id").primaryKey(), companyId: text("company_id").notNull(), source: text("source").notNull(), fromAddress: text("from_address").notNull(),
  workerId: text("worker_id"), messageRef: text("message_ref").notNull(), uploadId: text("upload_id"), status: text("status").notNull(),
  expenseId: text("expense_id"), receivedAt: ts("received_at").notNull()
}, (t) => [uniqueIndex("expense_intake_message").on(t.messageRef)]);
export const routineWaits = sqliteTable("routine_waits", {
  id: text("id").primaryKey(), routineRunId: text("routine_run_id").notNull(), checklistItemId: text("checklist_item_id").notNull(),
  kind: text("kind").notNull(), event: text("event"), subjectRef: text("subject_ref"), untilAt: ts("until_at"), status: text("status").notNull(),
  followUps: integer("follow_ups").notNull().default(0), nextFollowUpAt: ts("next_follow_up_at"), createdAt: ts("created_at").notNull(),
  resumedAt: ts("resumed_at")
}, (t) => [index("routine_waits_open").on(t.status, t.event, t.subjectRef)]);
// w4-parity-admin
export const agentActionOverrides = sqliteTable("agent_action_overrides", {
  id: text("id").primaryKey(), companyId: text("company_id").notNull(), principalId: text("principal_id").notNull(), command: text("command").notNull(),
  mode: text("mode").notNull(), setBy: text("set_by").notNull(), setAt: ts("set_at").notNull(), proposalId: text("proposal_id")
}, (t) => [uniqueIndex("agent_action_overrides_key").on(t.companyId, t.principalId, t.command)]);

// 6.10 Weft on Cloudflare (docs/cloudflare/design.md 4.1, migration 0008_hosted.sql). Additive only; owner
// cf0-contracts (names in packages/contracts/src/ext/cf-db.ts HOSTED_TABLES). Present on Node too and empty there
// unless a hosted option is on (WEFT_MEMORY=sqlite, WEFT_BLOBS=sqlite); the digest skips them while they are empty.
// The SQL memory repo: real git objects (same SHAs as git), the one ref, and the commit log with its chain trailer.
export const memObjects = sqliteTable("mem_objects", { sha: text("sha").primaryKey(), type: text("type").notNull(), body: blob("body", { mode: "buffer" }).notNull() });
export const memRefs = sqliteTable("mem_refs", { name: text("name").primaryKey(), sha: text("sha").notNull() });
export const memLog = sqliteTable("mem_log", {
  seq: integer("seq").primaryKey(), sha: text("sha").notNull(), parent: text("parent"), date: text("date").notNull(),
  chainSeq: integer("chain_seq"), chainHash: text("chain_hash"),
});
// Uploads in 1 MiB chunks (uploads.storage_path `blob:<sha256>`), run artifact and code bodies, run handles (a bearer
// credential: never in run_steps, read by no route), small per-world state, and the after-commit jobs outbox.
export const blobs = sqliteTable("blobs", { key: text("key").notNull(), idx: integer("idx").notNull(), bytes: blob("bytes", { mode: "buffer" }).notNull() }, (t) => [primaryKey({ columns: [t.key, t.idx] })]);
export const runFiles = sqliteTable("run_files", { path: text("path").primaryKey(), body: text("body").notNull() });
export const runHandles = sqliteTable("run_handles", { runId: text("run_id").primaryKey(), token: text("token").notNull(), nonce: text("nonce") });
export const kvState = sqliteTable("kv_state", { key: text("key").primaryKey(), value: text("value").notNull() });
export const outbox = sqliteTable("outbox", { id: text("id").primaryKey(), kind: text("kind").notNull(), body: text("body").notNull(), createdAt: ts("created_at").notNull() });
