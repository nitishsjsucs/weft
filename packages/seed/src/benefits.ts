// Seed step "benefits" (SPEC 5.3). Owner: t2-world. Two simulated carriers, 6 plans, and enrollments:
// 38 of 48 in medical (30 PPO, 8 HDHP), 34 dental, 30 vision, 8 HSA (the HDHP members), 30 in the 401(k).
import { benefitEnrollments, benefitPlans } from "@weft/db";
import { newId } from "@weft/core";
import type { SeedContext } from "./context";
import { ROSTER, seedWorkerId } from "./people";

export const JUNIPER = "Juniper Mutual (sim)";
export const TIDEWATER = "Tidewater Retirement (sim)";

type Tier = "ee" | "ee_spouse" | "ee_children" | "family";
export const PLANS = [
  { key: "ppo", carrier: JUNIPER, category: "health", type: "medical", name: "Juniper PPO 1500", pretaxCode: "section125_medical", prices: { ee: 9_500, ee_spouse: 21_000, ee_children: 18_500, family: 31_000, employer: 38_000 } },
  { key: "hdhp", carrier: JUNIPER, category: "health", type: "medical", name: "Juniper HDHP 3000 + HSA", pretaxCode: "section125_medical", prices: { ee: 4_500, ee_spouse: 12_000, ee_children: 10_500, family: 19_000, employer: 38_000 } },
  { key: "dental", carrier: JUNIPER, category: "health", type: "dental", name: "Juniper Dental Plus", pretaxCode: "section125_medical", prices: { ee: 800, ee_spouse: 1_800, ee_children: 1_600, family: 2_800, employer: 2_400 } },
  { key: "vision", carrier: JUNIPER, category: "health", type: "vision", name: "Juniper Vision", pretaxCode: "section125_medical", prices: { ee: 300, ee_spouse: 700, ee_children: 600, family: 1_000, employer: 600 } },
  { key: "hsa", carrier: JUNIPER, category: "health_savings", type: "hsa", name: "HSA contribution", pretaxCode: "hsa_cafeteria", prices: { employer: 2_500, min_election: 5_000, max_election: 15_000 } },
  { key: "k401", carrier: TIDEWATER, category: "retirement", type: "401k", name: "Tidewater 401(k)", pretaxCode: "401k_traditional", prices: {}, match: { match_bps: 10_000, up_to_bps: 400, min_deferral_bps: 300, max_deferral_bps: 1_000 } },
] as const;

// 1-based roster positions (EMP numbers), chosen once and fixed.
export const NO_MEDICAL = [6, 12, 16, 19, 22, 31, 33, 36, 39, 45];
export const HDHP = [5, 10, 14, 25, 29, 35, 41, 47];
export const NO_DENTAL_EXTRA = [2, 20, 30, 44];          // medical members without dental
export const NO_VISION_EXTRA = [3, 21, 34, 43];          // dental members without vision
export const NO_401K = [6, 9, 13, 16, 19, 22, 24, 27, 31, 33, 36, 38, 39, 42, 44, 45, 46, 48];
const HSA_ELECTIONS = [5_000, 7_500, 10_000, 12_500, 15_000, 5_000, 10_000, 15_000];
const DEFERRALS_BPS = [300, 400, 500, 600, 800, 1_000];

const tierFor = (filing: string, n: number): Tier => (filing === "mfj" ? (n % 2 === 0 ? "family" : "ee_spouse") : filing === "hoh" ? "ee_children" : "ee");
const effectiveFrom = (start: string) => (start > "2026-01-01" ? start : "2026-01-01");

export async function seedBenefits(ctx: SeedContext): Promise<void> {
  const { db, companyId } = ctx;
  const planIds: Record<string, string> = {};
  for (const p of PLANS) {
    const id = await newId(db, "bpl_");
    planIds[p.key] = id;
    await db.insert(benefitPlans).values({
      id, companyId, carrier: p.carrier, category: p.category, type: p.type, name: p.name, pretaxCode: p.pretaxCode,
      pricesJson: JSON.stringify(p.prices), matchJson: "match" in p ? JSON.stringify(p.match) : null,
    });
  }
  const enroll = async (workerId: string, plan: string, tier: Tier | null, employeeCents: number | null, deferralBps: number | null, from: string) => {
    await db.insert(benefitEnrollments).values({ id: await newId(db, "ben_"), workerId, planId: planIds[plan]!, tier, employeeCents, deferralBps, status: "active", effectiveFrom: from, effectiveTo: null });
  };
  let hsa = 0, k401 = 0;
  for (const [i, r] of ROSTER.entries()) {
    const n = i + 1;
    const wid = seedWorkerId(r.key);
    const from = effectiveFrom(r.start);
    const tier = tierFor(r.filing, n);
    if (!NO_MEDICAL.includes(n)) {
      const medical = HDHP.includes(n) ? PLANS[1] : PLANS[0];
      await enroll(wid, medical.key, tier, medical.prices[tier], null, from);
      if (!NO_DENTAL_EXTRA.includes(n)) {
        await enroll(wid, "dental", tier, PLANS[2].prices[tier], null, from);
        if (!NO_VISION_EXTRA.includes(n)) await enroll(wid, "vision", tier, PLANS[3].prices[tier], null, from);
      }
      if (HDHP.includes(n)) await enroll(wid, "hsa", null, HSA_ELECTIONS[hsa++ % HSA_ELECTIONS.length]!, null, from);
    }
    if (!NO_401K.includes(n)) await enroll(wid, "k401", null, null, DEFERRALS_BPS[k401++ % DEFERRALS_BPS.length]!, from);
  }
}
