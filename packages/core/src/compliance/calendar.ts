// The compliance calendar (wave 4 rank 1). Owner: w4-parity-compliance. Rows are derived in code from the filing rule
// table and the records they cover (filings, processed runs, notices, training assignments, contractor tax forms),
// never from model text. refreshCalendar upserts one row per (kind, subject) and reports the rows that newly became
// due soon or overdue; reads recompute the date-driven status, so a stale row never shows the wrong state.
import { and, asc, eq, inArray } from "drizzle-orm";
import { COMPLIANCE_DUE_SOON_DAYS, type ComplianceItem, type ComplianceItemKind, type ComplianceItemStatus, type FilingForm } from "@weft/contracts";
import { complianceItems, contractorTaxForms, filings, notices, payrollRuns, proposals, taxAccounts, trainingAssignments, trainingCourses, workers, type DbTx } from "@weft/db";
import { listTaxForms } from "../parity/contractor-forms";
import { displayName } from "../people/names";
import { hasDomain, inScope, type ReadScope } from "../people/scope";
import { daysBetween, dueOn, FILING_RULES, monthlyDepositDueOn, periodBounds, periodOf, previousPeriod, RULE_BY_FORM } from "./rules";

export type CalendarRow = typeof complianceItems.$inferSelect;
type Draft = Omit<CalendarRow, "id" | "companyId" | "createdAt" | "doneAt" | "status"> & { status: ComplianceItemStatus; doneAt: string | null };

const TERMINAL: ReadonlySet<string> = new Set(["done", "waived"]);

/** The status a row shows on `today`: done and waived stay; past due is overdue; prepared and proposed stay until then. */
export function liveStatus(stored: string, due: string, today: string): ComplianceItemStatus {
  if (TERMINAL.has(stored)) return stored as ComplianceItemStatus;
  if (today > due) return "overdue";
  if (stored === "prepared" || stored === "proposed") return stored;
  return daysBetween(today, due) <= COMPLIANCE_DUE_SOON_DAYS ? "due_soon" : "upcoming";
}

/** Weft started paying on 2026-09-01; periods that ended earlier were filed by the previous provider and are not on Weft's calendar. */
export const WEFT_FIRST_PAYDAY = "2026-09-01";

/** Filing rows for the current and previous period of every form whose filing account is active. Idempotent. */
export async function ensureFilings(tx: DbTx, newId: (p: string) => Promise<string>, companyId: string, today: string): Promise<string[]> {
  const accounts = await tx.select().from(taxAccounts).where(eq(taxAccounts.companyId, companyId));
  const existing = accounts.length ? await tx.select().from(filings).where(inArray(filings.taxAccountId, accounts.map((a) => a.id))) : [];
  const created: string[] = [];
  for (const rule of FILING_RULES) {
    const acct = accounts.find((a) => a.agency === rule.accountAgency && a.status === "active");
    if (!acct) continue;
    const current = periodOf(rule.form, today);
    // An annual form is due after its year ends: the year just ended and the current year (prepared to date).
    for (const period of [previousPeriod(current), current]) {
      if (periodBounds(period).end < WEFT_FIRST_PAYDAY) continue;
      if (existing.some((f) => f.taxAccountId === acct.id && f.form === rule.form && f.period === period)) continue;
      const id = await newId("fil_");
      await tx.insert(filings).values({ id, taxAccountId: acct.id, form: rule.form, period, status: "draft", filedAt: null, confirmation: null, dueOn: dueOn(rule.form, period), preparedJson: null, proposalId: null });
      existing.push({ id, taxAccountId: acct.id, form: rule.form, period, status: "draft", filedAt: null, confirmation: null, dueOn: dueOn(rule.form, period), preparedJson: null, proposalId: null });
      created.push(id);
    }
  }
  return created;
}

