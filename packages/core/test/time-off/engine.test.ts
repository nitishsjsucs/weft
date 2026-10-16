// The hand-computed time-off cases T1 to T19 (research/wave3/expenses-timeoff.md 9.1). Minutes unless stated; money
// in cents; rates per hour are annual / 2,080. T13 and T14 are also pinned in test/offboarding/offcycle.test.ts and
// T18 and T19 end to end in apps/api/test/time-off.test.ts; here they run on the pure rules.
import { describe, expect, it } from "vitest";
import {
  applyCaps, availableOn, balanceOf, coverageDays, deemedWorkedMinutes, finalVacationMinutes, forfeitureProblem, perHourWorked, perPeriodMinutes, requestChecks,
  requestDays, serviceMonths, yearEndCarry, type CheckInput,
} from "../../src/time-off/engine";
import { leaveMinutes, timeOffEarnings, type TimeOffPayrollInputs } from "../../src/time-off/payroll";
import { projectAvailable, type PolicyRow } from "../../src/time-off/store";
import { validatePolicy } from "../../src/commands/time-off";
import type { PayRateRow, PeriodSpec, WorkerRow } from "../../src/payroll/compute";

const TIERS = [{ min_service_months: 0, minutes_per_period: 300 }, { min_service_months: 36, minutes_per_period: 360 }];
const HOLIDAYS = new Map([["2026-11-26", "Thanksgiving Day"], ["2026-11-27", "Day after Thanksgiving"]]);
const vacPolicy = { id: "top_vac_us", schedule: "per_pay_period", minutesPerPeriod: 300, tiersJson: JSON.stringify(TIERS) } as PolicyRow;
const baseCheck: CheckInput = {
  typeKind: "vacation", today: "2026-10-26", startDate: "2026-11-23", days: [], requestedMinutes: 0, projectedAvailable: 0, locked: null, usedThisYear: 0,
  annualUseCap: null, minIncrement: 60, partialDayMinutes: null, coverage: null, requestId: "tor_0003", deadlineOverlap: [],
};

describe("accruals", () => {
  it("T1 per-period accrual by service tier", () => {
    expect(serviceMonths("2025-04-30", "2026-10-30")).toBe(18);
    const m = perPeriodMinutes(300, TIERS, 18);
    expect(m).toBe(300);
    expect(4_800 + applyCaps(m, { balance: 4_800, cap: 10_800, accruedThisYear: 0, annualCap: null }).posted).toBe(5_100);
    expect(perPeriodMinutes(300, TIERS, serviceMonths("2023-04-03", "2026-10-31"))).toBe(360);   // Imani, 42 months
  });
  it("T2 accrual cap posts the remainder and notes the capped part", () => {
    expect(applyCaps(300, { balance: 10_650, cap: 10_800, accruedThisYear: 0, annualCap: null })).toEqual({ posted: 150, capped: 150 });
    expect(applyCaps(300, { balance: 10_800, cap: 10_800, accruedThisYear: 0, annualCap: null })).toEqual({ posted: 0, capped: 300 });
  });
  it("T3 per hour worked, salaried exempt, three full periods carry the remainder", () => {
    const full = deemedWorkedMinutes({ periodStart: "2026-11-01", periodEnd: "2026-11-15" }, "2024-01-01", null);
    expect(full).toBe(5_200);
    const a = perHourWorked(0, full), b = perHourWorked(a.remainder, full), c = perHourWorked(b.remainder, full);
    expect([a, b, c]).toEqual([{ minutes: 173, remainder: 10 }, { minutes: 173, remainder: 20 }, { minutes: 174, remainder: 0 }]);
    expect(a.minutes + b.minutes + c.minutes).toBe(520);
  });
  it("T4 per hour worked, hourly", () => {
    expect(perHourWorked(0, 7_200)).toEqual({ minutes: 240, remainder: 0 });
  });
  it("T5 CO new hire, partial period", () => {
    const worked = deemedWorkedMinutes({ periodStart: "2026-11-01", periodEnd: "2026-11-15" }, "2026-11-02", null);
    expect(worked).toBe(4_800);
    expect(perHourWorked(0, worked).minutes).toBe(160);
  });
  it("T6 HFWA annual accrual cap", () => {
    expect(applyCaps(173, { balance: 2_800, cap: null, accruedThisYear: 2_800, annualCap: 2_880 })).toEqual({ posted: 80, capped: 93 });
  });
});

