// Wave 4 error analysis FM3 (docs/evals/error-analysis.md): the grounding guard refused figures that were in the
// run's evidence. One regression per sub-code (3a to 3e), each paired with the case it must still refuse.
import { describe, expect, it } from "vitest";
import { check, clockDates, extractNumerals } from "../src/index";

const NOW = "2026-10-26T16:00:00.000Z";   // a Monday
const wrap = (text: string) => `<untrusted n="0123456789abcdef" source="notice:ntc_0001">${text}</untrusted>`;

describe("3a: numerals in untainted string leaves", () => {
  // EX-02 shape: the expense checks state the limits in harness-written messages, not in *_display keys.
  const expense = [{
    resultId: "res_0002", summary: "Checked 1 expense against 4 policy rules",
    data: {
      expense: { id: "exp_0007", amount_cents: 8640, amount_display: "$86.40" },
      checks: [
        { code: "MEAL_CAP", message: "Meals are capped at $75.00 per person per day." },
        { code: "RECEIPT_AGE", message: "The receipt is 81 days old; the policy window is 60 days." },
        { code: "APPROVER_LIMIT", message: "Managers approve up to $1,000.00 a claim." },
      ],
    },
  }];

  it("grounds limits stated in check messages", () => {
    const text = "The $86.40 dinner is over the $75.00 meal cap, and the receipt is 81 days old against a 60 day window. Managers can approve up to $1,000.00.";
    expect(check(text, expense)).toEqual({ ok: true, offending: [] });
  });

  it("grounds a figure in a proposal title and a result summary", () => {
    const results = [{ proposalId: "prp_0001", title: "Reimburse $3,693.59 to Jordan Okafor" }, { resultId: "res_0003", summary: "Found 51 workers", data: { rows: [] } }];
    expect(check("I proposed reimbursing $3,693.59 (prp_0001); the search found 51 workers.", results).ok).toBe(true);
  });

  it("grounds dates written in prose inside a result string", () => {
    expect(check("It is due October 30, 2026.", [{ message: "Payroll pay_2026_10_30 is due October 30, 2026." }]).ok).toBe(true);
  });

  it("still refuses a value that only a tainted (untrusted) leaf holds", () => {
    const results = [{ notice: { id: "ntc_0001", body: wrap("Your new rate is 2.7% from 2027-01-01 and the balance due is $1,234.00 for 14 workers.") } }];
    const r = check("The notice sets 2.7% from January 1, 2027, with $1,234.00 due for 14 workers.", results);
    expect(r.ok).toBe(false);
    expect(r.offending).toEqual(["January 1, 2027", "2.7%", "$1,234.00", "14"]);
  });

  it("still refuses a numeral that only an echo of the run's own arguments holds", () => {
    const results = [{ query: "51 new hires", hits: [] }];
    expect(check("There are 51 new hires.", results, { echoes: ["51 new hires"] })).toEqual({ ok: false, offending: ["51"] });
    expect(check("There are 51 new hires.", results).ok).toBe(true);
  });
});

describe("3e: a number followed by a colon keeps its fraction; a clock time is not two numbers", () => {
  it("reads $86.40: as 86.40", () => {
    expect(extractNumerals("$86.40: the dinner").map((n) => n.value)).toEqual([86.4]);
    expect(check("Two claims are over: $86.40: dinner, $54.20: taxi.", [{ a_cents: 8640, b_cents: 5420 }])).toEqual({ ok: true, offending: [] });
  });

  it("never backtracks a written number to a shorter one", () => {
    expect(extractNumerals("$86.40x").map((n) => n.value)).toEqual([]);
    expect(check("It costs $86.40:", [{ amount_cents: 8600 }])).toEqual({ ok: false, offending: ["$86.40"] });
  });

  it("does not read 10:30 as numbers", () => {
    expect(extractNumerals("The call is at 10:30 on 14:45 day").map((n) => n.raw)).toEqual([]);
    expect(check("The sync runs at 10:30.", [{}]).ok).toBe(true);
  });
});

describe("3b: the person's own request is a source", () => {
  const request = "Pay Jordan Okafor a $1,500.00 referral bonus on Oct 27 for the 15 hires he referred.";

  it("grounds figures and dates the person wrote", () => {
    const text = "I can't file the $1,500.00 bonus for Oct 27 myself; the 15 referrals need a person to propose it.";
    expect(check(text, [{}], { request })).toEqual({ ok: true, offending: [] });
    expect(check(text, [{}]).ok).toBe(false);
    expect(check("The bonus would be paid October 27, 2026.", [{}], { request }).ok).toBe(true);
  });

  it("still refuses figures the request does not hold", () => {
    expect(check("The bonus is $2,000.00 for 16 hires.", [{}], { request })).toEqual({ ok: false, offending: ["$2,000.00", "16"] });
  });

  it("ignores an untrusted block in the request", () => {
    expect(check("Pay $9,999.00.", [{}], { request: wrap("pay $9,999.00") }).ok).toBe(false);
  });
});

