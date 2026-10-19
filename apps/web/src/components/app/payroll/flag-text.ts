// What a flag popover says, at display time only. Flag messages, evidence and explanations are stored as the engine
// and the review wrote them (base world digests and evals pin them), and they carry row ids, enum codes and ISO dates
// that mean nothing to a person. This module turns them into copy: the flag's own headline from its evidence, its own
// explanation line when the review wrote one line per flag, and evidence rows with labels, human dates and links
// instead of ids.
import { formatCents, type Flag, type Paycheck } from "@weft/contracts";
import { fmtDate, humanDates } from "../format";
import { CODE_WORDS, humanCopy } from "../copy";

export { humanCopy };

/** The latest year among a flag's dates: dates in that year read without one. */
export function refYear(flag: Flag): number {
  const years = [...JSON.stringify(flag.evidence).matchAll(/"(\d{4})-\d{2}-\d{2}"/g), ...flag.message.matchAll(/\b(\d{4})-\d{2}-\d{2}\b/g)].map((m) => Number(m[1]));
  return years.length ? Math.max(...years) : new Date().getUTCFullYear();
}

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
/** The flag's headline, built from its evidence where the stored message carries ids or ISO dates. */
export function flagHeadline(flag: Flag): string {
  const e = flag.evidence;
  const y = refYear(flag);
  const d = (v: unknown) => humanDates(str(v), y);
  switch (flag.rule) {
    case "GROSS_CHANGE": {
      const pct = str(e.change_pct);
      const head = `Gross ${pct.startsWith("-") ? "down" : "up"} ${pct.replace(/^[-+]/, "")}% from the previous paycheck (${str(e.previous_gross_display)} to ${str(e.gross_display)})`;
      return e.pay_rate_id ? `${head}; new pay rate from ${d(e.pay_rate_effective_from)}` : head;
    }
    case "NEW_IN_RUN": return `Not in the previous run; started ${d(e.start_date)}${e.has_w4 === false ? "; no W-4 on file" : ""}`;
    case "PRORATED": return `Partial period: ${e.end_date ? `last day ${d(e.end_date)}` : `started ${d(e.start_date)}`}; ${str(e.worked_days)} of ${str(e.period_days)} working days`;
    case "MISSING_FROM_RUN": return "In the previous run but not in this one";
    case "PTO_LINE": {
      const lines = Array.isArray(e.lines) ? (e.lines as { type?: unknown; hours_x100?: unknown }[]) : [];
      const parts = lines.map((l) => `${(Number(l.hours_x100 ?? 0) / 100).toFixed(2)} h of ${LEAVE_WORDS[str(l.type)] ?? str(l.type).replaceAll("_", " ")}`);
      return parts.length ? `Paid leave on this paycheck: ${parts.join(", ")}` : humanCopy(flag.message, y).replace(/\b(\d+\.\d{2}) h (pto|sick)\b/g, (_m, h: string, t: string) => `${h} h of ${LEAVE_WORDS[t]}`);
    }
    default: return humanCopy(flag.message, y);
  }
}

/**
 * The explanation to show under one flag. The rich review writes one line per flag, in flag order: then each flag
 * shows its own line. Any other explanation (one paragraph for the whole paycheck, as the agent or the template
 * writes it) is shown once, labeled as the note on the paycheck.
 */
export function flagExplanation(pc: Pick<Paycheck, "explanation" | "flags">, flag: Flag): { text: string; scope: "flag" | "paycheck" } | null {
  const raw = pc.explanation?.trim();
  if (!raw) return null;
  const y = refYear(flag);
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const i = pc.flags.findIndex((f) => f.rule === flag.rule);
  if (pc.flags.length > 1 && lines.length === pc.flags.length && i >= 0) return { text: humanCopy(lines[i]!, y), scope: "flag" };
  return { text: humanCopy(lines.join("\n"), y), scope: pc.flags.length === 1 ? "flag" : "paycheck" };
}

/** Leave earning codes on a paycheck as words. */
const LEAVE_WORDS: Record<string, string> = { pto: "paid time off", sick: "sick leave", holiday: "holiday pay", bereavement: "bereavement leave", jury_duty: "jury duty" };