describe("requests and checks", () => {
  it("T7 request minutes skip weekends and charge holidays 0", () => {
    const r = requestDays("2026-11-23", "2026-11-27", HOLIDAYS);
    expect(r.days).toHaveLength(5);
    expect(r.days.filter((d) => d.holiday).map((d) => d.minutes)).toEqual([0, 0]);
    expect(r.minutes).toBe(1_440);
  });
  it("T8 coverage: 3 of 9 is 33.3% over 30% on Nov 23 to 25; holidays not counted; 37.5% without Noor", () => {
    const days = requestDays("2026-11-23", "2026-11-27", HOLIDAYS).days;
    const ra = requestDays("2026-11-23", "2026-11-25", HOLIDAYS).days;
    const out = [{ workerId: "wrk_0008", requestId: "tor_0001", status: "approved", days: ra }, { workerId: "wrk_0009", requestId: "tor_0002", status: "approved", days: ra }, { workerId: "wrk_0010", requestId: "tor_0003", status: "pending", days }];
    const dates = days.map((d) => d.date);
    const nine = coverageDays({ dates, headcountOn: () => 9, holidays: HOLIDAYS, out, maxOutPct: 30, minPresent: 2 });
    expect(nine.map((d) => [d.outPct, d.overLimit])).toEqual([[33.3, true], [33.3, true], [33.3, true], [0, false], [0, false]]);
    const checks = requestChecks({ ...baseCheck, days, requestedMinutes: 1_440, projectedAvailable: 5_000, coverage: nine });
    const cov = checks.find((c) => c.rule === "COVERAGE_CONFLICT")!;
    expect(cov.severity).toBe("review");
    expect(cov.evidence.filter((e) => e.label === "also out").map((e) => e.ref)).toEqual(["tor_0001", "tor_0002"]);
    expect(checks.find((c) => c.rule === "INCLUDES_HOLIDAY")?.severity).toBe("info");
    const eight = coverageDays({ dates, headcountOn: () => 8, holidays: HOLIDAYS, out, maxOutPct: 30, minPresent: 2 });
    expect(eight[0]).toMatchObject({ outPct: 37.5, overLimit: true });
  });
  it("T9 balance check against the projected balance at the start date", () => {
    // One accrual of 300 is paid between the check and the start (the Nov 15 run, payday Fri Nov 13).
    const w = { startDate: "2025-04-01", endDate: null } as WorkerRow;
    expect(projectAvailable(1_200, vacPolicy, w, "2026-10-31", "2026-11-23")).toBe(1_500);
    expect(requestChecks({ ...baseCheck, requestedMinutes: 1_440, projectedAvailable: 1_500 }).some((c) => c.rule === "INSUFFICIENT_BALANCE")).toBe(false);
    expect(projectAvailable(1_000, vacPolicy, w, "2026-10-31", "2026-11-23")).toBe(1_300);
    expect(requestChecks({ ...baseCheck, requestedMinutes: 1_440, projectedAvailable: 1_300 }).find((c) => c.rule === "INSUFFICIENT_BALANCE")?.severity).toBe("block");
  });
  it("T10 CA sick waiting period: day 28 of 90 blocks and the accrual shows as locked", () => {
    const b = balanceOf({ workerId: "wrk_0021", policyId: "top_sick_ca", typeKind: "sick", asOf: "2026-10-28", rows: [{ kind: "import", minutes: 176, effectiveDate: "2026-10-15" }], startDate: "2026-10-01", waitingDays: 90 });
    expect(b).toMatchObject({ accruedUnlockedMinutes: 0, accruedLockedMinutes: 176, availableMinutes: 0 });
    const checks = requestChecks({ ...baseCheck, typeKind: "sick", startDate: "2026-10-28", requestedMinutes: 480, locked: { until: "2026-12-30" } });
    expect(checks.map((c) => [c.rule, c.severity])).toEqual([["WAITING_PERIOD", "block"]]);   // no short notice for sick leave
  });
  it("T10b a request filed inside the wait for a date after the unlock counts the locked accrual", () => {
    const b = balanceOf({ workerId: "wrk_0021", policyId: "top_sick_ca", typeKind: "sick", asOf: "2026-12-20", rows: [{ kind: "import", minutes: 1_040, effectiveDate: "2026-12-15" }], startDate: "2026-10-01", waitingDays: 90 });
    expect(b).toMatchObject({ accruedLockedMinutes: 1_040, availableMinutes: 0 });
    expect(availableOn(b, "2027-01-04", "2026-12-30")).toBe(1_040);
    expect(availableOn(b, "2026-12-22", "2026-12-30")).toBe(0);
    const checks = requestChecks({ ...baseCheck, typeKind: "sick", today: "2026-12-20", startDate: "2027-01-04", requestedMinutes: 480, projectedAvailable: availableOn(b, "2027-01-04", "2026-12-30") });
    expect(checks.filter((c) => c.severity === "block")).toEqual([]);
  });
  it("blocks a use cap overrun and a partial day under the minimum increment", () => {
    const checks = requestChecks({ ...baseCheck, typeKind: "sick", requestedMinutes: 30, projectedAvailable: 600, usedThisYear: 2_400, annualUseCap: 2_400, partialDayMinutes: 30 });
    expect(checks.map((c) => c.rule)).toEqual(["USE_CAP", "INCREMENT"]);
  });
});

