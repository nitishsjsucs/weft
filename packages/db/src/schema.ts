// Drizzle schema for SPEC 6 (frozen after the scaffold commit). Ids are prefixed text; timestamps are ISO-8601 UTC
// strings from the sim clock (spend uses the wall clock); money columns end in _cents; JSON columns end in _json.
import { sqliteTable, text, integer, primaryKey, uniqueIndex, index } from "drizzle-orm/sqlite-core";

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
  netCents: integer("net_cents").notNull(), reimbursementsCents: integer("reimbursements_cents").notNull().default(0), earningsJson: json("earnings_json").notNull(),
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
});
export const filings = sqliteTable("filings", {
  id: text("id").primaryKey(), taxAccountId: text("tax_account_id").notNull(), form: text("form").notNull(), period: text("period").notNull(),
  status: text("status").notNull(), filedAt: ts("filed_at"), confirmation: text("confirmation"),
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
