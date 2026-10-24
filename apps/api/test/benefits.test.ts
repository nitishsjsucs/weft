// Contract tests for /v1/benefits and the benefits.* read commands (owner: t2-world).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BenefitPlan, Enrollment, Page } from "@weft/contracts";
import { directCtx, directDeps, ensureTestPrincipals, runDirect } from "@weft/core";
import { createSimulators } from "@weft/sim";
import { createTestWeft, type TestWeft } from "../src/testing";

let weft: TestWeft;
beforeAll(async () => { weft = await createTestWeft(); await ensureTestPrincipals(weft.db); });
afterAll(async () => { await weft.close(); });
const get = (p: string) => weft.app.request(p, { headers: weft.uiHeaders("usr_sam") });

describe("benefits (SPEC 5.3)", () => {
  it("has 6 plans and the exact enrollment counts", async () => {
    const plans = (await (await get("/v1/benefits/plans")).json()).map((p: unknown) => BenefitPlan.parse(p));
    expect(plans.map((p: BenefitPlan) => p.name)).toEqual(["Juniper PPO 1500", "Juniper HDHP 3000 + HSA", "Juniper Dental Plus", "Juniper Vision", "HSA contribution", "Tidewater 401(k)"]);
    const all: Enrollment[] = [];
    let after = "";
    for (;;) {
      const page = Page(Enrollment).parse(await (await get(`/v1/benefits/enrollments?limit=100${after ? `&afterId=${after}` : ""}`)).json());
      all.push(...page.data);
      if (!page.hasMore) break;
      after = page.data.at(-1)!.id;
    }
    const byPlan = (name: string) => all.filter((e) => e.planId === plans.find((p: BenefitPlan) => p.name === name)!.id);
    const medical = new Set([...byPlan("Juniper PPO 1500"), ...byPlan("Juniper HDHP 3000 + HSA")].map((e) => e.workerId));
    expect(medical.size).toBe(38);
    expect(byPlan("Juniper PPO 1500")).toHaveLength(30);
    expect(byPlan("Juniper HDHP 3000 + HSA")).toHaveLength(8);
    expect(byPlan("Juniper Dental Plus")).toHaveLength(34);
    expect(byPlan("Juniper Vision")).toHaveLength(30);
    expect(new Set(byPlan("HSA contribution").map((e) => e.workerId))).toEqual(new Set(byPlan("Juniper HDHP 3000 + HSA").map((e) => e.workerId)));
    expect(byPlan("Tidewater 401(k)")).toHaveLength(30);
    expect(byPlan("Tidewater 401(k)").every((e) => e.deferralBps! >= 300 && e.deferralBps! <= 1000)).toBe(true);
    expect(byPlan("HSA contribution").every((e) => e.employeeCents! >= 5000 && e.employeeCents! <= 15000)).toBe(true);
  });
  it("benefits.list_plans and get_enrollment read in cents with displays", async () => {
    const deps = directDeps(weft.db, weft.clock, createSimulators({ db: weft.db, clock: weft.clock }));
    const plans = await runDirect("benefits.list_plans", {}, directCtx(weft.clock), deps);
    expect(plans.data.plans[0]).toMatchObject({ name: "Juniper PPO 1500", prices: { ee: { cents: 9500, display: "$95.00" }, employer: { cents: 38000, display: "$380.00" } }, active_enrollments: 30 });
    const e = await runDirect("benefits.get_enrollment", { worker_id: "wrk_0001" }, directCtx(weft.clock), deps);
    expect(e.data.worker).toBe("Vic Akisole (wrk_0001)");
    expect(e.data.count).toBeGreaterThan(0);
  });
});
