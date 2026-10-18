// The new hire portal's time-off view (rich-seed track): what the person will accrue once they start. Read-only, for
// the persona's own worker record: the policies that apply (their assignments, or before those exist the policies for
// their work state plus the company-wide ones), how each one accrues, the first date each can be used after the
// waiting period, and the company holidays from the start date to the end of next year. Requests open after day one.
import { and, eq } from "drizzle-orm";
import { workers, type DbTx } from "@weft/db";
import { unlockDate } from "./engine";
import { assignmentsOf, holidayMap, loadPolicies, type PolicyRow } from "./store";

export interface PortalTimeOffPolicy {
  id: string; name: string; type: string; paid: boolean; jurisdiction: string; accrual: string; usableFrom: string; waitingDays: number;
  capHours: number | null; carryoverHours: number | null;
}
export interface PortalTimeOff { workerId: string; startDate: string; policies: PortalTimeOffPolicy[]; holidays: { date: string; name: string }[] }

const hours = (m: number | null) => (m === null ? null : Math.round((m / 60) * 100) / 100);
const fmt = (h: number) => (Number.isInteger(h) ? String(h) : h.toFixed(2).replace(/0$/, ""));

/** One plain sentence on how the policy accrues. */
export function accrualSentence(p: Pick<PolicyRow, "schedule" | "minutesPerPeriod" | "workedMinutesPerChunk" | "minutesPerChunk" | "frontLoadMinutes">): string {
  if (p.schedule === "per_pay_period" && p.minutesPerPeriod) return `${fmt(p.minutesPerPeriod / 60)} h each semi-monthly pay period`;
  if (p.schedule === "per_hour_worked" && p.workedMinutesPerChunk && p.minutesPerChunk) return `1 h for every ${fmt(p.workedMinutesPerChunk / p.minutesPerChunk)} h worked`;
  if (p.schedule === "front_load_annual" && p.frontLoadMinutes) return `${fmt(p.frontLoadMinutes / 60)} h at the start of each year`;
  return "As the policy sets";
}

export async function portalTimeOff(tx: DbTx, companyId: string, workerId: string): Promise<PortalTimeOff | null> {
  const [w] = await tx.select().from(workers).where(and(eq(workers.id, workerId), eq(workers.companyId, companyId))).limit(1);
  if (!w) return null;
  const pols = await loadPolicies(tx, companyId);
  const assigned = new Set((await assignmentsOf(tx, [w.id])).map((a) => a.policyId));
  const state = w.workState ?? "";
  const mine = pols.filter((p) => (assigned.size ? assigned.has(p.id) : p.jurisdiction === "US" || p.jurisdiction === state || p.jurisdiction.startsWith(`${state}-`)));
  const lastYear = String(Number(w.startDate.slice(0, 4)) + 1);
  const hol = [...(await holidayMap(tx, companyId)).entries()].filter(([d]) => d >= w.startDate && d.slice(0, 4) <= lastYear).sort().map(([date, name]) => ({ date, name }));
  return {
    workerId: w.id, startDate: w.startDate, holidays: hol,
    policies: mine.map((p) => ({
      id: p.id, name: p.name, type: p.typeName, paid: p.paid, jurisdiction: p.jurisdiction, accrual: accrualSentence(p), usableFrom: unlockDate(w.startDate, p.waitingDaysBeforeUse),
      waitingDays: p.waitingDaysBeforeUse, capHours: hours(p.accrualCapMinutes), carryoverHours: hours(p.carryoverCapMinutes),
    })),
  };
}
