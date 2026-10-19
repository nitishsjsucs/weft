// Paycheck flag explanations (harness 4.8, SPEC 7.5): the agent's text is grounded per item against that paycheck's
// flag evidence with @weft/grounding; a failing item is refused with UNGROUNDED once (one repair), and on the next
// failure the deterministic template is saved, labeled "template".
import { eq } from "drizzle-orm";
import { formatCents, type Flag } from "@weft/contracts";
import { check } from "@weft/grounding";
import { settings, type DbTx } from "@weft/db";

export const MAX_EXPLANATION_CHARS = 600;

const s = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const cents = (v: unknown) => (typeof v === "number" ? formatCents(v) : "");

/** One sentence per flag, built only from the flag's structured evidence. */
export function templateExplanation(flags: Flag[]): string {
  const parts: string[] = [];
  for (const f of flags) {
    const e = f.evidence;
    switch (f.rule) {
      case "GROSS_CHANGE": {
        const why = e.pay_rate_id ? ` after pay rate ${s(e.pay_rate_id)} took effect ${s(e.pay_rate_effective_from)}${e.created_action_seq !== null && e.created_action_seq !== undefined ? ` (action ${s(e.created_action_seq)})` : ""}` : e.hours_x100 ? ` with ${s(e.hours_display)} hours` : e.worked_days ? ` for ${s(e.worked_days)} of ${s(e.period_days)} working days` : "";
        parts.push(`Gross pay changed ${s(e.change_pct)}% from ${cents(e.previous_gross_cents)} to ${cents(e.gross_cents)}${why}.`);
        break;
      }
      case "HOURS_SPIKE": parts.push(`${s(e.hours_display)} hours this period against an average of ${s(e.average_hours_display)} over the last ${s(e.runs_compared)} runs.`); break;
      case "NEW_IN_RUN": parts.push(`First paycheck in this schedule; start date ${s(e.start_date)}.`); break;
      case "PRORATED": parts.push(`Paid for ${s(e.worked_days)} of ${s(e.period_days)} working days (${e.end_date ? `end date ${s(e.end_date)}` : `start date ${s(e.start_date)}`}).`); break;
      case "MISSING_BANK_ACCOUNT": parts.push("No active bank account, so this paycheck is blocked until direct deposit is set up."); break;
      case "UNREGISTERED_STATE": parts.push(`Work state ${s(e.work_state)} has no active tax account yet, so this paycheck is blocked.`); break;
      case "NEGATIVE_NET": parts.push(`Net pay is ${cents(e.net_cents)}, at or below zero.`); break;
      case "MISSING_FROM_RUN": parts.push(`Was in ${s(e.previous_run_id)} but is not in this run.`); break;
      case "TOTAL_CHANGE": parts.push(`Run gross changed ${s(e.change_pct)}%.`); break;
    }
  }
  return parts.join(" ");
}

/**
 * The words that show an explanation speaks to a flag, by rule (lower case, any one is enough). Every template sentence
 * above carries one, so a template always covers its flags. The pre-payroll eval task (RT-02) checks the same words in
 * SQL, so a paycheck whose note speaks to only one of its flags fails the task.
 */
export const FLAG_COVERAGE_WORDS: Readonly<Partial<Record<Flag["rule"], readonly string[]>>> = {
  GROSS_CHANGE: ["gross", "raise", "rate", "%"],
  HOURS_SPIKE: ["hour"],
  NEW_IN_RUN: ["first", "new", "start", "hire", "join"],
  PRORATED: ["day", "prorat", "partial"],
  MISSING_BANK_ACCOUNT: ["bank", "direct deposit"],
  UNREGISTERED_STATE: ["tax account", "regist", "state"],
  NEGATIVE_NET: ["net"],
  MISSING_FROM_RUN: ["not in this run", "missing", "previous", "last run", "left", "end date"],
  TOTAL_CHANGE: ["total", "gross"],
  DUPLICATE_SUPPLEMENTAL: ["duplicate", "supplemental", "bonus", "twice"],
  RAISE_NOT_APPLIED: ["raise", "rate"],
  WITHHOLDING_CHANGED: ["withholding", "w-4"],
  PENDING_TIME_OFF_IN_PERIOD: ["time off", "leave", "pending"],
  PTO_LINE: ["time off", "pto", "leave", "vacation", "sick"],
  REIMBURSEMENT_SPIKE: ["reimburse", "expense"],
};

/** The rules of the review and block flags an explanation does not speak to (FLAG_COVERAGE_WORDS), in flag order. */
export function uncoveredFlags(text: string, flags: Flag[]): Flag["rule"][] {
  const t = text.toLowerCase();
  const rules = flags.filter((f) => f.severity !== "info").map((f) => f.rule);
  return rules.filter((rule, i) => rules.indexOf(rule) === i && !(FLAG_COVERAGE_WORDS[rule] ?? [""]).some((w) => t.includes(w)));
}

/** Several notes for one paycheck as one explanation, in the order given, each ending as a sentence. */
export function joinExplanations(texts: string[]): string {
  return texts.map((t) => t.trim()).filter(Boolean).map((t) => (/[.!?]$/.test(t) ? t : `${t}.`)).join(" ");
}

export interface GroundResult { ok: boolean; offending: string[] }
/** Grounds text against the flags' evidence plus the paycheck's own amounts. */
export function groundExplanation(text: string, flags: Flag[], paycheck: { gross_cents: number; net_cents: number; hours_x100: number | null }): GroundResult {
  return check(text, [...flags.map((f) => f.evidence), paycheck]);
}

const attemptsKey = (runId: string) => `payroll.explain_attempts.${runId}`;
export async function readAttempts(tx: DbTx, runId: string): Promise<Record<string, number>> {
  const row = (await tx.select().from(settings).where(eq(settings.key, attemptsKey(runId))))[0];
  return row ? (JSON.parse(row.valueJson) as Record<string, number>) : {};
}
export async function writeAttempts(tx: DbTx, runId: string, a: Record<string, number>): Promise<void> {
  const valueJson = JSON.stringify(Object.fromEntries(Object.entries(a).sort(([x], [y]) => (x < y ? -1 : 1))));
  await tx.insert(settings).values({ key: attemptsKey(runId), valueJson }).onConflictDoUpdate({ target: settings.key, set: { valueJson } });
}
