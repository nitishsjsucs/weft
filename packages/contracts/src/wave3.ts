import { z } from "zod";
// Wave 3 shared contracts (docs/wave3.md). Landed by the wave 3 architect before the tracks start; additive only.
// Tracks implement against these types and must not change their shape; additions go to
// packages/contracts/src/ext/<track-id>.ts plus a note in .scratch/contract-requests/<track-id>.md.
// Money is integer cents, time off is integer minutes, dates are YYYY-MM-DD in the company time zone.
const e = <T extends [string, ...string[]]>(...v: T) => z.enum(v);
const id = (p: string) => z.string().startsWith(p);
const iso = z.string();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Same shape as a paycheck flag (flags_json): every deterministic check in wave 3 writes this. */
export const W3Check = z.object({ rule: z.string(), severity: e("info", "review", "block"), message: z.string(), evidence: z.array(z.object({ label: z.string(), ref: z.string() })).default([]) });
export type W3Check = z.infer<typeof W3Check>;

// ---------- w3-expenses (research/wave3/expenses-timeoff.md section 7) ----------

export const ExpenseCategory = e("travel", "lodging", "meals", "mileage", "equipment", "software", "office", "supplies"); export type ExpenseCategory = z.infer<typeof ExpenseCategory>;
export const ExpenseStatus = e("submitted", "needs_review", "returned", "approved", "approved_taxable", "declined", "scheduled", "paid"); export type ExpenseStatus = z.infer<typeof ExpenseStatus>;
/** The four list bands on the Expenses screen. */
export const ExpenseBand = e("needs_review", "approved", "paid_out", "declined"); export type ExpenseBand = z.infer<typeof ExpenseBand>;
export const EXPENSE_BANDS: Record<ExpenseBand, readonly ExpenseStatus[]> = {
  needs_review: ["submitted", "needs_review", "returned"], approved: ["approved", "approved_taxable", "scheduled"], paid_out: ["paid"], declined: ["declined"],
};
export const ExpenseRuleCode = e("RECEIPT_MISSING", "RECEIPT_MISMATCH", "DUPLICATE", "ACCOUNTABLE_WINDOW", "OVER_CATEGORY_LIMIT", "MEALS_DETAIL_MISSING", "PER_DIEM_OVER", "MILEAGE_RATE", "OUTSIDE_EMPLOYMENT", "FUTURE_DATE", "CA_NECESSARY_EXPENSE", "SECOND_APPROVER");
export type ExpenseRuleCode = z.infer<typeof ExpenseRuleCode>;
/** One decision per call (no bulk decide exists anywhere). */
export const ExpenseDecision = e("approve", "approve_taxable", "return", "decline"); export type ExpenseDecision = z.infer<typeof ExpenseDecision>;
export const ExpenseDeclineReason = e("no_receipt", "duplicate", "personal", "over_policy", "late", "other"); export type ExpenseDeclineReason = z.infer<typeof ExpenseDeclineReason>;
/** Published 2026 rates the policy engine uses (sources in research/wave3/expenses-timeoff.md 3.3). */
export const EXPENSE_RATES = {
  mileageCentsPerMileX10: [{ from: "2026-01-01", to: "2026-06-30", centsPerMileX10: 725 }, { from: "2026-07-01", to: "2026-12-31", centsPerMileX10: 760 }],
  receiptRequiredAtCents: 7500, perDiemMealsCents: 6800, perDiemTravelDayCents: 5100,
  lodgingCents: [{ from: "2025-10-01", to: "2026-09-30", cents: 11000 }, { from: "2026-10-01", to: "2027-09-30", cents: 11300 }],
  accountableWindowDays: 60,
} as const;
export const Expense = z.object({
  id: id("exp_"), workerId: id("wrk_"), category: ExpenseCategory, merchant: z.string(), amountCents: z.number().int(), currency: z.literal("USD"),
  transactionDate: date, submittedAt: iso, businessPurpose: z.string(), attendees: z.string().nullable(), milesX10: z.number().int().nullable(),
  tripRef: z.string().nullable(), receiptUploadId: id("upl_").nullable(), status: ExpenseStatus, band: ExpenseBand, checks: z.array(W3Check),
  explanation: z.string().nullable(), explanationSource: e("agent", "template").nullable(), approverPrincipalId: z.string().nullable(),
  decidedBy: z.string().nullable(), decidedAt: iso.nullable(), decisionReasonCode: ExpenseDeclineReason.nullable(), payrollRunId: id("pay_").nullable(), policyVersion: z.number().int(),
});
export type Expense = z.infer<typeof Expense>;
/** Employee-entered fields are untrusted (merchant, businessPurpose, attendees, receipt extraction). */
export const EXPENSE_UNTRUSTED_FIELDS = ["merchant", "business_purpose", "attendees", "receipt_extract"] as const;
export const ExpenseSubmission = z.object({
  category: ExpenseCategory, merchant: z.string().min(1).max(120), amountCents: z.number().int().min(1).max(10_000_000), transactionDate: date,
  businessPurpose: z.string().min(1).max(400), attendees: z.string().max(400).nullable().default(null), milesX10: z.number().int().min(1).max(100_000).nullable().default(null),
  tripRef: z.string().max(40).nullable().default(null), preApprovalRef: z.string().max(40).nullable().default(null),
}).strict();
export type ExpenseSubmission = z.infer<typeof ExpenseSubmission>;
export const ExpenseDecideBody = z.object({ decision: ExpenseDecision, reasonCode: ExpenseDeclineReason.nullable().default(null), note: z.string().max(400).default("") }).strict();
export type ExpenseDecideBody = z.infer<typeof ExpenseDecideBody>;
/** paychecks.reimbursements_json entries. */
export const ReimbursementLine = z.object({ expenseId: id("exp_"), category: ExpenseCategory, amountCents: z.number().int() });
export type ReimbursementLine = z.infer<typeof ReimbursementLine>;

