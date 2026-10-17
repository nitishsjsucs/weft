import { z } from "zod";
// Wave 4 shared contracts (docs/wave4.md). Landed by the wave 4 architect before the tracks start; additive only.
// Tracks implement against these types and must not change their shape; additions go to
// packages/contracts/src/ext/<track-id>.ts plus a note in .scratch/contract-requests/<track-id>.md.
// Money is integer cents, time is integer minutes, dates are YYYY-MM-DD in the company time zone.
// Telemetry contracts live in telemetry.ts and the eval task schema in evals.ts.
const e = <T extends [string, ...string[]]>(...v: T) => z.enum(v);
const id = (p: string) => z.string().startsWith(p);
const iso = z.string();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// ---------- w4-parity-compliance: recurring filings, the compliance calendar, notices, handoffs, training ----------

/** Forms Weft prepares on a schedule. Federal 941 and 940, W-2 and W-3, 1099-NEC, and one wage report per seeded state. */
export const FilingForm = e("941", "940", "w2_w3", "1099_nec", "ca_de9", "ca_de9c", "ny_nys45", "tx_c3", "co_uitr1", "co_dr1094");
export type FilingForm = z.infer<typeof FilingForm>;
export const FilingCadence = e("quarterly", "annual", "monthly"); export type FilingCadence = z.infer<typeof FilingCadence>;
/** One row per form in the filing rule table the compliance track writes (packages/core/src/compliance/rules.ts). */
export const FilingRule = z.object({
  form: FilingForm, agency: z.string(), jurisdiction: z.string(), cadence: FilingCadence,
  /** Days after the period end the form is due (quarterly 941: the last day of the month after the quarter). */
  dueRule: z.string(), sourceUrl: z.string(), appliesTo: e("employees", "contractors", "all"),
});
export type FilingRule = z.infer<typeof FilingRule>;
export const ComplianceItemKind = e("filing", "deposit", "notice_response", "registration", "training_due", "contractor_form_expiry", "benefits_window_close");
export type ComplianceItemKind = z.infer<typeof ComplianceItemKind>;
export const ComplianceItemStatus = e("upcoming", "due_soon", "prepared", "proposed", "done", "overdue", "waived");
export type ComplianceItemStatus = z.infer<typeof ComplianceItemStatus>;
/** A compliance calendar row. Calendar entries are derived in code from rules and records, never from model text. */
export const ComplianceItem = z.object({
  id: id("cal_"), kind: ComplianceItemKind, title: z.string(), jurisdiction: z.string().nullable(), agency: z.string().nullable(),
  form: FilingForm.nullable(), period: z.string().nullable(), dueOn: date, status: ComplianceItemStatus,
  subjectRef: z.string().nullable(),   // fil_, ntc_, tra_, ctf_, ewn_ or txa_ id
  ownerPrincipalId: z.string().nullable(), proposalId: id("prp_").nullable(), createdAt: iso, doneAt: iso.nullable(),
});
export type ComplianceItem = z.infer<typeof ComplianceItem>;
/** Days before dueOn when a row becomes due_soon and the reminder routine posts it. */
export const COMPLIANCE_DUE_SOON_DAYS = 14;

/** Where a notice came from. `upload` is a person uploading a mailed notice (T4); its text is untrusted. */
export const NoticeSource = e("simulated", "upload"); export type NoticeSource = z.infer<typeof NoticeSource>;
/** How the agency notice routine handles each notice kind (R12). `escalate` hands it to a person with an evidence pack. */
export const NoticeHandling = e("update_rate", "attach_filing", "update_deposit_schedule", "pay_penalty_or_abate", "acknowledge", "escalate");
export type NoticeHandling = z.infer<typeof NoticeHandling>;
export const NOTICE_HANDLING: Record<string, NoticeHandling> = {
  rate_change: "update_rate", missing_filing: "attach_filing", deposit_schedule_change: "update_deposit_schedule",
  late_deposit_penalty: "pay_penalty_or_abate", futa_credit_reduction: "acknowledge", benefit_charge: "escalate", registration_confirmed: "acknowledge",
};
export const NoticeUploadBody = z.object({ uploadId: id("upl_"), agencyHint: z.string().max(40).nullable().default(null) }).strict();
export type NoticeUploadBody = z.infer<typeof NoticeUploadBody>;

