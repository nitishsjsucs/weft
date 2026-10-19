// The payroll flag popover's copy: each flag's own headline and explanation line, human dates, no row ids or engine
// codes, and evidence rows with labels and links. The stored strings are untouched (display only).
import { describe, expect, it } from "vitest";
import type { Flag, Paycheck } from "@weft/contracts";
import { humanDates } from "../src/components/app/format";
import { flagEvidence, flagExplanation, flagHeadline, humanCopy } from "../src/components/app/payroll/flag-text";

const plain = (s: string) => s.replace(/[  ]/g, " ");
const RAW = /\b[a-z]{2,5}_\d{4}\b|\d{4}-\d{2}-\d{2}|\b[A-Z]+_[A-Z_]+\b/;
const mira: Flag[] = [
  { rule: "NEW_IN_RUN", severity: "info", message: "Not in the previous run pay_2026_10_15; start date 2026-10-19", evidence: { worker_id: "wrk_0022", previous_run_id: "pay_2026_10_15", start_date: "2026-10-19", has_w4: true } },
  { rule: "PRORATED", severity: "review", message: "Partial period: start date 2026-10-19; 10 of 11 working days", evidence: { worker_id: "wrk_0022", start_date: "2026-10-19", end_date: null, worked_days: 10, period_days: 11, gross_cents: 393939, gross_display: "$3,939.39" } },
  { rule: "MISSING_BANK_ACCOUNT", severity: "block", message: "No active bank account for direct deposit", evidence: { worker_id: "wrk_0022", bank_account_id: null } },
];
const lena: Flag = { rule: "GROSS_CHANGE", severity: "review", message: "Gross up 18.0% from the previous paycheck ($4,916.67 to $5,801.67); pay rate prt_0052 effective 2026-10-16",
  evidence: { worker_id: "wrk_0026", previous_paycheck_id: "pyc_0115", previous_run_id: "pay_2026_10_15", previous_gross_cents: 491667, previous_gross_display: "$4,916.67", gross_cents: 580167, gross_display: "$5,801.67",
    change_pct: "18.0", pay_rate_id: "prt_0052", created_action_seq: 1, action_result_id: "res_0001", pay_rate_effective_from: "2026-10-16", pay_rate_cents: 13924000, pay_rate_display: "$139,240.00" } };
const pc = (flags: Flag[], explanation: string | null) => ({ flags, explanation }) as Pick<Paycheck, "flags" | "explanation">;

describe("humanDates", () => {
  it("reads plain dates as days and leaves instants, ids and other numbers alone", () => {
    expect(humanDates("start date 2026-10-19", 2026)).toBe("start date Oct 19");
    expect(humanDates("start date 2024-07-08", 2026)).toBe("start date Jul 8, 2024");
    expect(humanDates("2026-10-16 to 2026-10-31, payday 2026-10-30", 2026)).toBe("Oct 16 to Oct 31, payday Oct 30");
    expect(humanDates("pay_2026_10_30 at 2026-10-30T13:00:00.000Z, file 2026-10-09T17.md, 12026-10-190", 2026)).toBe("pay_2026_10_30 at 2026-10-30T13:00:00.000Z, file 2026-10-09T17.md, 12026-10-190");
    expect(humanDates("not a day 2026-02-31", 2026)).toBe("not a day 2026-02-31");
  });
});

describe("flag popover copy", () => {
  it("builds headlines from evidence with no ids and the start date once", () => {
    expect(flagHeadline(mira[0]!)).toBe("Not in the previous run; started Oct 19");
    expect(flagHeadline(mira[1]!)).toBe("Partial period: started Oct 19; 10 of 11 working days");
    expect(flagHeadline(mira[2]!)).toBe("No active bank account for direct deposit");
    expect(flagHeadline(lena)).toBe("Gross up 18.0% from the previous paycheck ($4,916.67 to $5,801.67); new pay rate from Oct 16");
  });

  it("cleans engine messages for the rules it has no wording for", () => {
    const pending: Flag = { rule: "PENDING_TIME_OFF_IN_PERIOD", severity: "info", message: "tor_0005 (California sick leave, 2026-10-28, 8.00 h) is still pending; blocked by WAITING_PERIOD, so approval cannot change this paycheck",
      evidence: { worker_id: "wrk_0021", request_id: "tor_0005", dates: ["2026-10-28"], minutes_in_period: 480, blocking: ["WAITING_PERIOD"], moves_gross: false } };
    expect(flagHeadline(pending)).toBe("A time-off request (California sick leave, Oct 28, 8.00 h) is still pending; blocked by the policy's waiting period, so approval cannot change this paycheck");
    expect(humanCopy("Paid leave on this paycheck: 8.00 h pto (tor_0006)")).toBe("Paid leave on this paycheck: 8.00 h pto");
    expect(humanCopy("Gross pay changed 18.0% from $4,916.67 to $5,801.67 after pay rate prt_0052 took effect 2026-10-16 (action 1).", 2026))
      .toBe("Gross pay changed 18.0% from $4,916.67 to $5,801.67 after the new pay rate took effect Oct 16.");
    expect(humanCopy("Was in pay_2026_10_15 but is not in this run.")).toBe("Was in the previous run but is not in this run.");
  });

  it("shows each flag its own line when the review wrote one line per flag", () => {
    const text = "First paycheck on this schedule; started Oct 19. Onboarding is not finished.\nPaid for 10 of 11 working days, counted from the start date.\nNo active bank account, so this paycheck is blocked.";
    expect(flagExplanation(pc(mira, text), mira[2]!)).toEqual({ text: "No active bank account, so this paycheck is blocked.", scope: "flag" });
    expect(flagExplanation(pc(mira, text), mira[0]!)?.text).toMatch(/^First paycheck/);
  });

  it("shows a paragraph for the whole paycheck once, labeled as the paycheck's note, with dates humanized", () => {
    const para = "First paycheck in this schedule; start date 2026-10-19. Paid for 10 of 11 working days (start date 2026-10-19). No active bank account, so this paycheck is blocked until direct deposit is set up.";
    const n = flagExplanation(pc(mira, para), mira[2]!)!;
    expect(n.scope).toBe("paycheck");
    expect(n.text).not.toMatch(RAW);
    expect(flagExplanation(pc([lena], "Gross pay changed 18.0% after pay rate prt_0052 took effect 2026-10-16 (action 1)."), lena))
      .toEqual({ text: "Gross pay changed 18.0% after the new pay rate took effect Oct 16.", scope: "flag" });
    expect(flagExplanation(pc(mira, null), mira[0]!)).toBeNull();
  });

  it("labels evidence, hides ids and links the previous run", () => {
    const rows = flagEvidence(lena).map((r) => ({ ...r, value: plain(r.value) }));
    expect(rows).toEqual([
      { label: "Previous run", value: "Paid Oct 15", href: "/app/payroll/pay_2026_10_15" },
      { label: "Previous gross", value: "$4,916.67" },
      { label: "Gross", value: "$5,801.67" },
      { label: "Change", value: "+18.0%" },
      { label: "Effective", value: "Oct 16" },
      { label: "New pay rate", value: "$139,240.00" },
    ]);
    expect(flagEvidence(mira[2]!)).toEqual([]);
    expect(flagEvidence(mira[0]!).map((r) => `${r.label}: ${plain(r.value)}`)).toEqual(["Previous run: Paid Oct 15", "Start date: Oct 19", "W-4 on file: Yes"]);
    for (const f of [...mira, lena]) for (const r of flagEvidence(f)) expect(`${r.label} ${r.value}`).not.toMatch(RAW);
  });
});
