// Golden tests (SPEC 7.3, research/domain.md 7): every line to the cent.
import { describe, expect, it } from "vitest";
import {
  calculatePaycheck, nyDblPeriodCapCents, nyPeriodTable, nyTableA, TAX_2026,
  type PaycheckCalc, type PaycheckInput, type W4Input,
} from "../src/index";

const W4: W4Input = { version: "2020", filingStatus: "single", step2Checkbox: false, step3Cents: 0, step4aCents: 0, step4bCents: 0, step4cCents: 0, allowances: 0, exempt: false };
function input(p: Partial<PaycheckInput> & { gross: number }): PaycheckInput {
  const { gross, ...rest } = p;
  return {
    payDate: "2026-10-30", payPeriodsPerYear: 26, jurisdiction: "TX",
    earnings: [{ type: "salary", amount_cents: gross, hours_x100: null }], pretax: [], posttax: [], reimbursements_cents: 0,
    w4: W4, state: { filingStatus: null, allowances: 0 }, ytd: {}, employerRates: { sui: null, ett: null }, ...rest,
  };
}
const line = (c: PaycheckCalc, code: string, payer: "employee" | "employer" = "employee", jurisdiction?: string) => {
  const l = c.taxes.find((x) => x.code === code && x.payer === payer && (!jurisdiction || x.jurisdiction === jurisdiction));
  return l ? l.amount_cents : 0;
};
const employeeLines = (c: PaycheckCalc) => Object.fromEntries(c.taxes.filter((x) => x.payer === "employee").map((x) => [`${x.jurisdiction}:${x.code}`, x.amount_cents]));
const employerLines = (c: PaycheckCalc) => Object.fromEntries(c.taxes.filter((x) => x.payer === "employer").map((x) => [`${x.jurisdiction}:${x.code}`, x.amount_cents]));

describe("P0 golden cases (domain.md 7)", () => {
  it("case 1: CA biweekly single, DE 4 single 1, gross $3,000.00", () => {
    const c = calculatePaycheck(input({
      gross: 300000, jurisdiction: "CA", payPeriodsPerYear: 26, state: { filingStatus: "single", allowances: 1 },
      employerRates: { sui: { rate: "0.034", wageBaseCents: 700000 }, ett: { rate: "0.001", wageBaseCents: 700000 } },
    }));
    expect(employeeLines(c)).toEqual({ "US:fit": 32038, "US:ss": 18600, "US:medicare": 4350, "CA:pit": 12754, "CA:sdi": 3900 });
    expect(employerLines(c)).toEqual({ "US:ss": 18600, "US:medicare": 4350, "US:futa": 1800, "CA:sui": 10200, "CA:ett": 300 });
    expect(c.net_cents).toBe(228358);
  });

  it("case 2: TX semimonthly MFJ, 401(k) 6% + Section 125 $200, gross $5,000.00", () => {
    const c = calculatePaycheck(input({
      gross: 500000, payPeriodsPerYear: 24, w4: { ...W4, filingStatus: "mfj" },
      pretax: [{ code: "401k_traditional", amount_cents: 30000 }, { code: "section125_medical", amount_cents: 20000 }],
      employerRates: { sui: { rate: "0.027", wageBaseCents: 900000 }, ett: null },
    }));
    expect(c.taxableWages.fit).toBe(450000);
    expect(c.taxableWages.ss).toBe(480000);
    expect(employeeLines(c)).toEqual({ "US:fit": 35833, "US:ss": 29760, "US:medicare": 6960 });
    // Employer side under the SPEC 7.1 reduces sets: Section 125 reduces FUTA and SUI wages, 401(k) does not.
    expect(employerLines(c)).toEqual({ "US:ss": 29760, "US:medicare": 6960, "US:futa": 2880, "TX:sui": 12960 });
    expect(c.pretax_cents).toBe(50000);
    expect(c.net_cents).toBe(377447);
  });

  it("case 4: NY biweekly single, IT-2104 1 allowance, gross $4,000.00, DBL collected", () => {
    const c = calculatePaycheck(input({ gross: 400000, jurisdiction: "NY", state: { filingStatus: "single", allowances: 1 } }));
    expect(employeeLines(c)).toEqual({ "US:fit": 54038, "US:ss": 24800, "US:medicare": 5800, "NY:pit": 19507, "NY:pfl": 1728, "NY:dbl": 120 });
    expect(c.net_cents).toBe(294007);
  });

  it("case 7: CO monthly MFJ, gross $20,000.00, YTD $195,000.00 (Additional Medicare crossing, SS and FAMLI capped)", () => {
    const ytd = { gross: 19500000, fit_wages: 19500000, ss_wages: 19500000, medicare_wages: 19500000, futa_wages: 19500000, "famli_wages:CO": 19500000, "sui_wages:CO": 19500000 };
    const c = calculatePaycheck(input({ gross: 2000000, jurisdiction: "CO", payPeriodsPerYear: 12, w4: { ...W4, filingStatus: "mfj" }, ytd }));
    expect(employeeLines(c)).toEqual({ "US:fit": 292833, "US:ss": 0, "US:medicare": 29000, "US:medicare_additional": 13500, "CO:pit": 83967, "CO:famli": 0 });
    expect(line(c, "famli", "employer")).toBe(0);
    expect(line(c, "futa", "employer")).toBe(0);
    expect(c.net_cents).toBe(1580700);
  });

  it("case 9: TX biweekly, pre-2020 W-4 Married 3 allowances, gross $2,500.00", () => {
    const c = calculatePaycheck(input({ gross: 250000, w4: { ...W4, version: "pre2020", filingStatus: "mfj", allowances: 3 } }));
    expect(employeeLines(c)).toEqual({ "US:fit": 13231, "US:ss": 15500, "US:medicare": 3625 });
    expect(c.net_cents).toBe(217644);
  });
});

