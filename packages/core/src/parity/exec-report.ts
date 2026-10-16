// Monthly exec report and Monday exec briefing (wave 3 rank 7, research/wave3/agent-parity.md 5.7).
// Owner: w3-parity-routines. Every number is computed here from the database; the report text is built from these
// figures only and grounded against them before it is posted, so the model never writes a number.
// reports.query (w3-parity-chat) can replace the payroll cost read once merged; the figures stay the same.
import { and, eq, sql } from "drizzle-orm";
import { formatCents } from "@weft/contracts";
import { payrollRuns, taxAccounts, workers, type DbTx } from "@weft/db";
import { totalsFromDto } from "../payroll/totals";
import { displayName } from "../people/names";

export interface MonthCost { month: string; month_start: string; label: string; runs: number; total_cost_cents: number; total_cost_display: string; gross_cents: number; gross_display: string }
export interface ExecFigures {
  kind: "monthly" | "weekly"; as_of: string; month: string; month_label: string; month_start: string; month_end: string;
  headcount: number; by_state: Record<string, number>; contractors_count: number; hires_count: number; departures_count: number;
  turnover_pct: string; turnover_display: string;
  cost: MonthCost; previous: MonthCost; cost_change_pct: string | null; cost_change_display: string | null;
  open_notices_count: number; pending_approvals_count: number;
  /** Weekly briefing only. */
  upcoming?: { next_payday: string | null; next_deadline: string | null; next_run_id: string | null; hires: { worker_id: string; name: string; start_date: string }[]; registrations_not_active: { jurisdiction: string; agency: string; status: string }[] };
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const lastDay = (m: string) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);
export const previousMonth = (m: string) => { const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 2, 1)); return d.toISOString().slice(0, 7); };
/** The month a report on `asOf` covers: on the 1st through the 7th, the month that just ended; otherwise the current one. */
export const reportMonth = (asOf: string) => (Number(asOf.slice(8, 10)) <= 7 ? previousMonth(asOf.slice(0, 7)) : asOf.slice(0, 7));
const pct = (num: number, den: number) => (den === 0 ? "0.0" : ((num / den) * 100).toFixed(1));

async function monthCost(tx: DbTx, companyId: string, month: string): Promise<MonthCost> {
  const runs = await tx.select().from(payrollRuns).where(and(eq(payrollRuns.companyId, companyId), eq(payrollRuns.status, "processed")));
  const inMonth = runs.filter((r) => r.payday.slice(0, 7) === month);
  let total = 0, gross = 0;
  for (const r of inMonth) { const t = totalsFromDto(r.totalsJson); total += t?.totalCost ?? 0; gross += t?.grossPay ?? 0; }
  return { month, month_start: `${month}-01`, label: monthLabel(month), runs: inMonth.length, total_cost_cents: total, total_cost_display: formatCents(total), gross_cents: gross, gross_display: formatCents(gross) };
}