// ---------- w3-timeoff (research/wave3/expenses-timeoff.md section 6) ----------

export const TimeOffTypeKind = e("vacation", "sick", "unpaid_sick", "prenatal", "holiday", "unpaid"); export type TimeOffTypeKind = z.infer<typeof TimeOffTypeKind>;
export const TimeOffJurisdiction = e("US", "CA", "CA-Oakland", "NY", "NY-NYC", "CO", "TX"); export type TimeOffJurisdiction = z.infer<typeof TimeOffJurisdiction>;
export const AccrualSchedule = e("per_pay_period", "per_hour_worked", "front_load_annual", "unlimited"); export type AccrualSchedule = z.infer<typeof AccrualSchedule>;
export const TimeOffLedgerKind = e("import", "accrual", "accrual_capped", "front_load", "use", "hold", "hold_release", "adjustment", "carryover_forfeit", "payout", "reinstatement");
export type TimeOffLedgerKind = z.infer<typeof TimeOffLedgerKind>;
export const TimeOffRequestStatus = e("pending", "approved", "denied", "cancelled", "taken"); export type TimeOffRequestStatus = z.infer<typeof TimeOffRequestStatus>;
export const TimeOffCheckRule = e("INSUFFICIENT_BALANCE", "WAITING_PERIOD", "USE_CAP", "INCREMENT", "COVERAGE_CONFLICT", "OVERLAPS_PAYROLL_DEADLINE", "INCLUDES_HOLIDAY", "SHORT_NOTICE");
export type TimeOffCheckRule = z.infer<typeof TimeOffCheckRule>;
export const TimeOffDecision = e("approve", "deny"); export type TimeOffDecision = z.infer<typeof TimeOffDecision>;
/** Defaults for department coverage (departments.coverage_max_out_pct, coverage_min_present). */
export const COVERAGE_DEFAULTS = { maxOutPct: 30, minPresent: 2 } as const;
export const MINUTES_PER_DAY = 480;
export const TimeOffBalance = z.object({
  workerId: id("wrk_"), policyId: id("top_"), typeKind: TimeOffTypeKind, asOf: date,
  accruedUnlockedMinutes: z.number().int(), accruedLockedMinutes: z.number().int(), usedMinutes: z.number().int(), holdsMinutes: z.number().int(), availableMinutes: z.number().int(),
});
export type TimeOffBalance = z.infer<typeof TimeOffBalance>;
export const TimeOffDay = z.object({ date, minutes: z.number().int().min(0), holiday: z.boolean() });
export const TimeOffRequest = z.object({
  id: id("tor_"), workerId: id("wrk_"), policyId: id("top_"), status: TimeOffRequestStatus, startAt: z.string(), endAt: z.string(), rangeType: e("date", "datetime"),
  requestedMinutes: z.number().int(), days: z.array(TimeOffDay), reason: z.string(), approverPrincipalId: z.string().nullable(),
  routing: z.array(z.object({ principalId: z.string().nullable(), why: z.string() })), checks: z.array(W3Check),
  decidedBy: z.string().nullable(), decidedAt: iso.nullable(), decisionNote: z.string().nullable(), payrollRunId: id("pay_").nullable(), createdAt: iso,
});
export type TimeOffRequest = z.infer<typeof TimeOffRequest>;
/** The employee never types an amount: minutes come from the dates and the holiday calendar. `reason` is untrusted. */
export const TimeOffSubmission = z.object({
  policyId: id("top_"), startDate: date, endDate: date, partialDayMinutes: z.number().int().min(60).max(480).nullable().default(null), reason: z.string().max(400).default(""),
}).strict();
export type TimeOffSubmission = z.infer<typeof TimeOffSubmission>;
export const TimeOffDecideBody = z.object({ decision: TimeOffDecision, note: z.string().max(400).default("") }).strict();
export type TimeOffDecideBody = z.infer<typeof TimeOffDecideBody>;
export const TeamCalendarDay = z.object({ date, out: z.array(z.object({ workerId: id("wrk_"), requestId: id("tor_"), status: TimeOffRequestStatus })), holiday: z.string().nullable(), outPct: z.number(), overLimit: z.boolean() });
export const TeamCalendar = z.object({ departmentId: id("dpt_"), from: date, to: date, headcount: z.number().int(), days: z.array(TeamCalendarDay) });
export type TeamCalendar = z.infer<typeof TeamCalendar>;
/** New paycheck earning line kinds (salaried gross is split, never increased). */
export const W3EarningKind = e("pto", "sick", "paid_holiday", "taxable_reimbursement"); export type W3EarningKind = z.infer<typeof W3EarningKind>;

