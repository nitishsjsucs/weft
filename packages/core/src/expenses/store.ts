// Expenses read model and lifecycle writes (wave 3, research/wave3/expenses-timeoff.md 7.3). Owner: w3-expenses.
// These run inside the caller's transaction (the executor's for commands, the seed's for history). They never emit
// events or append actions; commands return those.
import { and, asc, eq, gt, inArray, isNull } from "drizzle-orm";
import { EXPENSE_BANDS, type Expense, type ExpenseBand, type ExpenseCategory, type ExpenseStatus, type IdPrefix, type W3Check } from "@weft/contracts";
import { expensePolicies, expenses, paychecks, payrollRuns, workers, type DbTx } from "@weft/db";
import { previewRun } from "../payroll/lifecycle";
import { ptDateOf } from "../demo/define";
import { displayName } from "../people/names";
import { EXPENSE_POLICY_V1, evaluateExpense, type ExpensePolicy, type PolicyItem, type PolicyResult, type ReceiptExtract } from "./policy";

export type ExpenseRow = typeof expenses.$inferSelect;
export interface StoreDeps { newId(prefix: IdPrefix): Promise<string>; now: string }

export const bandOf = (s: string): ExpenseBand => (Object.entries(EXPENSE_BANDS).find(([, v]) => (v as readonly string[]).includes(s))?.[0] ?? "needs_review") as ExpenseBand;
/** Roles that read every claim (GET /v1/expenses); anyone else reads only their own. */
export const EXPENSE_ADMIN_ROLES: ReadonlySet<string> = new Set(["admin", "payroll_admin"]);
/** Whether a person (their role and own worker record) reads the claim of `ownerWorkerId`: the Expenses API's rule. */
export function seesExpense(viewer: { role: string | null; workerId: string | null }, ownerWorkerId: string | null): boolean {
  return EXPENSE_ADMIN_ROLES.has(viewer.role ?? "") || (!!viewer.workerId && viewer.workerId === ownerWorkerId);
}
/** Statuses an approver can decide from. */
export const DECIDABLE: readonly ExpenseStatus[] = ["submitted", "needs_review"];
/** Approved statuses that attach to a draft and ride the payroll seam. */
export const PAYABLE: readonly ExpenseStatus[] = ["approved", "approved_taxable", "scheduled"];

export function parseExtract(json: string | null): ReceiptExtract | null {
  if (!json) return null;
  try {
    const x = JSON.parse(json) as { total_cents?: number; totalCents?: number; date?: string; merchant?: string };
    const totalCents = x.totalCents ?? x.total_cents;
    return typeof totalCents === "number" && typeof x.date === "string" ? { totalCents, date: x.date, merchant: x.merchant } : null;
  } catch { return null; }
}

export function policyItemOf(r: ExpenseRow): PolicyItem {
  return {
    id: r.id, workerId: r.workerId, category: r.category as ExpenseCategory, merchant: r.merchant, amountCents: r.amountCents, transactionDate: r.transactionDate,
    submittedDate: ptDateOf(r.submittedAt), businessPurpose: r.businessPurpose, attendees: r.attendees, milesX10: r.milesX10, tripRef: r.tripRef,
    preApprovalRef: r.preApprovalRef, hasReceipt: r.receiptUploadId !== null, extract: parseExtract(r.receiptExtractJson), status: r.status,
  };
}

export const checksOf = (r: Pick<ExpenseRow, "checksJson">): W3Check[] => JSON.parse(r.checksJson || "[]") as W3Check[];

export function toExpenseDto(r: ExpenseRow): Expense {
  return {
    id: r.id, workerId: r.workerId, category: r.category as ExpenseCategory, merchant: r.merchant, amountCents: r.amountCents, currency: "USD",
    transactionDate: r.transactionDate, submittedAt: r.submittedAt, businessPurpose: r.businessPurpose, attendees: r.attendees, milesX10: r.milesX10,
    tripRef: r.tripRef, receiptUploadId: r.receiptUploadId, status: r.status as ExpenseStatus, band: bandOf(r.status), checks: checksOf(r),
    explanation: r.explanation, explanationSource: (r.explanationSource as "agent" | "template" | null) ?? null, approverPrincipalId: r.approverPrincipalId,
    decidedBy: r.decidedBy, decidedAt: r.decidedAt, decisionReasonCode: (r.decisionReasonCode as Expense["decisionReasonCode"]) ?? null,
    payrollRunId: r.payrollRunId, policyVersion: r.policyVersion,
  };
}

export async function getExpenseRow(tx: DbTx, companyId: string, id: string): Promise<ExpenseRow | null> {
  return (await tx.select().from(expenses).where(and(eq(expenses.companyId, companyId), eq(expenses.id, id))))[0] ?? null;
}

