// Offboarding step plans and effects (wave 2, w2-offboarding). Each plan is a pure read used by both preview and run,
// so an approval re-renders the same subject; each effect goes through a simulator and mirrors the result locally.
import { and, eq, inArray } from "drizzle-orm";
import { formatCents, type IdpSim, type DeviceSim } from "@weft/contracts";
import { benefitEnrollments, benefitPlans, devices, itAccounts, paychecks, payRates, payrollRuns, timeEntries, type DbTx } from "@weft/db";
import { canonicalJson } from "../shared/canonical-json";
import { sha256Hex } from "../shared/hash";
import type { CommandDeps } from "../shared/deps";
import { DomainRefusal } from "../demo/define";
import { lastDayOfMonth, ymd } from "../payroll/calendar";
import { businessDayOnOrAfter, finalPayEarnings, planSpecialRun, submittedRegularRunFor, type SpecialEarning } from "../payroll/offcycle";
export { submittedRegularRunFor };
import { computeTotals } from "../payroll/totals";
import type { CaseRow } from "./cases";
import type { WorkerRow } from "../payroll/compute";

/** IdpSim.clearGroups and DeviceSim.lock are in the frozen sim contract since the wave 2 merge; the checks below
 * stay so a partial sim fake still refuses cleanly. */
export type OffboardingIdp = Omit<IdpSim, "clearGroups"> & Partial<Pick<IdpSim, "clearGroups">>;
export type OffboardingDevices = Omit<DeviceSim, "lock"> & Partial<Pick<DeviceSim, "lock">>;

export const COBRA_FROM = "benefits@larkspur.example";
export const EARNING_LABEL: Record<string, string> = { salary: "Salary", regular: "Regular hours", overtime: "Overtime", pto_payout: "Unused PTO payout", bonus: "Bonus (supplemental)" };

const ptToday = (now: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.parse(now)));

// ------------------------------------------------------------------ final pay

export interface FinalPayPlan {
  periodStart: string; periodEnd: string; payday: string; earnings: SpecialEarning[]; grossCents: number; netCents: number; totalCostCents: number;
  employeeTaxesCents: number; employerTaxesCents: number; deductionsCents: number; ptoHoursX100: number; hasBank: boolean; hash: string;
}

/** Final pay: the worker's period wages through the last day plus unused PTO, paid on the last day or the next business day. */
export async function finalPayPlan(tx: DbTx, c: CaseRow, w: WorkerRow, payUnusedPto: boolean, now: string): Promise<FinalPayPlan> {
  const rates = await tx.select().from(payRates).where(eq(payRates.workerId, w.id));
  const pre = finalPayEarnings(w, rates, c.lastDay, payUnusedPto, null);
  let hours: number | null = null;
  if (rates.some((r) => r.kind === "hourly")) {
    const [t] = await tx.select().from(timeEntries).where(and(eq(timeEntries.workerId, w.id), eq(timeEntries.periodStart, pre.period.periodStart)));
    hours = t ? t.regularHoursX100 + t.overtimeHoursX100 : 0;
  }
  const fp = finalPayEarnings(w, rates, c.lastDay, payUnusedPto, hours);
  const { period, ptoHoursX100 } = fp;
  if (!fp.earnings.length) throw new DomainRefusal("DOMAIN_NO_PAY_RATE", `${w.id} has no pay rate on ${c.lastDay}`, null, null);
  // Wages a submitted regular run already paid for this period are not paid again; the PTO payout still is.
  const paidIn = await submittedRegularRunFor(tx, w.id, period.periodStart, period.periodEnd);
  const earnings = paidIn ? fp.earnings.filter((e) => e.type === "pto_payout") : fp.earnings;
  if (!earnings.length) throw new DomainRefusal("DOMAIN_NOTHING_TO_PAY", `${w.id}'s wages through ${c.lastDay} were paid in ${paidIn} and there is no PTO payout`, "Skip final pay or propose it with pay_unused_pto true", { case_id: c.id, pay_unused_pto: true });
  const today = ptToday(now);
  const payday = businessDayOnOrAfter(c.lastDay > today ? c.lastDay : today);
  const plan = await planSpecialRun(tx, { companyId: c.companyId, subtype: "dismissal", periodStart: period.periodStart, periodEnd: period.periodEnd, payday, lines: [{ workerId: w.id, earnings }], benefits: true });
  const p = plan.lines[0]!;
  const blocking = p.flags.filter((f) => f.severity === "block" && f.rule !== "MISSING_BANK_ACCOUNT").map((f) => f.rule);
  if (blocking.length) throw new DomainRefusal("DOMAIN_FINAL_PAY_BLOCKED", `Final pay for ${w.id} is blocked: ${blocking.join(", ")}`, "Resolve the blocking flag (for example the state registration), then propose final pay again", null);
  const calc = p.paycheck.calc;
  const deductionsCents = p.paycheck.deductions.reduce((s, d) => s + d.amountCents, 0);
  const totalCostCents = computeTotals([{ status: "draft", grossCents: calc.gross_cents, netCents: calc.net_cents, reimbursementsCents: 0, taxes: calc.taxes, deductions: p.paycheck.deductions, benefits: p.paycheck.benefits }]).totalCost;
  const material = { case: c.id, worker: w.id, lastDay: c.lastDay, payday, earnings, net: calc.net_cents, taxes: calc.taxes, deductions: p.paycheck.deductions, bank: p.paycheck.bank?.id ?? null };
  return {
    periodStart: period.periodStart, periodEnd: period.periodEnd, payday, earnings, grossCents: calc.gross_cents, netCents: calc.net_cents, totalCostCents,
    employeeTaxesCents: calc.employee_taxes_cents, employerTaxesCents: calc.employer_taxes_cents, deductionsCents, ptoHoursX100,
    hasBank: p.paycheck.bank !== null, hash: sha256Hex(canonicalJson(material)),
  };
}

