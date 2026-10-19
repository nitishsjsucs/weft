// What a flag popover says, at display time only. Flag messages, evidence and explanations are stored as the engine
// and the review wrote them (base world digests and evals pin them), and they carry row ids, enum codes and ISO dates
// that mean nothing to a person. This module turns them into copy: the flag's own headline from its evidence, its own
// explanation line when the review wrote one line per flag, and evidence rows with labels, human dates and links
// instead of ids.
import { formatCents, type Flag, type Paycheck } from "@weft/contracts";
import { fmtDate, humanDates, humanTimes } from "../format";

const ID = "[a-z]{2,5}_[A-Za-z0-9_]*\\d[A-Za-z0-9_]*";
/** Words for the engine's codes that can appear in flag text. */
const CODE_WORDS: Record<string, string> = { WAITING_PERIOD: "the policy's waiting period", INSUFFICIENT_BALANCE: "the balance", USE_CAP: "the yearly use cap" };

/** The latest year among a flag's dates: dates in that year read without one. */
export function refYear(flag: Flag): number {
  const years = [...JSON.stringify(flag.evidence).matchAll(/"(\d{4})-\d{2}-\d{2}"/g), ...flag.message.matchAll(/\b(\d{4})-\d{2}-\d{2}\b/g)].map((m) => Number(m[1]));
  return years.length ? Math.max(...years) : new Date().getUTCFullYear();
}

/**
 * Server text as copy: instants in Pacific time, plain dates as "Oct 19", no row ids (a parenthesized id list goes,
 * an id the sentence leans on becomes words) and engine codes as words.
 */
export function humanCopy(text: string, year?: number): string {
  return humanDates(humanTimes(text), year)
    .replace(new RegExp(`\\s*\\((?:${ID})(?:,\\s*${ID})*\\)`, "g"), "")
    .replace(new RegExp(`\\bafter pay rate ${ID} took effect`, "g"), "after the new pay rate took effect")
    .replace(/\s*\(action \d+\)/g, "")
    .replace(new RegExp(`;\\s*pay rate ${ID} effective`, "g"), "; new pay rate from")
    .replace(new RegExp(`\\b(in|from|Was in) (?:the previous run )?pay_[A-Za-z0-9_]+`, "g"), (_m, w: string) => `${w} the previous run`)
    .replace(new RegExp(`\\btor_\\d+ \\(`, "g"), "A time-off request (")
    .replace(new RegExp(`\\b${ID}\\b`, "g"), "")
    .replace(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g, (c) => CODE_WORDS[c] ?? c.toLowerCase().replaceAll("_", " "))
    .replace(/ {2,}/g, " ").replace(/ ([,.;)])/g, "$1").replace(/\( /g, "(").trim();
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

export interface EvidenceRow { label: string; value: string; href?: string }
const LABEL: Record<string, string> = {
  previous_gross: "Previous gross", gross: "Gross", change_pct: "Change", pay_rate: "New pay rate", pay_rate_effective_from: "Effective", pay_rate_effective_to: "Ends",
  used_pay_rate: "Rate used", hours: "Hours", previous_hours_x100: "Previous hours", average_hours: "Average hours", runs_compared: "Runs compared",
  overtime_threshold_hours: "Overtime above", worked_days: "Days worked", period_days: "Working days in period", start_date: "Start date", end_date: "Last day",
  work_state: "Work state", net: "Net pay", has_w4: "W-4 on file", previous_run_id: "Previous run", dates: "Dates", minutes_in_period: "Hours in period",
  blocking: "Held by", moves_gross: "Changes gross", reimbursements_cents: "Reimbursements", recent_average_cents: "Recent average", amount: "Amount",
  earning_type: "Earning", previous_payday: "Previous payday", same_paycheck: "Same paycheck", form_kind: "Form", submitted_at: "Submitted",
};
/** Keys a person has no use for: the row's own worker, ids, action sequence numbers and raw hundredths. */
function hidden(k: string, ev: Record<string, unknown>): boolean {
  if (k === "previous_run_id" || k === "previous_hours_x100") return false;
  if (k === "worker_id" || k === "lines" || /_ids?$/.test(k) || k.endsWith("_seq") || k.endsWith("_x100")) return true;
  return k.endsWith("_cents") && `${k.slice(0, -6)}_display` in ev;
}

function value(k: string, v: unknown, year: number): string {
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (k === "change_pct") { const p = str(v); return p.startsWith("-") ? `${p}%` : `+${p}%`; }
  if (k.endsWith("_cents") && typeof v === "number") return formatCents(v);
  if (k === "previous_hours_x100" && typeof v === "number") return (v / 100).toFixed(2);
  if (k === "minutes_in_period" && typeof v === "number") return `${(v / 60).toFixed(2)} h`;
  if (k === "overtime_threshold_hours") return `${str(v)} h`;
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? humanCopy(CODE_WORDS[x] ?? x, year) : JSON.stringify(x))).join(", ");
  if (typeof v === "string") return /^\d{4}-\d{2}-\d{2}$/.test(v) ? fmtDate(v, { month: "short", day: "numeric", year: "numeric" }) : humanCopy(v, year);
  return typeof v === "number" ? String(v) : JSON.stringify(v);
}

/** Evidence rows with labels, formatted values and a link where the evidence names another record. */
export function flagEvidence(flag: Flag): EvidenceRow[] {
  const ev = flag.evidence;
  const y = refYear(flag);
  return Object.entries(ev)
    .filter(([k, v]) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0) && !hidden(k, ev))
    .map(([k, v]): EvidenceRow => {
      const key = k.replace(/_display$/, "");
      const label = LABEL[key] ?? LABEL[k] ?? key.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
      if (k === "previous_run_id") {
        const m = /^pay_(\d{4})_(\d{2})_(\d{2})$/.exec(str(v));
        return { label, value: m ? `Paid ${fmtDate(`${m[1]}-${m[2]}-${m[3]}`)}` : "Open", href: `/app/payroll/${encodeURIComponent(str(v))}` };
      }
      return { label, value: value(k, v, y) };
    });
}
