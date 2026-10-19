// The rich pre-payroll review's flag explanations: one line per flag, context read from the worker's rows, human dates
// and no ids, and every line passes the same grounding check payroll.explain_flags uses.
import { describe, expect, it } from "vitest";
import type { Flag } from "@weft/contracts";
import { payroll } from "@weft/core";
import { day, flagNote, paycheckNote, type NoteFacts } from "../src/rich/flag-notes";

const facts = (over: Partial<NoteFacts> = {}): NoteFacts => ({ name: "Mira Delgado (demo)", openOnboarding: [], hasOnboarding: true, reminded: false, submitExcludesBlocked: false, timeOff: {}, year: 2026, ...over });
const mira: Flag[] = [
  { rule: "NEW_IN_RUN", severity: "info", message: "Not in the previous run pay_2026_10_15; start date 2026-10-19", evidence: { worker_id: "wrk_0022", previous_run_id: "pay_2026_10_15", start_date: "2026-10-19", has_w4: true } },
  { rule: "PRORATED", severity: "review", message: "Partial period: start date 2026-10-19; 10 of 11 working days", evidence: { worker_id: "wrk_0022", start_date: "2026-10-19", end_date: null, worked_days: 10, period_days: 11, gross_cents: 393939, gross_display: "$3,939.39" } },
  { rule: "MISSING_BANK_ACCOUNT", severity: "block", message: "No active bank account for direct deposit", evidence: { worker_id: "wrk_0022", bank_account_id: null } },
];
const gross = (extra: Record<string, unknown>, pct = "18.0"): Flag => ({ rule: "GROSS_CHANGE", severity: "review", message: "Gross changed", evidence: {
  worker_id: "wrk_0026", previous_gross_cents: 491667, previous_gross_display: "$4,916.67", gross_cents: 580167, gross_display: "$5,801.67", change_pct: pct, pay_rate_id: null, created_action_seq: null, ...extra } });

