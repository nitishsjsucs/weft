// Contract tests for /v1/it and the it.* read commands (owner: t2-world).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { Device, ItAccount, Page } from "@weft/contracts";
import { directCtx, directDeps, ensureTestPrincipals, runDirect } from "@weft/core";
import { createSimulators } from "@weft/sim";
import { createTestWeft, type TestWeft } from "../src/testing";

let weft: TestWeft;
beforeAll(async () => { weft = await createTestWeft(); await ensureTestPrincipals(weft.db); });
afterAll(async () => { await weft.close(); });
const get = (p: string) => weft.app.request(p, { headers: weft.uiHeaders("usr_sam") });

describe("IT (SPEC 5.6)", () => {
  it("every employee has google_ws and chat; Engineering and Hardware also github; each mirrors a sim IdP row", async () => {
    const rows = await weft.db.all<{ system: string; n: number }>(sql`SELECT system, COUNT(*) AS n FROM it_accounts GROUP BY system ORDER BY system`);
    const eh = await weft.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM workers WHERE type = 'employee' AND department_id IN ('dpt_engineering', 'dpt_hardware')`);
    expect(rows).toEqual([{ system: "chat", n: 48 }, { system: "github", n: eh[0]!.n }, { system: "google_ws", n: 48 }]);
    const orphans = await weft.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM it_accounts a LEFT JOIN sim_idp_accounts s ON s.id = a.sim_ref WHERE s.id IS NULL OR s.handle != a.handle`);
    expect(orphans[0]!.n).toBe(0);
  });
  it("routes page accounts and devices", async () => {
    const a = Page(ItAccount).parse(await (await get("/v1/it/accounts?workerId=wrk_0004")).json());
    expect(a.data.map((x) => [x.system, x.handle])).toEqual([["google_ws", "imani.ferreira"], ["chat", "imani.ferreira"], ["github", "lrk-imani-ferreira"]]);
    const d = Page(Device).parse(await (await get("/v1/it/devices?limit=2")).json());
    expect(d).toMatchObject({ hasMore: true, count: 2 });
    expect(d.data[0]!.price).toEqual({ amount: 189_900, currency: "USD", display: "$1,899.00" });
  });
  it("it.list_devices includes the $1,899.00 catalog item", async () => {
    const deps = directDeps(weft.db, weft.clock, createSimulators({ db: weft.db, clock: weft.clock }));
    const out = await runDirect("it.list_devices", { worker_id: "wrk_0004" }, directCtx(weft.clock), deps);
    expect(out.data.catalog).toEqual([{ sku: "lrk-laptop-std", name: "Larkspur standard laptop (sim)", price_cents: 189_900, price_display: "$1,899.00", eta_business_days: 3 }]);
    const acc = await runDirect("it.list_accounts", {}, directCtx(weft.clock), deps);
    expect(acc.data.by_system).toMatchObject({ google_ws: 48, chat: 48 });
    expect(JSON.stringify(acc.data).length).toBeLessThan(8000);
  });
});
