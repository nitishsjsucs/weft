// Scenario GP16 (docs/wave3.md), the three wave 3 anomaly rules. Owner: w3-parity-routines. Each rule fires on its
// planted case and on nothing else; the open draft pay_2026_10_30 keeps exactly its GP2 flags after a recompute.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Flag } from "@weft/contracts";
import { paychecks, payRates, workers } from "@weft/db";
import { parityFlags } from "../../packages/core/src/payroll/parity-flags";
import type { ComputedPaycheck } from "../../packages/core/src/payroll/compute";
import { planSpecialRun } from "../../packages/core/src/payroll/offcycle";
import { PARITY_CASES, plantParityAnomalyCases } from "../../packages/seed/src/w3-parity";
import { createTestWeft, type TestWeft } from "./helpers";

const W3_RULES = ["DUPLICATE_SUPPLEMENTAL", "RAISE_NOT_APPLIED", "WITHHOLDING_CHANGED"];
const rulesOf = (json: string) => (JSON.parse(json) as Flag[]).map((f) => f.rule);
const flagsByWorker = async (weft: TestWeft, runId: string) => {
  const rows = await weft.db.select().from(paychecks).where(eq(paychecks.payrollRunId, runId));
  return new Map(rows.map((p) => [p.workerId, rulesOf(p.flagsJson)]));
};

describe("GP16 anomaly rules: pure checks", () => {
  const rate = { id: "prt_old", workerId: "wrk_x", kind: "salary", amountCents: 10_000_000, currency: "USD", effectiveFrom: "2025-01-01", effectiveTo: null, createdActionSeq: null };
  const cp = (earnings: ComputedPaycheck["earnings"]): ComputedPaycheck => ({ workerId: "wrk_x", rate, earnings } as unknown as ComputedPaycheck);
  const data = (over: Record<string, unknown> = {}) => ({
    periodStart: "2026-11-01", periodEnd: "2026-11-15", previousPeriodEnd: "2026-10-31",
    priorSupplemental: new Map(), rates: new Map(), withholding: new Map(), ...over,
  });

  it("is silent on a plain salary paycheck and on missing data", () => {
    expect(parityFlags(cp([{ type: "salary", amountCents: 416_667, hoursX100: null }]), data())).toEqual([]);
    expect(parityFlags(cp([]), null)).toEqual([]);
  });

  it("DUPLICATE_SUPPLEMENTAL on two equal lines or a repeat of a recent run, never on a different amount", () => {
    const twice = parityFlags(cp([{ type: "bonus", amountCents: 50_000, hoursX100: null }, { type: "bonus", amountCents: 50_000, hoursX100: null }]), data());
    expect(twice.map((f) => [f.rule, f.severity])).toEqual([["DUPLICATE_SUPPLEMENTAL", "block"]]);
    const prior = new Map([["wrk_x", [{ runId: "pay_a", payday: "2026-11-06", type: "bonus", amountCents: 50_000 }]]]);
    expect(parityFlags(cp([{ type: "bonus", amountCents: 50_000, hoursX100: null }]), data({ priorSupplemental: prior }))[0]?.evidence).toMatchObject({ previous_run_id: "pay_a", amount_display: "$500.00" });
    expect(parityFlags(cp([{ type: "bonus", amountCents: 50_001, hoursX100: null }]), data({ priorSupplemental: prior }))).toEqual([]);
    expect(parityFlags(cp([{ type: "salary", amountCents: 50_000, hoursX100: null }]), data({ priorSupplemental: prior }))).toEqual([]);
  });

  it("RAISE_NOT_APPLIED only for a newer, higher rate of the same kind effective since the last run", () => {
    const at = (over: Partial<typeof rate>) => new Map([["wrk_x", [{ ...rate, id: "prt_new", amountCents: 10_600_000, effectiveFrom: "2026-11-01", effectiveTo: "2026-11-01", ...over }]]]);
    expect(parityFlags(cp([]), data({ rates: at({}) })).map((f) => f.rule)).toEqual(["RAISE_NOT_APPLIED"]);
    expect(parityFlags(cp([]), data({ rates: at({ effectiveFrom: "2026-11-16" }) }))).toEqual([]);   // after period end
    expect(parityFlags(cp([]), data({ rates: at({ effectiveFrom: "2026-07-01" }) }))).toEqual([]);   // before the last run
    expect(parityFlags(cp([]), data({ rates: at({ amountCents: 9_000_000 }) }))).toEqual([]);         // a cut, not a raise
    expect(parityFlags(cp([]), data({ rates: at({ kind: "hourly" }) }))).toEqual([]);
  });

  it("WITHHOLDING_CHANGED names the latest form", () => {
    const w = new Map([["wrk_x", [{ submissionId: "obs_1", kind: "state_withholding", submittedAt: "2026-11-01T10:00:00.000Z" }, { submissionId: "obs_2", kind: "federal_w4", submittedAt: "2026-11-02T10:00:00.000Z" }]]]);
    const f = parityFlags(cp([]), data({ withholding: w }));
    expect(f.map((x) => [x.rule, x.severity, x.evidence.submission_id])).toEqual([["WITHHOLDING_CHANGED", "review", "obs_2"]]);
  });
});

