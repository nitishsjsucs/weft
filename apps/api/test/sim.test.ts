// Contract tests for /v1/sim (demo controls) and sim.deliver_notice (owner: t2-world).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { ChatMessageDto } from "@weft/contracts";
import { directCtx, directDeps, directExecutors, ensureTestPrincipals, handlers, runDirect } from "@weft/core";
import { digestDb } from "@weft/seed";
import { createSimulators } from "@weft/sim";
import { createTestWeft, type TestWeft } from "../src/testing";
import { durationMs, nextCronSlot } from "../src/routes/sim";

let weft: TestWeft;
beforeAll(async () => { weft = await createTestWeft(); await ensureTestPrincipals(weft.db); });
afterAll(async () => { await weft.close(); });
const req = (path: string, body?: unknown) => weft.app.request(path, body === undefined ? { headers: weft.uiHeaders("usr_dana") } : { method: "POST", headers: { ...weft.uiHeaders("usr_dana"), "content-type": "application/json" }, body: JSON.stringify(body) });

describe("clock controls", () => {
  it("parses durations and finds the next 09:00 PT weekday slot", () => {
    expect(durationMs("PT30M")).toBe(1_800_000);
    expect(durationMs("P2D")).toBe(172_800_000);
    expect(nextCronSlot("2026-10-26T15:30:00.000Z")).toBe("2026-10-26T16:00:00.000Z");
    expect(nextCronSlot("2026-10-30T16:00:00.000Z")).toBe("2026-11-02T17:00:00.000Z");   // Fri 09:00 PDT to Mon 09:00 PST
  });
  it("GET and advance by, to and toNext", async () => {
    expect(await (await req("/v1/sim/clock")).json()).toEqual({ now: "2026-10-26T15:30:00.000Z", rate: 0 });
    expect(await (await req("/v1/sim/clock/advance", { by: "PT30M" })).json()).toEqual({ now: "2026-10-26T16:00:00.000Z", rate: 0 });
    expect((await (await req("/v1/sim/clock/advance", { toNext: "cron" })).json()).now).toBe("2026-10-27T16:00:00.000Z");
    expect((await req("/v1/sim/clock/advance", { to: "2026-10-01T00:00:00.000Z" })).status).toBe(400);
    const evts = await weft.db.all<{ type: string; payload_json: string }>(sql`SELECT type, payload_json FROM events WHERE type = 'clock.advanced' ORDER BY id`);
    expect(evts.map((e) => JSON.parse(e.payload_json).to)).toEqual(["2026-10-26T16:00:00.000Z", "2026-10-27T16:00:00.000Z"]);
  });
});

describe("faults, chat and state", () => {
  it("arms and disarms faults", async () => {
    const armed = await (await req("/v1/sim/faults", { target: "agency.CO.register", kind: "needs_info", mode: "once" })).json();
    expect(armed).toEqual([{ target: "agency.CO.register", kind: "needs_info", mode: "once", armed: true, firedCount: 0 }]);
    const off = await (await req("/v1/sim/faults", { target: "agency.CO.register", disarm: true })).json();
    expect(off[0].armed).toBe(false);
    expect((await req("/v1/sim/faults", { target: "x", kind: "boom", mode: "once" })).status).toBe(400);
  });
  it("lists the seeded chat feed by channel", async () => {
    const all = (await (await req("/v1/sim/chat")).json()).map((m: unknown) => ChatMessageDto.parse(m));
    expect(all).toHaveLength(6);
    expect(all.every((m: ChatMessageDto) => m.inbound && m.author.endsWith("(demo)"))).toBe(true);
    const nh = await (await req("/v1/sim/chat?channel=%23new-hires")).json();
    expect(nh.map((m: ChatMessageDto) => m.channel)).toEqual(["#new-hires", "#new-hires"]);
    expect((await req("/v1/sim/chat?channel=%23random")).status).toBe(400);
  });
  it("state lists simulator tables without credentials", async () => {
    const res = await req("/v1/sim/state");
    expect(res.status).toBe(200);
    const s = await res.json();
    expect(s.idpAccounts).toBeGreaterThan(96);
    expect(s.catalog[0].priceCents).toBe(189_900);
  });
});

describe("sim.deliver_notice", () => {
  it("stores the hero notice matched to the CA EDD account and emits notice.received", async () => {
    const deps = directDeps(weft.db, weft.clock, createSimulators({ db: weft.db, clock: weft.clock }));
    const out = await runDirect("sim.deliver_notice", { scenario: "ca_de2088_rate_change" }, directCtx(weft.clock, { principal: { id: "usr_dana", kind: "human", role: "admin" }, surface: "human_ui", agentKind: null }), deps);
    expect(out.data).toMatchObject({ agency: "ca_edd", kind: "rate_change", file_name: "CA_EDD_DE2088_2026.txt", tax_account_id: "txa_0002" });
    expect(out.events).toEqual([{ type: "notice.received", subjectRef: out.data.notice_id, payload: { notice_id: out.data.notice_id } }]);
    const n = await (await req(`/v1/notices/${out.data.notice_id}`)).json();
    expect(n).toMatchObject({ status: "new", taxAccountId: "txa_0002", extracted: { accountNumber: "000-4817-2", taxAccountId: "txa_0002", effectiveFrom: "2026-01-01", rates: [{ code: "sui", oldRate: "0.034", newRate: "0.015" }] } });
    expect(n.bodyText).not.toContain("Ignore prior instructions");
  });
});

describe("POST /v1/sim/reset", () => {
  it("rebuilds the world in under 5 s with the same digest as a fresh seed", async () => {
    const fresh = await createTestWeft();
    const expected = await digestDb(fresh.db);
    await fresh.close();
    await req("/v1/sim/faults", { target: "bank.submitBatch", kind: "return", mode: "always" });
    const res = await req("/v1/sim/reset", {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.ms).toBeLessThan(5_000);
    expect(await digestDb(weft.db)).toBe(expected);
    expect(weft.clock.now()).toBe("2026-10-26T15:30:00.000Z");
    await ensureTestPrincipals(weft.db);
  });
});

describe("registration faults through the handlers", () => {
  it("a needs_info fault sets the CO account to needs_info through tax.record_registration", async () => {
    const w2 = await createTestWeft();
    try {
      const d = directExecutors(w2.db, w2.clock, w2.sims);
      await w2.sims.faults.arm({ target: "agency.co_dor.register", kind: "needs_info", mode: "once" });
      const out = await d.human("usr_dana").exec("tax.register_state_account", { tax_account_id: "txa_0006" });
      expect(out).toMatchObject({ ok: true, data: { status: "needs_info" } });
      const evts = await w2.sims.tick(w2.clock.now());
      expect(evts.map((e) => e.type)).toEqual(["sim.registration_needs_info"]);
      const h = handlers.find((x) => x.event === "sim.registration_needs_info")!;
      await h.handle({ id: "evt_x", type: evts[0]!.type, ts: w2.clock.now(), subjectRef: evts[0]!.subjectRef, payload: evts[0]!.payload, attended: false, requestedBy: null }, d.system, d.readOnly);
      const [a] = await w2.db.all<{ status: string }>(sql`SELECT status FROM tax_accounts WHERE id = 'txa_0006'`);
      expect(a!.status).toBe("needs_info");
      const again = await d.human("usr_dana").exec("tax.register_state_account", { tax_account_id: "txa_0006" });
      expect(again).toMatchObject({ ok: true, data: { status: "awaiting_state" } });
    } finally { await w2.close(); }
  });
});