/** A hand-off to a person (G11, T3, T9): a tax specialist, an HR person, or a vendor specialist, with the reason logged. */
export const HandoffKind = e("tax_specialist", "hr_person", "vendor_specialist"); export type HandoffKind = z.infer<typeof HandoffKind>;
export const HandoffStatus = e("open", "acknowledged", "resolved", "cancelled"); export type HandoffStatus = z.infer<typeof HandoffStatus>;
export const HandoffReason = e("judgment_needed", "power_of_attorney", "medical_leave", "accommodation", "workplace_concern", "unknown_notice_kind", "low_confidence_extract", "employee_asked", "other");
export type HandoffReason = z.infer<typeof HandoffReason>;
export const HandoffCase = z.object({
  id: id("hnd_"), kind: HandoffKind, reason: HandoffReason, subjectRef: z.string().nullable(), workerId: id("wrk_").nullable(),
  summary: z.string(), evidence: z.array(z.object({ label: z.string(), ref: z.string() })), status: HandoffStatus,
  assigneePrincipalId: z.string().nullable(), openedBy: z.string(), runId: id("run_").nullable(), createdAt: iso, resolvedAt: iso.nullable(),
});
export type HandoffCase = z.infer<typeof HandoffCase>;

/** State-required training (T11). The rule rows carry their source; the track confirms each rule against the statute. */
export const TrainingCourseCode = e("ca_harassment_supervisor", "ca_harassment_staff", "ny_harassment", "il_harassment", "security_awareness");
export type TrainingCourseCode = z.infer<typeof TrainingCourseCode>;
export const TrainingAssignmentStatus = e("assigned", "reminded", "completed", "overdue", "waived");
export type TrainingAssignmentStatus = z.infer<typeof TrainingAssignmentStatus>;
export const TrainingAssignment = z.object({
  id: id("tra_"), workerId: id("wrk_"), courseId: id("trc_"), courseCode: TrainingCourseCode, dueOn: date, status: TrainingAssignmentStatus,
  assignedAt: iso, remindedAt: iso.nullable(), completedAt: iso.nullable(), certificateUploadId: id("upl_").nullable(),
});
export type TrainingAssignment = z.infer<typeof TrainingAssignment>;

// ---------- w4-parity-people: life events, enrollment windows, carriers, check-ins, digest, first day ----------

export const LifeEventKind = e("marriage", "divorce", "birth", "adoption", "move", "loss_of_coverage", "death_of_dependent");
export type LifeEventKind = z.infer<typeof LifeEventKind>;
export const LifeEventStatus = e("reported", "window_open", "elected", "closed_no_change", "expired", "rejected");
export type LifeEventStatus = z.infer<typeof LifeEventStatus>;
/** Default special enrollment window length; the people track confirms it per plan and records the source. */
export const LIFE_EVENT_WINDOW_DAYS = 30;
export const LifeEventReport = z.object({ kind: LifeEventKind, eventDate: date, note: z.string().max(400).default("") }).strict();
export type LifeEventReport = z.infer<typeof LifeEventReport>;
export const EnrollmentWindowKind = e("new_hire", "life_event", "open_enrollment"); export type EnrollmentWindowKind = z.infer<typeof EnrollmentWindowKind>;
export const EnrollmentWindowStatus = e("scheduled", "open", "closed", "cancelled"); export type EnrollmentWindowStatus = z.infer<typeof EnrollmentWindowStatus>;
export const EnrollmentWindow = z.object({
  id: id("ewn_"), workerId: id("wrk_").nullable(), kind: EnrollmentWindowKind, lifeEventId: id("lev_").nullable(), opensOn: date, closesOn: date,
  status: EnrollmentWindowStatus, remindersSent: z.number().int(), createdAt: iso,
});
export type EnrollmentWindow = z.infer<typeof EnrollmentWindow>;
/** An election filed with a (simulated) carrier or 401(k) provider, with its receipt (T5, R9). */
export const CarrierSubmissionStatus = e("queued", "sent", "confirmed", "rejected"); export type CarrierSubmissionStatus = z.infer<typeof CarrierSubmissionStatus>;
/** The 30-day check-in form (R15): fixed questions, answers are the hire's own words and untrusted. */
export const CHECKIN_QUESTIONS = [
  { key: "settled", label: "How settled do you feel, from 1 to 5?", kind: "scale" },
  { key: "tools", label: "Do you have every tool and account you need?", kind: "yes_no" },
  { key: "clarity", label: "Is it clear what is expected of you this quarter?", kind: "yes_no" },
  { key: "blocker", label: "What is getting in your way, if anything?", kind: "text" },
  { key: "manager_note", label: "Anything you want your manager to know?", kind: "text" },
] as const;
export const CheckinAnswers = z.object({ settled: z.number().int().min(1).max(5), tools: z.boolean(), clarity: z.boolean(), blocker: z.string().max(600).default(""), manager_note: z.string().max(600).default("") }).strict();
export type CheckinAnswers = z.infer<typeof CheckinAnswers>;
export const CHECKIN_DAY = 30;