export function finalPayDiff(plan: FinalPayPlan): { label: string; before: string; after: string }[] {
  return [
    ...plan.earnings.map((e) => ({ label: `${EARNING_LABEL[e.type] ?? e.type} (${e.note})`, before: "$0.00", after: formatCents(e.amountCents) })),
    { label: "Gross pay", before: "$0.00", after: formatCents(plan.grossCents) },
    { label: "Employee taxes", before: "$0.00", after: formatCents(plan.employeeTaxesCents) },
    { label: "Pre-tax deductions", before: "$0.00", after: formatCents(plan.deductionsCents) },
    { label: "Net pay to bank", before: "$0.00", after: formatCents(plan.netCents) },
    { label: "Dismissal run", before: "none", after: `${plan.periodStart} to ${plan.periodEnd}, payday ${plan.payday}` },
  ];
}


// ------------------------------------------------------------------ IdP steps

export async function accountsOf(tx: DbTx, workerId: string, systems: string[]) {
  const rows = await tx.select().from(itAccounts).where(and(eq(itAccounts.workerId, workerId), inArray(itAccounts.system, systems)));
  return rows.sort((a, b) => systems.indexOf(a.system) - systems.indexOf(b.system));
}

export function accountsHash(caseId: string, rows: { id: string; status: string; groupsJson: string }[]): string {
  return sha256Hex(canonicalJson({ case: caseId, accounts: rows.map((r) => [r.id, r.status, r.groupsJson]) }));
}

/** Suspends each account through the IdP simulator and mirrors the status in it_accounts. */
export async function suspendAccounts(deps: CommandDeps, rows: (typeof itAccounts.$inferSelect)[]): Promise<string[]> {
  const done: string[] = [];
  for (const a of rows) {
    if (a.status === "suspended") continue;
    if (a.simRef) await deps.sims.idp.suspend(a.simRef);
    await deps.tx.update(itAccounts).set({ status: "suspended" }).where(eq(itAccounts.id, a.id));
    done.push(`${a.system} ${a.handle}`);
  }
  return done;
}

