// Payment rail simulator (w2-benefits-contractors): pending on send, sent on the next tick, delivered after two business days.
import { afterEach, describe, expect, it } from "vitest";
import { simRailTransfers } from "@weft/db";
import { createSimulators } from "../src/index";
import { RAIL_DELIVERY_BUSINESS_DAYS } from "../src/rail";
import { CRED, simWorld, type SimTestWorld } from "./helpers";

let w: SimTestWorld | null = null;
afterEach(async () => { await w?.close(); w = null; });

describe("payment rail simulator", () => {
  it("moves a transfer pending, sent, delivered on the sim clock and emits sim.rail_delivered once", async () => {
    w = await simWorld("2026-10-30T16:00:00.000Z");   // Friday 09:00 PT
    const sims = createSimulators({ db: w.db, clock: w.clock });
    const r = await sims.rail.send({ paymentId: "cpy_0001", amountMinor: 650_000, currency: "EUR", credential: CRED });
    expect(r).toEqual({ railRef: "simr_0001", status: "pending" });
    expect(await sims.rail.send({ paymentId: "cpy_0001", amountMinor: 650_000, currency: "EUR", credential: CRED })).toEqual(r);
    expect(await sims.rail.tick(w.clock.now())).toEqual([]);
    const [t] = await w.db.select().from(simRailTransfers);
    expect(t).toMatchObject({ status: "sent", deliverAt: "2026-11-03T17:00:00.000Z" });   // Tue 09:00 PST, two business days later
    expect(RAIL_DELIVERY_BUSINESS_DAYS).toBe(2);
    expect(await sims.rail.tick("2026-11-02T17:00:00.000Z")).toEqual([]);
    expect(await sims.rail.tick("2026-11-03T17:00:00.000Z")).toEqual([{ type: "sim.rail_delivered", subjectRef: "simr_0001", payload: { payment_id: "cpy_0001" } }]);
    expect(await sims.rail.tick("2026-11-04T17:00:00.000Z")).toEqual([]);
    const [d] = await w.db.select().from(simRailTransfers);
    expect(d).toMatchObject({ status: "delivered", deliveredAt: "2026-11-03T17:00:00.000Z" });
  });

  it("refuses bad requests and honors the rail.send fault target", async () => {
    w = await simWorld();
    const sims = createSimulators({ db: w.db, clock: w.clock });
    await expect(sims.rail.send({ paymentId: "pay_1", amountMinor: 1, currency: "EUR", credential: CRED })).rejects.toThrow(/cpy_/);
    await expect(sims.rail.send({ paymentId: "cpy_0002", amountMinor: 0, currency: "EUR", credential: CRED })).rejects.toThrow(/positive/);
    await expect(sims.rail.send({ paymentId: "cpy_0002", amountMinor: 10, currency: "JPY", credential: CRED })).rejects.toThrow(/currency/);
    await sims.faults.arm({ target: "rail.send", kind: "error", mode: "once" });
    await expect(sims.rail.send({ paymentId: "cpy_0002", amountMinor: 10, currency: "USD", credential: CRED })).rejects.toThrow(/rail.send/);
    await expect(sims.rail.send({ paymentId: "cpy_0002", amountMinor: 10, currency: "USD", credential: CRED })).resolves.toMatchObject({ status: "pending" });
  });
});

describe("payment rail simulator returns", () => {
  it("a return fault books a bouncing transfer: sent on the next tick, returned instead of delivered, no delivery event", async () => {
    w = await simWorld("2026-10-30T16:00:00.000Z");
    const sims = createSimulators({ db: w.db, clock: w.clock });
    await sims.faults.arm({ target: "rail.send", kind: "return", mode: "once" });
    await sims.rail.send({ paymentId: "cpy_0009", amountMinor: 980_000, currency: "CAD", credential: CRED });
    expect(await sims.rail.tick(w.clock.now())).toEqual([]);
    expect((await w.db.select().from(simRailTransfers))[0]!.status).toBe("sent_return");
    expect(await sims.rail.tick("2026-11-03T17:00:00.000Z")).toEqual([]);
    expect((await w.db.select().from(simRailTransfers))[0]).toMatchObject({ status: "returned", deliveredAt: null });
  });
});