// ---------- w3-parity-chat: reports, charts, chat that can propose, approval card ----------

export const ReportMetric = e("payroll_cost_by_month", "headcount_by_state", "headcount_by_department", "hires_and_departures_by_month", "turnover_rate", "time_off_minutes_by_month", "expenses_by_category");
export type ReportMetric = z.infer<typeof ReportMetric>;
export const ChartSpec = z.object({
  kind: e("bar", "line", "stacked_bar"), title: z.string(), x: z.object({ key: z.string(), label: z.string() }),
  series: z.array(z.object({ key: z.string(), label: z.string(), unit: e("cents", "count", "minutes", "pct") })).min(1).max(6),
});
export type ChartSpec = z.infer<typeof ChartSpec>;
export const ReportResult = z.object({ metric: ReportMetric, from: date, to: date, rows: z.array(z.record(z.string(), z.union([z.string(), z.number()]))), chart: ChartSpec, artifactRef: id("art_").nullable() });
export type ReportResult = z.infer<typeof ReportResult>;
/** Chat card for a proposal (extends sim.ts ApprovalCard). Field values come from the proposal's stored preview, never model text. */
export const ApprovalCardW3 = z.object({
  proposalId: id("prp_"), headline: z.string(), risk: z.string(), moneyCents: z.number().int().nullable(), routineName: z.string().nullable(),
  subjectName: z.string().nullable(), approverName: z.string().nullable(), fields: z.array(z.object({ label: z.string(), value: z.string() })).max(12),
  status: e("pending", "approved", "denied", "expired", "superseded"),
});
export type ApprovalCardW3 = z.infer<typeof ApprovalCardW3>;
/**
 * Harness 5.3 wave 3 amendment (proposed; gated by the `agent.chat_can_propose` setting, default "off" until Nitish
 * says yes). Chat reads grow to 16 (actions.get_run leaves chat; it stays on MCP). When code (never the model) reads an
 * action intent in the request and the setting is on, the run gets CHAT_ACT_TOOLS instead: every write on it is R2 or
 * R4, so it is always a proposal. Tainted runs keep today's refusals.
 */
export const CHAT_TOOLS_W3 = [
  "people.search", "people.get", "payroll.list_runs", "payroll.get_run", "tax.get_rates", "tax.list_registrations", "notices.list", "notices.get",
  "actions.list", "memory.search", "memory.read", "agent.read_artifact", "comms.post_update", "reports.query", "expenses.list", "time_off.list_requests",
] as const;
export const CHAT_ACT_TOOLS = [
  "people.search", "people.get", "payroll.list_runs", "payroll.get_run", "actions.list", "memory.search", "agent.read_artifact", "comms.post_update",
  "reports.query", "expenses.list", "expenses.get", "time_off.list_requests", "time_off.get_balance",
  "payroll.propose_off_cycle", "expenses.decide", "time_off.decide",
] as const;
/**
 * Wave 4 chat domain routing (docs/evals/error-analysis.md FM2). Both chat lists hold comms.post_update, which the loop
 * never offers to chat, so that slot can carry one domain read without breaking the cap of 16. Code (never the model)
 * picks it from the person's words when the run opens, and it is frozen in the run's allowlist like every other name.
 * Every route is a read: a routed run can look more up, never change more.
 * Round 2 (docs/evals/round1-analysis.md R5, R6): a domain may have a second read. It takes CHAT_ROUTE_SPARE, the tax
 * registrations read, which no routed domain question needs; that name is on the default read list only, so in act
 * mode (and when the request names tax words) the domain brings its first read alone. Each entry names the slot it
 * takes, so every routed name is still listed here once, and the list never grows past 16.
 */
