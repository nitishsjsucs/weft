// Employee self-service in the portal (T9, docs/wave4.md). Owner: w4-parity-agent.
// Every portal.* read resolves the caller's own worker from the principal (the person a chat run acts for, or the
// signed-in person) and takes no worker id, so a question about someone else can only ever read the asker's record.
// The topic classifier is code: a human-only topic never reaches the model; the route opens an hr_person hand-off as
// the employee's own request (portal.request_handoff, human only) and answers with a fixed line.
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { formatCents, PORTAL_HUMAN_ONLY_TOPICS, type PortalTopic } from "@weft/contracts";
import {
  benefitEnrollments, benefitPlans, departments, handoffCases, holidays, paychecks, payrollRuns, principals, timeOffPolicies, timeOffTypes, workers,
  type DbTx,
} from "@weft/db";
import { DomainRefusal, isDetailed, ptDateOf, readCommand, responseFormatField, riskOf, writeCommand } from "../demo/define";
import { EXPENSE_POLICY_V1 } from "../expenses/policy";
import { assignmentsOf, balanceFor, policyById, workerOf } from "../time-off/store";
import { timeForms } from "../time-off/forms";
import type { WeftCommand } from "../shared/deps";

// ---------- the caller's own worker ----------

/** The principal whose own record a portal read serves: the person a run acts for, or the signed-in person. */
export function selfPrincipalId(ctx: { principal: { id: string; kind: string }; onBehalfOf: string | null }): string | null {
  return ctx.principal.kind === "human" ? ctx.principal.id : ctx.onBehalfOf;
}

export interface SelfWorker { principalId: string; workerId: string; display: string }

/** The caller's own worker id, or null when the principal has no worker record (an admin without one, a service). */
export async function selfWorkerOf(tx: DbTx, companyId: string, principalId: string | null): Promise<SelfWorker | null> {
  if (!principalId) return null;
  const [p] = await tx.select().from(principals).where(and(eq(principals.id, principalId), eq(principals.companyId, companyId))).limit(1);
  if (!p || p.kind !== "human" || !p.workerId) return null;
  return { principalId: p.id, workerId: p.workerId, display: p.display };
}

async function requireSelf(tx: DbTx, ctx: { companyId: string; principal: { id: string; kind: string }; onBehalfOf: string | null }): Promise<SelfWorker> {
  const self = await selfWorkerOf(tx, ctx.companyId, selfPrincipalId(ctx));
  if (!self) throw new DomainRefusal("DOMAIN_NO_SELF_RECORD", "This person has no worker record, so there is nothing of their own to read", "Portal tools answer only about the signed-in person's own record", null);
  return self;
}

const name = (w: { firstName: string; lastName: string; preferredName: string | null }) => `${w.preferredName ?? w.firstName} ${w.lastName}`;
const hours = (minutes: number) => `${Math.round((minutes / 60) * 100) / 100} h`;
/** Money as integer cents plus the display string (the grounding check reads *_cents and *_display keys). */
const money = (cents: number) => ({ amount_cents: cents, amount_display: formatCents(cents) });

/** No arguments beyond the response format: there is deliberately no worker id to pass. */
const SelfInput = z.object({ ...responseFormatField }).strict();
type SelfInput = z.infer<typeof SelfInput>;
const EXAMPLE = { hint: "Portal tools take no worker id; send { \"response_format\": null }", example: { response_format: null } };