// ---------- w4-parity-agent: portal questions, tagging the agent, email intake, wait and resume ----------

/**
 * Employee self-service in the portal (T9). The API picks PORTAL_TOOLS for a portal run; every tool resolves the
 * caller's own worker from the principal and never takes a worker id argument. All read only. Code (never the model)
 * classifies a human-only topic and opens a handoff as the employee's own request; the agent then says a person will
 * follow up. No harness 5.3 relaxation: the portal agent never files proposals.
 */
export const PORTAL_TOOLS = ["portal.my_profile", "portal.my_paychecks", "portal.my_time_off", "portal.my_benefits", "portal.policy_search", "memory.search"] as const;
export const PortalTopic = e("pay", "time_off", "benefits", "policy", "tax_forms", "medical_leave", "accommodation", "workplace_concern", "other");
export type PortalTopic = z.infer<typeof PortalTopic>;
export const PORTAL_HUMAN_ONLY_TOPICS: readonly PortalTopic[] = ["medical_leave", "accommodation", "workplace_concern"];
export const PortalAskBody = z.object({ text: z.string().min(1).max(2000), threadId: id("thr_").nullable().default(null) }).strict();
export type PortalAskBody = z.infer<typeof PortalAskBody>;

/** Tagging the agent in a simulated chat thread or channel (Q6). The thread text is untrusted, so the run is tainted and read only. */
export const MENTION_HANDLE = "@weft";
export const AgentMentionStatus = e("queued", "running", "answered", "refused", "ignored"); export type AgentMentionStatus = z.infer<typeof AgentMentionStatus>;
export const AgentMention = z.object({
  id: id("mnt_"), channel: z.string(), messageRef: z.string(), threadRef: z.string().nullable(), mentionedBy: z.string(),
  status: AgentMentionStatus, runId: id("run_").nullable(), createdAt: iso, answeredAt: iso.nullable(),
});
export type AgentMention = z.infer<typeof AgentMention>;

/** Email expense submission (S5). Accepted only from a worker's address on file; body and attachment are untrusted. */
export const ExpenseIntakeSource = e("portal", "email", "chat"); export type ExpenseIntakeSource = z.infer<typeof ExpenseIntakeSource>;
export const ExpenseIntakeStatus = e("received", "created", "bounced_unknown_sender", "bounced_no_receipt", "duplicate");
export type ExpenseIntakeStatus = z.infer<typeof ExpenseIntakeStatus>;
export const SimInboundEmail = z.object({ from: z.string().email(), subject: z.string().max(200), body: z.string().max(4000), attachment: z.object({ fileName: z.string(), fixture: z.string() }).nullable() }).strict();
export type SimInboundEmail = z.infer<typeof SimInboundEmail>;

/** Wait and resume (G6). A routine run parks on a wait and the engine resumes it when the event, time or decision arrives. */
export const RoutineWaitKind = e("event", "until", "proposal"); export type RoutineWaitKind = z.infer<typeof RoutineWaitKind>;
export const RoutineWaitStatus = e("waiting", "resumed", "expired", "cancelled"); export type RoutineWaitStatus = z.infer<typeof RoutineWaitStatus>;
/** A checklist item may declare one wait; the engine opens it when the item fails at the end of a run segment. */
export const RoutineWaitSpec = z.object({
  kind: RoutineWaitKind, event: z.string().nullable().default(null), subjectRefTemplate: z.string().nullable().default(null),
  timeoutDays: z.number().int().min(1).max(60), followUpEveryDays: z.number().int().min(1).max(14).nullable().default(null),
}).strict();
export type RoutineWaitSpec = z.infer<typeof RoutineWaitSpec>;
export const RoutineWait = z.object({
  id: id("rwt_"), routineRunId: id("rtr_"), checklistItemId: z.string(), kind: RoutineWaitKind, event: z.string().nullable(), subjectRef: z.string().nullable(),
  untilAt: iso.nullable(), status: RoutineWaitStatus, followUps: z.number().int(), createdAt: iso, resumedAt: iso.nullable(),
});
export type RoutineWait = z.infer<typeof RoutineWait>;
/** Additive: `ChecklistItem.wait` (optional). The frozen ChecklistItem interface is unchanged; the engine reads this shape. */
export interface ChecklistItemW4 { id: string; label: string; check: string; wait?: RoutineWaitSpec }