describe("extra federal edge cases (domain.md 7)", () => {
  it("11: weekly single $300.00 is below the first bracket", () => {
    const c = calculatePaycheck(input({ gross: 30000, payPeriodsPerYear: 52 }));
    expect(employeeLines(c)).toEqual({ "US:fit": 0, "US:ss": 1860, "US:medicare": 435 });
  });
  it("12: monthly single with the Step 2 box checked, $6,000.00", () => {
    const c = calculatePaycheck(input({ gross: 600000, payPeriodsPerYear: 12, w4: { ...W4, step2Checkbox: true } }));
    expect(line(c, "fit")).toBe(97058);
  });
  it("case 3 FIT: weekly HOH with Step 3 credits $2,200", () => {
    const c = calculatePaycheck(input({ gross: 120000, payPeriodsPerYear: 52, w4: { ...W4, filingStatus: "hoh", step3Cents: 220000 } }));
    expect(employeeLines(c)).toEqual({ "US:fit": 3915, "US:ss": 7440, "US:medicare": 1740 });
  });
  it("case 5 FIT: biweekly MFJ with Step 4(a), 4(b) and 4(c)", () => {
    const c = calculatePaycheck(input({ gross: 400000, w4: { ...W4, filingStatus: "mfj", step4aCents: 500000, step4bCents: 1000000, step4cCents: 5000 } }));
    expect(line(c, "fit")).toBe(33923);
  });
  it("case 6 federal lines: semimonthly single, Social Security wage base crossing (no state income tax)", () => {
    const c = calculatePaycheck(input({ gross: 1000000, payPeriodsPerYear: 24, ytd: { ss_wages: 18000000, medicare_wages: 18000000, futa_wages: 700000 } }));
    expect(employeeLines(c)).toEqual({ "US:fit": 200433, "US:ss": 27900, "US:medicare": 14500 });
    expect(line(c, "ss", "employer")).toBe(27900);
    expect(c.net_cents).toBe(757167);
  });
  it("case 10: NY supplemental bonus $5,000.00 (flat 22% FIT, 11.70% NY, DBL already capped this week)", () => {
    const c = calculatePaycheck(input({ gross: 500000, jurisdiction: "NY", supplemental: true, collectNyDbl: false, state: { filingStatus: "single", allowances: 1 } }));
    expect(employeeLines(c)).toEqual({ "US:fit": 110000, "US:ss": 31000, "US:medicare": 7250, "NY:pit": 58500, "NY:pfl": 2160 });
    expect(c.net_cents).toBe(291090);
  });
  it("an exempt W-4 withholds no FIT", () => {
    const c = calculatePaycheck(input({ gross: 300000, w4: { ...W4, exempt: true } }));
    expect(line(c, "fit")).toBe(0);
  });
});