export const CHAT_ROUTE_SLOT = "comms.post_update" as const;
export const CHAT_ROUTE_SPARE = "tax.list_registrations" as const;
export const CHAT_DOMAIN_ROUTES = [
  { domain: "benefits_reconcile", tool: "benefits.list_findings", slot: CHAT_ROUTE_SLOT },
  { domain: "integrations_sync", tool: "integrations.list_sync_items", slot: CHAT_ROUTE_SLOT },
  { domain: "integrations_sync", tool: "integrations.status", slot: CHAT_ROUTE_SPARE },
  { domain: "team_calendar", tool: "time_off.team_calendar", slot: CHAT_ROUTE_SLOT },
  { domain: "contractor_payouts", tool: "contractors.list_payouts", slot: CHAT_ROUTE_SLOT },
] as const;
export type ChatDomainRoute = (typeof CHAT_DOMAIN_ROUTES)[number]["domain"];
/**
 * Round 2 FG3 (docs/evals/round1-analysis.md R5): an optional, non-storing carrier read. `invoice(month)` stores the
 * invoice on its first call, so a read command never calls it. A carrier simulator that also offers `peekInvoice`
 * (same lines, nothing written, no fault consumed) lets benefits.list_findings show a labeled preview for a month that
 * was never reconciled; without it the read says only that the month was never reconciled.
 */
export interface CarrierInvoicePeek {
  peekInvoice(month: string): Promise<{ id?: string; month: string; carrier: string; lines: { workerId: string; planId: string; amountCents: number; tier?: string; periods?: number }[]; totalCents: number }>;
}
export function hasCarrierPeek(carrier: unknown): carrier is CarrierInvoicePeek {
  return typeof carrier === "object" && carrier !== null && typeof (carrier as { peekInvoice?: unknown }).peekInvoice === "function";
}
export const W3_SETTINGS = { chatCanPropose: "agent.chat_can_propose", allowAutoAutonomy: "agent.allow_auto_autonomy" } as const;
/** New ceiling keys (limits rows seeded by the owning track's seed step; `${key}_day` is the daily aggregate). */
export const W3_CEILINGS = { expense: "agent.expense_cents", expenseAuto: "agent.expense_auto_cents", screening: "agent.screening_cents" } as const;

// ---------- w3-parity-routines ----------

/** RoutineDef.autonomy gains "auto" (routines.ts). Auto never runs R4 without approval; tainted runs fall back to approve. */
export const RoutineAutonomy = e("recommend", "approve", "auto"); export type RoutineAutonomy = z.infer<typeof RoutineAutonomy>;
export const MilestoneKind = e("work_anniversary", "birthday"); export type MilestoneKind = z.infer<typeof MilestoneKind>;
export const ReadyCheckItem = e("accounts_active", "device_delivered", "bank_verified", "w4_submitted", "state_form_submitted", "i9_done", "benefits_decided", "state_registration_active");
export type ReadyCheckItem = z.infer<typeof ReadyCheckItem>;
export const ContractorTaxForm = e("w9", "w8ben", "w8bene"); export type ContractorTaxForm = z.infer<typeof ContractorTaxForm>;
export const CheckinStatus = e("scheduled", "sent", "nudged", "submitted", "skipped"); export type CheckinStatus = z.infer<typeof CheckinStatus>;

// ---------- integrations (w3-integrations-hr owns the framework; w3-integrations-screening-esign its three vendors) ----------

