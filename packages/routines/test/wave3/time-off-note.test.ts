// The rt_time_off_requests proposal note names the balance figures for what they hold (review fix group
// expense-and-timeoff): the balance now, with every open request on the policy counted, and the balance without this
// request. With a second pending request on the policy, "before this request" would have been wrong for the older one.
import { describe, expect, it } from "vitest";
import { decisionNote } from "../../src/wave3/time-off";

const base = {
  id: "tor_0003", workerId: "wrk_0010", workerName: "Ruth Okoro", departmentId: "dpt_hardware", policyId: "top_vac_us", policyName: "Larkspur Vacation",
  typeKind: "vacation", status: "pending", startAt: "2026-11-23", endAt: "2026-11-27", requestedMinutes: 1_440, approverPrincipalId: "usr_imani",
  days: [{ date: "2026-11-26", minutes: 0, holiday: true }], checks: [],
};

describe("rt_time_off_requests decision note", () => {
  it("states the balance now and without this request, from the read's fields", () => {
    // A second pending request of 960 minutes on the same policy: the balance now counts both holds (4,380 minutes),
    // and this request's balance without it adds back only its own 1,440.
    const note = decisionNote({ ...base, balance_now: { minutes: 4_380 }, balance_without_this_request: { minutes: 5_820 } });
    expect(note).toBe("Larkspur Vacation available 73.00 h now with every open request counted, 97.00 h without this request. company holidays 2026-11-26 are charged 0 h");
    expect(note).not.toMatch(/before|after/);
  });

  it("leaves the balance out when the read has none", () => {
    expect(decisionNote({ ...base, balance_now: null, balance_without_this_request: null })).toBe("company holidays 2026-11-26 are charged 0 h");
  });
});
