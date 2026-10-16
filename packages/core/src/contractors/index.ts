// Contractor payouts (wave 2, GP11). Owner: w2-benefits-contractors. Monthly contract amounts come from pay_rates
// (kind contract_monthly) in the contractor's currency; conversion uses the fixed fx_rates table (seeded from
// packages/sim/src/fx.ts) with decimal.js rounding half up to whole USD cents. Approval of
// contractors.schedule_payouts books each payment on the payment rail simulator; syncRail() mirrors the rail's
// pending, sent and delivered states onto contractor_payments and emits sim.rail_delivered.
import { and, asc, desc, eq, inArray, lte } from "drizzle-orm";
import { dec, roundCents } from "@weft/payroll-tax";
import type { ContractorPayout, RailStatus, Simulators } from "@weft/contracts";
import { contractorPayments, fxRates, payRates, simRailTransfers, workers, type DbTx } from "@weft/db";
import { emitBenefitsWave2Event } from "./events";


export const PAYOUT_CREDENTIAL_REF = "vault:sim-bank-operating" as const;
export type ContractorPaymentRow = typeof contractorPayments.$inferSelect;
export type FxRateRow = typeof fxRates.$inferSelect;

/** minor units x USD per unit, rounded half up to whole USD cents (both sides have two minor digits). */
export function convertToUsdCents(amountMinor: number, usdPerUnit: string): number {
  if (!Number.isInteger(amountMinor)) throw new Error(`convertToUsdCents: not an integer ${amountMinor}`);
  return roundCents(dec(amountMinor).times(dec(usdPerUnit)));
}

export async function listFxRates(tx: DbTx): Promise<FxRateRow[]> {
  return tx.select().from(fxRates).orderBy(asc(fxRates.currency), asc(fxRates.asOf));
}

/** The latest fixed rate on or before `asOf` for a currency, or null. */
export async function fxRateFor(tx: DbTx, currency: string, asOf: string): Promise<FxRateRow | null> {
  return (await tx.select().from(fxRates).where(and(eq(fxRates.currency, currency), lte(fxRates.asOf, asOf))).orderBy(desc(fxRates.asOf)).limit(1))[0] ?? null;
}

export function toPayoutDto(r: ContractorPaymentRow): ContractorPayout {
  return {
    id: r.id, workerId: r.workerId, amountMinor: r.amountMinor, currency: r.currency, fxRate: r.fxRate, usdCents: r.usdCents,
    railStatus: (r.railStatus ?? "pending") as RailStatus, railRef: r.railRef, scheduledFor: r.scheduledFor, sentAt: r.sentAt, deliveredAt: r.deliveredAt,
  };
}

export async function listPayouts(tx: DbTx, companyId: string, opts: { workerId?: string; status?: string } = {}): Promise<ContractorPaymentRow[]> {
  const ids = (await tx.select({ id: workers.id }).from(workers).where(and(eq(workers.companyId, companyId), eq(workers.type, "contractor")))).map((w) => w.id);
  if (ids.length === 0) return [];
  const conds = [inArray(contractorPayments.workerId, opts.workerId ? ids.filter((i) => i === opts.workerId) : ids)];
  if (opts.status) conds.push(eq(contractorPayments.railStatus, opts.status));
  return tx.select().from(contractorPayments).where(and(...conds)).orderBy(asc(contractorPayments.id));
}

export interface PayoutLine { workerId: string; name: string; currency: string; amountMinor: number; fxRate: string; usdCents: number }
export type PayoutPlan = { ok: true; lines: PayoutLine[]; totalUsdCents: number } | { ok: false; code: string; message: string };

