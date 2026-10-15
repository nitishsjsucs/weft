// Versioned rate data (SPEC 7.1, research/domain.md section 6, version 2026.1). Owner: t1-payroll.
// Synthetic 2026.1 tables: every value below is transcribed from research/domain.md and shown in the UI as
// "Synthetic 2026.1 tables". Money is integer cents; rates are decimal strings. Keyed by (jurisdiction, tax code,
// effective_from); 2026.1 has one effective_from for every table.

export const TAX_DATA_VERSION = "2026.1";

/** Taxable-wage bases a deduction may reduce (SPEC 7.1). `state_pit` is the work state's income tax. */
export type WageBase = "fit" | "ss" | "medicare" | "futa" | "state_pit" | "sui" | "sdi" | "pfl" | "dbl" | "famli";
export const WAGE_BASES: readonly WageBase[] = ["fit", "ss", "medicare", "futa", "state_pit", "sui", "sdi", "pfl", "dbl", "famli"];

/** Federal bracket row: annual wages at least `atLeastCents`, tentative = baseCents + (wages - atLeast) x rate. */
export interface Bracket { atLeastCents: number; baseCents: number; rate: string }
export type FedStatus = "mfj" | "single" | "hoh";

export interface PretaxRule {
  reduces: readonly WageBase[];
  /** SPEC 7.1: the state income tax and SUI treatment is a modeling choice, labeled in the trace. */
  modelingChoice: true;
  limitCents?: number;
}

export interface TaxTables {
  version: string;
  effectiveFrom: string;
  label: string;
  rounding: { mode: "half_up"; scale: 2; per: "tax_line_per_period" };
  federal: {
    payPeriods: Record<"annual" | "semiannual" | "quarterly" | "monthly" | "semimonthly" | "biweekly" | "weekly" | "daily", number>;
    fit: {
      method: "pub15t_2026_worksheet_1a";
      line1gStandardCents: Record<FedStatus, number>;
      pre2020AllowanceCents: number;
      supplemental: { flatRate: string; over1mRate: string; thresholdCents: number };
      tables: { standard: Record<FedStatus, Bracket[]>; step2Checkbox: Record<FedStatus, Bracket[]> };
    };
    socialSecurity: { employeeRate: string; employerRate: string; wageBaseCents: number };
    medicare: { employeeRate: string; employerRate: string; additionalRate: string; additionalThresholdCents: number };
    futa: { grossRate: string; maxCredit: string; netRate: string; wageBaseCents: number; creditReduction: Record<string, Record<string, string> | { status: string }> };
  };
  pretax: Record<string, PretaxRule>;
  states: {
    CA: {
      incomeTax: {
        method: "edd_method_b_annualized";
        lowIncomeExemptionCents: Record<"single" | "married_0_1" | "married_2plus" | "hoh", number>;
        standardDeductionCents: Record<"single" | "married_0_1" | "married_2plus" | "hoh", number>;
        estimatedDeductionPerAllowanceCents: number;
        allowanceCreditCents: number;
        /** rows: taxable income over `atLeastCents`: baseCents + (income - over) x rate */
        tables: Record<"single" | "married" | "hoh", Bracket[]>;
      };
      sdi: { employeeRate: string; wageBaseCents: null };
      sui: { wageBaseCents: number; newEmployerRate: string };
      ett: { rate: string; wageBaseCents: number };
    };
    NY: {
      incomeTax: {
        method: "nys50t_method_ii";
        annualAllowanceCents: { single: number; married: number; perExemption: number };
        /** Table C exemption value per payroll period, as published (NYS-50-T-NYS 1/26). */
        tableCExemptionCents: Record<number, number>;
        /** Table A combined deduction for 0 exemptions, as published, by periods per year. Other periods are derived. */
        tableAPublishedCents: Record<number, { single: number; married: number }>;
        /** Single biweekly table II-B as published, used to check the per-period derivation. */
        publishedSingleBiweekly: { atLeastCents: number; addCents: number; rate: string }[];
        supplementalRate: string;
        methodIIIThresholdCents: number;
        /** Annual schedules (at least, base, rate). Recapture rows are data; do not "fix" them. */
        tables: Record<"single" | "married", Bracket[]>;
      };
      pfl: { employeeRate: string; annualMaxCents: number };
      dbl: { employeeRate: string; weeklyMaxCents: number; employerOptional: true; simplified: string };
      sui: { wageBaseCents: number; newEmployerRate: string };
    };
    TX: { incomeTax: null; sui: { wageBaseCents: number; newEmployerRate: string } };
    CO: {
      incomeTax: { method: "dr1098_2026"; rate: string; allowanceCents: { mfj: number; other: number } };
      famli: { employeeRate: string; employerRate: string; wageBaseCents: number };
      sui: { wageBaseCents: number; newEmployerRate: string };
    };
  };
  overtime: { semimonthlyThresholdHoursX100: number; multiplier: string; simplified: string };
}

