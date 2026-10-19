// Server text as copy (display only; the stored text never changes): the chart step line keeps both ends of its range
// as dates, coverage and policy checks read their dates as days, and the notice run's lines, summary and diff carry
// no row ids or enum values.
import { describe, expect, it } from "vitest";
import { humanDates } from "../src/components/app/format";
import { answerText, auditLabel, enumWords, humanDateLists, humanDateText, humanLine, noticeName, routineSummaryText, stepLine } from "../src/components/app/copy";

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
    expect(humanLine("Drafted response 1 for ntc_0005")).toBe("Drafted the reply to the notice");
    expect(humanLine("File response 1 to DE 2088 notice ntc_0005 with CA EDD (sim)")).toBe("File the reply to the DE 2088 notice with CA EDD (sim)");
  });
  it("the routine summary drops proposal ids and action numbers", () => {
    expect(humanLine("Proposed Set CA SUI to 1.5% from 2027-01-01 (prp_0021); Proposed File response 1 to DE 2088 notice ntc_0005 with CA EDD (sim) (prp_0022); Drafted response 1 for ntc_0005 (#228)"))
      .toBe("Proposed Set CA SUI to 1.5% from Jan 1; Proposed File the reply to the DE 2088 notice with CA EDD (sim); Drafted the reply to the notice");
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

describe("notice and audit labels", () => {
  it("names a notice by its form, without doubling a form code that is already a phrase", () => {
    expect(noticeName("DE 2088")).toBe("DE 2088 notice");
    expect(noticeName("UI rate notice")).toBe("UI rate notice");
    expect(noticeName("Rate Notice")).toBe("Rate Notice");
    expect(noticeName(null)).toBe("Agency notice");
  });
  it("one label for an audit row everywhere", () => {
    expect(auditLabel(229)).toBe("audit #229");
  });
});

describe("audit and step lines carry no ids, codes or file names", () => {
  it("names offers, mentions, rates, tax accounts, agencies, systems and delivered notices", () => {
    expect(humanLine("Recorded mention mnt_0001 in #payroll")).toBe("Recorded a mention in #payroll");
    expect(humanLine("Accepted offer offr_0001: created Noor Castellanos (demo) (wrk_0063) (EMP-0056) as onboarding")).toBe("Accepted offer: created Noor Castellanos (demo) (EMP-0056) as onboarding");
    expect(humanLine("Reverted CA SUI rate etr_0005 to 3.4%")).toBe("Reverted CA SUI rate to 3.4%");
    expect(humanLine("Register CO withholding account with CO DOR (sim) (txa_0006)")).toBe("Register CO withholding account with CO DOR (sim)");
    expect(humanLine("Delivered CA_EDD_DE2088_2026.txt from ca_edd as ntc_0005")).toBe("Delivered the DE 2088 notice from CA EDD (sim)");
    expect(humanLine("Filed DE9 for 2026-Q2 with ca_edd (sim); accepted")).toBe("Filed DE9 for 2026-Q2 with CA EDD (sim); accepted");
    expect(humanLine("Created google_ws account noor.castellanos for Noor Castellanos (demo) (wrk_0063)")).toBe("Created Google Workspace account noor.castellanos for Noor Castellanos (demo)");
    expect(humanLine("Approved 8 h of vacation for Talia Brennan (demo) (tor_0148)")).toBe("Approved 8 h of vacation for Talia Brennan (demo)");
    expect(humanLine("Order Larkspur standard laptop (sim) for Elias Brandt (demo) (wrk_0054) at $1,899.00")).toBe("Order Larkspur standard laptop (sim) for Elias Brandt (demo) at $1,899.00");
    expect(humanLine("Approve expense exp_0001 for Mateo Alvarez (demo) (wrk_0005): $412.38 travel on 2026-10-12")).toBe("Approve expense for Mateo Alvarez (demo): $412.38 travel on Oct 12");
  });
  it("step lines read as sentences", () => {
    expect(stepLine("Found 1 workers")).toBe("Found 1 worker");
    expect(stepLine("1 actions for people.set_pay_rate")).toBe("Found 1 set pay rate action");
    expect(stepLine("pay_2026_10_30 (draft): 48 paychecks, 4 need review, 1 blocked")).toBe("The Oct 30 run (draft): 48 paychecks, 4 need review, 1 blocked");
    expect(stepLine("Explanations for pay_2026_10_30: 4 agent, 0 template, 0 refused")).toBe("Explained 4 flagged paychecks");
    expect(stepLine("Explanations for pay_2026_10_30: 3 agent, 0 template, 1 refused")).toBe("Explained 3 flagged paychecks; 1 could not be explained");
    expect(stepLine("Drafted response 1 for ntc_0005")).toBe("Drafted the reply to the notice");
  });
  it("a routine summary reads as a short list in run order", () => {
    expect(routineSummaryText("Proposed Update CA SUI rate 3.4% to 1.5% effective Jan 1, 2026 (prp_0021); Proposed File response 1 to DE 2088 notice ntc_0005 with CA EDD (sim) (prp_0022); Drafted response 1 for ntc_0005 (#228)"))
      .toBe("Drafted the reply to the notice. Proposed: file the reply to the DE 2088 notice with CA EDD (sim); update CA SUI rate 3.4% to 1.5% effective Jan 1, 2026.");
    expect(routineSummaryText("Nothing")).toBe("Nothing");
  });
});

describe("chat answers at display", () => {
  it("moves cited result ids into sources and words ids, codes and action numbers", () => {
    const a = answerText("The NY raise is flagged for Lena Brooks (wrk_0026) under the `GROSS_CHANGE` rule. Pay rate `prt_0052` took effect **2026-10-16**, recorded by action sequence 1, result `res_0001`.");
    expect(a.sources).toEqual(["res_0001"]);
    expect(a.text).toBe("The NY raise is flagged for Lena Brooks under the gross change rule. Pay rate took effect Oct 16, recorded as audit #1.");
    const b = answerText("Imani should review Ruth Okoro's (wrk_0010) request. Source: `tor_0003`, result `res_0270`.");
    expect(b).toEqual({ text: "Imani should review Ruth Okoro's request.", sources: ["res_0270"] });
    expect(answerText("1 blocked paycheck for missing bank information (pay_2026_10_30).").text).toBe("1 blocked paycheck for missing bank information.");
    expect(answerText("because the raise in action #1 took effect on Oct 16").text).toBe("because the raise in audit #1 took effect on Oct 16");
    expect(answerText("Source: res_0234").text).toBe("");
    expect(answerText("There is no approve tool.").text).toBe("There is no approve tool.");
  });
});