describe("agency examples", () => {
  it("CA EDD Method B Example E: semimonthly $2,400, married, 4 allowances = $4.13", () => {
    const c = calculatePaycheck(input({ gross: 240000, jurisdiction: "CA", payPeriodsPerYear: 24, state: { filingStatus: "married", allowances: 4 } }));
    expect(line(c, "pit", "employee", "CA")).toBe(413);
  });
  it("NY Example 1: weekly $400, single, 3 exemptions = $8.01", () => {
    const c = calculatePaycheck(input({ gross: 40000, jurisdiction: "NY", payPeriodsPerYear: 52, state: { filingStatus: "single", allowances: 3 } }));
    expect(line(c, "pit", "employee", "NY")).toBe(801);
  });
  it("the per-period NY derivation reproduces the published biweekly single table II-B and Table A", () => {
    expect(nyPeriodTable(TAX_2026.states.NY.incomeTax.tables.single, 26)).toEqual(TAX_2026.states.NY.incomeTax.publishedSingleBiweekly);
    const unpublished = { ...TAX_2026, states: { ...TAX_2026.states, NY: { ...TAX_2026.states.NY, incomeTax: { ...TAX_2026.states.NY.incomeTax, tableAPublishedCents: {} } } } };
    expect(nyTableA("single", 0, 26, unpublished)).toBe(28460);
    expect(nyTableA("married", 0, 26, unpublished)).toBe(30580);
    expect(nyTableA("single", 1, 26, TAX_2026)).toBe(32310);
    expect(nyTableA("married", 1, 26, TAX_2026)).toBe(34430);
  });
});

