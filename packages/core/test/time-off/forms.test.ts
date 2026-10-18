// Time-off amounts in the forms people ask for (fix group read-figures): minutes, hours and 8-hour days, rounded to
// two places, and request totals per worker and policy.
import { describe, expect, it } from "vitest";
import { balanceForms, daysOf, hoursOf, REQUEST_TOTALS_BY, requestBalance, requestTotals, timeForms, workerRef } from "../../src/time-off/forms";

describe("time-off forms", () => {
  it("converts minutes to hours and days of 480 minutes, two decimals", () => {
    expect([hoursOf(3_293), daysOf(3_293)]).toEqual([54.88, 6.86]);
    expect([hoursOf(5_340), daysOf(5_340)]).toEqual([89, 11.13]);
    expect([hoursOf(240), daysOf(240)]).toEqual([4, 0.5]);
    expect([hoursOf(0), daysOf(0)]).toEqual([0, 0]);
    expect(timeForms("requested", 1_440)).toEqual({ requested_hours: 24, requested_days: 3 });
  });

  it("gives a balance's available, used and held amounts in hours and days", () => {
    expect(balanceForms({ availableMinutes: 5_340, usedMinutes: 480, holdsMinutes: 1_440 })).toEqual({
      available_hours: 89, available_days: 11.13, used_hours: 8, used_days: 1, holds_hours: 24, holds_days: 3,
    });
  });

  it("gives a request's policy balance before and after it from today's available and what the request holds", () => {
    expect(requestBalance(5_340, 1_440)).toEqual({ balance_before_request: { minutes: 6_780, hours: 113, days: 14.13 }, balance_after_request: { minutes: 5_340, hours: 89, days: 11.13 } });
    expect(requestBalance(960, 0)).toEqual({ balance_before_request: { minutes: 960, hours: 16, days: 2 }, balance_after_request: { minutes: 960, hours: 16, days: 2 } });
  });

  it("totals requests overall, and per worker and policy only when asked, largest first", () => {
    const rows = [
      { workerId: "wrk_1", policyId: "top_vac", requestedMinutes: 1_440 },
      { workerId: "wrk_2", policyId: "top_sick", requestedMinutes: 240 },
      { workerId: "wrk_1", policyId: "top_sick", requestedMinutes: 480 },
    ];
    const name = (id: string) => `W ${id}`, policy = (id: string) => `P ${id}`;
    expect(requestTotals(rows, [], name, policy)).toEqual({ totals: { count: 3, requested_minutes: 2_160, requested_hours: 36, requested_days: 4.5 } });
    const t = requestTotals(rows, [...REQUEST_TOTALS_BY], name, policy);
    expect(t.by_worker).toEqual([
      { worker: "W wrk_1", count: 2, requested_minutes: 1_920, requested_hours: 32, requested_days: 4 },
      { worker: "W wrk_2", count: 1, requested_minutes: 240, requested_hours: 4, requested_days: 0.5 },
    ]);
    expect(t.by_policy).toEqual([
      { policy: "P top_vac", count: 1, requested_minutes: 1_440, requested_hours: 24, requested_days: 3 },
      { policy: "P top_sick", count: 2, requested_minutes: 720, requested_hours: 12, requested_days: 1.5 },
    ]);
  });

  it("names a worker with the demo marker and the short id", () => {
    expect(workerRef({ id: "wrk_0010", firstName: "Ruth", lastName: "Okoro", preferredName: null })).toBe("Ruth Okoro (demo) (wrk_0010)");
  });
});
