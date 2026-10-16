// Thirty-day check-in (wave 3 rank 12, research/wave3/agent-parity.md 5.12). Owner: w3-parity-routines.
// Day 30 after the start date the hire gets a four-question check-in by email; three days after it was sent, if it is
// still open, one nudge; when the hire submits, the manager gets a summary by email. The written answers are the hire's own
// words (untrusted), so the summary carries the two multiple-choice answers only, quotes no numbers, and points to
// Weft for the rest. Nothing an agent reads (onboarding.list_checkins) carries the written answers.
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { CheckinStatus } from "@weft/contracts";
import { checkins, workers, type DbTx } from "@weft/db";
import { displayName } from "../people/names";

export const CHECKIN_DAY = 30;
export const NUDGE_AFTER_DAYS = 3;
/** A check-in still goes out when the routine first runs up to this many days after day 30 (weekends, a missed run). */
export const SEND_WINDOW_DAYS = 6;

export const CHECKIN_QUESTIONS = [
  { id: "overall", kind: "choice", text: "How is your first month going?", options: ["great", "good", "mixed", "hard"] },
  { id: "equipped", kind: "choice", text: "Do you have the tools, access and information you need?", options: ["yes", "mostly", "no"] },
  { id: "unclear", kind: "text", text: "What is still unclear about your role or goals?", options: [] },
  { id: "better", kind: "text", text: "What would have made your first month better?", options: [] },
] as const;

export const CheckinAnswers = z.object({
  overall: z.enum(["great", "good", "mixed", "hard"]),
  equipped: z.enum(["yes", "mostly", "no"]),
  unclear: z.string().max(1000),
  better: z.string().max(1000),
});
export type CheckinAnswers = z.infer<typeof CheckinAnswers>;

/** The Pacific calendar date of an instant (a check-in sent at 17:00 PT is still that day). */
const ptDay = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
export const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);

export interface CheckinRow { checkin_id: string | null; worker_id: string; name: string; start_date: string; due_on: string; status: CheckinStatus | "due"; sent_at: string | null; nudged_at: string | null; submitted_at: string | null }
export interface CheckinPlan { as_of: string; to_send: CheckinRow[]; to_nudge: CheckinRow[]; open: CheckinRow[]; submitted: CheckinRow[] }

export async function checkinPlan(tx: DbTx, companyId: string, asOf: string): Promise<CheckinPlan> {
  const people = (await tx.select().from(workers).where(and(eq(workers.companyId, companyId), eq(workers.type, "employee")))).filter((w) => w.status === "active" || w.status === "onboarding");
  const rows = people.length ? await tx.select().from(checkins).where(inArray(checkins.workerId, people.map((p) => p.id))) : [];
  const plan: CheckinPlan = { as_of: asOf, to_send: [], to_nudge: [], open: [], submitted: [] };
  for (const w of [...people].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const dueOn = addDays(w.startDate, CHECKIN_DAY);
    const base = { worker_id: w.id, name: displayName(w.firstName, w.lastName), start_date: w.startDate, due_on: dueOn };
    const c = rows.find((r) => r.workerId === w.id && r.dueOn === dueOn);
    if (!c) {
      if (dueOn <= asOf && asOf <= addDays(dueOn, SEND_WINDOW_DAYS)) plan.to_send.push({ ...base, checkin_id: null, status: "due", sent_at: null, nudged_at: null, submitted_at: null });
      continue;
    }
    const row: CheckinRow = { ...base, checkin_id: c.id, status: c.status as CheckinStatus, sent_at: c.sentAt, nudged_at: c.nudgedAt, submitted_at: c.submittedAt };
    if (c.status === "submitted") plan.submitted.push(row);
    else if (c.status === "sent" && c.sentAt && asOf >= addDays(ptDay(c.sentAt), NUDGE_AFTER_DAYS)) plan.to_nudge.push(row);
    else if (c.status === "sent" || c.status === "nudged") plan.open.push(row);
  }
  return plan;
}

export function inviteEmail(name: string, nudge: boolean): { subject: string; body: string } {
  return nudge
    ? { subject: "A quick reminder: your first-month check-in", body: `Hi ${name},\n\nA gentle reminder that your first-month check-in is still open. It has four short questions; open it in the Weft portal whenever you have a moment.\n\nThank you,\nLarkspur Robotics people team (sent by the Weft agent)` }
    : { subject: "How is your first month going?", body: `Hi ${name},\n\nYou have been with us a month! We would love to hear how it is going. The check-in has four short questions; open it in the Weft portal. Your manager sees a short summary.\n\nThank you,\nLarkspur Robotics people team (sent by the Weft agent)` };
}

/** The manager's summary: the two multiple-choice answers only, no numbers, nothing the hire typed. */
export function managerSummary(name: string, a: CheckinAnswers): { subject: string; body: string } {
  const wrote = [a.unclear.trim(), a.better.trim()].filter(Boolean).length;
  const open = wrote === 0 ? "They left the written questions blank." : `They also wrote ${wrote === 1 ? "one written answer" : "two written answers"} in their own words; read them with the check-in in Weft.`;
  return {
    subject: `First-month check-in from ${name}`,
    body: `${name} finished the first-month check-in.\n\nHow the month is going: ${a.overall}.\nTools, access and information: ${a.equipped}.\n${open}\n\n(sent by the Weft agent)`,
  };
}
