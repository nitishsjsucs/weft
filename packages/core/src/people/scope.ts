// Who a read acts for, and which workers' private fields that person may see. A domain grant (people: view) lets a
// manager read the people domain at all; this narrows it to the records the person is entitled to. Full records go
// to the People and payroll roles (admin, payroll_admin, hr_manager). Every other human role, a manager first, sees
// full records only for themself and their direct and indirect reports; anyone else is directory fields only (name,
// title, department, work state, manager), never pay, bank, W-4, benefits elections or ID numbers. Same reach as the
// manager check in time_off.decide (packages/core/src/commands/time-off.ts), extended down the reporting chain.
// A call with no human behind it (a system service, an unowned routine) is not narrowed here: the executor's own
// grant check already applied to it.
import { and, eq } from "drizzle-orm";
import type { ExecContext } from "@weft/contracts";
import { offers, principals, workers, type DbTx } from "@weft/db";
import { DomainRefusal } from "../demo/define";

/** Roles that read every worker's full record (their domain grants still apply). */
export const FULL_RECORD_ROLES: ReadonlySet<string> = new Set(["admin", "payroll_admin", "hr_manager"]);

/** The fields anyone with people access may read about any worker. */
export const DIRECTORY_FIELDS = ["name", "title", "department", "work_state", "manager"] as const;

/** The private fields a narrowed read leaves out for a worker outside the viewer's reports. */
export const WITHHELD_FIELDS = ["pay", "bank account", "W-4", "benefits elections", "ID numbers"] as const;

export interface ReadScope {
  viewerId: string;
  display: string;
  role: string | null;
  selfWorkerId: string | null;
  /** Direct and indirect reports of the viewer's own worker record. */
  reports: ReadonlySet<string>;
  grants: Readonly<Record<string, string>>;
}

/** The human a call acts for: the caller when a person calls, the on-behalf-of person for an agent run. */
export function viewerIdOf(ctx: Pick<ExecContext, "principal" | "onBehalfOf">): string | null {
  if (ctx.principal.kind === "human") return ctx.principal.id;
  if (ctx.principal.kind === "agent") return ctx.onBehalfOf;
  return null;
}

/** Every worker under `root` in the reporting chain (cycle safe). */
export function reportsUnder(edges: readonly { id: string; managerId: string | null }[], root: string | null): Set<string> {
  const out = new Set<string>();
  if (!root) return out;
  const byManager = new Map<string, string[]>();
  for (const e of edges) if (e.managerId) byManager.set(e.managerId, [...(byManager.get(e.managerId) ?? []), e.id]);
  const queue = [root];
  while (queue.length) {
    for (const id of byManager.get(queue.shift()!) ?? []) {
      if (id === root || out.has(id)) continue;
      out.add(id);
      queue.push(id);
    }
  }
  return out;
}

function parseGrants(json: string | null | undefined): Record<string, string> {
  try { return (JSON.parse(json ?? "{}") as Record<string, string>) ?? {}; } catch { return {}; }
}

/**
 * The narrowing for a read by `principalId`, or null when the person reads full records (or no person is behind the
 * call). An unknown principal is narrowed with no reports, so a dangling on-behalf-of id fails closed.
 */
export async function readScopeFor(tx: DbTx, companyId: string, principalId: string | null): Promise<ReadScope | null> {
  if (!principalId) return null;
  const [p] = await tx.select().from(principals).where(and(eq(principals.id, principalId), eq(principals.companyId, companyId))).limit(1);
  if (p && p.kind !== "human") return null;
  if (p && FULL_RECORD_ROLES.has(p.role ?? "")) return null;
  const edges = await tx.select({ id: workers.id, managerId: workers.managerId }).from(workers).where(eq(workers.companyId, companyId));
  const self = p?.workerId ?? null;
  return { viewerId: principalId, display: p?.display ?? principalId, role: p?.role ?? null, selfWorkerId: self, reports: reportsUnder(edges, self), grants: parseGrants(p?.grantsJson) };
}

/** readScopeFor the human this call acts for. */
export function readScopeOf(tx: DbTx, ctx: Pick<ExecContext, "companyId" | "principal" | "onBehalfOf">): Promise<ReadScope | null> {
  return readScopeFor(tx, ctx.companyId, viewerIdOf(ctx));
}

/** True when the viewer may read this worker's full record: no narrowing, the viewer's own record, or a report. */
export function inScope(scope: ReadScope | null, workerId: string | null | undefined): boolean {
  if (!scope) return true;
  if (!workerId) return false;
  return workerId === scope.selfWorkerId || scope.reports.has(workerId);
}

/** True when the viewer holds view (or better) on a domain. */
export function hasDomain(scope: ReadScope | null, domain: string | null | undefined): boolean {
  if (!scope || !domain) return true;
  const g = scope.grants[domain];
  return !!g && g !== "none";
}

const roleWord = (s: ReadScope) => (s.role === "manager" ? "a manager" : s.role ? `role ${s.role}` : "a person without a People role");

/** Why a worker's private fields are left out, in words the model can repeat to the person. */
export function withheldReason(scope: ReadScope, subject: string): string {
  return `${scope.display} is ${roleWord(scope)}: pay, bank account, W-4, benefits elections and ID numbers are shared only for their own record and their direct and indirect reports, and ${subject} is not one of them. Say plainly that you cannot share these; do not estimate them.`;
}

/** The access block a narrowed record carries, so the result itself says what is missing and why. */
export function directoryAccess(scope: ReadScope, subject: string, withheld: readonly string[] = WITHHELD_FIELDS) {
  return { scope: "directory" as const, shown: [...DIRECTORY_FIELDS], withheld: [...withheld], reason: withheldReason(scope, subject) };
}

