// The payment rail simulator (wave 2, docs/wave2.md). Owner: w2-benefits-contractors. Writes only sim_* tables; stores vault names, never credentials.
// send() books a transfer as pending (one per payment id, so a retry returns the same ref). tick(now) moves pending
// transfers to sent and delivers sent transfers once RAIL_DELIVERY_BUSINESS_DAYS business days have passed since
// they were booked, returning one sim.rail_delivered per delivery. Fault target rail.send: an "error" fault throws;
// a "return" fault books the transfer to bounce, so it shows sent and then turns returned instead of delivered.
import { and, asc, eq, inArray, lte } from "drizzle-orm";
import type { FaultInjector, PaymentRailSim, SimClock } from "@weft/contracts";
import { simRailTransfers, type DbTx } from "@weft/db";
import { firstFault, SimFaultError } from "./faults";
import { mintId } from "./ids";
import { addBusinessDays } from "./time";

export const RAIL_DELIVERY_BUSINESS_DAYS = 2;
export const RAIL_CURRENCIES: readonly string[] = ["USD", "EUR", "CAD", "INR"];

export type RailTransferRow = typeof simRailTransfers.$inferSelect;
/** Stored transfer states; pending_return and sent_return are a bouncing transfer before it turns returned. */
export const RAIL_TRANSFER_STATES = ["pending", "sent", "delivered", "pending_return", "sent_return", "returned"] as const;
type RailEvent = Awaited<ReturnType<PaymentRailSim["tick"]>>[number];

export interface RailSimInternal extends PaymentRailSim { list(paymentIds?: string[]): Promise<RailTransferRow[]> }

export function createRailSim(db: DbTx, clock: SimClock, faults: FaultInjector): RailSimInternal {
  return {
    async send(req) {
      const fault = await firstFault(faults, ["rail.send"]);
      if (fault === "error") throw new SimFaultError("rail.send");
      const bounce = fault === "return";
      if (!req.paymentId.startsWith("cpy_")) throw new Error(`rail.send: payment id must start with cpy_, got ${req.paymentId}`);
      if (!Number.isInteger(req.amountMinor) || req.amountMinor <= 0) throw new Error("rail.send: amountMinor must be a positive integer");
      if (!RAIL_CURRENCIES.includes(req.currency)) throw new Error(`rail.send: unsupported currency ${req.currency}`);
      if (!req.credential) throw new Error("rail.send: missing credential");
      const existing = (await db.select().from(simRailTransfers).where(eq(simRailTransfers.paymentId, req.paymentId)))[0];
      if (existing) return { railRef: existing.id, status: "pending" as const };
      const id = await mintId(db, "simr_");
      const now = clock.now();
      await db.insert(simRailTransfers).values({
        id, paymentId: req.paymentId, amountMinor: req.amountMinor, currency: req.currency, status: bounce ? "pending_return" : "pending",
        sentAt: now, deliverAt: addBusinessDays(now, RAIL_DELIVERY_BUSINESS_DAYS), deliveredAt: null,
      });
      return { railRef: id, status: "pending" as const };
    },
    async tick(now) {
      const out: RailEvent[] = [];
      const due = await db.select().from(simRailTransfers).where(and(eq(simRailTransfers.status, "sent"), lte(simRailTransfers.deliverAt, now))).orderBy(asc(simRailTransfers.id));
      for (const t of due) {
        await db.update(simRailTransfers).set({ status: "delivered", deliveredAt: now }).where(eq(simRailTransfers.id, t.id));
        out.push({ type: "sim.rail_delivered", subjectRef: t.id, payload: { payment_id: t.paymentId } });
      }
      await db.update(simRailTransfers).set({ status: "returned" }).where(and(eq(simRailTransfers.status, "sent_return"), lte(simRailTransfers.deliverAt, now)));
      await db.update(simRailTransfers).set({ status: "sent" }).where(eq(simRailTransfers.status, "pending"));
      await db.update(simRailTransfers).set({ status: "sent_return" }).where(eq(simRailTransfers.status, "pending_return"));
      return out;
    },
    async list(paymentIds) {
      if (paymentIds && paymentIds.length === 0) return [];
      return db.select().from(simRailTransfers).where(paymentIds ? inArray(simRailTransfers.paymentId, paymentIds) : undefined).orderBy(asc(simRailTransfers.id));
    },
  };
}
