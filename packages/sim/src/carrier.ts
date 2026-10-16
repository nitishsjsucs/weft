// The carrier invoice simulator. Owner: w2-benefits-contractors (docs/wave2.md). Writes only sim_carrier_invoices.
// invoice(month) bills the medical, dental and vision enrollments it has on record for the month, at the enrolled tier
// price for each semi-monthly period of coverage, and plants three deterministic billing errors:
//   1. it is never told about terminations, so a worker whose employment ended keeps a full month on the bill;
//   2. it bills the family tier for the first single-coverage medical member with no dependent on file;
//   3. it bills the ee tier for the first family medical enrollment.
// The first call for a (month, carrier) stores the invoice; later calls return the stored one. Fault target carrier.invoice.
import { and, asc, eq } from "drizzle-orm";
import type { CarrierInvoice, CarrierSim, FaultInjector, SimClock } from "@weft/contracts";
import { benefitEnrollments, benefitPlans, simCarrierInvoices, workers, type DbTx } from "@weft/db";
import { firstFault, SimFaultError } from "./faults";
import { mintId } from "./ids";

export const CARRIER_NAME = "Juniper Mutual (sim)";
/** Plan types the carrier invoices (premium plans with coverage tiers). HSA and 401(k) are not premiums. */
export const CARRIER_BILLED_TYPES: readonly string[] = ["medical", "dental", "vision"];
/** Coverage tiers that cover at least one dependent. */
export const DEPENDENT_TIERS: readonly string[] = ["ee_spouse", "ee_children", "family"];
/** The month's semi-monthly periods: 1st to 15th and 16th to month end. */
export function monthPeriods(month: string): { start: string; end: string }[] {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`carrier: month must be YYYY-MM, got ${month}`);
  const [y, m] = month.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return [{ start: `${month}-01`, end: `${month}-15` }, { start: `${month}-16`, end: `${month}-${String(last).padStart(2, "0")}` }];
}

/** One invoice line: the contract's three fields plus the tier the carrier billed and the periods it charged. */
export interface CarrierLine { workerId: string; planId: string; amountCents: number; tier: string; periods: number }
export interface CarrierInvoiceDetail extends CarrierInvoice { id: string; lines: CarrierLine[] }

type Enr = typeof benefitEnrollments.$inferSelect;
type Plan = typeof benefitPlans.$inferSelect;

const priceOf = (plan: Plan, tier: string): number => {
  const prices = JSON.parse(plan.pricesJson) as Record<string, unknown>;
  const v = prices[tier];
  return typeof v === "number" ? v : 0;
};
const inForce = (e: Pick<Enr, "status" | "effectiveFrom" | "effectiveTo">, p: { start: string; end: string }) =>
  e.status !== "pending" && e.effectiveFrom <= p.end && (e.effectiveTo === null || e.effectiveTo >= p.start) && !(e.status === "terminated" && e.effectiveTo === null);

/** Builds the lines deterministically from the carrier's enrollment records (no storage). */
export async function buildCarrierLines(db: DbTx, month: string, carrier = CARRIER_NAME): Promise<CarrierLine[]> {
  const periods = monthPeriods(month);
  const plans = (await db.select().from(benefitPlans).where(eq(benefitPlans.carrier, carrier)).orderBy(asc(benefitPlans.id)))
    .filter((p) => CARRIER_BILLED_TYPES.includes(p.type));
  const planById = new Map(plans.map((p) => [p.id, p]));
  const enr = (await db.select().from(benefitEnrollments).orderBy(asc(benefitEnrollments.workerId), asc(benefitEnrollments.id))).filter((e) => planById.has(e.planId));
  const ended = new Set((await db.select({ id: workers.id, endDate: workers.endDate }).from(workers)).filter((w) => w.endDate !== null).map((w) => w.id));
  const dependents = new Set(enr.filter((e) => e.status === "active" && e.tier !== null && DEPENDENT_TIERS.includes(e.tier)).map((e) => e.workerId));

  const lines: CarrierLine[] = [];
  for (const e of enr) {
    const n = periods.filter((p) => inForce(e, p)).length;
    if (n === 0) continue;
    lines.push({ workerId: e.workerId, planId: e.planId, tier: e.tier ?? "ee", periods: n, amountCents: 0 });
  }
  // Planted errors 2 and 3 (error 1 needs no plant: the carrier bills the enrollment it still has on file).
  const medical = (l: CarrierLine) => planById.get(l.planId)?.type === "medical";
  const single = lines.find((l) => medical(l) && l.tier === "ee" && !dependents.has(l.workerId) && !ended.has(l.workerId));
  if (single) single.tier = "family";
  const family = lines.find((l) => medical(l) && l.tier === "family" && l !== single && !ended.has(l.workerId));
  if (family) family.tier = "ee";
  for (const l of lines) l.amountCents = priceOf(planById.get(l.planId)!, l.tier) * l.periods;
  return lines;
}

/** The stored invoice for a month, or null. */
export async function storedInvoice(db: DbTx, month: string, carrier = CARRIER_NAME): Promise<CarrierInvoiceDetail | null> {
  const row = (await db.select().from(simCarrierInvoices).where(and(eq(simCarrierInvoices.month, month), eq(simCarrierInvoices.carrier, carrier))))[0];
  if (!row) return null;
  return { id: row.id, month: row.month, carrier: row.carrier, lines: JSON.parse(row.linesJson) as CarrierLine[], totalCents: row.totalCents };
}

export interface CarrierSimInternal extends CarrierSim { invoice(month: string): Promise<CarrierInvoiceDetail> }

export function createCarrierSim(db: DbTx, _clock: SimClock, faults: FaultInjector): CarrierSimInternal {
  return {
    async invoice(month) {
      const fault = await firstFault(faults, ["carrier.invoice"]);
      if (fault === "error") throw new SimFaultError("carrier.invoice");
      const existing = await storedInvoice(db, month);
      if (existing) return existing;
      const lines = await buildCarrierLines(db, month);
      const totalCents = lines.reduce((s, l) => s + l.amountCents, 0);
      const id = await mintId(db, "simv_");
      await db.insert(simCarrierInvoices).values({ id, month, carrier: CARRIER_NAME, linesJson: JSON.stringify(lines), totalCents });
      return { id, month, carrier: CARRIER_NAME, lines, totalCents };
    },
  };
}