export const IntegrationVendor = e("greenhouse", "workday", "checkr", "hireright", "docusign"); export type IntegrationVendor = z.infer<typeof IntegrationVendor>;
export const IntegrationCategory = e("ats", "hris", "screening", "esign"); export type IntegrationCategory = z.infer<typeof IntegrationCategory>;
export const VENDOR_CATEGORY: Record<IntegrationVendor, IntegrationCategory> = { greenhouse: "ats", workday: "hris", checkr: "screening", hireright: "screening", docusign: "esign" };
/** UI label: "Simulated" or "Connected". Real only when every required secret resolves and WEFT_INTEGRATIONS_REAL=1. */
export const ConnectorMode = e("simulated", "real"); export type ConnectorMode = z.infer<typeof ConnectorMode>;
export const ConnectorHealth = e("ok", "auth_failed", "rate_limited", "permission_gap", "unreachable", "not_available"); export type ConnectorHealth = z.infer<typeof ConnectorHealth>;
export const ConnectorStatus = z.object({
  vendor: IntegrationVendor, category: IntegrationCategory, mode: ConnectorMode, configured: z.boolean(), lastSyncAt: iso.nullable(), cursor: z.string().nullable(),
  health: ConnectorHealth, detail: z.string().nullable(),   // structured, never vendor free text
});
export type ConnectorStatus = z.infer<typeof ConnectorStatus>;
/** Secret names per vendor, read only through WEFT_SECRETS_FILE. The UI shows present or missing, never a value. */
export const INTEGRATION_SECRETS: Record<IntegrationVendor, readonly string[]> = {
  greenhouse: ["WEFT_GREENHOUSE_CLIENT_ID", "WEFT_GREENHOUSE_CLIENT_SECRET"],
  workday: ["WEFT_WORKDAY_HOST", "WEFT_WORKDAY_TENANT", "WEFT_WORKDAY_CLIENT_ID", "WEFT_WORKDAY_CLIENT_SECRET", "WEFT_WORKDAY_REFRESH_TOKEN", "WEFT_WORKDAY_TOKEN_URL"],
  checkr: ["CHECKR_API_KEY"],
  hireright: [],   // no public API: the real adapter always refuses with INTEGRATION_NOT_AVAILABLE
  docusign: ["DOCUSIGN_INTEGRATION_KEY", "DOCUSIGN_USER_ID", "DOCUSIGN_ACCOUNT_ID", "DOCUSIGN_PRIVATE_KEY_FILE"],
};
/** Optional secrets (webhook signing keys, the public board token). */
export const INTEGRATION_OPTIONAL_SECRETS: Record<IntegrationVendor, readonly string[]> = {
  greenhouse: ["WEFT_GREENHOUSE_WEBHOOK_SECRET", "WEFT_GREENHOUSE_BOARD_TOKEN"], workday: [], checkr: [], hireright: [], docusign: ["DOCUSIGN_CONNECT_HMAC_KEY"],
};
export const IntegrationCard = z.object({
  status: ConnectorStatus, title: z.string(), body: z.string(), freePath: z.string(), secrets: z.array(z.object({ name: z.string(), present: z.boolean(), optional: z.boolean() })),
  ownership: z.record(z.string(), e("weft", "vendor")).nullable(),   // Workday: people, compensation, time_off
});
export type IntegrationCard = z.infer<typeof IntegrationCard>;
export interface SyncPage<T> { items: T[]; nextCursor: string | null; rateLimit: { remaining: number | null; resetAt: string | null } }
export const SyncItemKind = e("sync_conflict", "unmapped_value", "orphaned", "permission_gap"); export type SyncItemKind = z.infer<typeof SyncItemKind>;
export const SyncItem = z.object({ id: id("syn_"), vendor: IntegrationVendor, kind: SyncItemKind, subjectRef: z.string(), status: e("open", "resolved", "dismissed"), detail: z.record(z.string(), z.string()), createdAt: iso, resolvedAt: iso.nullable() });
export type SyncItem = z.infer<typeof SyncItem>;
export interface WebhookVerdict { ok: boolean; dedupeKey: string | null }