async function drafts(tx: DbTx, companyId: string, today: string): Promise<Draft[]> {
  const out: Draft[] = [];
  const accounts = await tx.select().from(taxAccounts).where(eq(taxAccounts.companyId, companyId));
  const byId = new Map(accounts.map((a) => [a.id, a]));
  // Filings.
  const fs = accounts.length ? await tx.select().from(filings).where(inArray(filings.taxAccountId, accounts.map((a) => a.id))).orderBy(asc(filings.id)) : [];
  const pending = new Map((await tx.select({ id: proposals.id, subjectRef: proposals.subjectRef, command: proposals.command, status: proposals.status }).from(proposals)
    .where(and(eq(proposals.companyId, companyId), eq(proposals.status, "pending")))).filter((p) => p.command === "tax.file_return" && p.subjectRef).map((p) => [p.subjectRef!, p.id]));
  for (const f of fs) {
    const proposalId = pending.get(f.id) ?? null;
    const rule = RULE_BY_FORM[f.form as FilingForm];
    if (!rule) continue;
    const due = f.dueOn ?? dueOn(rule.form, f.period);
    const status: ComplianceItemStatus = f.status === "filed" || f.status === "accepted" ? "done" : proposalId ? "proposed" : f.preparedJson ? "prepared" : "upcoming";
    out.push({ kind: "filing", title: `${rule.label} for ${f.period}`, jurisdiction: rule.jurisdiction, agency: byId.get(f.taxAccountId)?.agency ?? null, form: f.form, period: f.period, dueOn: due,
      status, subjectRef: f.id, ownerPrincipalId: null, proposalId: proposalId ?? f.proposalId, doneAt: status === "done" ? f.filedAt : null });
  }
  // Federal deposits on the monthly schedule, one per month with a Weft payday.
  const irs = accounts.find((a) => a.agency === "irs");
  if (irs?.depositSchedule === "monthly") {
    const runs = await tx.select().from(payrollRuns).where(eq(payrollRuns.companyId, companyId));
    const months = [...new Set(runs.filter((r) => r.payday >= WEFT_FIRST_PAYDAY).map((r) => r.payday.slice(0, 7)))].sort();
    for (const m of months) {
      const inMonth = runs.filter((r) => r.payday.startsWith(m));
      // The simulator remits each run's federal taxes when it settles: the month is deposited once every run in it is processed.
      const deposited = inMonth.every((r) => r.status === "processed") && today > `${m}-31`.slice(0, 10);
      const last = inMonth.map((r) => r.processedAt).filter(Boolean).sort().at(-1) ?? null;
      out.push({ kind: "deposit", title: `Federal tax deposit for ${m} (monthly schedule)`, jurisdiction: "US", agency: "irs", form: null, period: m, dueOn: monthlyDepositDueOn(m),
        status: deposited ? "done" : "upcoming", subjectRef: `${irs.id}:${m}`, ownerPrincipalId: null, proposalId: null, doneAt: deposited ? last : null });
    }
  }
  // Notice responses with a respond-by date.
  for (const n of await tx.select().from(notices).where(eq(notices.companyId, companyId)).orderBy(asc(notices.id))) {
    if (!n.respondBy) continue;
    const done = n.status === "resolved" || n.status === "escalated";
    out.push({ kind: "notice_response", title: `Respond to ${n.formCode} notice ${n.id}`, jurisdiction: null, agency: n.agency, form: null, period: null, dueOn: n.respondBy,
      status: done ? "done" : n.status === "proposed" ? "proposed" : "upcoming", subjectRef: n.id, ownerPrincipalId: null, proposalId: null, doneAt: done ? n.receivedAt : null });
  }
  // Required training.
  const courses = await tx.select().from(trainingCourses).where(eq(trainingCourses.companyId, companyId));
  if (courses.length) {
    const assigns = await tx.select().from(trainingAssignments).where(inArray(trainingAssignments.courseId, courses.map((c) => c.id))).orderBy(asc(trainingAssignments.id));
    const people = assigns.length ? await tx.select({ id: workers.id, first: workers.firstName, last: workers.lastName }).from(workers).where(inArray(workers.id, [...new Set(assigns.map((a) => a.workerId))])) : [];
    for (const a of assigns) {
      if (a.status === "waived") continue;
      const c = courses.find((x) => x.id === a.courseId)!;
      const w = people.find((p) => p.id === a.workerId);
      out.push({ kind: "training_due", title: `${c.title} for ${w ? displayName(w.first, w.last) : a.workerId}`, jurisdiction: c.jurisdiction, agency: null, form: null, period: null,
        dueOn: a.dueOn, status: a.status === "completed" ? "done" : "upcoming", subjectRef: a.id, ownerPrincipalId: null, proposalId: a.proposalId, doneAt: a.completedAt });
    }
  }
  // Contractor tax forms that are missing, expired or lapse within 90 days.
  const forms = await listTaxForms(tx, companyId, today, { withinDays: 90 });
  for (const r of forms.contractors) {
    if (r.state === "valid") continue;
    const label = r.needed === "w9" ? "W-9" : "W-8";
    out.push({ kind: "contractor_form_expiry", title: r.state === "missing" ? `${label} missing for ${r.name}` : `${label} for ${r.name} ${r.state === "expired" ? "expired" : "expires"} ${r.expires_on}`,
      jurisdiction: null, agency: null, form: null, period: null, dueOn: r.expires_on ?? today, status: "upcoming", subjectRef: r.form_id ?? r.worker_id, ownerPrincipalId: null, proposalId: null, doneAt: null });
  }
  return out;
}

const keyOf = (r: { kind: string; subjectRef: string | null }) => `${r.kind}|${r.subjectRef ?? ""}`;

export interface RefreshResult { created: number; updated: number; filings_created: string[]; due_soon: string[]; overdue: string[] }

