// Off-cycle and final pay arithmetic (wave 2, w2-offboarding), exact to the cent on synthetic inputs.
import { describe, expect, it } from "vitest";
import { calculatePaycheck, federalIncomeTax, TAX_2026, type PaycheckInput } from "@weft/payroll-tax";
import { calendarDays, finalPayEarnings, proratedHourlyLines, proratedSalaryLines, unusedPtoHoursX100 } from "../../src/payroll/offcycle";
import type { PayRateRow, WorkerRow } from "../../src/payroll/compute";

const rate = (id: string, amountCents: number, effectiveFrom: string, effectiveTo: string | null = null, kind = "salary"): PayRateRow =>
  ({ id, workerId: "wrk_0001", kind, amountCents, currency: "USD", effectiveFrom, effectiveTo, createdActionSeq: null });
const worker = { id: "wrk_0001", startDate: "2024-03-04", endDate: null } as WorkerRow;
const W4 = { version: "2020", filingStatus: "single", step2Checkbox: false, step3Cents: 0, step4aCents: 0, step4bCents: 0, step4cCents: 0, allowances: 0, exempt: false } as const;

describe("off-cycle proration by calendar days", () => {
  it("splits a mid-period raise into one line per rate, one half-up rounding each", () => {
    // Oct 16 to 31 is 16 calendar days; the raise from $120,000.00 to $130,000.00 takes effect Oct 21.
    const rates = [rate("prt_old", 12_000_000, "2025-01-01", "2026-10-20"), rate("prt_new", 13_000_000, "2026-10-21")];
    const lines = proratedSalaryLines(worker, rates, "2026-10-16", "2026-10-31");
    expect(calendarDays("2026-10-16", "2026-10-31")).toBe(16);
    // 12,000,000 / 24 x 5 / 16 = 156,250 exactly; 13,000,000 / 24 x 11 / 16 = 372,395.833... -> 372,396.
    expect(lines.map((l) => [l.type, l.amountCents])).toEqual([["salary", 156_250], ["salary", 372_396]]);
    expect(lines[0]!.note).toBe("5 of 16 days, 2026-10-16 to 2026-10-20, at $120,000.00 a year");
    expect(lines[1]!.note).toBe("11 of 16 days, 2026-10-21 to 2026-10-31, at $130,000.00 a year");
  });

  it("pays a full period at one rate as one line", () => {
    const lines = proratedSalaryLines(worker, [rate("prt_a", 11_750_000, "2025-01-01")], "2026-10-01", "2026-10-15");
    expect(lines.map((l) => l.amountCents)).toEqual([489_583]);   // 11,750,000 / 24 = 489,583.33
  });

  it("splits an hourly period's regular and overtime hours by calendar days between the two rates", () => {
    // Oct 1 to 15 is 15 days; $31.17 an hour through Oct 5, $33.33 from Oct 6; 81.50 regular and 5.00 overtime hours.
    const rates = [rate("prt_h1", 3_117, "2025-01-01", "2026-10-05", "hourly"), rate("prt_h2", 3_333, "2026-10-06", null, "hourly")];
    const lines = proratedHourlyLines(worker, rates, "2026-10-01", "2026-10-15", 8_150, 500);
    // 3,117 x 81.50 x 5/15 = 84,678.5 -> 84,679; 3,117 x 1.5 x 5.00 x 5/15 = 7,792.5 -> 7,793;
    // 3,333 x 81.50 x 10/15 = 181,093; 3,333 x 1.5 x 5.00 x 10/15 = 16,665.
    expect(lines.map((l) => [l.type, l.amountCents, l.hoursX100])).toEqual([
      ["regular", 84_679, 2_717], ["overtime", 7_793, 167], ["regular", 181_093, 5_433], ["overtime", 16_665, 333],
    ]);
    expect(lines[0]!.note).toBe("5 of 15 days, 2026-10-01 to 2026-10-05, 27.17 h at $31.17 an hour");
  });

  it("taxes the bonus at the federal flat 22 percent and the salary by the regular method", () => {
    const salary = 156_250 + 372_396;
    const input: PaycheckInput = {
      payDate: "2026-11-02", payPeriodsPerYear: 24, jurisdiction: "TX",
      earnings: [{ type: "salary", amount_cents: 156_250, hours_x100: null }, { type: "salary", amount_cents: 372_396, hours_x100: null }, { type: "supplemental", amount_cents: 250_000, hours_x100: null }],
      pretax: [], posttax: [], reimbursements_cents: 0, w4: W4, state: { filingStatus: null, allowances: 0 }, ytd: {},
      employerRates: { sui: null, ett: null }, supplementalCents: 250_000,
    };
    const calc = calculatePaycheck(input, TAX_2026);
    const regular = federalIncomeTax({ fitWagesCents: salary, periods: 24, w4: W4, supplemental: false, ytdSupplementalCents: 0 }, TAX_2026).amountCents;
    const fit = calc.taxes.find((t) => t.code === "fit")!;
    expect(fit.taxable_wages_cents).toBe(salary + 250_000);
    expect(fit.amount_cents).toBe(regular + 55_000);   // 250,000 x 0.22 = 55,000 exactly
    expect(calc.ytdDeltas.supplemental).toBe(250_000);
    // Without supplementalCents the same paycheck is the unchanged aggregate path.
    const aggregate = calculatePaycheck({ ...input, supplementalCents: undefined }, TAX_2026);
    expect(aggregate.taxes.find((t) => t.code === "fit")!.amount_cents).toBe(federalIncomeTax({ fitWagesCents: salary + 250_000, periods: 24, w4: W4, supplemental: false, ytdSupplementalCents: 0 }, TAX_2026).amountCents);
    expect(aggregate.ytdDeltas.supplemental).toBeUndefined();
  });
});

describe("final pay", () => {
  it("counts unused PTO as whole calendar months in the year, 10 hours each, capped at 120", () => {
    expect(unusedPtoHoursX100("2024-03-04", "2026-10-30")).toBe(9_000);   // Jan to Sep
    expect(unusedPtoHoursX100("2024-03-04", "2026-10-31")).toBe(10_000);  // Oct complete too
    expect(unusedPtoHoursX100("2026-06-15", "2026-10-30")).toBe(3_000);   // Jul, Aug, Sep
    expect(unusedPtoHoursX100("2026-10-20", "2026-10-30")).toBe(0);
  });

  it("prorates the last period by working days and pays PTO at salary / 2,080", () => {
    const out = finalPayEarnings(worker, [rate("prt_a", 23_200_000, "2025-01-01")], "2026-10-30", true, null);
    expect(out.period).toEqual({ periodStart: "2026-10-16", periodEnd: "2026-10-31" });
    // Oct 16 to 30 has 11 working days and Oct 16 to 31 has 11 (Oct 31 is a Saturday): the full 23,200,000 / 24.
    expect(out.earnings.map((e) => [e.type, e.amountCents, e.hoursX100])).toEqual([["salary", 966_667, null], ["pto_payout", 1_003_846, 9_000]]);
    // 23,200,000 / 2,080 x 90 = 1,003,846.15 -> 1,003,846.
    const noPto = finalPayEarnings(worker, [rate("prt_a", 23_200_000, "2025-01-01")], "2026-10-21", false, null);
    expect(noPto.earnings.map((e) => [e.type, e.amountCents])).toEqual([["salary", 351_515]]);   // Oct 16, 19, 20, 21: 4 of 11 working days, 966,666.67 x 4 / 11 = 351,515.15
  });
});
