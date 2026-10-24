// Contract tests for /v1/sim (demo controls) and sim.deliver_notice (owner: t2-world).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { ChatMessageDto } from "@weft/contracts";
import { directCtx, directDeps, directExecutors, ensureTestPrincipals, handlers, runDirect } from "@weft/core";
import { digestDb } from "@weft/seed";
import { createSimulators } from "@weft/sim";
import { createWeft } from "../src/compose";
import { createTestWeft, type TestWeft } from "../src/testing";
import { durationMs, nextCronSlot, resetWorld } from "../src/routes/sim";
import { SEED_CHAT } from "../../../packages/seed/src/it";

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
    // The clock test above moved past Mon 09:00, so the people digest routine may have posted to #people-ops; the six
    // seeded messages are the inbound ones.
    const all = (await (await req("/v1/sim/chat")).json()).map((m: unknown) => ChatMessageDto.parse(m)).filter((m: ChatMessageDto) => m.inbound);
    expect(all).toHaveLength(6);
    const authors = new Set<string>(SEED_CHAT.map((m) => m.author));
    expect(all.every((m: ChatMessageDto) => m.inbound && authors.has(m.author))).toBe(true);
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

  it("drops every Weft table but never workerd's reserved _cf_ tables", async () => {
    // workerd keeps its own _cf_KV in an object's database and refuses every statement on it (cf-db.ts
    // RESERVED_TABLE_PREFIX). It is created outside Weft's SQL, so the stand-in is made the same way, before the world
    // opens; the emulator (WEFT_DB=durable-emu) refuses a DROP of it as workerd does.
    const dataDir = mkdtempSync(join(tmpdir(), "weft-reset-reserved-"));
    const file = join(dataDir, "weft.db");
    try {
      const raw = new DatabaseSync(file);
      try { raw.exec(`CREATE TABLE "_cf_KV" (key TEXT PRIMARY KEY, value BLOB); INSERT INTO "_cf_KV" (key, value) VALUES ('k', x'00ff');`); } finally { raw.close(); }
      const w = await createWeft({ dataDir, testMode: true });
      try {
        await resetWorld(w);
        expect(await w.db.all(sql`SELECT name FROM sqlite_master WHERE name = '_cf_KV'`)).toEqual([{ name: "_cf_KV" }]);
        expect((await w.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM workers`))[0]!.n).toBeGreaterThan(0);
      } finally { await w.close(); }
      const after = new DatabaseSync(file);
      try { expect(after.prepare(`SELECT key, hex(value) AS value FROM "_cf_KV"`).all()).toEqual([{ key: "k", value: "00FF" }]); } finally { after.close(); }
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
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

describe("partial registration (SPEC 9.7)", () => {
  it("one active CO account leaves state_registration pending; a repeated completion is idempotent", async () => {
    const w3 = await createTestWeft();
    try {
      await ensureTestPrincipals(w3.db);
      const d = directExecutors(w3.db, w3.clock, w3.sims);
      const dana = d.human("usr_dana");
      const accepted = await dana.exec("people.accept_offer", { offer_id: "offr_0001" });
      if (!accepted.ok || accepted.status !== "done") throw new Error(JSON.stringify(accepted));
      const noor = (accepted.data as { worker_id: string }).worker_id;
      expect(await dana.exec("tax.register_state_account", { tax_account_id: "txa_0007" })).toMatchObject({ ok: true, data: { status: "awaiting_state" } });

      await w3.clock.advance("2026-10-28T15:30:00.000Z");   // 2 business days after Mon 08:30 PT
      const evts = await w3.sims.tick(w3.clock.now());
      expect(evts.map((e) => e.type)).toEqual(["sim.registration_completed"]);
      const deliver = async (type: string, payload: Record<string, string>, subjectRef: string) => {
        for (const h of handlers.filter((x) => x.event === type)) await h.handle({ id: "evt_t2x", type, ts: w3.clock.now(), subjectRef, payload, attended: false, requestedBy: null }, d.system, d.readOnly);
      };
      await deliver(evts[0]!.type, evts[0]!.payload, evts[0]!.subjectRef);
      await deliver(evts[0]!.type, evts[0]!.payload, evts[0]!.subjectRef);   // a duplicate event changes nothing
      const co = await w3.db.all<{ id: string; status: string }>(sql`SELECT id, status FROM tax_accounts WHERE jurisdiction = 'CO' ORDER BY id`);
      expect(co).toEqual([{ id: "txa_0006", status: "not_registered" }, { id: "txa_0007", status: "active" }]);
      const confirmed = await w3.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM notices WHERE kind = 'registration_confirmed'`);
      expect(confirmed[0]!.n).toBe(1);
      const rates = await w3.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM employer_tax_rates WHERE jurisdiction = 'CO'`);
      expect(rates[0]!.n).toBe(1);

      await deliver("tax_account.activated", { tax_account_id: "txa_0007", worker_ids: noor }, "txa_0007");
      const task = await w3.db.all<{ status: string }>(sql`SELECT status FROM onboarding_tasks WHERE worker_id = ${noor} AND kind = 'state_registration'`);
      expect(task).toEqual([{ status: "pending" }]);
      const early = await d.system.exec("svc_events", "onboarding.complete_task", { worker_id: noor, kind: "state_registration" }, { eventId: null, attended: false, requestedBy: null });
      expect(early).toMatchObject({ ok: false, refusal: { code: "DOMAIN_REGISTRATION_INCOMPLETE", message: "CO registrations not active: txa_0006 not_registered" } });
    } finally { await w3.close(); }
  });
});