describe("payroll lines", () => {
  const period: PeriodSpec = { companyId: "cmp_larkspur", payScheduleId: "ps_us_semimonthly", periodStart: "2026-11-16", periodEnd: "2026-11-30", payday: "2026-11-30" };
  const w = { id: "wrk_0009", startDate: "2024-05-20", endDate: null, type: "employee" } as WorkerRow;
  const inputs: TimeOffPayrollInputs = { approved: [{ workerId: "wrk_0009", kind: "pto", days: requestDays("2026-11-23", "2026-11-25", HOLIDAYS).days }], holidays: [{ date: "2026-11-26", minutes: 480 }, { date: "2026-11-27", minutes: 480 }] };
  it("T11 salaried: gross unchanged, split into salary, pto and paid_holiday at annual / 2,080", () => {
    const rate = { kind: "salary", amountCents: 13_200_000 } as PayRateRow;
    expect(leaveMinutes(w, period, inputs)).toEqual({ pto: 1_440, sick: 0, paid_holiday: 960 });
    const out = timeOffEarnings(w, rate, [{ type: "salary", amountCents: 550_000, hoursX100: null }], period, inputs);
    expect(out).toEqual([
      { type: "salary", amountCents: 296_154, hoursX100: null }, { type: "pto", amountCents: 152_308, hoursX100: 2_400 }, { type: "paid_holiday", amountCents: 101_538, hoursX100: 1_600 },
    ]);
    expect(out.reduce((s, e) => s + e.amountCents, 0)).toBe(550_000);
  });
  it("T12 hourly: holiday hours are a line on top of the worked hours", () => {
    const tech = { id: "wrk_0044", startDate: "2024-06-17", endDate: null, type: "employee" } as WorkerRow;
    const rate = { kind: "hourly", amountCents: 3_000 } as PayRateRow;
    const out = timeOffEarnings(tech, rate, [{ type: "regular", amountCents: 212_010, hoursX100: 7_067 }], period, { approved: [], holidays: inputs.holidays });
    expect(out).toEqual([{ type: "regular", amountCents: 212_010, hoursX100: 7_067 }, { type: "paid_holiday", amountCents: 48_000, hoursX100: 1_600 }]);
    expect(out.reduce((s, e) => s + e.amountCents, 0)).toBe(260_010);
  });
});

describe("separation and year end", () => {
  it("T13 final pay from the ledger: 5,119 plus floor(300 x 15 / 16) = 5,400 minutes", () => {
    expect(finalVacationMinutes(5_119, 300, { periodStart: "2026-10-16", periodEnd: "2026-10-31" }, "2026-10-30")).toEqual({ minutes: 5_400, prorated: 281, advanceNotRecovered: false });
    expect(finalVacationMinutes(5_063, 360, { periodStart: "2026-10-16", periodEnd: "2026-10-31" }, "2026-10-30").minutes).toBe(5_400);   // Imani in the seed
  });
  it("T14 a negative balance pays nothing and is never deducted", () => {
    expect(finalVacationMinutes(-480, 0, { periodStart: "2026-10-16", periodEnd: "2026-10-31" }, "2026-10-30")).toEqual({ minutes: 0, prorated: 0, advanceNotRecovered: true });
  });
  it("T15 sick is never paid out (only vacation-kind policies with payout reach final pay)", () => {
    expect(forfeitureProblem({ jurisdiction: "CA", typeKind: "sick", accrualCapMinutes: 4_800, carryoverCapMinutes: 0 })).toBeNull();
    // The final pay loader selects counts_as_vacation and pay_out_at_separation policies only (store.vacationPosition).
  });
  it("T16 year-end carryover", () => {
    expect(yearEndCarry(3_120, 2_400)).toEqual({ carry: 2_400, forfeit: 720 });
    expect(yearEndCarry(9_000, null)).toEqual({ carry: 9_000, forfeit: 0 });
    expect(yearEndCarry(1_920, 0)).toEqual({ carry: 0, forfeit: 1_920 });
  });
  it("T17 a CA vacation policy that would forfeit is refused", () => {
    expect(() => validatePolicy({ jurisdiction: "CA", typeKind: "vacation", accrualCapMinutes: 10_800, carryoverCapMinutes: 2_400 })).toThrowError(/cannot forfeit/);
    try { validatePolicy({ jurisdiction: "CA", typeKind: "vacation", accrualCapMinutes: 10_800, carryoverCapMinutes: 2_400 }); } catch (e) { expect((e as { code: string }).code).toBe("DOMAIN_FORFEITURE_NOT_ALLOWED"); }
    expect(() => validatePolicy({ jurisdiction: "TX", typeKind: "vacation", accrualCapMinutes: 10_800, carryoverCapMinutes: 2_400 })).not.toThrow();
  });
});
