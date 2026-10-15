import { describe, expect, it } from "vitest";
import { check, extractNumerals, renderPlaceholders } from "../src/index";

describe("grounding.check", () => {
  it("has the frozen signature", () => {
    expect(check("Net pay is $1,234.56", [{ net_cents: 123456 }])).toEqual({ ok: true, offending: [] });
  });

  it("flags a number that no tool result contains", () => {
    const r = check("Gross pay rose to $4,100.00 for 23 people.", [{ gross_cents: 400000, affected_count: 22 }]);
    expect(r.ok).toBe(false);
    expect(r.offending).toEqual(["$4,100.00", "23"]);
  });

  it("applies the cents rule: only *_cents leaves are divided by 100", () => {
    expect(check("$1,234.56", [{ net_cents: 123456 }]).ok).toBe(true);
    expect(check("$1,234.56", [{ net: 123456 }]).ok).toBe(false);
    expect(check("123456 is the raw number", [{ net_cents: 123456 }]).ok).toBe(false);
  });

  it("acceptance: '$2,650' is ungrounded against 264987 cents unless written 'about $2,650'", () => {
    const results = [{ employer_cost_delta_cents: 264987 }];
    expect(check("The change costs $2,650 a year.", results)).toEqual({ ok: false, offending: ["$2,650"] });
    expect(check("The change costs about $2,650 a year.", results).ok).toBe(true);
    expect(check("The change costs around $2,650 a year.", results).ok).toBe(true);
    expect(check("The change costs approximately $2,650.", results).ok).toBe(true);
    expect(check("The change costs ~$2,650.", results).ok).toBe(true);
    expect(check("The change costs about $2,600.", results).ok).toBe(true);
    expect(check("The change costs about $2,700.", results).ok).toBe(false);
    expect(check("The change costs $2,649.87.", results).ok).toBe(true);
  });

  it("acceptance: '1.9%' is grounded by rate_delta 0.019", () => {
    expect(check("The rate falls by 1.9%.", [{ rate_delta: 0.019 }]).ok).toBe(true);
    expect(check("The rate falls by 1.8%.", [{ rate_delta: 0.019 }]).ok).toBe(false);
    expect(check("The rate falls by 1.9 percent.", [{ rate_delta: 0.019 }]).ok).toBe(true);
  });

  it("grounds percents from decimal-string rates and display strings", () => {
    expect(check("CA SUI goes from 3.4% to 1.5%.", [{ old_rate: "0.034", new_rate: "0.015" }]).ok).toBe(true);
    expect(check("The delta is 1.9%.", [{ rate_delta_display: "1.9%" }]).ok).toBe(true);
  });

  it("matches dates in ISO and US forms and flags dates the results do not hold", () => {
    const results = [{ effective_date: "2026-01-01" }];
    for (const t of ["effective 2026-01-01", "effective January 1, 2026", "effective Jan 1, 2026", "effective 1/1/2026", "effective 01/01/2026", "for 2026"]) {
      expect(check(t, results), t).toEqual({ ok: true, offending: [] });
    }
    expect(check("effective February 1, 2026", results)).toEqual({ ok: false, offending: ["February 1, 2026"] });
    expect(check("for 2027", results).ok).toBe(false);
  });

  it("exempts small integers up to 10 but not money or percents", () => {
    expect(check("I checked 3 notices and 10 workers.", [{}]).ok).toBe(true);
    expect(check("I checked 11 workers.", [{}]).ok).toBe(false);
    expect(check("It costs $5.", [{}]).ok).toBe(false);
    expect(check("It moved 5%.", [{}]).ok).toBe(false);
  });

  it("grounds counts and written numbers", () => {
    expect(check("Nineteen other workers are unaffected.", [{ unaffected_count: 19 }]).ok).toBe(true);
    expect(check("Twenty-two people are in CA.", [{ affected_count: 22 }]).ok).toBe(true);
    expect(check("Twenty-three people are in CA.", [{ affected_count: 22 }]).ok).toBe(false);
  });

  it("ignores numbers inside identifiers the results contain", () => {
    const results = [{ id: "wrk_0014", name: "Rowan Achebe (demo)", notice: "CA_EDD_DE2088_2026.txt", result_id: "res_0042" }];
    expect(check("Rowan Achebe (demo) (wrk_0014) read CA_EDD_DE2088_2026.txt; see res_0042.", results).ok).toBe(true);
  });

  it("strips placeholders before checking", () => {
    expect(check("Net pay is {{r1.net_cents}}.", [{}]).ok).toBe(true);
    const r = renderPlaceholders("Net pay is {{r1.net_cents}}.", new Map([["r1", { alias: "r1", resultId: "res_1", tool: "payroll__get_run", values: { net_cents: 264987 } }]]));
    expect(r.text).toBe("Net pay is $2,649.87.");
  });

  it("extracts money, approximation and percents", () => {
    const [n] = extractNumerals("about $2,650");
    expect(n).toMatchObject({ value: 2650, money: true, approx: true, percent: false });
  });
});
