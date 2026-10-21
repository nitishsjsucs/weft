// Design 11.4 and 3.4: client trust headers are stripped and the front sets its own; the slot-smoke path; the
// showcase memo; health reports the runtime and world; SSE streams through; the hosted routes reach the slot or
// the HostedExtras entrypoint.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DO_NAMES, type PlatformReadout } from "../../src/shared/contracts";
import { Harness } from "../support/harness";

let h: Harness;
beforeAll(async () => {
  h = await Harness.start({ poolSize: 8 });
  await h.provision();
});
afterAll(async () => { await h?.close(); });

type WhoAmI = { headers: Record<string, string>; world: { slot: string; gen: number; mode: string }; envLlm: string | null; provider: string | null };

describe("trust headers", () => {
  it("drops the client's x-weft-proxy, x-weft-ctx, x-weft-smoke and cookies, and sets the proxy secret", async () => {
    const v = h.visitor();
    await v.lease();
    const r = await v.json<WhoAmI>("/api/v1/whoami", { headers: { "x-weft-proxy": "forged", "x-weft-ctx": "forged", "x-weft-smoke": "forged", "x-weft-principal": "usr_dana" } });
    expect(r.status).toBe(200);
    const hd = r.body.headers;
    expect(hd["x-weft-proxy"]).toBe(h.secrets.proxy);
    expect(hd["x-weft-ctx"]).toBeUndefined();
    expect(hd["x-weft-smoke"]).toBeUndefined();
    expect(hd.cookie).toBeUndefined();
    expect(hd["x-weft-principal"]).toBe("usr_dana");
    expect(r.body.world.mode).toBe("slot");
  });

  it("does not route by a forged smoke header", async () => {
    const r = await h.visitor().json<WhoAmI>("/api/v1/whoami", { headers: { "x-weft-smoke": "1792000000." + "0".repeat(64) } });
    expect(r.body.world.slot).toBe(DO_NAMES.showcase);
  });
});

describe("slot-smoke", () => {
  it("serves the smoke header as a human session on slot-smoke with the provider forced to scripted", async () => {
    const r = await h.visitor().json<WhoAmI>("/api/v1/whoami", { headers: await h.smokeHeaders() });
    expect(r.body.world).toMatchObject({ slot: DO_NAMES.smoke, mode: "smoke" });
    expect(r.body.envLlm).toBe("scripted");
    expect(r.body.provider).toBe("scripted");
    const w = await h.visitor().fetch("/api/v1/notes", { method: "POST", body: JSON.stringify({ text: "smoke note" }), headers: await h.smokeHeaders() }, { origin: null });
    expect(w.status).toBe(201);
    const reset = await h.visitor().fetch("/api/v1/sim/reset", { method: "POST", body: "{}", headers: await h.smokeHeaders() }, { origin: null });
    expect(reset.status).toBe(200);
    const after = await h.visitor().json<{ text: string }[]>("/api/v1/notes", { headers: await h.smokeHeaders() });
    expect(after.body.map((n) => n.text)).not.toContain("smoke note");
    // The showcase never sees the smoke world's changes.
    expect((await h.visitor().json<{ text: string }[]>("/api/v1/notes")).body.map((n) => n.text)).not.toContain("smoke note");
  });
});

describe("reads", () => {
  it("adds the runtime and world to /v1/health", async () => {
    const v = h.visitor();
    const l = await v.lease();
    const r = await v.json<{ runtime: string; world: { slot: string; gen: number; mode: string }; ok: boolean }>("/api/v1/health");
    expect(r.body).toMatchObject({ ok: true, runtime: "cloudflare", world: { slot: l.slot, gen: l.gen, mode: "slot" } });
    const s = await h.visitor().json<{ world: { mode: string } }>("/api/v1/health");
    expect(s.body.world.mode).toBe("showcase");
  });

  it("memoizes showcase GETs in the isolate, per principal", async () => {
    const v = h.visitor();
    const a = await v.fetch("/api/v1/notes?memo=1", {}, { principal: "usr_dana" });
    expect(a.headers.get("x-weft-memo")).toBe("miss");
    const b = await v.fetch("/api/v1/notes?memo=1", {}, { principal: "usr_dana" });
    expect(b.headers.get("x-weft-memo")).toBe("hit");
    expect(await b.json()).toEqual(await a.json());
    const c = await v.fetch("/api/v1/notes?memo=1", {}, { principal: "usr_maya" });
    expect(c.headers.get("x-weft-memo")).toBe("miss");
    // Leased worlds are never memoized.
    const l = h.visitor();
    await l.lease();
    expect((await l.fetch("/api/v1/notes?memo=1")).headers.get("x-weft-memo")).toBeNull();
  });

  it("streams SSE through the front", async () => {
    const v = h.visitor();
    await v.lease();
    const r = await v.fetch("/api/v1/agent/runs/run_0001/events");
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    expect(await r.text()).toContain("event: step");
  });

  it("answers 404 outside the API's paths", async () => {
    expect((await h.visitor().fetch("/api/nothing")).status).toBe(404);
  });
});

describe("hosted routes", () => {
  it("reads the Platform readout from the Lobby and SpendDO through HostedExtras", async () => {
    const r = await h.visitor().json<PlatformReadout>("/api/_hosted/platform");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ level: 0, dollars: { spentUsd: 0, dayCapUsd: 2, runCapUsd: 0.1 }, neurons: { used: 0, cap: 5000 }, leases: { pool: 8 }, deadLetters: 0 });
    expect(r.body.restoresLeft).toBeGreaterThanOrEqual(0);
    expect(r.body.shares).toHaveProperty("doRowsWritten");
    expect((await h.visitor().json("/api/_hosted/models")).body).toEqual([]);
    expect((await h.visitor().json("/api/_hosted/help?q=payroll")).body).toMatchObject({ ok: false, code: "HELP_DISABLED" });
  });

  it("gates dictation and PDFs as mutations", async () => {
    expect((await h.visitor().fetch("/api/_hosted/dictate", { method: "POST", body: "x" })).status).toBe(409);
    expect((await h.visitor().fetch("/api/_hosted/pdf/offer_letter/off_1")).status).toBe(409);
    const v = h.visitor();
    await v.lease();
    expect((await v.json("/api/_hosted/dictate", { method: "POST", body: "x" })).body).toMatchObject({ ok: false, code: "DICTATION_DISABLED" });
  });

  it("switches the world's model and mints the lease's MCP key in the slot", async () => {
    const v = h.visitor();
    const l = await v.lease();
    const sw = await v.fetch("/api/_hosted/model", { method: "PUT", body: JSON.stringify({ provider: "workers_ai" }) });
    expect(sw.status).toBe(200);
    expect(await sw.json()).toEqual({ ok: true, provider: "workers_ai" });
    expect((await v.fetch("/api/_hosted/model", { method: "PUT", body: JSON.stringify({ provider: "nope" }) })).status).toBe(400);
    const k = await v.fetch("/api/_hosted/mcp-key", { method: "POST" });
    expect(k.status).toBe(201);
    const key = await k.json() as { key: string; url: string; expiresAt: string };
    expect(key.key).toMatch(new RegExp(`^wk_mcp_${l.slot}_${l.gen}_[A-Za-z0-9]{16,}$`));
    expect(key.url).toBe("http://weft.test/mcp");
    expect((await h.visitor().fetch("/api/_hosted/mcp-key", { method: "POST" })).status).toBe(409);
  });
});