export async function clearAllGroups(deps: CommandDeps, workerId: string): Promise<{ handle: string; system: string; removed: string[] }[]> {
  const idp = deps.sims.idp as OffboardingIdp;
  const rows = await deps.tx.select().from(itAccounts).where(eq(itAccounts.workerId, workerId));
  const out: { handle: string; system: string; removed: string[] }[] = [];
  for (const a of rows.sort((x, y) => (x.id < y.id ? -1 : 1))) {
    const groups = JSON.parse(a.groupsJson) as string[];
    if (!groups.length) continue;
    const res = a.simRef && idp.clearGroups ? await idp.clearGroups(a.simRef) : { removed: groups };
    await deps.tx.update(itAccounts).set({ groupsJson: "[]" }).where(eq(itAccounts.id, a.id));
    out.push({ handle: a.handle, system: a.system, removed: res.removed.length ? res.removed : groups });
  }
  return out;
}

// ------------------------------------------------------------------ devices

export async function lockableDevices(tx: DbTx, workerId: string) {
  return (await tx.select().from(devices).where(eq(devices.workerId, workerId))).filter((d) => d.status === "assigned" || d.status === "delivered").sort((a, b) => (a.id < b.id ? -1 : 1));
}

export async function lockDevices(deps: CommandDeps, workerId: string, caseId: string): Promise<{ deviceId: string; lockRef: string }[]> {
  const sim = deps.sims.devices as OffboardingDevices;
  if (!sim.lock) throw new DomainRefusal("DOMAIN_SIM_UNAVAILABLE", "The device simulator has no remote lock", null, null);
  const out: { deviceId: string; lockRef: string }[] = [];
  for (const d of await lockableDevices(deps.tx, workerId)) {
    const r = await sim.lock({ workerId, deviceId: d.id, reason: `offboarding ${caseId}` });
    out.push({ deviceId: d.id, lockRef: r.lockRef });
  }
  return out;
}

// ------------------------------------------------------------------ benefits and COBRA

export function endOfMonth(date: string): string {
  const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7));
  return ymd(y, m, lastDayOfMonth(y, m));
}

export async function liveEnrollments(tx: DbTx, workerId: string) {
  return (await tx.select().from(benefitEnrollments).where(eq(benefitEnrollments.workerId, workerId))).filter((e) => e.status === "active" || e.status === "pending").sort((a, b) => (a.id < b.id ? -1 : 1));
}

export async function terminateEnrollments(tx: DbTx, workerId: string, effectiveTo: string): Promise<string[]> {
  const rows = await liveEnrollments(tx, workerId);
  for (const e of rows) await tx.update(benefitEnrollments).set({ status: "terminated", effectiveTo: e.effectiveTo !== null && e.effectiveTo < effectiveTo ? e.effectiveTo : effectiveTo }).where(eq(benefitEnrollments.id, e.id));
  return rows.map((e) => e.id);
}

/** COBRA notice text (template, simulated): which coverage ends, when, and the 60-day election window. */
export async function cobraNotice(tx: DbTx, w: WorkerRow, c: CaseRow): Promise<{ to: string; subject: string; body: string; plans: string[] }> {
  const enrolls = (await tx.select().from(benefitEnrollments).where(eq(benefitEnrollments.workerId, w.id))).sort((a, b) => (a.id < b.id ? -1 : 1));
  const plans = enrolls.length ? await tx.select().from(benefitPlans).where(inArray(benefitPlans.id, enrolls.map((e) => e.planId))) : [];
  const health = plans.filter((p) => p.type !== "401k").map((p) => p.name).sort();
  const coverageEnds = endOfMonth(c.lastDay);
  const to = w.personalEmail ?? w.workEmail;
  const body = [
    `Hello ${w.preferredName ?? w.firstName},`,
    "",
    "This is your COBRA continuation coverage election notice from Larkspur Robotics (a fictional company; this notice is simulated).",
    "",
    `Your employment ends on ${c.lastDay}. Your group health coverage ends on ${coverageEnds}.`,
    health.length ? `Plans you can continue: ${health.join(", ")}.` : "You had no group health plans on file, so there is no coverage to continue.",
    "",
    "You have 60 days from the later of the coverage end date or the date of this notice to elect continuation coverage.",
    "If you elect it, coverage continues without a gap. Premiums are up to 102 percent of the full plan cost.",
    "",
    `Reference: ${c.id}. Reply to ${COBRA_FROM} with questions.`,
  ].join("\n");
  return { to, subject: "Your COBRA continuation coverage notice (simulated)", body, plans: health };
}