describe("GP16 anomaly rules in the seeded world", () => {
  let weft: TestWeft;
  const post = (path: string, body: unknown) => weft.app.request(path, { method: "POST", headers: { ...weft.uiHeaders("usr_dana"), "content-type": "application/json" }, body: JSON.stringify(body) });
  beforeAll(async () => { weft = await createTestWeft(); });
  afterAll(async () => { await weft?.close(); });

  it("the planted workers are salaried employees who were paid in pay_2026_10_15", async () => {
    const prev = await flagsByWorker(weft, "pay_2026_10_15");
    for (const c of Object.values(PARITY_CASES)) {
      const [w] = await weft.db.select().from(workers).where(eq(workers.id, c.workerId));
      expect(w, c.workerId).toMatchObject({ type: "employee" });
      expect(prev.has(c.workerId), c.workerId).toBe(true);
      const rates = await weft.db.select().from(payRates).where(eq(payRates.workerId, c.workerId));
      expect(rates.at(-1)?.kind).toBe("salary");
    }
  });

  it("the open draft keeps its GP2 flags after the cases are planted and it is recomputed", async () => {
    const before = await flagsByWorker(weft, "pay_2026_10_30");
    expect([...before.values()].flat().filter((r) => W3_RULES.includes(r))).toEqual([]);
    await plantParityAnomalyCases(weft.db);
    const res = await post("/v1/tools/payroll.preview_run", { run_id: "pay_2026_10_30" });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await flagsByWorker(weft, "pay_2026_10_30")).toEqual(before);
  });

  it("a new Nov 1 to 15 draft flags the missed raise and the W-4 on their workers only", async () => {
    const res = await post("/v1/tools/payroll.create_draft", { pay_schedule_id: "ps_us_semimonthly", period_end: "2026-11-15" });
    const out = (await res.json()) as { ok: boolean; data?: { run_id: string } };
    expect(out.ok, JSON.stringify(out).slice(0, 400)).toBe(true);
    const runId = out.data!.run_id;
    const byWorker = await flagsByWorker(weft, runId);
    const hits = [...byWorker.entries()].flatMap(([w, rules]) => rules.filter((r) => W3_RULES.includes(r)).map((r) => `${w}:${r}`)).sort();
    expect(hits).toEqual([`${PARITY_CASES.raise.workerId}:RAISE_NOT_APPLIED`, `${PARITY_CASES.withholding.workerId}:WITHHOLDING_CHANGED`].sort());
  });

  it("an off-cycle that repeats the Nov 6 bonus is blocked by DUPLICATE_SUPPLEMENTAL; another worker's bonus is not", async () => {
    const plan = await planSpecialRun(weft.db, {
      companyId: "cmp_larkspur", subtype: "off_cycle", periodStart: "2026-11-01", periodEnd: "2026-11-15", payday: "2026-11-10",
      lines: [
        { workerId: PARITY_CASES.bonus.workerId, earnings: [{ type: "bonus", amountCents: PARITY_CASES.bonus.amountCents, hoursX100: null, note: "bonus" }] },
        { workerId: PARITY_CASES.raise.workerId, earnings: [{ type: "bonus", amountCents: PARITY_CASES.bonus.amountCents, hoursX100: null, note: "bonus" }] },
      ],
      benefits: false,
    } as unknown as Parameters<typeof planSpecialRun>[1]);
    const rules = Object.fromEntries(plan.lines.map((l) => [l.workerId, l.flags.map((f) => f.rule)]));
    expect(rules[PARITY_CASES.bonus.workerId]).toEqual(["DUPLICATE_SUPPLEMENTAL"]);
    expect(rules[PARITY_CASES.raise.workerId]).toEqual([]);
  });
});
