// New Hire Ready Check (wave 3 rank 8, research/wave3/agent-parity.md 5.8). Owner: w3-parity-routines.
// Deterministic: hires whose start date falls within the next N business days (weekends skipped; the holiday calendar
// belongs to w3-timeoff), each checked against the eight ReadyCheckItem values with the owner who unblocks it.
// The texts carry names, dates and owners only, so comms.send_message grounding passes (start dates of onboarding
// workers are company facts).
import { and, eq, inArray } from "drizzle-orm";
import type { ReadyCheckItem } from "@weft/contracts";
import { bankAccounts, benefitEnrollments, devices, itAccounts, onboardingTasks, taxAccounts, taxProfiles, workers, type DbTx } from "@weft/db";
import { displayName } from "../people/names";
import { addWorkingDays } from "../life-events/business-days";
import { holidayMap } from "../time-off/store";

export type ReadyOwner = "the hire" | "IT" | "payroll" | "HR";
export const READY_ITEMS: readonly { item: ReadyCheckItem; label: string; owner: ReadyOwner }[] = [
  { item: "accounts_active", label: "work accounts", owner: "IT" },
  { item: "device_delivered", label: "laptop delivered", owner: "IT" },
  { item: "bank_verified", label: "direct deposit account", owner: "the hire" },
  { item: "w4_submitted", label: "federal W-4", owner: "the hire" },
  { item: "state_form_submitted", label: "state withholding form", owner: "the hire" },
  { item: "i9_done", label: "I-9", owner: "the hire" },
  { item: "benefits_decided", label: "benefits elected or waived", owner: "the hire" },
  { item: "state_registration_active", label: "state payroll registration", owner: "payroll" },
];
export const REQUIRED_SYSTEMS = ["chat", "google_ws", "github"] as const;
export const READY_WINDOW_BUSINESS_DAYS = 3;

export interface ReadyHire {
  worker_id: string; name: string; start_date: string; work_state: string | null; first_day: boolean; ready: boolean;
  items: { item: ReadyCheckItem; label: string; owner: ReadyOwner; ok: boolean }[];
  blocked: { item: ReadyCheckItem; label: string; owner: ReadyOwner }[];
}
export interface ReadyCheckResult { as_of: string; window_end: string; business_days: number; hires: ReadyHire[] }

const isWeekend = (d: string) => { const w = new Date(`${d}T12:00:00.000Z`).getUTCDay(); return w === 0 || w === 6; };
const nextDay = (d: string) => new Date(Date.parse(`${d}T12:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
/** The date N business days after `from` (weekends skipped). */
export function addBusinessDays(from: string, n: number): string {
  let d = from;
  for (let left = n; left > 0;) { d = nextDay(d); if (!isWeekend(d)) left--; }
  return d;
}

/** One hire, or every employee starting in [asOf, asOf + N business days]. */
export async function readyCheck(tx: DbTx, companyId: string, asOf: string, opts: { businessDays?: number; workerId?: string } = {}): Promise<ReadyCheckResult> {
  const n = opts.businessDays ?? READY_WINDOW_BUSINESS_DAYS;
  // wave 4 (w4-parity-people, R2): the three business days skip the company holiday calendar too.
  const end = addWorkingDays(asOf, n, await holidayMap(tx, companyId));
  const all = await tx.select().from(workers).where(and(eq(workers.companyId, companyId), eq(workers.type, "employee")));
  const hires = all
    .filter((w) => (opts.workerId ? w.id === opts.workerId : w.startDate >= asOf && w.startDate <= end && ["onboarding", "active"].includes(w.status)))
    .sort((a, b) => (a.startDate === b.startDate ? (a.id < b.id ? -1 : 1) : a.startDate < b.startDate ? -1 : 1));
  if (!hires.length) return { as_of: asOf, window_end: end, business_days: n, hires: [] };
  const ids = hires.map((h) => h.id);
  const [tasks, accts, devs, banks, profiles, enrolls, regs] = await Promise.all([
    tx.select().from(onboardingTasks).where(inArray(onboardingTasks.workerId, ids)),
    tx.select().from(itAccounts).where(inArray(itAccounts.workerId, ids)),
    tx.select().from(devices).where(inArray(devices.workerId, ids)),
    tx.select().from(bankAccounts).where(inArray(bankAccounts.workerId, ids)),
    tx.select({ workerId: taxProfiles.workerId }).from(taxProfiles).where(inArray(taxProfiles.workerId, ids)),
    tx.select({ workerId: benefitEnrollments.workerId }).from(benefitEnrollments).where(inArray(benefitEnrollments.workerId, ids)),
    tx.select().from(taxAccounts).where(eq(taxAccounts.companyId, companyId)),
  ]);
  const out: ReadyHire[] = [];
  for (const w of hires) {
    const task = (kind: string) => tasks.find((t) => t.workerId === w.id && t.kind === kind) ?? null;
    /** A task, when the checklist has one, decides; otherwise the data does. */
    const byTask = (kind: string, fallback: boolean) => { const t = task(kind); return t ? t.status === "done" : fallback; };
    const active = new Set(accts.filter((a) => a.workerId === w.id && a.status === "active").map((a) => a.system));
    const stateRegs = regs.filter((r) => r.jurisdiction === w.workState);
    const ok: Record<ReadyCheckItem, boolean> = {
      accounts_active: REQUIRED_SYSTEMS.every((s) => active.has(s)),
      device_delivered: devs.some((d) => d.workerId === w.id && (d.status === "delivered" || d.status === "assigned")),
      bank_verified: banks.some((b) => b.workerId === w.id && b.status === "active"),
      w4_submitted: byTask("federal_w4", profiles.some((p) => p.workerId === w.id)),
      state_form_submitted: byTask("state_withholding", true),
      i9_done: byTask("i9_sim", true),
      benefits_decided: byTask("benefits_selection", enrolls.some((e) => e.workerId === w.id) || !task("benefits_selection")),
      state_registration_active: stateRegs.length > 0 && stateRegs.every((r) => r.status === "active"),
    };
    const items = READY_ITEMS.map((r) => ({ ...r, ok: ok[r.item] }));
    const blocked = items.filter((i) => !i.ok).map(({ item, label, owner }) => ({ item, label, owner }));
    out.push({ worker_id: w.id, name: displayName(w.firstName, w.lastName), start_date: w.startDate, work_state: w.workState, first_day: w.startDate === asOf, ready: blocked.length === 0, items, blocked });
  }
  return { as_of: asOf, window_end: end, business_days: n, hires: out };
}

/** "direct deposit account (the hire), laptop delivered (IT)" */
export const blockedText = (h: Pick<ReadyHire, "blocked">) => h.blocked.map((b) => `${b.label} (${b.owner})`).join(", ");

/** The #new-hires line for one hire: the first-day welcome, a ready line, or the blocking items with owners. */
export function readyLine(h: ReadyHire): string {
  if (h.first_day && h.ready) return `First day today: please welcome ${h.name}! Accounts, laptop, pay and paperwork are all set.`;
  if (h.first_day) return `First day today: please welcome ${h.name}! Still open: ${blockedText(h)}.`;
  if (h.ready) return `Ready for day one: ${h.name} starts ${h.start_date}. Accounts, laptop, pay and paperwork are all set.`;
  return `Not ready yet: ${h.name} starts ${h.start_date}. Blocking: ${blockedText(h)}.`;
}
