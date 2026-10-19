// Rich profile: what Friday's pre-payroll review wrote on each flagged paycheck of the Oct 30 draft. One line per flag,
// in flag order, so the flag's popover can show its own line: the flag's fact, then the context the review read from
// the world (the worker's onboarding tasks, the onboarding nudge, the pending submit, the time-off policy). Every
// clause comes from the flag's evidence or from a seeded row, never from the rule name alone, so a hire with open
// onboarding is never called complete and a gross change with no new pay rate is never called a raise. People read
// dates as "Oct 19" and never see a row id. The caller grounds the text with payroll.groundExplanation as before.
import type { Flag } from "@weft/contracts";
import { payroll } from "@weft/core";

/** What the review read beside the flags. */
export interface NoteFacts {
  /** The worker's display name of record, "Mira Delgado (demo)". */
  name: string;
  /** Onboarding task kinds that are not done, in checklist order (empty when there is no checklist or it is done). */
  openOnboarding: string[];
  /** Whether the worker has an onboarding checklist at all. */
  hasOnboarding: boolean;
  /** Whether the onboarding nudge routine reminded the worker to add a bank account. */
  reminded: boolean;
  /** Whether the submit proposal this review files excludes blocked paychecks. */
  submitExcludesBlocked: boolean;
  /** Time-off requests named in the flags: policy name and whether the policy is paid. */
  timeOff: Record<string, { policyName: string; paid: boolean }>;
  /** The payroll period's year: dates in it read without a year. */
  year: number;
  /** Pay rates named in the flags, by id: their kind ("salary" reads "a year", "hourly" "an hour"). */
  rateKinds?: Record<string, string>;
}

const PER: Record<string, string> = { salary: " a year", hourly: " an hour" };

const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-10-19" as "Oct 19" (or "Jul 8, 2024" outside the period's year). */
export function day(iso: unknown, year: number): string {
  const m = typeof iso === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso) : null;
  if (!m) return String(iso ?? "");
  const s = `${MONTH[Number(m[2]) - 1]} ${Number(m[3])}`;
  return Number(m[1]) === year ? s : `${s}, ${m[1]}`;
}
function days(list: unknown, year: number): string {
  const ds = Array.isArray(list) ? list.map((d) => day(d, year)) : [];
  return ds.length <= 1 ? (ds[0] ?? "") : `${ds[0]} to ${ds.at(-1)}`;
}
export const joinAnd = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

const TASK: Record<string, string> = {
  sign_offer: "the offer letter", sign_confidentiality: "the confidentiality agreement", federal_w4: "the W-4", state_withholding: "state withholding",
  direct_deposit: "direct deposit", i9_sim: "the I-9", benefits_selection: "benefits selection", it_accounts: "IT accounts",
};
const BLOCKING: Record<string, string> = { WAITING_PERIOD: "the policy's waiting period", INSUFFICIENT_BALANCE: "the balance", USE_CAP: "the yearly use cap" };
const LEAVE: Record<string, string> = { pto: "paid time off", sick: "sick leave" };

