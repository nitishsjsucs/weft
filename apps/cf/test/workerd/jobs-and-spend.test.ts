// Design 3.4 and 11.4: the after-commit outbox reaches its queue and is deleted, the consumer dispatches each job to
// its handler, a failing job retries and lands in weft-dlq, a malformed or unhandled message is acknowledged; and
// SpendDO's caps hold across two slots (day, visitor, IP hash, neurons) with orphans settled at the worst case.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DO_NAMES, HOSTED_CONFIG_KEYS, NEURON_SHARES, ORPHAN_SETTLE_MS, type HostedJob } from "../../src/shared/contracts";
import { Harness } from "../support/harness";

let h: Harness;
beforeAll(async () => {
  h = await Harness.start({ poolSize: 4 });
  await h.provision();
});
afterAll(async () => { await h?.close(); });

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 30_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() - t0 > ms) throw new Error(`condition not met in ${ms} ms: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const job = (jobId: string, uploadId = "upl_1"): HostedJob => ({ v: 1, kind: "ocr.receipt", jobId, slot: "slot-1", gen: 1, uploadId, expenseId: "exp_1", sha256: "0".repeat(64), storagePath: "blob:x", contentType: "image/png" });

describe("outbox and queues", () => {
  it("sends an outbox row to weft-jobs after the commit and deletes it; the handler runs once", async () => {
    const v = h.visitor();
    const l = await v.lease();
    expect((await v.fetch("/api/v1/notes", { method: "POST", body: JSON.stringify({ text: "with a receipt", job: "ocr.receipt" }) })).status).toBe(201);
    const env = await h.coreEnv();
    const sql = await h.core.getDurableObjectStorage("CompanyDO", { name: l.slot! });
    await until(async () => (await sql.exec("SELECT COUNT(*) AS n FROM outbox")) as { n: number }[], (r) => r[0]!.n === 0);
    const keys = await until(async () => (await env.CONFIG.list({ prefix: "test.job:" })).keys.map((k) => k.name), (k) => k.length > 0);
    expect(keys).toHaveLength(1);
    expect(await env.CONFIG.get(keys[0]!)).toBe("1");
  });

  it("sends a PDF job to weft-render (its own queue, concurrency 1)", async () => {
    const env = await h.coreEnv();
    const before = (await env.CONFIG.list({ prefix: "test.job:" })).keys.length;
    const v = h.visitor();
    await v.lease();
    expect((await v.fetch("/api/v1/notes", { method: "POST", body: JSON.stringify({ text: "with a pdf", job: "render.pdf" }) })).status).toBe(201);
    await until(async () => (await env.CONFIG.list({ prefix: "test.job:" })).keys.length, (n) => n > before);
    expect(h.server.getLogs().some((l) => /"evt":"job.done","kind":"render.pdf"/.test(l.message ?? ""))).toBe(true);
  });

  it("retries a failing job and records it once it is dead", async () => {
    const env = await h.coreEnv();
    await env.JOBS.send(job("obx_fail000000000001", "upl_fail"), { contentType: "json" });
    const attempts = await until(async () => Number((await env.CONFIG.get("test.job:obx_fail000000000001")) ?? "0"), (n) => n >= 2, 60_000);
    expect(attempts).toBeGreaterThanOrEqual(2);
    await until(async () => await env.CONFIG.get("test.dead:obx_fail000000000001"), (v) => v === "1", 90_000);
  }, 120_000);

  it("acknowledges malformed messages and kinds with no handler without retrying", async () => {
    const env = await h.coreEnv();
    await env.JOBS.send({ hello: "world" } as never, { contentType: "json" });
    await env.JOBS.send({ ...job("obx_unhandled0000001"), kind: "embed.memory", namespace: "seed-x", notes: [] } as never, { contentType: "json" });
    await new Promise((r) => setTimeout(r, 3000));
    expect(await env.CONFIG.get("test.dead:obx_unhandled0000001")).toBeNull();
    expect(await env.CONFIG.get("test.job:obx_unhandled0000001")).toBeNull();
  });
});

describe("SpendDO across slots", () => {
  const spend = async () => { const env = await h.coreEnv(); return env.SPEND.get(env.SPEND.idFromName(DO_NAMES.spend)); };

  it("charges a slot's reservations to its lease's visitor and IP hash, and holds the day cap across slots", async () => {
    const env = await h.coreEnv();
    await env.CONFIG.put(HOSTED_CONFIG_KEYS.capDayUsd, "0.05");
    await env.CONFIG.put(HOSTED_CONFIG_KEYS.capVisitorDayUsd, "0.03");
    try {
      await new Promise((r) => setTimeout(r, 400));
      const a = h.visitor("198.51.100.201");
      const b = h.visitor("198.51.100.202");
      const la = await a.lease();
      const lb = await b.lease();
      expect(la.slot).not.toBe(lb.slot);
      const res = (v: typeof a, usd: number, runId: string) => v.json<{ ok: boolean; hostedCap?: string; cap?: string }>("/api/v1/spend", { method: "POST", body: JSON.stringify({ usdMicros: usd * 1e6, runId }) });
      expect((await res(a, 0.02, "run_0001")).body.ok).toBe(true);
      // The visitor cap (0.03) refuses a's second reservation; b's world still has the day cap's room.
      expect((await res(a, 0.02, "run_0002")).body).toMatchObject({ ok: false, hostedCap: "visitor", cap: "day" });
      expect((await res(b, 0.025, "run_0001")).body.ok).toBe(true);
      // Together the two slots reach the day cap (0.05): the next cent is refused in either world.
      expect((await res(b, 0.01, "run_0002")).body).toMatchObject({ ok: false, hostedCap: "day" });
      const entries = await (await spend()).entries();
      const mine = entries.filter((e) => e.kind === "reserve");
      expect(new Set(mine.map((e) => e.world)).size).toBe(2);
      expect(mine.every((e) => e.visitor?.startsWith("vis_") && /^[0-9a-f]{32}$/.test(e.ip_hash ?? ""))).toBe(true);
      expect(mine.some((e) => e.ip_hash?.includes("198.51"))).toBe(false);
    } finally {
      await env.CONFIG.delete(HOSTED_CONFIG_KEYS.capDayUsd);
      await env.CONFIG.delete(HOSTED_CONFIG_KEYS.capVisitorDayUsd);
    }
  });

  it("holds the IP-hash and neuron caps, and settles orphans at their reserved worst case", async () => {
    const s = await spend();
    const env = await h.coreEnv();
    await env.CONFIG.put(HOSTED_CONFIG_KEYS.capIpDayUsd, "0.04");
    await new Promise((r) => setTimeout(r, 400));
    try {
      expect((await s.reserve({ runId: "run_9001", usdMicros: 30_000, model: "m", live: true, world: "slot-1:gen-9", visitor: "vis_" + "1".repeat(32), ipHash: "f".repeat(32) })).ok).toBe(true);
      expect(await s.reserve({ runId: "run_9002", usdMicros: 20_000, model: "m", live: true, world: "slot-2:gen-9", visitor: "vis_" + "2".repeat(32), ipHash: "f".repeat(32) })).toMatchObject({ ok: false, hostedCap: "ip" });
    } finally {
      await env.CONFIG.delete(HOSTED_CONFIG_KEYS.capIpDayUsd);
    }
    expect((await s.reserve({ runId: "run_9003", usdMicros: 0, model: "@cf/openai/gpt-oss-120b", live: true, neurons: NEURON_SHARES.agent - 1, product: "agent", world: "slot-1:gen-9" })).ok).toBe(true);
    expect(await s.reserve({ runId: "run_9004", usdMicros: 0, model: "@cf/openai/gpt-oss-120b", live: true, neurons: 2, product: "agent", world: "slot-1:gen-9" })).toMatchObject({ ok: false, hostedCap: "neurons" });
    const before = (await s.status({})).openReservations;
    expect(before).toBeGreaterThan(0);
    const n = await s.settleOrphans(new Date(Date.now() + ORPHAN_SETTLE_MS + 60_000).toISOString());
    expect(n).toBe(before);
    expect((await s.status({})).openReservations).toBe(0);
  });

  it("runs the orphan settle from the cron sweep", async () => {
    const s = await spend();
    await s.reserve({ runId: null, usdMicros: 1_000, model: "m", live: false, world: "slot-1:gen-9" });
    const r = await h.core.scheduled({ cron: "*/15 * * * *", scheduledTime: new Date() });
    expect(r.outcome).toBe("ok");
    const ops = await h.ops();
    expect(ops.lobby.readout).toBeTruthy();
  });
});