export interface ExpenseFilter { band?: ExpenseBand; status?: string; workerId?: string; category?: string }
export async function listExpenseRows(tx: DbTx, companyId: string, f: ExpenseFilter = {}): Promise<ExpenseRow[]> {
  const rows = await tx.select().from(expenses).where(eq(expenses.companyId, companyId)).orderBy(asc(expenses.id));
  return rows.filter((r) => (!f.band || bandOf(r.status) === f.band) && (!f.status || r.status === f.status) && (!f.workerId || r.workerId === f.workerId) && (!f.category || r.category === f.category));
}

/** The active policy row (latest version effective on `date`), or the built-in v1. */
export async function activePolicy(tx: DbTx, companyId: string, date: string): Promise<ExpensePolicy> {
  const rows = (await tx.select().from(expensePolicies).where(eq(expensePolicies.companyId, companyId))).filter((p) => p.effectiveFrom <= date).sort((a, b) => b.version - a.version);
  const p = rows[0];
  if (!p) return EXPENSE_POLICY_V1;
  return { version: p.version, effectiveFrom: p.effectiveFrom, rules: { ...EXPENSE_POLICY_V1.rules, ...(JSON.parse(p.rulesJson) as Partial<ExpensePolicy["rules"]>) }, sources: JSON.parse(p.sourcesJson) as ExpensePolicy["sources"] };
}

/** Runs the engine on a stored row against the worker and the worker's other expenses. Read only. */
export async function evaluateRow(tx: DbTx, r: ExpenseRow): Promise<PolicyResult> {
  const w = (await tx.select().from(workers).where(eq(workers.id, r.workerId)))[0];
  if (!w) throw new Error(`expense ${r.id}: no worker ${r.workerId}`);
  const others = (await tx.select().from(expenses).where(eq(expenses.workerId, r.workerId))).filter((o) => o.id !== r.id).map(policyItemOf);
  const policy = await activePolicy(tx, r.companyId, r.transactionDate);
  return evaluateExpense(policyItemOf(r), { worker: { id: w.id, workState: w.workState, startDate: w.startDate, endDate: w.endDate }, others }, policy);
}

/** Writes the engine's checks onto the row (the submit path and expenses.check_policy). */
export async function writeChecks(tx: DbTx, r: ExpenseRow): Promise<PolicyResult> {
  const res = await evaluateRow(tx, r);
  await tx.update(expenses).set({ checksJson: JSON.stringify(res.checks), policyVersion: res.policyVersion, ...(r.status === "submitted" ? { status: "needs_review" } : {}) }).where(eq(expenses.id, r.id));
  return res;
}

export async function workerNameMap(tx: DbTx, ids: string[]): Promise<Map<string, { name: string; title: string; state: string | null; payScheduleId: string | null }>> {
  const rows = ids.length ? await tx.select().from(workers).where(inArray(workers.id, [...new Set(ids)])) : [];
  return new Map(rows.map((w) => [w.id, { name: displayName(w.firstName, w.lastName), title: w.title ?? "", state: w.workState, payScheduleId: w.payScheduleId }]));
}

/** The earliest draft regular run of the schedule whose approval deadline is still ahead of `now`. */
export async function targetDraft(tx: DbTx, companyId: string, payScheduleId: string, now: string) {
  const rows = await tx.select().from(payrollRuns).where(and(eq(payrollRuns.companyId, companyId), eq(payrollRuns.payScheduleId, payScheduleId), eq(payrollRuns.status, "draft"), eq(payrollRuns.subtype, "regular"), gt(payrollRuns.approvalDeadline, now)));
  rows.sort((a, b) => (a.payday < b.payday ? -1 : a.payday > b.payday ? 1 : 0));
  return rows[0] ?? null;
}

/**
 * Attaches an approved item to the earliest open draft before its deadline and recomputes that draft, so its
 * paycheck carries the reimbursement (approved: reimbursements_cents and reimbursements_json, outside gross; approved
 * taxable: a taxable_reimbursement earning inside gross). With no such draft the item stays approved and the next
 * draft created picks it up (expenses.schedule on payroll.draft_created). Returns the run id or null.
 */
export async function attachToDraft(tx: DbTx, deps: StoreDeps, r: ExpenseRow): Promise<string | null> {
  if (r.status !== "approved" && r.status !== "approved_taxable") return r.payrollRunId;
  const w = (await tx.select().from(workers).where(eq(workers.id, r.workerId)))[0];
  if (!w?.payScheduleId) return null;
  const run = await targetDraft(tx, r.companyId, w.payScheduleId, deps.now);
  if (!run) return null;
  await tx.update(expenses).set({ payrollRunId: run.id, status: r.status === "approved" ? "scheduled" : "approved_taxable" }).where(eq(expenses.id, r.id));
  await previewRun(tx, deps, run.id);
  const pc = (await tx.select({ id: paychecks.id }).from(paychecks).where(and(eq(paychecks.payrollRunId, run.id), eq(paychecks.workerId, r.workerId))))[0];
  await tx.update(expenses).set({ paycheckId: pc?.id ?? null }).where(eq(expenses.id, r.id));
  return run.id;
}