// ------------------------------------------------------------------------------------------------ lists about people

/**
 * A list read about people (leave requests, balances, offboarding cases, background checks, training, documents,
 * onboarding): the rows about the viewer's own record and reports, and how many others it left out. Not narrowed
 * (scope null) keeps every row. `workerOf` names the worker a row is about; a row about no one is left out.
 */
export function splitByScope<T>(scope: ReadScope | null, rows: readonly T[], workerOf: (row: T) => string | null | undefined): { shown: T[]; withheld: number } {
  if (!scope) return { shown: [...rows], withheld: 0 };
  const shown = rows.filter((r) => inScope(scope, workerOf(r)));
  return { shown, withheld: rows.length - shown.length };
}

/** The access block of a list cut to the viewer's reports, so the result says how many rows it left out and why. */
export function reportsAccess(scope: ReadScope, what: string, withheld: number) {
  return {
    scope: "reports" as const, withheld_rows: withheld,
    reason: `${scope.display} is ${roleWord(scope)}: ${what} are shared only for their own record and their direct and indirect reports. Say plainly that you cannot share anyone else's.`,
  };
}

/** The refusal for one record about someone outside the viewer's reports. It never says whether the record exists. */
export function outsideReports(scope: ReadScope, what: string): DomainRefusal {
  return new DomainRefusal("DOMAIN_OUTSIDE_REPORTS", `${scope.display} is ${roleWord(scope)}: ${what} are shared only for their own record and their direct and indirect reports`, "Ask about someone in your reporting chain, or ask a People admin", null);
}

/** True when an offer is the viewer's to read in full: no narrowing, or its hiring manager is the viewer or a report. */
export const hiringManagerInScope = (scope: ReadScope | null, managerId: string | null | undefined): boolean => inScope(scope, managerId);

/** Why an offer's pay is left out, in words the model can repeat to the person. */
export function offerPayReason(scope: ReadScope, candidate: string): string {
  return `${scope.display} is ${roleWord(scope)}: offer pay is shared only when they or one of their direct and indirect reports is the hiring manager, and the offer for ${candidate} is not one of them. Say plainly that you cannot share it; do not estimate it.`;
}

/** An offer is in a narrowed viewer's scope when its hiring manager is the viewer or one of their reports. */
export async function offerIdInScope(tx: DbTx, companyId: string, scope: ReadScope | null, offerId: string | null | undefined): Promise<boolean> {
  if (!scope) return true;
  if (!offerId) return false;
  const [o] = await tx.select({ managerId: offers.managerId }).from(offers).where(and(eq(offers.id, offerId), eq(offers.companyId, companyId))).limit(1);
  return !!o && inScope(scope, o.managerId);
}

/** A record whose subject is a worker or an offer; any other subject (an unmatched vendor record) names no Weft person. */
export async function subjectInScope(tx: DbTx, companyId: string, scope: ReadScope | null, subjectRef: string): Promise<boolean> {
  if (!scope) return true;
  if (subjectRef.startsWith("wrk_")) return inScope(scope, subjectRef);
  if (subjectRef.startsWith("offr_")) return offerIdInScope(tx, companyId, scope, subjectRef);
  return true;
}

/** A sync item's detail for a narrowed viewer outside its subject: the field and label stay, the values do not. */
export function withheldSyncDetail(scope: ReadScope, detail: Record<string, unknown>, subject: string) {
  return { field: detail.field ?? null, label: detail.label ?? null, withheld: ["weft_value", "vendor_value"], reason: withheldReason(scope, subject) };
}

// ------------------------------------------------------------------------------------------------ audit rows

/** The worker ids an audit row names: its args' worker_id and worker_ids, and a proposal's wrk_ subject. */
export function workersNamed(argsJson: unknown, subjectRef: string | null = null): string[] {
  let args: unknown = argsJson;
  if (typeof argsJson === "string") { try { args = JSON.parse(argsJson); } catch { args = null; } }
  const out: string[] = [];
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    if (typeof a.worker_id === "string") out.push(a.worker_id);
    if (Array.isArray(a.worker_ids)) for (const w of a.worker_ids) if (typeof w === "string") out.push(w);
  }
  if (subjectRef?.startsWith("wrk_")) out.push(subjectRef);
  return out;
}

const MONEY = /\$\s?\d/;

/**
 * An audit row (an action or a proposal) a narrowed viewer may read in words: the command's domain is one they hold,
 * every worker the row names is in their reports, and a row naming no worker carries no amount. Any other row stays
 * listed with its seq, time, actor and command, and its summary or headline is withheld.
 */
export function auditRowVisible(scope: ReadScope | null, domainOf: (command: string) => string | null | undefined, row: { command: string | null; argsJson: unknown; subjectRef?: string | null; text: string }): boolean {
  if (!scope) return true;
  if (row.command && !hasDomain(scope, domainOf(row.command) ?? "company")) return false;
  const named = workersNamed(row.argsJson, row.subjectRef ?? null);
  if (named.length) return named.every((w) => inScope(scope, w));
  return !MONEY.test(row.text);
}

export const WITHHELD_SUMMARY = "Withheld: this row is about pay, benefits or a worker outside your reports";

/** The access block of a narrowed audit read, so the result says how many rows it withheld and why. */
export const auditAccess = (scope: ReadScope, n: number) => ({
  scope: "reports" as const, withheld_rows: n,
  reason: `${scope.display} sees audit summaries only for their own record, their direct and indirect reports and the domains they can view. Say plainly that you cannot share the withheld rows.`,
});