export const myProfile = readCommand<SelfInput, Record<string, unknown>>({
  name: "portal.my_profile", summary: "Read the asker's own employment record",
  description: "Portal only. Reads the signed-in person's own record: name, title, department, manager, work state, start date and status. Takes no worker id and can never read anyone else. Example: { \"response_format\": null }",
  input: SelfInput, domain: "people",
  async run(_i, ctx, deps) {
    const self = await requireSelf(deps.tx, ctx);
    const [w] = await deps.tx.select().from(workers).where(eq(workers.id, self.workerId)).limit(1);
    if (!w) return { data: { worker: null, note: "Your worker record is not created yet; it appears once your offer letter is signed." }, summary: "No worker record yet" };
    const [dept] = w.departmentId ? await deps.tx.select({ name: departments.name }).from(departments).where(eq(departments.id, w.departmentId)).limit(1) : [];
    // The manager's name only: a person may know who they report to, never that person's record.
    const [mgr] = w.managerId ? await deps.tx.select({ firstName: workers.firstName, lastName: workers.lastName, preferredName: workers.preferredName }).from(workers).where(eq(workers.id, w.managerId)).limit(1) : [];
    return {
      data: { worker: { id: w.id, name: name(w), title: w.title, department: dept?.name ?? null, manager: mgr ? name(mgr) : null, work_state: w.workState, start_date: w.startDate, status: w.status, type: w.type, work_email: w.workEmail } },
      summary: `Own record of ${name(w)}`,
    };
  },
});

export const myPaychecks = readCommand<SelfInput, Record<string, unknown>>({
  name: "portal.my_paychecks", summary: "Read the asker's own processed paychecks",
  description: "Portal only. The signed-in person's own paychecks from processed pay runs, newest first (up to 6): payday, period, gross, employee taxes, deductions, reimbursements and net, as cents plus display. Takes no worker id. Example: { \"response_format\": null }",
  input: SelfInput, domain: "people",
  async run(i, ctx, deps) {
    const self = await requireSelf(deps.tx, ctx);
    const rows = await deps.tx.select({ p: paychecks, r: payrollRuns }).from(paychecks).innerJoin(payrollRuns, eq(paychecks.payrollRunId, payrollRuns.id))
      .where(and(eq(paychecks.workerId, self.workerId), eq(payrollRuns.companyId, ctx.companyId), eq(payrollRuns.status, "processed")))
      .orderBy(desc(payrollRuns.payday), desc(paychecks.id)).limit(6);
    const out = rows.map(({ p, r }) => {
      const taxes = JSON.parse(p.taxesJson) as { payer: string; amount_cents: number; code?: string }[];
      const deductions = JSON.parse(p.deductionsJson) as { amountCents?: number; amount_cents?: number }[];
      const employeeTax = taxes.filter((t) => t.payer === "employee").reduce((s, t) => s + t.amount_cents, 0);
      const ded = deductions.reduce((s, d) => s + (d.amountCents ?? d.amount_cents ?? 0), 0);
      return {
        paycheck_id: p.id, payday: r.payday, period_start: r.periodStart, period_end: r.periodEnd, gross: money(p.grossCents), employee_taxes: money(employeeTax),
        deductions: money(ded), reimbursements: money(p.reimbursementsCents), net: money(p.netCents),
        ...(isDetailed(i) ? { taxes: taxes.filter((t) => t.payer === "employee").map((t) => ({ code: t.code ?? null, amount: money(t.amount_cents) })) } : {}),
      };
    });
    return { data: { paychecks: out, note: out.length ? null : "No processed paychecks yet; your first one appears after your first payday." }, summary: `${out.length} own paychecks` };
  },
});

export const myTimeOff = readCommand<SelfInput, Record<string, unknown>>({
  name: "portal.my_time_off", summary: "Read the asker's own time off balances",
  description: "Portal only. The signed-in person's own time off balances today (available hours and days per policy) and the policy names. Takes no worker id. Example: { \"response_format\": null }",
  input: SelfInput, domain: "people",
  async run(_i, ctx, deps) {
    const self = await requireSelf(deps.tx, ctx);
    const w = await workerOf(deps.tx, ctx.companyId, self.workerId);
    if (!w) return { data: { balances: [], note: "No worker record yet." }, summary: "No worker record yet" };
    const today = ptDateOf(ctx.now);
    const balances: Record<string, unknown>[] = [];
    for (const a of await assignmentsOf(deps.tx, [w.id])) {
      const p = await policyById(deps.tx, ctx.companyId, a.policyId);
      if (!p) continue;
      const b = await balanceFor(deps.tx, w, p, today);
      balances.push({ policy: p.name, available_minutes: b.availableMinutes, ...timeForms("available", b.availableMinutes), available_display: hours(b.availableMinutes) });
    }
    balances.sort((a, b) => String(a.policy).localeCompare(String(b.policy)));
    return { data: { as_of: today, balances }, summary: `${balances.length} own time off balances` };
  },
});