describe("SPEC 7.1 and 7.2 rules", () => {
  it("NY DBL semimonthly per-period cap is $1.30 (biweekly $1.20, weekly $0.60)", () => {
    expect(nyDblPeriodCapCents(24, TAX_2026)).toBe(130);
    expect(nyDblPeriodCapCents(26, TAX_2026)).toBe(120);
    expect(nyDblPeriodCapCents(52, TAX_2026)).toBe(60);
    const c = calculatePaycheck(input({ gross: 500000, jurisdiction: "NY", payPeriodsPerYear: 24, state: { filingStatus: "single", allowances: 0 } }));
    expect(line(c, "dbl", "employee", "NY")).toBe(130);
  });
  it("a 401(k) member's CA PIT wages are reduced by the deferral while SS wages are not", () => {
    const c = calculatePaycheck(input({
      gross: 500000, jurisdiction: "CA", payPeriodsPerYear: 24, state: { filingStatus: "single", allowances: 1 },
      pretax: [{ code: "401k_traditional", amount_cents: 30000 }],
      employerRates: { sui: { rate: "0.034", wageBaseCents: 700000 }, ett: { rate: "0.001", wageBaseCents: 700000 } },
    }));
    const pit = c.taxes.find((x) => x.code === "pit" && x.jurisdiction === "CA")!;
    const ss = c.taxes.find((x) => x.code === "ss" && x.payer === "employee")!;
    const sdi = c.taxes.find((x) => x.code === "sdi")!;
    const sui = c.taxes.find((x) => x.code === "sui")!;
    expect(pit.taxable_wages_cents).toBe(470000);
    expect(c.taxableWages.fit).toBe(470000);
    expect(ss.taxable_wages_cents).toBe(500000);
    expect(sdi.taxable_wages_cents).toBe(500000);
    expect(sui.taxable_wages_cents).toBe(500000);
    expect(c.ytdDeltas.k401_deferral).toBe(30000);
    expect(c.trace.some((l) => l.includes("modeling choice"))).toBe(true);
  });
  it("CA SUI and ETT stop at the $7,000 wage base via YTD", () => {
    const c = calculatePaycheck(input({
      gross: 400000, jurisdiction: "CA", payPeriodsPerYear: 24, state: { filingStatus: "single", allowances: 1 }, ytd: { "sui_wages:CA": 500000, futa_wages: 500000 },
      employerRates: { sui: { rate: "0.034", wageBaseCents: 700000 }, ett: { rate: "0.001", wageBaseCents: 700000 } },
    }));
    expect(line(c, "sui", "employer", "CA")).toBe(6800);
    expect(line(c, "ett", "employer", "CA")).toBe(200);
    expect(line(c, "futa", "employer")).toBe(1200);
  });
  it("NY PFL stops at the $411.91 annual max", () => {
    const c = calculatePaycheck(input({ gross: 500000, jurisdiction: "NY", payPeriodsPerYear: 24, state: { filingStatus: "single", allowances: 0 }, ytd: { "tax:NY:pfl:employee": 41100 } }));
    expect(line(c, "pfl", "employee", "NY")).toBe(91);
  });
  it("YTD deltas carry wages and each tax amount", () => {
    const c = calculatePaycheck(input({ gross: 300000, jurisdiction: "CA", state: { filingStatus: "single", allowances: 1 }, employerRates: { sui: { rate: "0.034", wageBaseCents: 700000 }, ett: { rate: "0.001", wageBaseCents: 700000 } } }));
    expect(c.ytdDeltas).toMatchObject({ gross: 300000, ss_wages: 300000, "sui_wages:CA": 300000, "sdi_wages:CA": 300000, "state_pit_wages:CA": 300000, "tax:US:fit:employee": 32038, "tax:CA:sui:employer": 10200 });
  });
  it("rejects non-integer cents and unknown deduction codes", () => {
    expect(() => calculatePaycheck(input({ gross: 100.5 }))).toThrow(/integer cents/);
    expect(() => calculatePaycheck(input({ gross: 100000, pretax: [{ code: "mystery", amount_cents: 1 }] }))).toThrow(/unknown pre-tax/);
  });
  it("is pure: the same input gives the same output", () => {
    const i = input({ gross: 412345, jurisdiction: "NY", payPeriodsPerYear: 24, state: { filingStatus: "married", allowances: 2 } });
    expect(calculatePaycheck(i)).toEqual(calculatePaycheck(i));
    expect(TAX_2026.version).toBe("2026.1");
  });
});

describe("YTD deltas record capped wages for capped taxes", () => {
  it("SUI wages stop at the base so a rate-change credit uses taxable wages", () => {
    const c = calculatePaycheck(input({
      gross: 400000, jurisdiction: "CA", payPeriodsPerYear: 24, state: { filingStatus: "single", allowances: 1 }, ytd: { "sui_wages:CA": 500000, futa_wages: 500000, ss_wages: 18300000 },
      employerRates: { sui: { rate: "0.034", wageBaseCents: 700000 }, ett: { rate: "0.001", wageBaseCents: 700000 } },
    }));
    expect(c.ytdDeltas["sui_wages:CA"]).toBe(200000);
    expect(c.ytdDeltas.futa_wages).toBe(200000);
    expect(c.ytdDeltas.ss_wages).toBe(150000);
    expect(c.ytdDeltas.medicare_wages).toBe(400000);
  });
});
