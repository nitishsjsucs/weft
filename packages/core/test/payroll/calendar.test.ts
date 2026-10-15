import { describe, expect, it } from "vitest";
import { ptToUtc, semimonthlyRunDates, workingDays, runIdForPayday, nextSemimonthlyPeriodEnd, semimonthlyPeriodsThrough } from "../../src/payroll/calendar";

describe("semi-monthly calendar (SPEC 5.1, 5.5)", () => {
  it("matches the seeded runs", () => {
    expect(semimonthlyRunDates("2026-09-15").payday).toBe("2026-09-15");
    expect(semimonthlyRunDates("2026-09-30").payday).toBe("2026-09-30");
    expect(semimonthlyRunDates("2026-10-15").payday).toBe("2026-10-15");
    const oct30 = semimonthlyRunDates("2026-10-31");
    expect(oct30).toEqual({ periodStart: "2026-10-16", periodEnd: "2026-10-31", payday: "2026-10-30", approvalDeadline: "2026-10-29T00:00:00.000Z", settleAt: "2026-10-30T13:00:00.000Z" });
    expect(runIdForPayday(oct30.payday)).toBe("pay_2026_10_30");
  });
  it("Nov 1 to 15 pays on Friday Nov 13 in PST", () => {
    const nov = semimonthlyRunDates("2026-11-15");
    expect(nov.payday).toBe("2026-11-13");
    expect(nov.settleAt).toBe("2026-11-13T14:00:00.000Z");
    expect(nov.approvalDeadline).toBe("2026-11-12T01:00:00.000Z");
    expect(nextSemimonthlyPeriodEnd("2026-10-31")).toBe("2026-11-15");
  });
  it("counts working days for proration", () => {
    expect(workingDays("2026-10-16", "2026-10-31")).toBe(11);
    expect(workingDays("2026-10-16", "2026-10-23")).toBe(6);
    expect(workingDays("2026-10-19", "2026-10-31")).toBe(10);
    expect(ptToUtc("2026-03-08", 6)).toBe("2026-03-08T13:00:00.000Z");
    expect(ptToUtc("2026-03-07", 6)).toBe("2026-03-07T14:00:00.000Z");
    expect(semimonthlyPeriodsThrough(2026, "2026-08-31")).toHaveLength(16);
  });
});