/** Greenhouse (Harvest v3), normalized. Candidate fields are untrusted. */
export interface AtsHire { applicationId: string; candidateId: string; offerId: string; offerVersion: number; first: string; last: string; email: string; jobName: string; departmentExtId: string | null; officeExtId: string | null; startDate: string | null; salary: { amountMinor: number; currency: string } | null; hiredAt: string }
export interface AtsJob { id: string; name: string; departmentName: string | null; officeName: string | null; location: string | null; updatedAt: string; url: string | null }
export interface AtsConnector {
  status(): Promise<ConnectorStatus>;
  testConnection(): Promise<ConnectorStatus>;
  listHires(q: { updatedAfter: string | null; cursor: string | null }): Promise<SyncPage<AtsHire>>;
  getHire(applicationId: string): Promise<AtsHire | null>;
  listJobs(q: { cursor: string | null; source: "board" | "harvest" }): Promise<SyncPage<AtsJob>>;
  verifyWebhook(raw: Uint8Array, headers: Record<string, string>): WebhookVerdict;
  parseWebhook(raw: Uint8Array): { action: string; applicationId: string | null } | null;   // ids only
  markHired(req: { applicationId: string; startDate: string; credential: string }): Promise<{ ok: true }>;   // proposal only
}
/** Workday, normalized. Time-off comments are untrusted. */
export interface HrisWorker { workerRef: string; employeeId: string; first: string; last: string; workEmail: string | null; title: string | null; orgRef: string | null; managerRef: string | null; locationState: string | null; hireDate: string | null; terminationDate: string | null; baseAmountMinor: number | null; currency: string | null; frequency: string | null; updatedAt: string }
export interface HrisOrg { orgRef: string; name: string; kind: string }
export interface HrisTimeOffEntry { entryRef: string; workerRef: string; date: string; quantityMinutes: number; typeRef: string; status: string; comment: string | null }
export interface HrisBalance { workerRef: string; planRef: string; asOf: string; minutes: number }
export interface HrisConnector {
  status(): Promise<ConnectorStatus>;
  testConnection(): Promise<ConnectorStatus & { services: string[] }>;
  listChangedWorkers(q: { updatedFrom: string; updatedThrough: string; page: number }): Promise<SyncPage<HrisWorker>>;
  listOrganizations(q: { cursor: string | null }): Promise<SyncPage<HrisOrg>>;
  listTimeOff(q: { workerRef: string; from: string; to: string; status: "approved" | "all" }): Promise<SyncPage<HrisTimeOffEntry>>;
  listBalances(q: { workerRef: string; asOf: string }): Promise<SyncPage<HrisBalance>>;
  requestTimeOff(req: { workerRef: string; days: { date: string; minutes: number; typeRef: string }[]; credential: string }): Promise<{ eventRef: string; status: string }>;   // proposal only
}
/** Background screening (Checkr, HireRight), normalized. Record text never leaves the human-only path. */
export const ScreeningStatus = e("invited", "consented", "in_progress", "suspended", "disputed", "complete_clear", "complete_review", "canceled", "expired");
export type ScreeningStatus = z.infer<typeof ScreeningStatus>;
export const Adjudication = e("none", "engaged", "pre_adverse", "post_adverse"); export type Adjudication = z.infer<typeof Adjudication>;
export interface ScreeningPackage { slug: string; name: string; priceCents: number; screenings: string[]; phase: "full" | "non_criminal" | "criminal" }
export interface ScreeningSnapshot { status: ScreeningStatus; result: "clear" | "consider" | null; adjudication: Adjudication; etaOn: string | null; completedAt: string | null; vendorReportId: string | null }
export interface ScreeningConnector {
  status(): Promise<ConnectorStatus>;
  listPackages(): Promise<ScreeningPackage[]>;
  createOrder(i: { orderId: string; candidate: { first: string; last: string; email: string }; packageSlug: string; workLocation: { country: string; state: string; city: string | null } }): Promise<{ vendorCandidateId: string; vendorOrderId: string; applyUrl: string; status: ScreeningStatus }>;
  getOrder(vendorOrderId: string): Promise<ScreeningSnapshot>;
  cancelOrder(vendorOrderId: string): Promise<void>;
  verifyWebhook(raw: Uint8Array, headers: Record<string, string>): WebhookVerdict;
  parseWebhook(raw: Uint8Array): { dedupeKey: string; vendorOrderId: string; kind: string }[];
  // human-only path; never reachable from a model surface
  listAdverseItems(vendorReportId: string): Promise<{ id: string; text: string }[]>;
  startPreAdverse(vendorReportId: string, itemIds: string[], postNoticeAt: string): Promise<{ vendorAdverseId: string }>;
  cancelAdverse(vendorAdverseId: string): Promise<void>;
}
export const EnvelopeStatus = e("sent", "delivered", "completed", "declined", "voided"); export type EnvelopeStatus = z.infer<typeof EnvelopeStatus>;
export interface ESignConnector {
  status(): Promise<ConnectorStatus>;
  send(i: { offerId: string; documents: { weftDocId: string; title: string; bytes: Uint8Array; sha256: string }[]; signer: { name: string; email: string; clientUserId: string }; expiresOn: string | null }): Promise<{ envelopeId: string; status: "sent" }>;
  signingUrl(envelopeId: string, signer: { name: string; email: string; clientUserId: string }, returnUrl: string): Promise<{ url: string; expiresAt: string }>;
  envelope(envelopeId: string): Promise<{ status: EnvelopeStatus; recipients: { clientUserId: string; status: string }[] }>;
  void(envelopeId: string, reason: string): Promise<void>;
  download(envelopeId: string, which: "combined" | "certificate"): Promise<Uint8Array>;
  verifyWebhook(raw: Uint8Array, headers: Record<string, string>): WebhookVerdict;
  parseWebhook(raw: Uint8Array): { dedupeKey: string; envelopeId: string; event: string }[];
}
/** Webhook deliveries and poll results are applied by these system commands after a re-read (never from the body). */
export const VENDOR_APPLY_COMMAND: Record<IntegrationVendor, string> = {
  greenhouse: "integrations.record_ats_hire", workday: "integrations.apply_hris_change", checkr: "screening.apply_vendor_event", hireright: "screening.apply_vendor_event", docusign: "documents.apply_esign_event",
};
/** Simulators.vendors (sim.ts). packages/sim builds the simulated set; @weft/integrations may overlay real adapters. */
export interface VendorConnectors { greenhouse: AtsConnector; workday: HrisConnector; checkr: ScreeningConnector; hireright: ScreeningConnector; docusign: ESignConnector }
/** Offer lifecycle with the wave 3 `declined` state (envelope declined by the candidate). OFFER_TRANSITIONS stays frozen. */
export const OfferLifecycleW3 = e("draft", "sent", "viewed", "accepted", "voided", "expired", "declined"); export type OfferLifecycleW3 = z.infer<typeof OfferLifecycleW3>;
export const OFFER_TRANSITIONS_W3: Record<OfferLifecycleW3, readonly OfferLifecycleW3[]> = {
  draft: ["sent", "voided"], sent: ["viewed", "voided", "expired", "declined"], viewed: ["accepted", "voided", "expired", "declined"],
  accepted: [], voided: [], expired: [], declined: [],
};
export const ScreeningOrder = z.object({
  id: id("scr_"), offerId: id("offr_"), workerId: id("wrk_").nullable(), vendor: e("checkr", "hireright"), mode: ConnectorMode, packageSlug: z.string(), priceCents: z.number().int(),
  status: ScreeningStatus, result: e("clear", "consider").nullable(), adjudication: Adjudication, phase: e("full", "non_criminal", "criminal"), etaOn: date.nullable(),
  createdAt: iso, completedAt: iso.nullable(),
});
export type ScreeningOrder = z.infer<typeof ScreeningOrder>;
export const EsignEnvelope = z.object({ id: id("env_"), offerId: id("offr_"), provider: e("builtin", "docusign"), mode: ConnectorMode, envelopeId: z.string(), status: EnvelopeStatus, sentAt: iso, completedAt: iso.nullable(), voidedAt: iso.nullable() });
export type EsignEnvelope = z.infer<typeof EsignEnvelope>;