/** Attaches every approved item without a run whose worker is on the run's schedule (expenses.schedule). */
export async function scheduleForRun(tx: DbTx, deps: StoreDeps, runId: string): Promise<string[]> {
  const run = (await tx.select().from(payrollRuns).where(eq(payrollRuns.id, runId)))[0];
  if (!run || run.status !== "draft" || run.subtype !== "regular" || run.approvalDeadline <= deps.now) return [];
  const waiting = await tx.select().from(expenses).where(and(eq(expenses.companyId, run.companyId), inArray(expenses.status, ["approved", "approved_taxable"]), isNull(expenses.payrollRunId)));
  const ws = await workerNameMap(tx, waiting.map((e) => e.workerId));
  const mine = waiting.filter((e) => ws.get(e.workerId)?.payScheduleId === run.payScheduleId).sort((a, b) => (a.id < b.id ? -1 : 1));
  if (!mine.length) return [];
  for (const e of mine) await tx.update(expenses).set({ payrollRunId: run.id, status: e.status === "approved" ? "scheduled" : "approved_taxable" }).where(eq(expenses.id, e.id));
  await previewRun(tx, deps, run.id);
  const pcs = await tx.select({ id: paychecks.id, workerId: paychecks.workerId }).from(paychecks).where(eq(paychecks.payrollRunId, run.id));
  const byWorker = new Map(pcs.map((p) => [p.workerId, p.id]));
  for (const e of mine) await tx.update(expenses).set({ paycheckId: byWorker.get(e.workerId) ?? null }).where(eq(expenses.id, e.id));
  return mine.map((e) => e.id);
}

/**
 * payroll.processed: items of the run whose paycheck was processed become paid. Items whose paycheck was excluded
 * (blocked at submit) go back to approved without a run, so the next draft pays them. Idempotent.
 */
export async function markPaidForRun(tx: DbTx, runId: string): Promise<{ paid: string[]; released: string[] }> {
  const run = (await tx.select().from(payrollRuns).where(eq(payrollRuns.id, runId)))[0];
  if (!run || run.status !== "processed") return { paid: [], released: [] };
  const items = await tx.select().from(expenses).where(and(eq(expenses.payrollRunId, runId), inArray(expenses.status, ["scheduled", "approved_taxable"])));
  if (!items.length) return { paid: [], released: [] };
  const pcs = await tx.select({ workerId: paychecks.workerId, status: paychecks.status, id: paychecks.id }).from(paychecks).where(eq(paychecks.payrollRunId, runId));
  const processed = new Map(pcs.filter((p) => p.status === "processed").map((p) => [p.workerId, p.id]));
  const paid: string[] = [], released: string[] = [];
  for (const e of items.sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (processed.has(e.workerId)) {
      await tx.update(expenses).set({ status: "paid", paycheckId: processed.get(e.workerId)! }).where(eq(expenses.id, e.id));
      paid.push(e.id);
    } else {
      await tx.update(expenses).set({ status: e.status === "scheduled" ? "approved" : "approved_taxable", payrollRunId: null, paycheckId: null }).where(eq(expenses.id, e.id));
      released.push(e.id);
    }
  }
  return { paid, released };
}

/** Why a decided item cannot be reopened, or null when it can. */
export async function reopenBlocker(tx: DbTx, r: ExpenseRow): Promise<string | null> {
  if (r.status === "paid") return `Not reversible: paid in ${r.payrollRunId ?? "a processed run"}`;
  if (DECIDABLE.includes(r.status as ExpenseStatus)) return "Not decided yet: nothing to reopen";
  if (r.payrollRunId) {
    const run = (await tx.select().from(payrollRuns).where(eq(payrollRuns.id, r.payrollRunId)))[0];
    if (run && run.status !== "draft") return `Not reversible: ${run.id} is ${run.status}`;
  }
  return null;
}

/** Undoes a decision until paid: back to needs_review, detached from its draft (recomputed), checks rerun. */
export async function reopenExpense(tx: DbTx, deps: StoreDeps, r: ExpenseRow): Promise<{ before: string; detachedFrom: string | null }> {
  const detachedFrom = r.payrollRunId;
  await tx.update(expenses).set({
    status: "needs_review", decidedBy: null, decidedAt: null, decisionReasonCode: null, decisionNote: null, payrollRunId: null, paycheckId: null,
  }).where(eq(expenses.id, r.id));
  if (detachedFrom) await previewRun(tx, deps, detachedFrom);
  const fresh = (await tx.select().from(expenses).where(eq(expenses.id, r.id)))[0]!;
  await writeChecks(tx, fresh);
  return { before: r.status, detachedFrom };
}
