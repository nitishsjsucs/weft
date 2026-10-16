// Milestones (wave 3 rank 9, research/wave3/agent-parity.md 5.9). Owner: w3-parity-routines. Work anniversaries come
// from the start date (whole years); birthdays only for people with a synthetic workers.birth_month_day (MM-DD,
// opt-in, never a year). Texts carry names and a year count only, so comms.send_message grounding passes.
import { eq } from "drizzle-orm";
import type { MilestoneKind } from "@weft/contracts";
import { workers, type DbTx } from "@weft/db";
import { displayName } from "../people/names";

export interface Milestone { kind: MilestoneKind; worker_id: string; name: string; on: string; years: number | null }
export interface MilestonesResult { as_of: string; until: string; milestones: Milestone[] }

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);

export async function listMilestones(tx: DbTx, companyId: string, asOf: string, opts: { days?: number; kinds?: MilestoneKind[] } = {}): Promise<MilestonesResult> {
  const until = addDays(asOf, opts.days ?? 0);
  const kinds = new Set<MilestoneKind>(opts.kinds?.length ? opts.kinds : ["work_anniversary", "birthday"]);
  const days: string[] = [];
  for (let d = asOf; d <= until; d = addDays(d, 1)) days.push(d);
  const rows = (await tx.select().from(workers).where(eq(workers.companyId, companyId))).filter((w) => w.status === "active" || w.status === "offboarding");
  const out: Milestone[] = [];
  for (const d of days) {
    const md = d.slice(5);
    for (const w of rows) {
      if (kinds.has("work_anniversary") && w.startDate.slice(5) === md && w.startDate < d) {
        out.push({ kind: "work_anniversary", worker_id: w.id, name: displayName(w.firstName, w.lastName), on: d, years: Number(d.slice(0, 4)) - Number(w.startDate.slice(0, 4)) });
      }
      if (kinds.has("birthday") && w.birthMonthDay === md) out.push({ kind: "birthday", worker_id: w.id, name: displayName(w.firstName, w.lastName), on: d, years: null });
    }
  }
  out.sort((a, b) => (a.on === b.on ? (a.kind === b.kind ? (a.worker_id < b.worker_id ? -1 : 1) : a.kind < b.kind ? 1 : -1) : a.on < b.on ? -1 : 1));
  return { as_of: asOf, until, milestones: out };
}

/** One #general post for the day, or null when there is nothing to celebrate. */
export function milestonesText(r: MilestonesResult): string | null {
  const today = r.milestones.filter((m) => m.on === r.as_of);
  if (!today.length) return null;
  const parts = today.map((m) => (m.kind === "birthday" ? `Happy birthday, ${m.name}!` : `Happy ${m.years === 1 ? "first" : `${m.years}-year`} work anniversary, ${m.name}!`));
  return `Milestones today: ${parts.join(" ")}`;
}