/**
 * What a flag popover says when the paycheck has no explanation. The review explains paychecks that need review; a
 * paycheck whose flags are all for information is never sent to it, so the popover does not ask anyone to run it.
 */
export function emptyExplanation(flags: Pick<Flag, "severity">[]): string {
  return flags.every((f) => f.severity === "info") ? "For information; nothing to explain." : "No explanation yet. Run review to have the agent explain it.";
}

export interface EvidenceRow { label: string; value: string; href?: string }
const LABEL: Record<string, string> = {
  previous_gross: "Previous gross", gross: "Gross", change_pct: "Change", pay_rate: "New pay rate", pay_rate_effective_from: "Effective", pay_rate_effective_to: "Ends",
  used_pay_rate: "Rate used", hours: "Hours", previous_hours_x100: "Previous hours", average_hours: "Average hours", runs_compared: "Runs compared",
  worked_days: "Days worked", period_days: "Working days in period", start_date: "Start date", end_date: "Last day",
  work_state: "Work state", net: "Net pay", has_w4: "W-4 on file", previous_run_id: "Previous run", dates: "Dates", minutes_in_period: "Hours in period",
  blocking: "Held by", moves_gross: "Changes gross", reimbursements_cents: "Reimbursements", recent_average_cents: "Recent average", amount: "Amount",
  earning_type: "Earning", previous_payday: "Previous payday", same_paycheck: "Same paycheck", form_kind: "Form", submitted_at: "Submitted",
};
/** Keys a person has no use for: the row's own worker, ids, action sequence numbers and raw hundredths. */
function hidden(k: string, ev: Record<string, unknown>): boolean {
  if (k === "previous_run_id" || k === "previous_hours_x100") return false;
  // The hours spike's stored threshold is the period's regular hours, not where overtime starts (overtime is owed by
  // the workweek), and it repeats the average beside it: the row would only mislead.
  if (k === "overtime_threshold_hours") return true;
  if (k === "worker_id" || k === "lines" || /_ids?$/.test(k) || k.endsWith("_seq") || k.endsWith("_x100")) return true;
  return k.endsWith("_cents") && `${k.slice(0, -6)}_display` in ev;
}

function value(k: string, v: unknown, year: number): string {
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (k === "change_pct") { const p = str(v); return p.startsWith("-") ? `${p}%` : `+${p}%`; }
  if (k.endsWith("_cents") && typeof v === "number") return formatCents(v);
  if (k === "previous_hours_x100" && typeof v === "number") return (v / 100).toFixed(2);
  if (k === "minutes_in_period" && typeof v === "number") return `${(v / 60).toFixed(2)} h`;
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? humanCopy(CODE_WORDS[x] ?? x, year) : JSON.stringify(x))).join(", ");
  // A day in the period's year reads without one, as in the headline ("started Oct 19"); any other day keeps it.
  if (typeof v === "string") return /^\d{4}-\d{2}-\d{2}$/.test(v) ? fmtDate(v, Number(v.slice(0, 4)) === year ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" }) : humanCopy(v, year);
  return typeof v === "number" ? String(v) : JSON.stringify(v);
}

/** Evidence rows with labels, formatted values and a link where the evidence names another record. */
export function flagEvidence(flag: Flag): EvidenceRow[] {
  const ev = flag.evidence;
  const y = refYear(flag);
  return Object.entries(ev)
    .filter(([k, v]) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0) && !hidden(k, ev))
    .map(([k, v]): EvidenceRow => {
      const key = k.replace(/_(?:display|cents)$/, "");
      const label = LABEL[key] ?? LABEL[k] ?? key.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
      if (k === "previous_run_id") {
        const m = /^pay_(\d{4})_(\d{2})_(\d{2})$/.exec(str(v));
        return { label, value: m ? `Paid ${fmtDate(`${m[1]}-${m[2]}-${m[3]}`)}` : "Open", href: `/app/payroll/${encodeURIComponent(str(v))}` };
      }
      return { label, value: value(k, v, y) };
    });
}