// ---------- w4-parity-admin: Reports screen, permissions screen, routine gallery ----------

/** Metrics added for the Reports screen and R16 (weekly headcount and cost by state). ReportMetric (wave3.ts) is unchanged. */
export const ReportMetricW4 = e("payroll_cost_by_state", "headcount_and_cost_by_state", "contractor_vs_employee_cost_by_month", "compliance_due_by_month");
export type ReportMetricW4 = z.infer<typeof ReportMetricW4>;
/** Per-action narrowing of the agent below the domain grant (G1): `deny` hides the command, `propose_only` forces a proposal. */
export const AgentActionOverrideMode = e("deny", "propose_only"); export type AgentActionOverrideMode = z.infer<typeof AgentActionOverrideMode>;
export const AgentActionOverride = z.object({ id: id("aov_"), principalId: z.string(), command: z.string(), mode: AgentActionOverrideMode, setBy: z.string(), setAt: iso });
export type AgentActionOverride = z.infer<typeof AgentActionOverride>;
export const PermissionMatrixRow = z.object({
  principalId: z.string(), name: z.string(), role: z.string(),
  domains: z.record(z.string(), e("none", "view", "edit", "approve")), agentDomains: z.record(z.string(), e("none", "view", "edit", "approve")),
  overrides: z.array(AgentActionOverride),
});
export type PermissionMatrixRow = z.infer<typeof PermissionMatrixRow>;
export const RoutineGalleryRow = z.object({
  routineId: id("rt_"), name: z.string(), enabled: z.boolean(), autonomy: e("recommend", "approve", "auto"), source: e("prebuilt", "custom"),
  createdBy: z.string().nullable(), enabledAt: iso.nullable(), lastRunAt: iso.nullable(), lastRunStatus: z.string().nullable(), nextRunAt: iso.nullable(),
  approvals: z.number().int(), overrides: z.number().int(),
});
export type RoutineGalleryRow = z.infer<typeof RoutineGalleryRow>;

// ---------- planned commands (owners implement; names, risk, access and approval are the contract) ----------