const $ = (dollars: number): number => Math.round(dollars * 100);
const rows = (r: [number, number, number][]): Bracket[] => r.map(([a, b, c]) => ({ atLeastCents: $(a), baseCents: $(b), rate: String(c) }));

export const TAX_2026: TaxTables = {
  version: TAX_DATA_VERSION,
  effectiveFrom: "2026-01-01",
  label: "Synthetic 2026.1 tables",
  rounding: { mode: "half_up", scale: 2, per: "tax_line_per_period" },
  federal: {
    payPeriods: { annual: 1, semiannual: 2, quarterly: 4, monthly: 12, semimonthly: 24, biweekly: 26, weekly: 52, daily: 260 },
    fit: {
      method: "pub15t_2026_worksheet_1a",
      line1gStandardCents: { mfj: $(12900), single: $(8600), hoh: $(8600) },
      pre2020AllowanceCents: $(4300),
      supplemental: { flatRate: "0.22", over1mRate: "0.37", thresholdCents: $(1000000) },
      tables: {
        standard: {
          mfj: rows([[0, 0, 0], [19300, 0, 0.10], [44100, 2480, 0.12], [120100, 11600, 0.22], [230700, 35932, 0.24], [422850, 82048, 0.32], [531750, 116896, 0.35], [788000, 206583.50, 0.37]]),
          single: rows([[0, 0, 0], [7500, 0, 0.10], [19900, 1240, 0.12], [57900, 5800, 0.22], [113200, 17966, 0.24], [209275, 41024, 0.32], [263725, 58448, 0.35], [648100, 192979.25, 0.37]]),
          hoh: rows([[0, 0, 0], [15550, 0, 0.10], [33250, 1770, 0.12], [83000, 7740, 0.22], [121250, 16155, 0.24], [217300, 39207, 0.32], [271750, 56631, 0.35], [656150, 191171, 0.37]]),
        },
        step2Checkbox: {
          mfj: rows([[0, 0, 0], [16100, 0, 0.10], [28500, 1240, 0.12], [66500, 5800, 0.22], [121800, 17966, 0.24], [217875, 41024, 0.32], [272325, 58448, 0.35], [400450, 103291.75, 0.37]]),
          single: rows([[0, 0, 0], [8050, 0, 0.10], [14250, 620, 0.12], [33250, 2900, 0.22], [60900, 8983, 0.24], [108938, 20512, 0.32], [136163, 29224, 0.35], [328350, 96489.63, 0.37]]),
          hoh: rows([[0, 0, 0], [12075, 0, 0.10], [20925, 885, 0.12], [45800, 3870, 0.22], [64925, 8077.50, 0.24], [112950, 19603.50, 0.32], [140175, 28315.50, 0.35], [332375, 95585.50, 0.37]]),
        },
      },
    },
    socialSecurity: { employeeRate: "0.062", employerRate: "0.062", wageBaseCents: $(184500) },
    medicare: { employeeRate: "0.0145", employerRate: "0.0145", additionalRate: "0.009", additionalThresholdCents: $(200000) },
    futa: {
      grossRate: "0.060", maxCredit: "0.054", netRate: "0.006", wageBaseCents: $(7000),
      // Year-end only (Form 940 Schedule A), never withheld per paycheck. 2026 is a labeled projection until Nov 10.
      creditReduction: { "2025": { CA: "0.012", VI: "0.045" }, "2026": { status: "pending_until_2026-11-10" } },
    },
  },
  // SPEC 7.1 reduces sets, written explicitly per deduction code. Labeled "modeling choice" in the trace: domain.md 1.6
  // defaults states to the federal FIT treatment for state income tax and to the FUTA treatment for SUI.
  pretax: {
    "401k_traditional": { reduces: ["fit", "state_pit"], modelingChoice: true, limitCents: $(24500) },
    "403b": { reduces: ["fit", "state_pit"], modelingChoice: true },
    "457b": { reduces: ["fit", "state_pit"], modelingChoice: true },
    section125_medical: { reduces: ["fit", "ss", "medicare", "futa", "state_pit", "sui", "sdi", "pfl", "dbl", "famli"], modelingChoice: true },
    health_fsa: { reduces: ["fit", "ss", "medicare", "futa", "state_pit", "sui", "sdi", "pfl", "dbl", "famli"], modelingChoice: true, limitCents: $(3400) },
    hsa_cafeteria: { reduces: ["fit", "ss", "medicare", "futa", "state_pit", "sui", "sdi", "pfl", "dbl", "famli"], modelingChoice: true },
    roth_401k: { reduces: [], modelingChoice: true },
  },
  states: {
    CA: {
      incomeTax: {
        method: "edd_method_b_annualized",
        lowIncomeExemptionCents: { single: $(18896), married_0_1: $(18896), married_2plus: $(37791), hoh: $(37791) },
        standardDeductionCents: { single: $(5706), married_0_1: $(5706), married_2plus: $(11412), hoh: $(11412) },
        estimatedDeductionPerAllowanceCents: $(1000),
        allowanceCreditCents: $(168.30),
        tables: {
          single: rows([[0, 0, 0.011], [11079, 121.87, 0.022], [26264, 455.94, 0.044], [41452, 1124.21, 0.066], [57542, 2186.15, 0.088], [72724, 3522.17, 0.1023], [371479, 34084.81, 0.1133], [445771, 42502.09, 0.1243], [742953, 79441.81, 0.1353], [1000000, 114220.27, 0.1463]]),
          married: rows([[0, 0, 0.011], [22158, 243.74, 0.022], [52528, 911.88, 0.044], [82904, 2248.42, 0.066], [115084, 4372.30, 0.088], [145448, 7044.33, 0.1023], [742958, 68169.60, 0.1133], [891542, 85004.17, 0.1243], [1000000, 98485.50, 0.1353], [1485906, 164228.58, 0.1463]]),
          hoh: rows([[0, 0, 0.011], [22173, 243.90, 0.022], [52530, 911.75, 0.044], [67716, 1579.93, 0.066], [83805, 2641.80, 0.088], [98990, 3978.08, 0.1023], [505208, 45534.18, 0.1133], [606251, 56982.35, 0.1243], [1000000, 105925.35, 0.1353], [1010417, 107334.77, 0.1463]]),
        },
      },
      sdi: { employeeRate: "0.013", wageBaseCents: null },
      sui: { wageBaseCents: $(7000), newEmployerRate: "0.034" },
      ett: { rate: "0.001", wageBaseCents: $(7000) },
    },
    NY: {
      incomeTax: {
        method: "nys50t_method_ii",
        annualAllowanceCents: { single: $(7400), married: $(7950), perExemption: $(1000) },
        tableCExemptionCents: { 260: 385, 52: 1925, 26: 3850, 24: 4165, 12: 8330, 1: $(1000) },
        tableAPublishedCents: { 26: { single: 28460, married: 30580 } },
        publishedSingleBiweekly: [
          { atLeastCents: $(0), addCents: 0, rate: "0.039" }, { atLeastCents: $(327), addCents: 1277, rate: "0.044" },
          { atLeastCents: $(450), addCents: 1815, rate: "0.0515" }, { atLeastCents: $(535), addCents: 2254, rate: "0.054" },
          { atLeastCents: $(3102), addCents: 16115, rate: "0.059" }, { atLeastCents: $(3723), addCents: 19781, rate: "0.0703" },
          { atLeastCents: $(4140), addCents: 22715, rate: "0.0753" }, { atLeastCents: $(6063), addCents: 37204, rate: "0.064" },
          { atLeastCents: $(8285), addCents: 51419, rate: "0.1144" }, { atLeastCents: $(10208), addCents: 73427, rate: "0.0735" },
        ],
        supplementalRate: "0.117",
        methodIIIThresholdCents: $(1077550),
        tables: {
          single: rows([[0, 0, 0.039], [8500, 332, 0.044], [11700, 472, 0.0515], [13900, 586, 0.054], [80650, 4190, 0.059], [96800, 5143, 0.0703], [107650, 5906, 0.0753], [157650, 9673, 0.064], [215400, 13369, 0.1144], [265400, 19091, 0.0735]]),
          married: rows([[0, 0, 0.039], [8500, 332, 0.044], [11700, 472, 0.0515], [13900, 586, 0.054], [80650, 4190, 0.059], [96800, 5143, 0.0657], [107650, 5855, 0.0707], [157650, 9388, 0.0801], [211550, 13708, 0.064], [323200, 20854, 0.1349], [373200, 27600, 0.0735], [1077550, 79369, 0.0765]]),
        },
      },
      pfl: { employeeRate: "0.00432", annualMaxCents: $(411.91) },
      dbl: { employeeRate: "0.005", weeklyMaxCents: 60, employerOptional: true, simplified: "per-period cap = $0.60 x 52 / periods per year (simplified)" },
      sui: { wageBaseCents: $(17600), newEmployerRate: "0.041" },
    },
    TX: { incomeTax: null, sui: { wageBaseCents: $(9000), newEmployerRate: "0.027" } },
    CO: {
      incomeTax: { method: "dr1098_2026", rate: "0.044", allowanceCents: { mfj: $(11000), other: $(5500) } },
      famli: { employeeRate: "0.0044", employerRate: "0.0044", wageBaseCents: $(184500) },
      sui: { wageBaseCents: $(30600), newEmployerRate: "0.0305" },
    },
  },
  // SPEC 7.2: hourly overtime is 1.5x above 86.67 hours per semi-monthly period (40 x 52 / 24, simplified).
  overtime: { semimonthlyThresholdHoursX100: 8667, multiplier: "1.5", simplified: "40 h x 52 / 24 = 86.67 h per semi-monthly period (simplified)" },
};
