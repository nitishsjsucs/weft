// Server text as copy (display only; the stored text never changes): the chart step line keeps both ends of its range
// as dates, coverage and policy checks read their dates as days, and the notice run's lines, summary and diff carry
// no row ids or enum values.
import { describe, expect, it } from "vitest";
import { humanDates } from "../src/components/app/format";
import { enumWords, humanDateLists, humanDateText, humanLine } from "../src/components/app/copy";

describe("humanDates before a colon", () => {
  it("formats a date followed by a colon and keeps the year on the other end of the range", () => {
    expect(humanDates("Payroll cost by month, 2025-11-01 to 2026-10-26: 10 months with paid runs"))
      .toBe("Payroll cost by month, Nov 1, 2025 to Oct 26: 10 months with paid runs");
    expect(humanDates("2025-11-01 to 2026-10-26: 10 months")).toBe("Nov 1, 2025 to Oct 26: 10 months");
  });
  it("still leaves instants and ids alone", () => {
    expect(humanDates("at 2026-10-26T10:00 and 2026-10-26:09")).toBe("at 2026-10-26T10:00 and 2026-10-26:09");
    expect(humanDates("pay_2026_10_30 and x-2026-10-30")).toBe("pay_2026_10_30 and x-2026-10-30");
  });
});

describe("date lists", () => {
  it("a run of days reads as a range, other lists as a list", () => {
    expect(humanDateLists("on 2026-11-23, 2026-11-24, 2026-11-25")).toBe("on Nov 23 to Nov 25");
    expect(humanDateLists("on 2026-11-23, 2026-11-25")).toBe("on Nov 23 and Nov 25");
    expect(humanDateLists("on 2025-12-31, 2026-01-01, 2026-01-02")).toBe("on Dec 31, 2025 to Jan 2");
  });
  it("the coverage check on a time-off request and the lodging check on an expense", () => {
    expect(humanDateText("3 of 9 out (33.3%) on 2026-11-23, 2026-11-24, 2026-11-25")).toBe("3 of 9 out (33.3%) on Nov 23 to Nov 25");
    expect(humanDateText("Lodging $289.00 is over the standard $113.00 night rate for 2026-10-15")).toBe("Lodging $289.00 is over the standard $113.00 night rate for Oct 15");
  });
});

describe("humanLine", () => {
  it("the notice run's step lines name the notice, not its id", () => {
    expect(humanLine("Drafted response 1 for ntc_0005")).toBe("Drafted response 1 for the notice");
    expect(humanLine("File response 1 to DE 2088 notice ntc_0005 with CA EDD (sim)")).toBe("File response 1 to DE 2088 notice with CA EDD (sim)");
  });
  it("the routine summary drops proposal ids and action numbers", () => {
    expect(humanLine("Proposed Set CA SUI to 1.5% from 2027-01-01 (prp_0021); Proposed File response 1 to DE 2088 notice ntc_0005 with CA EDD (sim) (prp_0022); Drafted response 1 for ntc_0005 (#228)"))
      .toBe("Proposed Set CA SUI to 1.5% from Jan 1; Proposed File response 1 to DE 2088 notice with CA EDD (sim); Drafted response 1 for the notice");
  });
  it("a payroll run id reads as its payday; unknown ids and plain words stay", () => {
    expect(humanLine("pay_2026_10_15")).toBe("the Oct 15 run");
    expect(humanLine("Submitted pay_2026_10_30: 47 paychecks")).toBe("Submitted the Oct 30 run: 47 paychecks");
    expect(humanLine("3 of 9 out (33.3%), GROSS_CHANGE stays, zzz_0001 stays")).toBe("3 of 9 out (33.3%), GROSS_CHANGE stays, zzz_0001 stays");
  });
});

describe("enumWords", () => {
  it("stored enum values read as words", () => {
    expect(enumWords("in_review to resolved")).toBe("in review to resolved");
    expect(enumWords("3.4% to 1.5%")).toBe("3.4% to 1.5%");
    expect(enumWords("Ada_Lovelace@x.example")).toBe("Ada_Lovelace@x.example");
  });
});
