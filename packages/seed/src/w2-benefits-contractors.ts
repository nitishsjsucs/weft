// Seed step "w2_benefits_contractors" (wave 2, docs/wave2.md). Owner: w2-benefits-contractors. Runs after "payroll". Keep it deterministic (ctx.faker, id counters).
// Seeds the fixed FX table from packages/sim/src/fx.ts and one 2027 open enrollment row per eligible employee. The
// carrier reconciliation fixtures need no new rows: the carrier simulator bills Owen Mercer, whose last day is
// 2026-10-23 and whose enrollments were never terminated, and plants the tier errors on the first single and the first
// family medical enrollment (packages/sim/src/carrier.ts). Wave 1 counts are untouched.
import { fxRates, openEnrollment } from "@weft/db";
import { eligibleForOpenEnrollment, newId, OPEN_ENROLLMENT_PLAN_YEAR, seedEnrollmentStatus } from "@weft/core";
import { FX_LABEL, FX_USD_PER_UNIT } from "@weft/sim";
import type { SeedStep } from "./context";

export const FX_AS_OF = "2026-01-01";

export const seedW2BenefitsContractors: SeedStep = async (ctx) => {
  const { db, companyId } = ctx;
  for (const [currency, usdPerUnit] of Object.entries(FX_USD_PER_UNIT).sort(([a], [b]) => a.localeCompare(b))) {
    await db.insert(fxRates).values({ currency, asOf: FX_AS_OF, usdPerUnit, source: FX_LABEL });
  }
  const now = ctx.clock.now();
  for (const w of await eligibleForOpenEnrollment(db, companyId)) {
    const n = Number(/(\d+)$/.exec(w.id)?.[1] ?? 0);
    const status = seedEnrollmentStatus(n);
    await db.insert(openEnrollment).values({ id: await newId(db, "oen_"), workerId: w.id, planYear: OPEN_ENROLLMENT_PLAN_YEAR, status, lastNudgedAt: null, nudges: 0, electedAt: status === "elected" || status === "waived" ? now : null });
  }
};
