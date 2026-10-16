// Pre-payroll time-off rules on the pure function (research/wave3/expenses-timeoff.md 6.4): PTO_LINE is info,
// PENDING_TIME_OFF_IN_PERIOD is review only when the decision would move the paycheck's gross.
import { describe, expect, it } from "vitest";
import { timeOffFlags, type TimeOffFlagData, type TimeOffFlagRequest } from "../../src/time-off/flags";
import type { ComputedPaycheck } from "../../src/payroll/compute";

const paycheck = (kind: "salary" | "hourly", earnings: ComputedPaycheck["earnings"], workerId = "wrk_0030") =>
  ({ workerId, rate: { kind }, earnings, calc: { gross_cents: earnings.reduce((s, e) => s + e.amountCents, 0) } }) as unknown as ComputedPaycheck;
const req = (over: Partial<TimeOffFlagRequest>): TimeOffFlagRequest => ({
  id: "tor_0009", workerId: "wrk_0030", policyName: "Larkspur Vacation", typeKind: "vacation", paid: true, status: "pending",
  minutesInPeriod: 480, dates: ["2026-10-28"], blocking: [], ...over,
});
const data = (requests: TimeOffFlagRequest[]): TimeOffFlagData => ({ periodStart: "2026-10-16", periodEnd: "2026-10-31", requests });

describe("time-off pre-payroll flags", () => {
  it("nothing in the period flags nothing", () => {
    expect(timeOffFlags(paycheck("salary", [{ type: "salary", amountCents: 475_000, hoursX100: null }]), data([]))).toEqual([]);
    expect(timeOffFlags(paycheck("salary", []), null)).toEqual([]);
  });

  it("PTO_LINE is info and names the approved request; gross is what the lines add up to", () => {
    const cp = paycheck("salary", [{ type: "salary", amountCents: 431_154, hoursX100: null }, { type: "pto", amountCents: 43_846, hoursX100: 800 }]);
    const flags = timeOffFlags(cp, data([req({ id: "tor_0006", status: "approved" })]));
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ rule: "PTO_LINE", severity: "info", message: "Paid leave on this paycheck: 8.00 h pto (tor_0006)" });
    expect(flags[0]!.evidence).toMatchObject({ request_ids: ["tor_0006"], gross_cents: 475_000 });
  });

  it("a paid holiday line alone is routine and does not flag", () => {
    const cp = paycheck("salary", [{ type: "salary", amountCents: 431_154, hoursX100: null }, { type: "paid_holiday", amountCents: 43_846, hoursX100: 800 }]);
    expect(timeOffFlags(cp, data([]))).toEqual([]);
  });

  it("a salaried worker's pending paid leave is info: approval moves hours, not gross", () => {
    const [f] = timeOffFlags(paycheck("salary", [{ type: "salary", amountCents: 650_000, hoursX100: null }]), data([req({ minutesInPeriod: 240, dates: ["2026-10-29"], policyName: "New York City sick leave" })]));
    expect(f).toMatchObject({ rule: "PENDING_TIME_OFF_IN_PERIOD", severity: "info" });
    expect(f!.message).toBe("tor_0009 (New York City sick leave, 2026-10-29, 4.00 h) is still pending; approval moves 4.00 h from salary to a leave line; gross is unchanged");
    expect(f!.evidence).toMatchObject({ moves_gross: false, minutes_in_period: 240 });
  });

  it("an hourly worker's pending paid leave is review: approval would add pay", () => {
    const [f] = timeOffFlags(paycheck("hourly", [{ type: "regular", amountCents: 240_000, hoursX100: 8_000 }]), data([req({ minutesInPeriod: 960, dates: ["2026-10-27", "2026-10-28"] })]));
    expect(f).toMatchObject({ rule: "PENDING_TIME_OFF_IN_PERIOD", severity: "review" });
    expect(f!.message).toContain("2026-10-27 to 2026-10-28, 16.00 h");
    expect(f!.message).toContain("approval adds 16.00 h of paid leave");
  });

  it("a blocked or unpaid pending request cannot move gross, so it is info even for hourly workers", () => {
    const hourly = paycheck("hourly", [{ type: "regular", amountCents: 240_000, hoursX100: 8_000 }]);
    const [blocked] = timeOffFlags(hourly, data([req({ blocking: ["WAITING_PERIOD"], policyName: "California sick leave" })]));
    expect(blocked).toMatchObject({ severity: "info" });
    expect(blocked!.message).toContain("blocked by WAITING_PERIOD");
    const [unpaid] = timeOffFlags(hourly, data([req({ paid: false, typeKind: "unpaid_sick" })]));
    expect(unpaid).toMatchObject({ severity: "info" });
    expect(unpaid!.message).toContain("unpaid leave");
  });

  it("only the paycheck's own worker is flagged", () => {
    expect(timeOffFlags(paycheck("hourly", [], "wrk_0031"), data([req({})]))).toEqual([]);
  });
});