describe("rich flag notes", () => {
  it("writes one line per flag in flag order, leaves the start date to the headline and evidence and never shows an id or ISO date", () => {
    const text = paycheckNote(mira, facts({ openOnboarding: ["direct_deposit", "i9_sim", "benefits_selection"], reminded: true, submitExcludesBlocked: true }));
    const lines = text.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("First paycheck on this schedule. Onboarding is not finished: direct deposit, the I-9 and benefits selection are still open.");
    expect(lines[1]).toBe("Paid for 10 of 11 working days, counted from the start date. Expected for a partial first period.");
    expect(lines[2]).toBe("No active bank account, so this paycheck is blocked until direct deposit is set up. The onboarding nudge reminded Mira Delgado (demo) to add one. The proposed submit leaves this paycheck out until it is on file.");
    expect(text).not.toMatch(/Oct 19|started/);
    expect(text).not.toMatch(/\b[a-z]{2,4}_\d{4}\b|\d{4}-\d{2}-\d{2}/);
    expect(payroll.groundExplanation(text, mira, { gross_cents: 393939, net_cents: 300000, hours_x100: null }).ok).toBe(true);
  });

  it("calls onboarding complete only when every task is done, and says nothing about it without a checklist", () => {
    expect(flagNote(mira[0]!, facts())).toContain("Onboarding is complete.");
    expect(flagNote(mira[0]!, facts({ openOnboarding: ["i9_sim"] }))).toContain("the I-9 is still open");
    expect(flagNote(mira[0]!, facts({ hasOnboarding: false }))).toBe("First paycheck on this schedule.");
    expect(flagNote({ ...mira[0]!, evidence: { ...mira[0]!.evidence, has_w4: false } }, facts({ hasOnboarding: false }))).toContain("No W-4 is on file yet.");
  });

  it("leaves out the reminder and the submit when no row shows them", () => {
    expect(flagNote(mira[2]!, facts())).toBe("No active bank account, so this paycheck is blocked until direct deposit is set up.");
  });

  it("says raise only for a new pay rate from a recorded action, and names the real cause otherwise", () => {
    const raise = flagNote(gross({ pay_rate_id: "prt_0052", created_action_seq: 1, pay_rate_display: "$139,240.00", pay_rate_effective_from: "2026-10-16" }), facts());
    expect(raise).toBe("Gross pay is up 18.0% from $4,916.67 to $5,801.67 because a new pay rate of $139,240.00 took effect Oct 16. That is the approved raise on the audit log; nothing to fix before payday.");
    expect(flagNote(gross({ pay_rate_id: "prt_0052", pay_rate_display: "$139,240.00", pay_rate_effective_from: "2026-10-16" }), facts())).not.toMatch(/raise/);
    const hours = flagNote(gross({ hours_x100: 12000, hours_display: "120.00" }, "57.7"), facts());
    expect(hours).toMatch(/on 120\.00 hours\. The change comes from the hours/);
    const partial = flagNote(gross({ worked_days: 6, period_days: 11 }, "-45.5"), facts());
    expect(partial).toMatch(/^Gross pay is down 45\.5% .* for 6 of 11 working days\. The change comes from the partial period/);
    for (const t of [hours, partial]) expect(t).not.toMatch(/raise/i);
  });

  it("gives a new pay rate its unit from the rate's kind, and adds no figure the grounding check lacks", () => {
    const f = gross({ pay_rate_id: "prt_0052", created_action_seq: 1, pay_rate_display: "$139,240.00", pay_rate_effective_from: "2026-10-16" });
    const year = flagNote(f, facts({ rateKinds: { prt_0052: "salary" } }));
    expect(year).toContain("a new pay rate of $139,240.00 a year took effect Oct 16.");
    expect(flagNote(f, facts({ rateKinds: { prt_0052: "hourly" } }))).toContain("$139,240.00 an hour took effect");
    expect(payroll.groundExplanation(year, [f], { gross_cents: 580167, net_cents: 400000, hours_x100: null }).ok).toBe(true);
  });

  it("an hours spike says what was computed and leaves overtime to the workweek, not a per-period rule", () => {
    const f: Flag = { rule: "HOURS_SPIKE", severity: "review", message: "120.00 hours vs an average of 86.67 over the last 3 runs",
      evidence: { worker_id: "wrk_0040", hours_x100: 12000, hours_display: "120.00", average_hours_x100: 8667, average_hours_display: "86.67", runs_compared: 3, overtime_threshold_hours: "86.67" } };
    const t = flagNote(f, facts());
    expect(t).toBe("120.00 hours this period against an average of 86.67 over the last 3 runs. Overtime is owed by the workweek, not the pay period, so confirm the weekly hours with the manager before payday.");
    expect(t).not.toMatch(/above 86\.67|paid as overtime/);
    expect(payroll.groundExplanation(t, [f], { gross_cents: 500000, net_cents: 400000, hours_x100: 12000 }).ok).toBe(true);
  });

  it("tells a final partial period from a first one", () => {
    const last = flagNote({ ...mira[1]!, evidence: { ...mira[1]!.evidence, start_date: "2024-07-08", end_date: "2026-10-23", worked_days: 6 } }, facts());
    expect(last).toBe("Paid for 6 of 11 working days; the last day on record is Oct 23. Expected for a final partial period.");
  });

  it("names a pending request by its policy and dates, not its id or blocking code", () => {
    const f: Flag = { rule: "PENDING_TIME_OFF_IN_PERIOD", severity: "info", message: "tor_0005 (California sick leave, 2026-10-28, 8.00 h) is still pending; blocked by WAITING_PERIOD",
      evidence: { worker_id: "wrk_0021", request_id: "tor_0005", dates: ["2026-10-28"], minutes_in_period: 480, blocking: ["WAITING_PERIOD"], moves_gross: false } };
    const t = flagNote(f, facts({ timeOff: { tor_0005: { policyName: "California sick leave", paid: true } } }));
    expect(t).toBe("A California sick leave request for Oct 28 is still pending. It is held by the policy's waiting period, so approving it cannot change this paycheck.");
    expect(payroll.groundExplanation(t, [f], { gross_cents: 1, net_cents: 1, hours_x100: null }).ok).toBe(true);
  });

  it("reads dates outside the period's year with the year", () => {
    expect(day("2026-10-19", 2026)).toBe("Oct 19");
    expect(day("2024-07-08", 2026)).toBe("Jul 8, 2024");
  });
});
