// Device vendor simulator: one catalog item, orders with an ETA of 3 sim business days, delivery on tick.
import { and, asc, eq, lte } from "drizzle-orm";
import type { DeviceCatalogItem, DeviceSim, FaultInjector, SimClock, SimEvent } from "@weft/contracts";
import { simDeviceOrders, type DbTx } from "@weft/db";
import { firstFault, SimFaultError } from "./faults";
import { mintId } from "./ids";
import { addBusinessDays } from "./time";

export const DEVICE_CATALOG: readonly DeviceCatalogItem[] = Object.freeze([
  { sku: "lrk-laptop-std", name: "Larkspur standard laptop (sim)", priceCents: 189_900, etaBusinessDays: 3 },
]);

export function catalogItem(sku: string): DeviceCatalogItem | undefined {
  return DEVICE_CATALOG.find((d) => d.sku === sku);
}

/** Wave 2 offboarding addition (w2-offboarding): a remote lock, fault target `devices.lock`. */
export interface DeviceSimOffboarding { lock(req: { workerId: string; deviceId: string; reason: string }): Promise<{ lockRef: string; lockedAt: string }> }

export function createDeviceSim(db: DbTx, clock: SimClock, faults: FaultInjector): DeviceSim & DeviceSimOffboarding {
  return {
    catalog: () => DEVICE_CATALOG.map((d) => ({ ...d })),
    async order(req) {
      const fault = await firstFault(faults, ["devices.order"]);
      if (fault === "error") throw new SimFaultError("devices.order");
      const item = catalogItem(req.sku);
      if (!item) throw new Error(`devices.order: unknown sku ${req.sku}`);
      const orderRef = await mintId(db, "simd_");
      const now = clock.now();
      const eta = addBusinessDays(now, item.etaBusinessDays);
      await db.insert(simDeviceOrders).values({ id: orderRef, workerId: req.workerId, sku: item.sku, shipTo: req.shipTo, priceCents: item.priceCents, status: "ordered", eta, createdAt: now });
      return { orderRef, eta, priceCents: item.priceCents };
    },
    async lock(req) {
      const fault = await firstFault(faults, ["devices.lock"]);
      if (fault === "error") throw new SimFaultError("devices.lock");
      if (!/^dev_[A-Za-z0-9_]+$/.test(req.deviceId)) throw new Error(`devices.lock: invalid device id ${req.deviceId}`);
      // The vendor MDM keeps no state the app reads back: the lock reference and time are the receipt.
      return { lockRef: await mintId(db, "simd_"), lockedAt: clock.now() };
    },
    async tick(now) {
      const out: SimEvent[] = [];
      const due = await db.select().from(simDeviceOrders).where(and(eq(simDeviceOrders.status, "ordered"), lte(simDeviceOrders.eta, now))).orderBy(asc(simDeviceOrders.id));
      for (const o of due) {
        await db.update(simDeviceOrders).set({ status: "delivered" }).where(eq(simDeviceOrders.id, o.id));
        out.push({ type: "sim.device_delivered", subjectRef: o.id, payload: { order_ref: o.id, worker_id: o.workerId } });
      }
      return out;
    },
  };
}
