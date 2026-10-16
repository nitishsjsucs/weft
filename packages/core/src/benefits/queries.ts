// Benefit reads shared by benefits.* commands and the /v1/benefits routes.
import { and, asc, eq, inArray } from "drizzle-orm";
import type { BenefitPlan, Enrollment } from "@weft/contracts";
import { benefitEnrollments, benefitPlans, workers, type DbTx } from "@weft/db";

export type PlanRow = typeof benefitPlans.$inferSelect;
export type EnrollmentRow = typeof benefitEnrollments.$inferSelect;

export function toPlanDto(p: PlanRow): BenefitPlan {
  return { id: p.id, carrier: p.carrier, category: p.category as BenefitPlan["category"], type: p.type as BenefitPlan["type"], name: p.name, pretaxCode: p.pretaxCode as BenefitPlan["pretaxCode"], prices: JSON.parse(p.pricesJson) as Record<string, number>, match: p.matchJson ? (JSON.parse(p.matchJson) as Record<string, unknown>) : null };
}
export function toEnrollmentDto(e: EnrollmentRow): Enrollment {
  return { id: e.id, workerId: e.workerId, planId: e.planId, tier: e.tier as Enrollment["tier"], employeeCents: e.employeeCents, deferralBps: e.deferralBps, status: e.status as Enrollment["status"], effectiveFrom: e.effectiveFrom, effectiveTo: e.effectiveTo };
}

export async function listPlans(tx: DbTx, companyId: string): Promise<PlanRow[]> {
  return tx.select().from(benefitPlans).where(eq(benefitPlans.companyId, companyId)).orderBy(asc(benefitPlans.id));
}

/** Enrollments of the company's workers (optionally one worker), ordered by id. */
export async function listEnrollments(tx: DbTx, companyId: string, workerId?: string): Promise<EnrollmentRow[]> {
  const ids = (await tx.select({ id: workers.id }).from(workers).where(workerId ? and(eq(workers.companyId, companyId), eq(workers.id, workerId)) : eq(workers.companyId, companyId))).map((r) => r.id);
  if (ids.length === 0) return [];
  return tx.select().from(benefitEnrollments).where(inArray(benefitEnrollments.workerId, ids)).orderBy(asc(benefitEnrollments.id));
}

// Wave 2 (w2-benefits-contractors): reconciliation, open enrollment and contractor payouts, re-exported through the
// demo surface so the seed and the API routes reach them from @weft/core.
export * from "./recon";
export * from "./enrollment";
export * from "../contractors/index";