export const myBenefits = readCommand<SelfInput, Record<string, unknown>>({
  name: "portal.my_benefits", summary: "Read the asker's own benefit enrollments",
  description: "Portal only. The signed-in person's own active benefit enrollments: plan, carrier, category, tier and the per-paycheck employee cost. Takes no worker id. Example: { \"response_format\": null }",
  input: SelfInput, domain: "benefits",
  async run(_i, ctx, deps) {
    const self = await requireSelf(deps.tx, ctx);
    const rows = await deps.tx.select({ e: benefitEnrollments, p: benefitPlans }).from(benefitEnrollments).innerJoin(benefitPlans, eq(benefitEnrollments.planId, benefitPlans.id))
      .where(and(eq(benefitEnrollments.workerId, self.workerId), eq(benefitPlans.companyId, ctx.companyId))).orderBy(asc(benefitPlans.category), asc(benefitPlans.id));
    const active = rows.filter(({ e }) => e.status === "active" || e.status === "enrolled");
    const out = active.map(({ e, p }) => ({
      plan: p.name, carrier: p.carrier, category: p.category, tier: e.tier, effective_from: e.effectiveFrom,
      employee_cost_per_paycheck: e.employeeCents === null ? null : money(e.employeeCents), deferral_percent: e.deferralBps === null ? null : `${e.deferralBps / 100}%`,
    }));
    return { data: { enrollments: out, note: out.length ? null : "No active benefit enrollments on file." }, summary: `${out.length} own benefit enrollments` };
  },
});

// ---------- policy search: company policy only, never anyone's record ----------

/** text_display: the grounding check accepts the numbers in a *_display string, so answers may quote the policy. */
export interface PolicyEntry { topic: string; title: string; text_display: string; source: string }

