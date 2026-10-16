// syncRail mirrors the payment rail simulator onto contractor_payments (owner: w2-benefits-contractors).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeDb, contractorPayments, events, migrate, openDb, type Db } from "@weft/db";
import type { SimClock } from "@weft/contracts";
import { createSimulators } from "../../../sim/src/index";
import { syncRail } from "../../src/benefits/queries";

let db: Db | null = null; let dir = "";
afterEach(async () => { if (db) await closeDb(db); db = null; rmSync(dir, { recursive: true, force: true }); });
const clockAt = (at: string): SimClock & { at: string } => { const c = { at, now: () => c.at, rate: () => 0, advance: async (to: string) => { c.at = to; }, set: async (to: string) => { c.at = to; } }; return c; };
const payment = (id: string) => ({ id, workerId: "wrk_0049", amountMinor: 650_000, currency: "EUR", fxRate: "1.08", usdCents: 702_000, status: "scheduled", scheduledFor: "2026-10-30", railStatus: "pending", railRef: null, sentAt: null, deliveredAt: null });

describe("syncRail", () => {
  it("moves payouts pending, sent, delivered (paid) and returned (failed), with one sim.rail_delivered per delivery", async () => {
    dir = mkdtempSync(join(tmpdir(), "weft-rail-"));
    db = openDb({ dataDir: dir });
    await migrate(db);
    const clock = clockAt("2026-10-26T15:30:00.000Z");
    const sims = createSimulators({ db, clock });
    await db.insert(contractorPayments).values([payment("cpy_0001"), payment("cpy_0002")]);
    await sims.rail.send({ paymentId: "cpy_0001", amountMinor: 650_000, currency: "EUR", credential: "c" });
    await sims.faults.arm({ target: "rail.send", kind: "return", mode: "once" });
    await sims.rail.send({ paymentId: "cpy_0002", amountMinor: 650_000, currency: "EUR", credential: "c" });
    expect(await syncRail(db, sims, clock.now())).toEqual({ sent: 2, delivered: 0, returned: 0 });
    const rows = async () => (await db!.select().from(contractorPayments)).map((r) => [r.id, r.railStatus, r.status]);
    expect(await rows()).toEqual([["cpy_0001", "sent", "scheduled"], ["cpy_0002", "sent", "scheduled"]]);
    clock.at = "2026-10-28T15:30:00.000Z";
    expect(await syncRail(db, sims, clock.now())).toEqual({ sent: 0, delivered: 1, returned: 1 });
    expect(await rows()).toEqual([["cpy_0001", "delivered", "paid"], ["cpy_0002", "returned", "failed"]]);
    expect(await syncRail(db, sims, clock.now())).toEqual({ sent: 0, delivered: 0, returned: 0 });
    const ev = await db.select().from(events);
    expect(ev.map((e) => [e.type, JSON.parse(e.payloadJson).payment_id])).toEqual([["sim.rail_delivered", "cpy_0001"]]);
  });
});