export async function execFigures(tx: DbTx, companyId: string, input: { kind: "monthly" | "weekly"; asOf: string; month?: string }): Promise<ExecFigures> {
  const month = input.month ?? reportMonth(input.asOf);
  const start = `${month}-01`, end = lastDay(month);
  const all = await tx.select().from(workers).where(eq(workers.companyId, companyId));
  const employees = all.filter((w) => w.type === "employee");
  const onStaff = (d: string) => employees.filter((w) => w.startDate <= d && (w.endDate === null || w.endDate >= d));
  const atEnd = onStaff(end);
  const atStart = onStaff(start);
  const byState: Record<string, number> = {};
  for (const w of atEnd) byState[w.workState ?? "none"] = (byState[w.workState ?? "none"] ?? 0) + 1;
  const hires = employees.filter((w) => w.startDate >= start && w.startDate <= end).length;
  const departures = employees.filter((w) => w.endDate !== null && w.endDate >= start && w.endDate <= end).length;
  const cost = await monthCost(tx, companyId, month);
  const previous = await monthCost(tx, companyId, previousMonth(month));
  const change = previous.total_cost_cents > 0 ? pct(cost.total_cost_cents - previous.total_cost_cents, previous.total_cost_cents) : null;
  const one = async (q: ReturnType<typeof sql>) => Number((await tx.all<{ n: number }>(q))[0]?.n ?? 0);
  const turnover = pct(departures, atStart.length);
  const out: ExecFigures = {
    kind: input.kind, as_of: input.asOf, month, month_label: monthLabel(month), month_start: start, month_end: end,
    headcount: atEnd.length, by_state: Object.fromEntries(Object.entries(byState).sort(([a], [b]) => a.localeCompare(b))),
    contractors_count: all.filter((w) => w.type === "contractor" && w.status !== "inactive").length, hires_count: hires, departures_count: departures,
    turnover_pct: turnover, turnover_display: `${turnover}%`, cost, previous,
    cost_change_pct: change, cost_change_display: change === null ? null : `${change.replace("-", "")}%`,
    open_notices_count: await one(sql`SELECT COUNT(*) AS n FROM notices WHERE company_id = ${companyId} AND status != 'resolved'`),
    pending_approvals_count: await one(sql`SELECT COUNT(*) AS n FROM proposals WHERE company_id = ${companyId} AND status = 'pending' AND kind != 'suggestion'`),
  };
  if (input.kind === "weekly") {
    const drafts = (await tx.select().from(payrollRuns).where(and(eq(payrollRuns.companyId, companyId), eq(payrollRuns.status, "draft"))))
      .filter((r) => r.payday >= input.asOf).sort((a, b) => (a.payday < b.payday ? -1 : 1));
    const horizon = new Date(Date.parse(`${input.asOf}T12:00:00.000Z`) + 14 * 86_400_000).toISOString().slice(0, 10);
    const regs = await tx.select().from(taxAccounts).where(eq(taxAccounts.companyId, companyId));
    out.upcoming = {
      next_payday: drafts[0]?.payday ?? null, next_deadline: drafts[0]?.approvalDeadline ?? null, next_run_id: drafts[0]?.id ?? null,
      hires: employees.filter((w) => w.startDate >= input.asOf && w.startDate <= horizon).sort((a, b) => (a.startDate < b.startDate ? -1 : 1))
        .map((w) => ({ worker_id: w.id, name: displayName(w.firstName, w.lastName), start_date: w.startDate })),
      registrations_not_active: regs.filter((r) => r.status !== "active").map((r) => ({ jurisdiction: r.jurisdiction, agency: r.agency, status: r.status })),
    };
  }
  return out;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The report text, built from the figures alone (no em dashes, no model prose). */
export function execReportText(f: ExecFigures): string {
  const states = Object.entries(f.by_state).map(([s, n]) => `${s} ${n}`).join(", ");
  const costLine = f.cost.runs === 0
    ? `No pay run was processed in ${f.month_label}.`
    : `Payroll cost ${f.cost.total_cost_display} across ${plural(f.cost.runs, "processed run")}${f.cost_change_display !== null && f.cost_change_pct !== null
      ? `, ${f.cost_change_pct.startsWith("-") ? "down" : "up"} ${f.cost_change_display} from ${f.previous.label} (${f.previous.total_cost_display})` : ""}.`;
  const people = `${plural(f.headcount, "employee")} at month end (${states}), ${plural(f.hires_count, "hire")} and ${plural(f.departures_count, "departure")} (turnover ${f.turnover_display}).`;
  const open = `Open items: ${plural(f.open_notices_count, "agency notice")} and ${plural(f.pending_approvals_count, "approval")} waiting in the Weft inbox.`;
  if (f.kind === "monthly") return `Monthly exec report for ${f.month_label}: ${people} ${costLine} ${open}`;
  const u = f.upcoming!;
  const payroll = u.next_payday ? `Next payday ${u.next_payday} (${u.next_run_id}), approval due ${u.next_deadline!.slice(0, 10)}.` : "No draft pay run is open.";
  const hires = u.hires.length ? `Starting soon: ${u.hires.map((h) => `${h.name} on ${h.start_date}`).join(", ")}.` : "No hires start in the next two weeks.";
  const regs = u.registrations_not_active.length ? `Registrations not active: ${u.registrations_not_active.map((r) => `${r.jurisdiction} ${r.agency.replace(/_/g, " ").toUpperCase()} (${r.status.replace(/_/g, " ")})`).join(", ")}.` : "Every state registration is active.";
  return `Monday exec briefing (${f.as_of}): ${payroll} ${hires} ${regs} ${people.replace("at month end", `at the end of ${f.month_label}`)} ${costLine} ${open}`;
}
