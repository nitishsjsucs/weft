// SPEC 7.5 rule table on synthetic inputs: every rule, its severity and the review grouping.
import { describe, expect, it } from "vitest";
import { flagsFor, isBlocked, reviewGroupOf, runFlags, type FlagContext } from "../../src/payroll/anomalies";
import type { ComputedPaycheck } from "../../src/payroll/compute";

function cp(over: Partial<ComputedPaycheck> & { gross?: number; net?: number } = {}): ComputedPaycheck {
  const { gross = 500000, net = 380000, ...rest } = over;
  return {
    workerId: "wrk_0001", worker: { id: "wrk_0001", startDate: "2025-01-06", endDate: null, workState: "CA" } as ComputedPaycheck["worker"],
    rate: null, hoursX100: null, earnings: [], deductions: [], benefits: [], reimbursementsCents: 0,
    calc: { gross_cents: gross, net_cents: net, taxes: [], taxableWages: {}, employee_deductions_cents: 0, employee_taxes_cents: 0, employer_taxes_cents: 0, pretax_cents: 0, posttax_cents: 0, ytdDeltas: {}, trace: [] },
    bank: { id: "bnk_0001" } as ComputedPaycheck["bank"], hasW4: true, stateRegistered: true, prorated: null, ...rest,
  };
}
const ctx = (o: Partial<FlagContext> = {}): FlagContext => ({
  periodStart: "2026-10-16", periodEnd: "2026-10-31", previousRunId: "pay_2026_10_15",
  previous: new Map([["wrk_0001", { id: "pyc_0001", workerId: "wrk_0001", grossCents: 500000, hoursX100: null }]]),
  recentHours: new Map(), rateChanges: new Map(), ...o,
});
const rules = (c: ComputedPaycheck, x = ctx()) => flagsFor(c, x).map((f) => `${f.rule}:${f.severity}`).sort();

describe("anomaly rules", () => {
  it("a steady paycheck has no flags and is Ready", () => {
    const f = flagsFor(cp(), ctx());
    expect(f).toEqual([]);
    expect(reviewGroupOf(f)).toBe("ready");
  });
  it("GROSS_CHANGE fires above 10% only", () => {
    expect(rules(cp({ gross: 550000 }))).toEqual([]);
    expect(rules(cp({ gross: 550001 }))).toEqual(["GROSS_CHANGE:review"]);
    expect(rules(cp({ gross: 449999 }))).toEqual(["GROSS_CHANGE:review"]);
  });
  it("HOURS_SPIKE fires above 25% over the recent average", () => {
    const x = ctx({ recentHours: new Map([["wrk_0001", [8000, 8000, 8000]]]) });
    expect(rules(cp({ hoursX100: 10000 }), x)).toEqual([]);
    expect(rules(cp({ hoursX100: 10001 }), x)).toEqual(["HOURS_SPIKE:review"]);
  });
  it("NEW_IN_RUN is info, or review without a W-4", () => {
    const x = ctx({ previous: new Map() });
    expect(rules(cp(), x)).toEqual(["NEW_IN_RUN:info"]);
    expect(reviewGroupOf(flagsFor(cp(), x))).toBe("ready");
    expect(rules(cp({ hasW4: false }), x)).toEqual(["NEW_IN_RUN:review"]);
    expect(rules(cp(), ctx({ previousRunId: null, previous: new Map() }))).toEqual([]);
  });
  it("PRORATED is review; MISSING_BANK_ACCOUNT, UNREGISTERED_STATE and NEGATIVE_NET block", () => {
    expect(rules(cp({ prorated: { workedDays: 6, periodDays: 11 } }))).toEqual(["PRORATED:review"]);
    const blocked = flagsFor(cp({ bank: null, stateRegistered: false, net: 0 }), ctx());
    expect(blocked.map((f) => `${f.rule}:${f.severity}`).sort()).toEqual(["MISSING_BANK_ACCOUNT:block", "NEGATIVE_NET:block", "UNREGISTERED_STATE:block"]);
    expect(isBlocked(blocked)).toBe(true);
    expect(reviewGroupOf(blocked)).toBe("needs_review");
  });
  it("MISSING_FROM_RUN and TOTAL_CHANGE are run level", () => {
    const x = ctx({ previous: new Map([["wrk_0001", { id: "pyc_0001", workerId: "wrk_0001", grossCents: 500000, hoursX100: null }], ["wrk_0002", { id: "pyc_0002", workerId: "wrk_0002", grossCents: 500000, hoursX100: null }]]) });
    const f = runFlags({ included: [cp()], ctx: x, previousRunGrossCents: 1000000 });
    expect(f.map((r) => `${r.rule}:${r.severity}`).sort()).toEqual(["MISSING_FROM_RUN:review", "TOTAL_CHANGE:info"]);
    expect(f.find((r) => r.rule === "MISSING_FROM_RUN")!.evidence).toMatchObject({ worker_id: "wrk_0002", previous_paycheck_id: "pyc_0002" });
    expect(runFlags({ included: [cp({ gross: 1040000 })], ctx: ctx(), previousRunGrossCents: 1000000 })).toEqual([]);
  });
});