export interface PlannedCommandW4 { name: string; owner: string; risk: "R0" | "R1" | "R2" | "R3" | "R4"; access: "all" | "human_only" | "system_only"; approval: "never" | "always" }
const pc = (owner: string, risk: PlannedCommandW4["risk"], access: PlannedCommandW4["access"], approval: PlannedCommandW4["approval"], ...names: string[]): PlannedCommandW4[] => names.map((name) => ({ name, owner, risk, access, approval }));
export const W4_PLANNED_COMMANDS: readonly PlannedCommandW4[] = [
  ...pc("w4-parity-compliance", "R0", "all", "never", "compliance.calendar", "tax.list_filings", "tax.get_filing", "handoffs.list", "training.list_assignments"),
  ...pc("w4-parity-compliance", "R1", "all", "never", "tax.prepare_filing", "handoffs.open"),
  ...pc("w4-parity-compliance", "R4", "all", "always", "tax.file_return"),
  ...pc("w4-parity-compliance", "R3", "all", "always", "training.assign", "training.send_reminders"),
  ...pc("w4-parity-compliance", "R1", "system_only", "never", "compliance.refresh_calendar", "notices.ingest_upload"),
  ...pc("w4-parity-compliance", "R2", "human_only", "never", "handoffs.resolve", "training.complete"),
  // integrator: harness 5.4 (the t2 registry rule) requires approval for every R2 notices.* and benefits enrollment
  // command; a person's own submission still runs directly because human callers execute an "always" command.
  ...pc("w4-parity-compliance", "R2", "human_only", "always", "notices.upload"),
  ...pc("w4-parity-compliance", "R2", "all", "always", "tax.set_deposit_schedule"),
  ...pc("w4-parity-compliance", "R1", "all", "never", "notices.acknowledge"),
  ...pc("w4-parity-compliance", "R3", "all", "always", "compliance.post_reminders"),
  ...pc("w4-parity-people", "R0", "all", "never", "benefits.list_life_events", "benefits.list_windows", "benefits.list_carrier_submissions", "people.out_this_week"),
  ...pc("w4-parity-people", "R1", "all", "never", "benefits.open_window", "benefits.send_window_reminders"),
  ...pc("w4-parity-people", "R3", "all", "always", "benefits.submit_elections", "comms.send_first_day_message"),
  ...pc("w4-parity-people", "R2", "human_only", "always", "benefits.report_life_event", "benefits.elect_in_window"),
  ...pc("w4-parity-people", "R1", "human_only", "never", "onboarding.submit_checkin_form"),
  ...pc("w4-parity-agent", "R1", "human_only", "never", "portal.request_handoff"),
  ...pc("w4-parity-people", "R0", "all", "never", "onboarding.list_first_days"),
  ...pc("w4-parity-people", "R1", "system_only", "never", "benefits.close_windows", "benefits.record_carrier_receipt"),
  ...pc("w4-parity-agent", "R0", "all", "never", "portal.my_profile", "portal.my_paychecks", "portal.my_time_off", "portal.my_benefits", "portal.policy_search", "routines.list_waits"),
  ...pc("w4-parity-agent", "R1", "system_only", "never", "expenses.intake_email", "agent.record_mention", "routines.open_wait", "routines.resume_wait"),
  ...pc("w4-parity-admin", "R0", "all", "never", "routines.gallery", "settings.permission_matrix"),
  ...pc("w4-parity-admin", "R2", "all", "always", "settings.set_agent_action_override"),
  ...pc("w4-parity-admin", "R0", "all", "never", "reports.breakdown"),
  ...pc("w4-parity-admin", "R3", "all", "always", "comms.send_report"),
];

// ---------- new event types (validated by Wave4EventBody; the frozen EventBody union is unchanged) ----------
const ref = (p: string) => z.string().startsWith(p);
const ev = <T extends string, P extends z.ZodRawShape>(type: T, payload: P) => z.object({ type: z.literal(type), payload: z.object(payload).strict() });
export const Wave4EventBody = z.discriminatedUnion("type", [
  ev("compliance.item_due_soon", { item_id: ref("cal_") }),
  ev("compliance.item_overdue", { item_id: ref("cal_") }),
  ev("filing.prepared", { filing_id: ref("fil_") }),
  ev("filing.filed", { filing_id: ref("fil_") }),
  ev("notice.uploaded", { notice_id: ref("ntc_"), upload_id: ref("upl_") }),
  ev("handoff.opened", { handoff_id: ref("hnd_") }),
  ev("handoff.resolved", { handoff_id: ref("hnd_") }),
  ev("training.assigned", { assignment_id: ref("tra_"), worker_id: ref("wrk_") }),
  ev("training.completed", { assignment_id: ref("tra_"), worker_id: ref("wrk_") }),
  ev("life_event.reported", { life_event_id: ref("lev_"), worker_id: ref("wrk_") }),
  ev("enrollment_window.opened", { window_id: ref("ewn_") }),
  ev("enrollment_window.closed", { window_id: ref("ewn_") }),
  ev("carrier.submission_confirmed", { submission_id: ref("csb_") }),
  ev("worker.first_day", { worker_id: ref("wrk_") }),
  ev("chat.agent_mentioned", { mention_id: ref("mnt_") }),
  ev("email.expense_received", { intake_id: ref("exi_") }),
  ev("routine.wait_resumed", { wait_id: ref("rwt_"), routine_run_id: ref("rtr_") }),
]);
export type Wave4EventBody = z.infer<typeof Wave4EventBody>;
export const WAVE4_EVENT_TYPES = Wave4EventBody.options.map((o) => o.shape.type.value);

/** Id prefixes added in wave 4 (also in ids.ts ID_PREFIXES). `cmp_` is the company, so calendar rows use `cal_`. */
export const WAVE4_ID_PREFIXES = ["cal_", "hnd_", "trc_", "tra_", "lev_", "ewn_", "csb_", "mnt_", "exi_", "rwt_", "aov_"] as const;