// ---------- planned commands (owners implement; names, risk and access are the contract) ----------

export interface PlannedCommand { name: string; owner: string; risk: "R0" | "R1" | "R2" | "R3" | "R4"; access: "all" | "human_only" | "system_only"; approval: "never" | "always" }
const pc = (owner: string, risk: PlannedCommand["risk"], access: PlannedCommand["access"], approval: PlannedCommand["approval"], ...names: string[]): PlannedCommand[] => names.map((name) => ({ name, owner, risk, access, approval }));
export const W3_PLANNED_COMMANDS: readonly PlannedCommand[] = [
  ...pc("w3-expenses", "R0", "all", "never", "expenses.list", "expenses.get"),
  ...pc("w3-expenses", "R1", "all", "never", "expenses.check_policy", "expenses.explain"),
  ...pc("w3-expenses", "R2", "all", "always", "expenses.decide"),
  ...pc("w3-expenses", "R2", "human_only", "never", "expenses.submit", "expenses.resubmit", "expenses.reopen"),
  ...pc("w3-expenses", "R1", "system_only", "never", "expenses.schedule", "expenses.mark_paid"),
  ...pc("w3-timeoff", "R0", "all", "never", "time_off.list_policies", "time_off.get_balance", "time_off.list_requests", "time_off.team_calendar"),
  ...pc("w3-timeoff", "R1", "all", "never", "time_off.check_request", "time_off.route_request"),
  ...pc("w3-timeoff", "R2", "all", "always", "time_off.decide", "time_off.adjust_balance"),
  ...pc("w3-timeoff", "R2", "human_only", "never", "time_off.submit", "time_off.cancel", "time_off.reopen"),
  ...pc("w3-timeoff", "R1", "system_only", "never", "time_off.post_accruals", "time_off.close_year", "time_off.record_payout"),
  ...pc("w3-parity-chat", "R0", "all", "never", "reports.query"),
  ...pc("w3-parity-routines", "R1", "all", "never", "notices.escalate", "routines.set_autonomy"),
  ...pc("w3-parity-routines", "R0", "all", "never", "people.list_milestones", "onboarding.ready_check", "contractors.list_tax_forms"),
  ...pc("w3-integrations-hr", "R0", "all", "never", "integrations.status", "integrations.list_sync_items", "ats.get_hire", "ats.list_jobs", "hris.get_worker_external", "hris.list_time_off"),
  ...pc("w3-integrations-hr", "R1", "all", "never", "integrations.sync_now"),
  ...pc("w3-integrations-hr", "R2", "all", "always", "integrations.map_value"),
  ...pc("w3-integrations-hr", "R3", "all", "always", "ats.mark_hired", "hris.request_time_off"),
  ...pc("w3-integrations-hr", "R1", "system_only", "never", "integrations.record_ats_hire", "integrations.apply_hris_change", "integrations.record_delivery"),
  ...pc("w3-integrations-hr", "R2", "human_only", "never", "integrations.resolve_sync_item"),
  ...pc("w3-integrations-screening-esign", "R0", "all", "never", "screening.list_packages", "screening.get_status", "documents.get_envelope"),
  ...pc("w3-integrations-screening-esign", "R4", "all", "always", "screening.order"),
  ...pc("w3-integrations-screening-esign", "R3", "all", "always", "screening.cancel", "documents.resend_envelope"),
  ...pc("w3-integrations-screening-esign", "R3", "human_only", "never", "screening.proceed_to_criminal", "screening.review", "screening.engage", "screening.start_pre_adverse", "screening.send_final_adverse", "screening.cancel_adverse"),
  ...pc("w3-integrations-screening-esign", "R1", "system_only", "never", "screening.apply_vendor_event", "documents.apply_esign_event"),
];