/** The searchable policy entries, built in code from policy rows (no worker data). */
export async function policyEntries(tx: DbTx, companyId: string): Promise<PolicyEntry[]> {
  const r = EXPENSE_POLICY_V1.rules;
  const out: PolicyEntry[] = [
    { topic: "expenses", title: "Receipts", text_display: `Attach a receipt to any expense of ${formatCents(r.receiptRequiredAtCents)} or more.`, source: "Expense policy v1" },
    { topic: "expenses", title: "Meals", text_display: `Business meals are reimbursed up to ${formatCents(r.mealsPerPersonCents)} per person; list the attendees and the business purpose.`, source: "Expense policy v1" },
    { topic: "expenses", title: "Per diem", text_display: `Travel meals per diem is ${formatCents(r.perDiemMealsCents)} a day, ${formatCents(r.perDiemTravelDayCents)} on the first and last travel day.`, source: "Expense policy v1" },
    { topic: "expenses", title: "Submission window", text_display: `Submit expenses within ${r.accountableWindowDays} days of the purchase.`, source: "Expense policy v1" },
    { topic: "expenses", title: "Equipment", text_display: `Equipment over ${formatCents(r.equipmentPreApprovalCents)} needs a pre-approval reference.`, source: "Expense policy v1" },
    { topic: "expenses", title: "Mileage", text_display: "Mileage is reimbursed at the IRS standard rate for the trip date: 72.5 cents a mile through June 30, 2026, then 76 cents.", source: "Expense policy v1" },
    { topic: "time_off", title: "Requesting time off", text_display: "The portal has no time off request form yet. Ask your manager or the people team to file the request in Weft; it is checked against your balance, team coverage and company holidays, then goes to your manager for a decision.", source: "Weft time off" },
    { topic: "expenses", title: "Submitting an expense", text_display: "Use Submit an expense in the My expenses section of the portal, or email the receipt from your work address on file.", source: "Weft expenses" },
    { topic: "expenses", title: "Email submission", text_display: "You can email a receipt from your work address on file; it becomes a submitted expense and goes through the normal review.", source: "Weft expenses" },
  ];
  const types = new Map((await tx.select().from(timeOffTypes).where(eq(timeOffTypes.companyId, companyId))).map((t) => [t.id, t]));
  for (const p of await tx.select().from(timeOffPolicies).where(eq(timeOffPolicies.companyId, companyId)).orderBy(asc(timeOffPolicies.id))) {
    const t = types.get(p.typeId);
    const parts = [
      t ? `${t.name} (${t.paid ? "paid" : "unpaid"})` : null,
      p.minutesPerPeriod ? `accrues ${hours(p.minutesPerPeriod)} per pay period` : null,
      p.frontLoadMinutes ? `front-loaded ${hours(p.frontLoadMinutes)}` : null,
      p.accrualCapMinutes ? `balance cap ${hours(p.accrualCapMinutes)}` : null,
      p.carryoverCapMinutes !== null ? `carryover cap ${hours(p.carryoverCapMinutes)}` : null,
      p.waitingDaysBeforeUse ? `usable after ${p.waitingDaysBeforeUse} days of employment` : null,
    ].filter(Boolean);
    out.push({ topic: "time_off", title: p.name, text_display: `${parts.join("; ")}. Applies in ${p.jurisdiction}.`, source: "Time off policy" });
  }
  const hol = await tx.select().from(holidays).orderBy(asc(holidays.date));
  if (hol.length) out.push({ topic: "time_off", title: "Company holidays", text_display: hol.map((h) => `${h.date} ${h.name}`).join("; "), source: "Holiday calendar" });
  return out;
}

const PolicyInput = z.object({ query: z.string().min(1).max(200), ...responseFormatField }).strict();

export const policySearch = readCommand<z.infer<typeof PolicyInput>, Record<string, unknown>>({
  name: "portal.policy_search", summary: "Search company policy for an employee question",
  description: "Portal only. Searches company policy (expenses, time off, holidays) for words in the query. Returns matching entries with a title, text and source. Contains no one's personal data. Example: { \"query\": \"meal limit\", \"response_format\": null }",
  input: PolicyInput, domain: "people",
  async run(i, ctx, deps) {
    const words = i.query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
    const scored = (await policyEntries(deps.tx, ctx.companyId))
      .map((e) => ({ e, n: words.filter((w) => `${e.topic} ${e.title} ${e.text_display}`.toLowerCase().includes(w)).length }))
      .filter((x) => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 5);
    return { data: { hits: scored.map(({ e }) => e) }, summary: `${scored.length} policy entries for the query` };
  },
});

// ---------- topics and hand-offs ----------

const HUMAN_ONLY: [PortalTopic, RegExp][] = [
  ["workplace_concern", /\b(harass\w*|discriminat\w*|retaliat\w*|hostile|bull(y|ied|ying)|unsafe|whistle\s?blow\w*|misconduct|complaint about|report(ing)? my (manager|boss|coworker|colleague))\b/i],
  ["accommodation", /\b(accommodat\w*|ergonomic|wheelchair|ada\b|disabilit\w*)\b/i],
  ["medical_leave", /\b(medical leave|fmla|cfra|pfl|paid family leave|family leave|disability leave|maternity|paternity|parental leave|pregnan\w*|surgery|diagnos\w*|hospital\w*|chemo\w*|cancer|mental health|bereavement)\b/i],
];
const ROUTINE: [PortalTopic, RegExp][] = [
  ["tax_forms", /\b(w-?2|w-?4|1099|tax forms?|withholding certificate)\b/i],
  ["time_off", /\b(pto|vacation|time off|sick (time|days?|hours?|leave balance)|holidays?|leave balance|days? off)\b/i],
  ["benefits", /\b(benefits?|medical plan|dental|vision|401\s?\(?k\)?|insurance|enroll\w*|hsa|fsa)\b/i],
  ["pay", /\b(make|makes|earn|earns|earning|pay|paid|paycheck|paystub|pay stub|salary|wages?|net|gross|withh[eo]ld\w*|deductions?|bonus|direct deposit|payday)\b/i],
  ["policy", /\b(polic(y|ies)|expenses?|reimburs\w*|per diem|mileage|receipts?|handbook|meals?)\b/i],
];

