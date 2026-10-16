// /v1 integrations (w3-integrations-hr): five cards with secret names present or missing and never a value, the
// public webhook receiver (signature over the raw bytes, 1 MB cap, unknown vendor), the human sync, and the
// scheduler path: a failed simulated delivery retries on the sim clock while the 15-minute poll imports the hire.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { commands } from "@weft/core";
import { createTestWeft, type TestWeft } from "../src/testing";

const SECRET_VALUE = "gh-client-secret-do-not-leak-7731";
let weft: TestWeft;
const dir = mkdtempSync(join(tmpdir(), "weft-int-api-"));
const prevFile = process.env.WEFT_SECRETS_FILE;
beforeAll(async () => {
  const f = join(dir, "secrets.env");
  writeFileSync(f, `WEFT_GREENHOUSE_CLIENT_ID=gh-client-id-4410\nWEFT_GREENHOUSE_CLIENT_SECRET=${SECRET_VALUE}\n`);
  process.env.WEFT_SECRETS_FILE = f;
  weft = await createTestWeft();
});
afterAll(async () => {
  await weft.scheduler.tick();
  for (let i = 0; i < 10; i++) {
    const open = await weft.db.all<{ id: string }>(sql`SELECT id FROM routine_runs WHERE status IN ('queued', 'running')`);
    const runs = await weft.db.all<{ id: string }>(sql`SELECT id FROM agent_runs WHERE status IN ('queued', 'running')`);
    if (!open.length && !runs.length) break;
    for (const r of runs) await (weft.agent as unknown as { settled(id: string): Promise<unknown> }).settled(r.id);
    for (const r of open) await (weft.routines as unknown as { settled(id: string): Promise<unknown> }).settled(r.id);
  }
  await weft.close();
  if (prevFile === undefined) delete process.env.WEFT_SECRETS_FILE; else process.env.WEFT_SECRETS_FILE = prevFile;
  rmSync(dir, { recursive: true, force: true });
});
const call = async (method: string, path: string, body?: unknown) => {
  const res = await weft.app.request(path, { method, headers: { ...weft.uiHeaders("usr_dana"), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : null };
};

describe("GET /v1/integrations", () => {
  it("returns five cards, simulated without WEFT_INTEGRATIONS_REAL, with secret names and presence only", async () => {
    const r = await call("GET", "/v1/integrations");
    expect(r.status).toBe(200);
    expect(r.json.map((c: { status: { vendor: string } }) => c.status.vendor)).toEqual(["greenhouse", "workday", "checkr", "hireright", "docusign"]);
    for (const c of r.json) expect(c.status.mode).toBe("simulated");
    const gh = r.json[0];
    expect(gh.secrets).toEqual([
      { name: "WEFT_GREENHOUSE_CLIENT_ID", present: true, optional: false }, { name: "WEFT_GREENHOUSE_CLIENT_SECRET", present: true, optional: false },
      { name: "WEFT_GREENHOUSE_WEBHOOK_SECRET", present: false, optional: true }, { name: "WEFT_GREENHOUSE_BOARD_TOKEN", present: false, optional: true },
    ]);
    expect(gh).toMatchObject({ title: "Greenhouse", ownership: null });
    expect(r.json[1].ownership).toEqual({ people: "weft", compensation: "weft", time_off: "weft" });
    for (const p of ["/v1/integrations", "/v1/integrations/greenhouse", "/v1/sync-items", "/v1/ats/jobs"]) {
      const x = await call("GET", p);
      expect(x.text, p).not.toContain(SECRET_VALUE);
      expect(x.text, p).not.toContain("gh-client-id-4410");
    }
  });
  it("tests the connection and lists open roles from the simulated board", async () => {
    const t = await call("POST", "/v1/integrations/greenhouse/test");
    expect(t.json).toMatchObject({ vendor: "greenhouse", mode: "simulated", health: "ok" });
    const jobs = await call("GET", "/v1/ats/jobs");
    expect(jobs.json.map((j: { name: string }) => j.name)).toEqual(["Firmware Test Engineer (demo)", "Field Operations Lead (demo)", "Controls Engineer (demo)"]);
    expect(jobs.json[0].url).toMatch(/\.example\//);
  });
});

describe("POST /v1/integrations/:vendor/webhook", () => {
  const post = (vendor: string, body: string, headers: Record<string, string> = {}) =>
    weft.app.request(`/v1/integrations/${vendor}/webhook`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  it("is public but refuses a missing or wrong signature, an unknown vendor and a body over 1 MB", async () => {
    expect((await post("greenhouse", '{"action":"ping"}')).status).toBe(401);
    expect((await post("greenhouse", '{"action":"ping"}', { signature: "sha256 " + "a".repeat(64), "greenhouse-event-id": "e-1" })).status).toBe(401);
    const unknown = await post("acme", "{}");
    expect([unknown.status, (await unknown.json())._tag]).toEqual([404, "NotFound"]);
    const big = await post("greenhouse", " ".repeat(1_048_577));
    expect(big.status).toBe(413);
    expect((await weft.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM integration_deliveries`))[0]!.n).toBe(0);
  });
});

describe("sync and polling", () => {
  it("a human sync with nothing new writes only the cursor", async () => {
    const r = await call("POST", "/v1/integrations/greenhouse/sync");
    expect(r.json).toMatchObject({ ok: true, status: "done", data: { vendor: "greenhouse", detected: [] } });
  });
  it("a failed delivery retries on the sim clock while the poll imports the hire once", async () => {
    await weft.clock.set("2026-10-26T17:00:00.000Z", 0);   // past the 15-minute poll window of the sync above
    await call("POST", "/v1/sim/faults", { target: "greenhouse.webhook", kind: "error", mode: "once" });
    const sim = await call("POST", "/v1/integrations/greenhouse/simulate", { kind: "hire" });
    expect(sim.json.data.deliveries).toEqual([expect.objectContaining({ status: 503, outcome: "pending" })]);
    expect(sim.json.data.weft_offer_id).toBeTruthy();   // the kick ran the poll: sync_now detected the hire
    const acts = await weft.db.all<{ command: string; actor_id: string }>(sql`SELECT command, actor_id FROM actions WHERE command LIKE 'integrations.%' ORDER BY seq`);
    expect(acts.map((a) => `${a.command} ${a.actor_id}`)).toEqual([
      "integrations.sync_now usr_dana", "integrations.sync_now svc_scheduler", "integrations.record_ats_hire svc_events",
    ]);
    // One minute later the retry delivers; the receiver stores it and the re-read finds the hire already linked.
    await weft.clock.set("2026-10-26T17:01:00.000Z", 0);
    await weft.scheduler.tick();
    await weft.scheduler.tick();
    const [row] = await weft.db.all<{ status: string; attempt: number }>(sql`SELECT status, attempt FROM sim_webhook_outbox ORDER BY id DESC LIMIT 1`);
    expect(row).toEqual({ status: "delivered", attempt: 2 });
    expect((await weft.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM ext_links WHERE vendor = 'greenhouse'`))[0]!.n).toBe(1);
    const [d] = await weft.db.all<{ applied_at: string | null; action: string }>(sql`SELECT applied_at, action FROM integration_deliveries`);
    expect(d).toMatchObject({ action: "hire_candidate" });
    expect(d!.applied_at).toBeTruthy();
  });
});

describe("registry rules for the w3-integrations-hr commands", () => {
  it("risk, approval and access follow W3_PLANNED_COMMANDS", () => {
    const mine = commands.filter((c) => /^(integrations|ats|hris)\./.test(c.name));
    const row = (n: string) => { const c = mine.find((x) => x.name === n)!; return [c.risk({} as never), c.approval, c.access]; };
    expect(row("integrations.status")).toEqual(["R0", "never", "all"]);
    expect(row("integrations.sync_now")).toEqual(["R1", "never", "all"]);
    expect(row("integrations.map_value")).toEqual(["R2", "always", "all"]);
    expect(row("integrations.record_ats_hire")).toEqual(["R1", "never", "system_only"]);
    expect(row("integrations.record_delivery")).toEqual(["R1", "never", "system_only"]);
    expect(row("integrations.resolve_sync_item")).toEqual(["R2", "never", "human_only"]);
    for (const c of mine) {
      expect(c.description.length, c.name).toBeLessThanOrEqual(400);
      if (c.access === "all" && c.risk({} as never) >= "R2") expect(c.preview, c.name).not.toBeNull();
      if (c.access !== "all") expect([c.mcp, c.tiers], c.name).toEqual(["hidden", { main: "unavailable", task: "unavailable" }]);
    }
    expect(mine.find((c) => c.name === "ats.get_hire")!.untrustedFields).toEqual(["hire.first", "hire.last", "hire.email"]);
  });
});