// ---------- new event types (validated by Wave3EventBody; the frozen EventBody union is unchanged) ----------
const ref = (p: string) => z.string().startsWith(p);
const ev = <T extends string, P extends z.ZodRawShape>(type: T, payload: P) => z.object({ type: z.literal(type), payload: z.object(payload).strict() });
export const Wave3EventBody = z.discriminatedUnion("type", [
  ev("expense.submitted", { expense_id: ref("exp_"), worker_id: ref("wrk_") }),
  ev("expense.decided", { expense_id: ref("exp_"), status: z.string() }),
  ev("expense.paid", { expense_id: ref("exp_"), payroll_run_id: ref("pay_") }),
  ev("time_off.request.created", { request_id: ref("tor_"), worker_id: ref("wrk_") }),
  ev("time_off.request.routed", { request_id: ref("tor_") }),
  ev("time_off.request.decided", { request_id: ref("tor_"), status: z.string() }),
  ev("time_off.request.cancelled", { request_id: ref("tor_") }),
  ev("time_off.balance.adjusted", { worker_id: ref("wrk_"), policy_id: ref("top_") }),
  ev("offer.imported", { offer_id: ref("offr_"), vendor: z.string() }),
  ev("offer.declined", { offer_id: ref("offr_") }),
  ev("integration.ats_hire_detected", { vendor: z.string(), application_ref: z.string() }),
  ev("integration.sync_item_opened", { sync_item_id: ref("syn_") }),
  ev("people.external_change", { worker_id: ref("wrk_"), vendor: z.string() }),
  ev("screening.status_changed", { order_id: ref("scr_"), status: z.string() }),
  ev("esign.envelope_changed", { envelope_id: ref("env_"), status: z.string() }),
  ev("checkin.submitted", { checkin_id: ref("chk_"), worker_id: ref("wrk_") }),
]);
export type Wave3EventBody = z.infer<typeof Wave3EventBody>;
export const WAVE3_EVENT_TYPES = Wave3EventBody.options.map((o) => o.shape.type.value);

/** Id prefixes added in wave 3 (also in ids.ts ID_PREFIXES). */
export const WAVE3_ID_PREFIXES = ["exp_", "epol_", "tot_", "top_", "tasn_", "tol_", "tor_", "hcal_", "hol_", "extl_", "dlv_", "syn_", "scr_", "spk_", "env_", "chk_", "ctf_", "simx_", "simo_"] as const;