/** Upserts the calendar for `today` (PT date). Emits nothing itself; the command turns due_soon and overdue into events. */
export async function refreshCalendar(tx: DbTx, deps: { newId: (p: string) => Promise<string>; now: string }, companyId: string, today: string): Promise<RefreshResult> {
  const filingsCreated = await ensureFilings(tx, deps.newId, companyId, today);
  const want = await drafts(tx, companyId, today);
  const have = new Map((await tx.select().from(complianceItems).where(eq(complianceItems.companyId, companyId))).map((r) => [keyOf(r), r]));
  const res: RefreshResult = { created: 0, updated: 0, filings_created: filingsCreated, due_soon: [], overdue: [] };
  for (const d of want) {
    const status = liveStatus(d.status, d.dueOn, today);
    const row = have.get(keyOf(d));
    if (!row) {
      const id = await deps.newId("cal_");
      await tx.insert(complianceItems).values({ ...d, id, companyId, status, createdAt: deps.now });
      res.created++;
      if (status === "due_soon") res.due_soon.push(id);
      if (status === "overdue") res.overdue.push(id);
      continue;
    }
    const patch = { title: d.title, dueOn: d.dueOn, status, proposalId: d.proposalId, doneAt: d.doneAt, jurisdiction: d.jurisdiction, agency: d.agency };
    if (row.title === patch.title && row.dueOn === patch.dueOn && row.status === status && row.proposalId === patch.proposalId && row.doneAt === patch.doneAt) continue;
    await tx.update(complianceItems).set(patch).where(eq(complianceItems.id, row.id));
    res.updated++;
    if (status === "due_soon" && row.status !== "due_soon") res.due_soon.push(row.id);
    if (status === "overdue" && row.status !== "overdue") res.overdue.push(row.id);
  }
  return res;
}

export interface CalendarFilter { from?: string; to?: string; kind?: ComplianceItemKind; status?: ComplianceItemStatus }
export interface CalendarDto extends ComplianceItem { daysLeft: number; sourceUrl: string | null }

export function toCalendarDto(r: CalendarRow, today: string): CalendarDto {
  return {
    id: r.id, kind: r.kind as ComplianceItemKind, title: r.title, jurisdiction: r.jurisdiction, agency: r.agency, form: (r.form as FilingForm | null) ?? null, period: r.period,
    dueOn: r.dueOn, status: liveStatus(r.status, r.dueOn, today), subjectRef: r.subjectRef, ownerPrincipalId: r.ownerPrincipalId, proposalId: (r.proposalId as `prp_${string}` | null) ?? null,
    createdAt: r.createdAt, doneAt: r.doneAt, daysLeft: daysBetween(today, r.dueOn),
    sourceUrl: r.form ? RULE_BY_FORM[r.form as FilingForm]?.sourceUrl ?? null : r.kind === "deposit" ? "https://www.irs.gov/publications/p15" : null,
  };
}

export async function listCalendar(tx: DbTx, companyId: string, today: string, f: CalendarFilter = {}): Promise<CalendarDto[]> {
  const rows = await tx.select().from(complianceItems).where(f.kind ? and(eq(complianceItems.companyId, companyId), eq(complianceItems.kind, f.kind)) : eq(complianceItems.companyId, companyId));
  return rows.map((r) => toCalendarDto(r, today))
    .filter((r) => (!f.from || r.dueOn >= f.from) && (!f.to || r.dueOn <= f.to) && (!f.status || r.status === f.status))
    .sort((a, b) => (a.dueOn === b.dueOn ? (a.id < b.id ? -1 : 1) : a.dueOn < b.dueOn ? -1 : 1));
}

/**
 * The calendar rows a narrowed viewer (a manager) may read. A row about a person names them in its title, so it follows
 * the person read scope: required training only for the viewer's own record and reports, a contractor's tax form only
 * with payroll view and for a contractor in their reports. Filing, deposit and notice rows are company deadlines with
 * no person or amount in them and stay. Not narrowed (scope null) keeps every row.
 */
export async function scopeCalendar<T extends { kind: string; subjectRef: string | null }>(tx: DbTx, scope: ReadScope | null, rows: readonly T[]): Promise<{ shown: T[]; withheld: number }> {
  if (!scope) return { shown: [...rows], withheld: 0 };
  const refs = (kind: string) => [...new Set(rows.filter((r) => r.kind === kind && r.subjectRef).map((r) => r.subjectRef!))];
  const training = refs("training_due");
  const forms = refs("contractor_form_expiry").filter((r) => !r.startsWith("wrk_"));
  const workerOf = new Map<string, string>([
    ...(training.length ? await tx.select({ id: trainingAssignments.id, workerId: trainingAssignments.workerId }).from(trainingAssignments).where(inArray(trainingAssignments.id, training)) : []).map((a) => [a.id, a.workerId] as const),
    ...(forms.length ? await tx.select({ id: contractorTaxForms.id, workerId: contractorTaxForms.workerId }).from(contractorTaxForms).where(inArray(contractorTaxForms.id, forms)) : []).map((f) => [f.id, f.workerId] as const),
  ]);
  const about = (r: T) => (r.subjectRef?.startsWith("wrk_") ? r.subjectRef : workerOf.get(r.subjectRef ?? "") ?? null);
  const shown = rows.filter((r) => {
    if (r.kind === "training_due") return inScope(scope, about(r));
    if (r.kind === "contractor_form_expiry") return hasDomain(scope, "payroll") && inScope(scope, about(r));
    return true;
  });
  return { shown, withheld: rows.length - shown.length };
}
