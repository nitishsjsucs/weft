// The 30-day check-in form in the portal (wave 4, R15). Owner: w4-parity-people.
// The wave 3 routine (rt_thirty_day_checkin) sends the check-in; the hire answers the fixed CHECKIN_QUESTIONS here.
// Answers are the hire's own words and untrusted: the manager's email names the scale and the two yes or no answers
// only, and says whether the hire wrote anything, never what. The manager reads the written answers in Weft, for direct
// reports only. Wave 3 check-ins answered with the earlier four questions still read back (formOf).
import { and, asc, eq, inArray } from "drizzle-orm";
import { CHECKIN_QUESTIONS, CheckinAnswers, type CheckinStatus } from "@weft/contracts";
import { checkins, workers, type DbTx } from "@weft/db";
import { displayName } from "../people/names";

export { CHECKIN_QUESTIONS, CheckinAnswers };

/** Stored answers carry form "w4" so the wave 3 shape stays readable beside them. */
export interface StoredW4 extends CheckinAnswers { form: "w4" }
export interface CheckinView {
  id: string; workerId: string; name: string; dueOn: string; status: CheckinStatus; sentAt: string | null; submittedAt: string | null;
  form: "w4" | "w3" | null;
  /** Structured answers (safe to summarize). */
  settled: number | null; tools: boolean | null; clarity: boolean | null;
  /** The hire's own words: shown to the hire and their manager in Weft only. */
  written: { blocker: string; managerNote: string } | null;
}

function formOf(json: string | null): Pick<CheckinView, "form" | "settled" | "tools" | "clarity" | "written"> {
  if (!json) return { form: null, settled: null, tools: null, clarity: null, written: null };
  const a = JSON.parse(json) as Record<string, unknown>;
  if (a.form === "w4") return { form: "w4", settled: Number(a.settled), tools: a.tools === true, clarity: a.clarity === true, written: { blocker: String(a.blocker ?? ""), managerNote: String(a.manager_note ?? "") } };
  // Wave 3 answers (overall, equipped, unclear, better): map the two choices; the text stays text.
  const settled = ({ great: 5, good: 4, mixed: 3, hard: 2 } as Record<string, number>)[String(a.overall)] ?? null;
  return { form: "w3", settled, tools: a.equipped === "yes" ? true : a.equipped === "no" ? false : null, clarity: null, written: { blocker: String(a.unclear ?? ""), managerNote: String(a.better ?? "") } };
}

export async function checkinsFor(tx: DbTx, workerIds: string[], status?: string): Promise<CheckinView[]> {
  if (workerIds.length === 0) return [];
  const conds = [inArray(checkins.workerId, workerIds)];
  if (status) conds.push(eq(checkins.status, status));
  const rows = await tx.select().from(checkins).where(and(...conds)).orderBy(asc(checkins.dueOn), asc(checkins.id));
  const ppl = await tx.select({ id: workers.id, first: workers.firstName, last: workers.lastName }).from(workers).where(inArray(workers.id, workerIds));
  const nm = new Map(ppl.map((p) => [p.id, displayName(p.first, p.last)]));
  return rows.map((c) => ({ id: c.id, workerId: c.workerId, name: nm.get(c.workerId) ?? c.workerId, dueOn: c.dueOn, status: c.status as CheckinStatus, sentAt: c.sentAt, submittedAt: c.submittedAt, ...formOf(c.answersJson) }));
}

/** Direct reports of a manager's worker (workers.manager_id), in id order. */
export async function directReports(tx: DbTx, companyId: string, managerWorkerId: string): Promise<string[]> {
  return (await tx.select({ id: workers.id }).from(workers).where(and(eq(workers.companyId, companyId), eq(workers.managerId, managerWorkerId))).orderBy(asc(workers.id))).map((r) => r.id);
}

const yn = (b: boolean) => (b ? "yes" : "no");
/** The scale in words: like the wave 3 summary, the email quotes no numbers. */
export const SETTLED_WORDS: Record<number, string> = { 1: "not settled yet", 2: "a little settled", 3: "somewhat settled", 4: "mostly settled", 5: "fully settled" };
/** The manager's email: the scale in words and the two yes or no answers, and whether anything was written; never the text. */
export function managerSummaryW4(name: string, a: CheckinAnswers): { subject: string; body: string } {
  const wrote = [a.blocker.trim(), a.manager_note.trim()].filter(Boolean).length;
  const open = wrote === 0 ? "They left the written questions blank." : `They also wrote ${wrote === 1 ? "one written answer" : "two written answers"} in their own words; read them on the check-in in Weft.`;
  return {
    subject: `First-month check-in from ${name}`,
    body: `${name} finished the first-month check-in.\n\nHow settled they feel: ${SETTLED_WORDS[a.settled] ?? "not said"}.\nEvery tool and account they need: ${yn(a.tools)}.\nClear on what is expected this quarter: ${yn(a.clarity)}.\n${open}\n\n(sent by the Weft agent)`,
  };
}