/** Builds the payout lines from DB rows only: active contractors, their contract_monthly rate on `scheduledFor`, the fixed FX rate. */
export async function planPayouts(tx: DbTx, companyId: string, workerIds: string[], scheduledFor: string): Promise<PayoutPlan> {
  const unique = [...new Set(workerIds)].sort();
  if (unique.length === 0) return { ok: false, code: "DOMAIN_NO_CONTRACTORS", message: "Pick at least one contractor" };
  const rows = await tx.select().from(workers).where(and(eq(workers.companyId, companyId), inArray(workers.id, unique)));
  const lines: PayoutLine[] = [];
  for (const id of unique) {
    const w = rows.find((r) => r.id === id);
    if (!w || w.type !== "contractor") return { ok: false, code: "DOMAIN_NOT_CONTRACTOR", message: `${id} is not a contractor in this company` };
    if (w.status !== "active") return { ok: false, code: "DOMAIN_NOT_ACTIVE", message: `${id} is not active` };
    const rates = (await tx.select().from(payRates).where(and(eq(payRates.workerId, id), eq(payRates.kind, "contract_monthly"))).orderBy(desc(payRates.effectiveFrom), desc(payRates.id)))
      .filter((r) => r.effectiveFrom <= scheduledFor && (r.effectiveTo === null || r.effectiveTo >= scheduledFor));
    const rate = rates[0];
    if (!rate) return { ok: false, code: "DOMAIN_NO_RATE", message: `${id} has no contract rate on ${scheduledFor}` };
    const fx = await fxRateFor(tx, rate.currency, scheduledFor);
    if (!fx) return { ok: false, code: "DOMAIN_NO_FX_RATE", message: `No fixed FX rate for ${rate.currency}` };
    lines.push({ workerId: id, name: `${w.firstName} ${w.lastName} (demo)`, currency: rate.currency, amountMinor: rate.amountCents, fxRate: fx.usdPerUnit, usdCents: convertToUsdCents(rate.amountCents, fx.usdPerUnit) });
  }
  const dup = await tx.select({ id: contractorPayments.id, workerId: contractorPayments.workerId }).from(contractorPayments).where(and(inArray(contractorPayments.workerId, unique), eq(contractorPayments.scheduledFor, scheduledFor)));
  if (dup.length > 0) return { ok: false, code: "DOMAIN_ALREADY_SCHEDULED", message: `${dup[0]!.workerId} already has a payout for ${scheduledFor} (${dup[0]!.id})` };
  return { ok: true, lines, totalUsdCents: lines.reduce((s, l) => s + l.usdCents, 0) };
}

/** Ticks the rail simulator at `now` and mirrors transfer states onto contractor_payments. Idempotent. */
export async function syncRail(tx: DbTx, sims: Pick<Simulators, "rail">, now: string, stamp: { attended: boolean; requestedBy: string | null } = { attended: false, requestedBy: null }) {
  const delivered = await sims.rail.tick(now);
  const open = await tx.select().from(contractorPayments).where(inArray(contractorPayments.railStatus, ["pending", "sent"]));
  if (open.length === 0) return { sent: 0, delivered: 0, returned: 0 };
  const transfers = new Map((await tx.select().from(simRailTransfers).where(inArray(simRailTransfers.paymentId, open.map((p) => p.id)))).map((t) => [t.paymentId, t]));
  let sent = 0, done = 0, returned = 0;
  for (const p of open) {
    const t = transfers.get(p.id);
    if (!t) continue;
    if (t.status === "delivered") {
      await tx.update(contractorPayments).set({ railStatus: "delivered", status: "paid", sentAt: p.sentAt ?? t.sentAt, deliveredAt: t.deliveredAt ?? now, railRef: t.id }).where(eq(contractorPayments.id, p.id));
      done++;
    } else if ((t.status === "sent" || t.status === "sent_return") && p.railStatus === "pending") {
      await tx.update(contractorPayments).set({ railStatus: "sent", sentAt: now, railRef: t.id }).where(eq(contractorPayments.id, p.id));
      sent++;
    } else if (t.status === "returned") {
      await tx.update(contractorPayments).set({ railStatus: "returned", status: "failed", sentAt: p.sentAt ?? t.sentAt, railRef: t.id }).where(eq(contractorPayments.id, p.id));
      returned++;
    }
  }
  for (const e of delivered) {
    if (open.some((p) => p.id === e.payload.payment_id)) await emitBenefitsWave2Event(tx, now, { type: "sim.rail_delivered", payload: { payment_id: e.payload.payment_id! } }, e.payload.payment_id!, stamp);
  }
  return { sent, delivered: done, returned };
}