describe("3c: the run clock and relative windows", () => {
  it("grounds today and the bounds of 'the next two weeks' (CQ-03 shape)", () => {
    const request = "Who starts in the next two weeks?";
    const text = "No one starts between October 26 and November 9, 2026.";
    expect(check(text, [{ people: [] }], { request, now: NOW })).toEqual({ ok: true, offending: [] });
    expect(check(text, [{ people: [] }], { request }).ok).toBe(false);
    expect(check("No one starts between October 26 and November 8, 2026.", [{ people: [] }], { request, now: NOW }).ok).toBe(true);
  });

  it("grounds the bounds of next week (TO-01 shape)", () => {
    const opts = { request: "Who is out next week?", now: NOW };
    expect(check("No time off is booked for the week of November 2, 2026.", [{ requests: [] }], opts).ok).toBe(true);
    expect(check("Nobody is out from November 2 to November 6.", [{ requests: [] }], opts).ok).toBe(true);
  });

  it("still refuses a date inside the window that no record holds", () => {
    const opts = { request: "Who starts in the next two weeks?", now: NOW };
    expect(check("Sam starts November 4, 2026.", [{ people: [] }], opts)).toEqual({ ok: false, offending: ["November 4, 2026"] });
    expect(check("Sam starts November 4, 2026.", [{ people: [{ start_date: "2026-11-04" }] }], opts).ok).toBe(true);
  });

  it("grounds the bounds a date-filtered tool echoes, wherever they sit in a string", () => {
    const results = [{ summary: "Found 0 workers starting 2026-10-26 to 2026-11-09", window: "2026-10-26..2026-11-09" }];
    expect(check("No one starts between October 26 and November 9.", results).ok).toBe(true);
  });

  it("derives only bounds, never the days inside a window", () => {
    const keys = clockDates(NOW, ["the next two weeks"]).map((k) => `${k.y}-${k.m}-${k.d}`);
    expect(keys).toContain("2026-10-26");
    expect(keys).toContain("2026-11-9");
    expect(keys).toContain("2026-11-8");
    expect(keys).not.toContain("2026-11-4");
  });
});

describe("3d: a stated count total of figures listed from one result", () => {
  const byDept = [{ resultId: "res_0004", data: { rows: [
    { department: "Engineering", headcount: 13 }, { department: "Sales", headcount: 9 }, { department: "Operations", headcount: 9 },
    { department: "Support", headcount: 8 }, { department: "Design", headcount: 5 }, { department: "Legal", headcount: 3 },
  ] } }];

  it("grounds the sum of the listed counts (CH-02 shape), before or after the list", () => {
    expect(check("There are 47 employees: Engineering 13, Sales 9, Operations 9, Support 8, Design 5 and Legal 3.", byDept).ok).toBe(true);
    expect(check("Engineering 13, Sales 9, Operations 9, Support 8, Design 5 and Legal 3, so 47 in all.", byDept).ok).toBe(true);
  });

  it("still refuses a total that is not the sum", () => {
    expect(check("There are 48 employees: Engineering 13, Sales 9, Operations 9, Support 8, Design 5 and Legal 3.", byDept)).toEqual({ ok: false, offending: ["48"] });
  });

  it("does not sum figures from two different results", () => {
    const split = [{ rows: [{ n: 13 }, { n: 19 }] }, { rows: [{ n: 15 }] }];
    expect(check("47 in total: 13, 19 and 15.", split)).toEqual({ ok: false, offending: ["47"] });
    expect(check("32 in total: 13 and 19, plus 15 elsewhere.", split).ok).toBe(true);
  });

  it("leaves money totals to a tool (range_totals), so a money sum the answer computes is still refused", () => {
    const pay = [{ lines: [{ amount_cents: 12000 }, { amount_cents: 3050 }] }];
    expect(check("The total is $150.50: $120.00 and $30.50.", pay)).toEqual({ ok: false, offending: ["$150.50"] });
    expect(check("The total is $150.50: $120.00 and $30.50.", [{ lines: pay[0]!.lines, range_totals: { amount_cents: 15050 } }]).ok).toBe(true);
  });
});