/** One line for one flag: its fact, then the context the review read, with no ids and no ISO dates. */
export function flagNote(f: Flag, facts: NoteFacts): string {
  const e = f.evidence;
  const y = facts.year;
  switch (f.rule) {
    case "GROSS_CHANGE": {
      const pct = String(e.change_pct ?? "");
      const up = !pct.startsWith("-");
      const head = `Gross pay is ${up ? "up" : "down"} ${pct.replace(/^[-+]/, "")}% from ${String(e.previous_gross_display)} to ${String(e.gross_display)}`;
      if (e.pay_rate_id) {
        const raise = e.created_action_seq !== null && e.created_action_seq !== undefined;
        const per = PER[facts.rateKinds?.[String(e.pay_rate_id)] ?? ""] ?? "";
        return `${head} because a new pay rate of ${String(e.pay_rate_display)}${per} took effect ${day(e.pay_rate_effective_from, y)}. ${raise ? "That is the approved raise on the audit log; nothing to fix before payday." : "Check the new rate before payday."}`;
      }
      if (e.hours_x100) return `${head} on ${String(e.hours_display)} hours. The change comes from the hours, not a pay rate change.`;
      if (e.worked_days) return `${head} for ${String(e.worked_days)} of ${String(e.period_days)} working days. The change comes from the partial period, not a pay rate change.`;
      return `${head}. No new pay rate explains it; check the earnings lines before payday.`;
    }
    case "HOURS_SPIKE":
      // What was computed, not a rule: overtime is owed by the workweek, so the period's total alone does not say how
      // much of it is overtime.
      return `${String(e.hours_display)} hours this period against an average of ${String(e.average_hours_display)} over the last ${String(e.runs_compared)} runs. Overtime is owed by the workweek, not the pay period, so confirm the weekly hours with the manager before payday.`;
    case "NEW_IN_RUN": {
      const w4 = e.has_w4 === false ? " No W-4 is on file yet." : "";
      const open = facts.openOnboarding.map((k) => TASK[k] ?? k.replaceAll("_", " "));
      const ctx = !facts.hasOnboarding ? "" : open.length ? ` Onboarding is not finished: ${joinAnd(open)} ${open.length === 1 ? "is" : "are"} still open.` : " Onboarding is complete.";
      // The headline and the evidence already give the start date, so the note does not repeat it.
      return `First paycheck on this schedule.${w4}${ctx}`;
    }
    case "PRORATED":
      return e.end_date
        ? `Paid for ${String(e.worked_days)} of ${String(e.period_days)} working days; the last day on record is ${day(e.end_date, y)}. Expected for a final partial period.`
        : `Paid for ${String(e.worked_days)} of ${String(e.period_days)} working days, counted from the start date. Expected for a partial first period.`;
    case "MISSING_BANK_ACCOUNT": {
      const ctx = [facts.reminded ? `The onboarding nudge reminded ${facts.name} to add one.` : "", facts.submitExcludesBlocked ? "The proposed submit leaves this paycheck out until it is on file." : ""].filter(Boolean).join(" ");
      return `No active bank account, so this paycheck is blocked until direct deposit is set up.${ctx ? ` ${ctx}` : ""}`;
    }
    case "PENDING_TIME_OFF_IN_PERIOD": {
      // Hours are left out: the flag's evidence holds minutes, and the grounding check only passes figures it holds.
      const req = facts.timeOff[String(e.request_id)];
      const blocking = Array.isArray(e.blocking) ? (e.blocking as string[]) : [];
      const what = `A ${req?.policyName ?? "time-off"} request for ${days(e.dates, y)} is still pending.`;
      if (blocking.length) return `${what} It is held by ${joinAnd(blocking.map((b) => BLOCKING[b] ?? b.toLowerCase().replaceAll("_", " ")))}, so approving it cannot change this paycheck.`;
      if (e.moves_gross) return `${what} Approving it adds paid leave to this paycheck, so decide it before the approval deadline.`;
      if (req && !req.paid) return `${what} It is unpaid leave, so approving it adds no line to this paycheck.`;
      return `${what} Approving it moves those hours from salary to a leave line; gross pay stays the same.`;
    }
    case "PTO_LINE": {
      const lines = Array.isArray(e.lines) ? (e.lines as { type: string }[]) : [];
      const kinds = [...new Set(lines.map((l) => LEAVE[l.type] ?? l.type))];
      return `Approved ${joinAnd(kinds)} is on this paycheck as its own leave line, inside gross pay.`;
    }
    default: {
      // Rules with no rich wording: the engine's own sentence (or the flag message), which is already grounded.
      const t = payroll.templateExplanation([f]);
      return t || f.message.replace(/\.?$/, ".");
    }
  }
}

/** The paycheck's explanation: one line per flag, in the flags' order. */
export function paycheckNote(flags: Flag[], facts: NoteFacts): string {
  return flags.map((f) => flagNote(f, facts)).join("\n");
}