/** Code, never the model, classifies the question. Human-only topics win over routine ones. */
export function classifyPortalTopic(text: string): PortalTopic {
  for (const [t, re] of HUMAN_ONLY) if (re.test(text)) return t;
  for (const [t, re] of ROUTINE) if (re.test(text)) return t;
  return "other";
}
export const isHumanOnlyTopic = (t: PortalTopic) => PORTAL_HUMAN_ONLY_TOPICS.includes(t);

const TOPIC_LABEL: Record<string, string> = { medical_leave: "medical leave", accommodation: "a workplace accommodation", workplace_concern: "a workplace concern" };

/** The fixed reply for a human-only topic: no model wrote it, so it can never promise an outcome. */
export function handoffReply(topic: PortalTopic, handoffId: string): string {
  return `Questions about ${TOPIC_LABEL[topic] ?? "this"} go to a person, so I have not looked anything up. I opened a private request with the HR team (${handoffId}); someone will follow up with you directly. If this is urgent or you feel unsafe, contact your HR partner or manager right away.`;
}

const HandoffInput = z.object({
  topic: z.enum(["medical_leave", "accommodation", "workplace_concern"]),
  run_id: z.string().startsWith("run_").optional(), thread_id: z.string().startsWith("thr_").optional(),
}).strict();

export const requestHandoff = writeCommand<z.infer<typeof HandoffInput>>({
  name: "portal.request_handoff", summary: "Ask a person on the HR team to follow up (portal only)",
  description: "Human only: the signed-in employee asks a person on the HR team to follow up on medical leave, an accommodation or a workplace concern. Opens an hr_person hand-off for the asker's own record. The question text is not stored in the case.",
  input: HandoffInput, domain: "people", needs: "view", effect: "write", risk: riskOf("R1"), approval: "never", access: "human_only", reversible: false, preview: null,
  async run(i, ctx, deps) {
    const self = await requireSelf(deps.tx, ctx);
    const id = await deps.newId("hnd_");
    const label = TOPIC_LABEL[i.topic] ?? i.topic;
    await deps.tx.insert(handoffCases).values({
      id, companyId: ctx.companyId, kind: "hr_person", reason: i.topic, subjectRef: self.workerId, workerId: self.workerId,
      // Template text only (ids, enums, the DB name); the employee's words stay out of the case so no later run reads them as instructions.
      summary: `${self.display} asked in the portal for a person to follow up about ${label}.`,
      evidenceJson: JSON.stringify([{ label: "Asked through", ref: i.thread_id ?? "portal" }, ...(i.run_id ? [{ label: "Portal run", ref: i.run_id }] : [])]),
      status: "open", assigneePrincipalId: null, openedBy: ctx.principal.id, runId: i.run_id ?? null, createdAt: ctx.now, resolvedAt: null,
    });
    return { data: { handoff_id: id, kind: "hr_person", reason: i.topic, worker_id: self.workerId }, summary: `Opened hand-off ${id} to the HR team about ${label}`, events: [{ type: "handoff.opened", subjectRef: id, payload: { handoff_id: id } }] };
  },
});

export const portalCommandsW4: WeftCommand[] = [myProfile, myPaychecks, myTimeOff, myBenefits, policySearch, requestHandoff];
