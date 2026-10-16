// Pre-payroll time-off rules (research/wave3/expenses-timeoff.md 6.4). Owner: w3-timeoff. Called by payroll/w3-hooks.ts.
// - PTO_LINE (info): the paycheck carries pto or sick lines from approved leave; the evidence names the requests.
// - PENDING_TIME_OFF_IN_PERIOD: a pending request has working days inside the period. It is review only when the
//   decision would move this paycheck's gross (an hourly worker's paid leave that is not blocked); for a salaried
//   worker approval only moves hours from the salary line to a leave line, so it is info.
// NEGATIVE_BALANCE (research 6.4) is not a FlagRule in the contracts, so it waits for a contract change; Weft never
// posts a negative balance (adjust_balance and approval refuse one).
import { eq, inArray } from "drizzle-orm";
import type { Flag } from "@weft/contracts";
import { timeOffPolicies, timeOffRequests, timeOffTypes, type DbTx } from "@weft/db";
import type { ComputedPaycheck } from "../payroll/compute";
import type { W3FlagInput } from "../payroll/w3-hooks";
import { minutesToHoursX100 } from "./engine";
import { parseDays } from "./store";

export interface TimeOffFlagRequest {
  id: string; workerId: string; policyName: string; typeKind: string; paid: boolean; status: string;
  minutesInPeriod: number; dates: string[]; blocking: string[];
}
export interface TimeOffFlagData {
  periodStart: string; periodEnd: string;
  requests: TimeOffFlagRequest[];
}

export async function loadTimeOffFlagData(tx: DbTx, input: W3FlagInput): Promise<TimeOffFlagData | null> {
  if (!input.workerIds.length) return null;
  const rows = await tx.select().from(timeOffRequests).where(inArray(timeOffRequests.workerId, input.workerIds));
  if (!rows.length) return null;
  const policyIds = [...new Set(rows.map((r) => r.policyId))];
  const pols = new Map((await tx.select({ id: timeOffPolicies.id, name: timeOffPolicies.name, typeKind: timeOffTypes.kind, paid: timeOffTypes.paid }).from(timeOffPolicies)
    .innerJoin(timeOffTypes, eq(timeOffTypes.id, timeOffPolicies.typeId)).where(inArray(timeOffPolicies.id, policyIds))).map((p) => [p.id, p]));
  const requests: TimeOffFlagRequest[] = [];
  for (const r of rows.sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (r.status !== "pending" && r.status !== "approved" && r.status !== "taken") continue;
    const days = parseDays(r).filter((d) => d.minutes > 0 && d.date >= input.periodStart && d.date <= input.periodEnd);
    if (!days.length) continue;
    const p = pols.get(r.policyId);
    const checks = (() => { try { return JSON.parse(r.checksJson) as { rule: string; severity: string }[]; } catch { return []; } })();
    requests.push({
      id: r.id, workerId: r.workerId, policyName: p?.name ?? r.policyId, typeKind: p?.typeKind ?? "vacation", paid: p?.paid ?? true, status: r.status,
      minutesInPeriod: days.reduce((s, d) => s + d.minutes, 0), dates: days.map((d) => d.date), blocking: checks.filter((c) => c.severity === "block").map((c) => c.rule),
    });
  }
  return { periodStart: input.periodStart, periodEnd: input.periodEnd, requests };
}

const hrs = (minutes: number) => (minutesToHoursX100(minutes) / 100).toFixed(2);
const span = (dates: string[]) => (dates.length === 1 ? dates[0]! : `${dates[0]} to ${dates.at(-1)}`);
const LEAVE_LINES = new Set(["pto", "sick"]);

export function timeOffFlags(cp: ComputedPaycheck, data: unknown): Flag[] {
  const d = data as TimeOffFlagData | null | undefined;
  if (!d) return [];
  const out: Flag[] = [];
  const mine = d.requests.filter((r) => r.workerId === cp.workerId);
  const lines = cp.earnings.filter((e) => LEAVE_LINES.has(e.type) && e.amountCents > 0);
  if (lines.length) {
    const approved = mine.filter((r) => r.status !== "pending" && r.paid);
    const parts = lines.map((l) => `${((l.hoursX100 ?? 0) / 100).toFixed(2)} h ${l.type}`);
    out.push({
      rule: "PTO_LINE", severity: "info",
      message: `Paid leave on this paycheck: ${parts.join(", ")}${approved.length ? ` (${approved.map((r) => r.id).join(", ")})` : ""}`,
      evidence: {
        worker_id: cp.workerId, lines: lines.map((l) => ({ type: l.type, hours_x100: l.hoursX100, amount_cents: l.amountCents })),
        request_ids: approved.map((r) => r.id), gross_cents: cp.calc.gross_cents,
      },
    });
  }
  for (const r of mine.filter((x) => x.status === "pending")) {
    const hourly = cp.rate?.kind === "hourly";
    const movesGross = hourly && r.paid && r.blocking.length === 0;
    const effect = r.blocking.length ? `blocked by ${r.blocking.join(", ")}, so approval cannot change this paycheck`
      : movesGross ? `approval adds ${hrs(r.minutesInPeriod)} h of paid leave to this paycheck`
      : r.paid ? `approval moves ${hrs(r.minutesInPeriod)} h from salary to a leave line; gross is unchanged`
      : "unpaid leave; approval adds no line";
    out.push({
      rule: "PENDING_TIME_OFF_IN_PERIOD", severity: movesGross ? "review" : "info",
      message: `${r.id} (${r.policyName}, ${span(r.dates)}, ${hrs(r.minutesInPeriod)} h) is still pending; ${effect}`,
      evidence: { worker_id: cp.workerId, request_id: r.id, dates: r.dates, minutes_in_period: r.minutesInPeriod, blocking: r.blocking, moves_gross: movesGross },
    });
  }
  return out;
}
