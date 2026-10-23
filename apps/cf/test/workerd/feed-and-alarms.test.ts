// Design 3.4 and 3.3: the hibernatable WebSocket change feed ({seq, tables} after every commit, lease frames on reset
// and lease end), agent jobs started inside alarm invocations with at most one live run per invocation, the fetch
// counter (at most 40 per alarm), and scheduler ticks only while the clock runs.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DO_NAMES, LIVE_PING, LIVE_PONG, MAX_FETCHES_PER_ALARM, type LiveMessage } from "../../src/shared/contracts";
import { Harness, type Visitor } from "../support/harness";

let h: Harness;
beforeAll(async () => {
  h = await Harness.start({ poolSize: 10 });
  await h.provision();
});
afterAll(async () => { await h?.close(); });

async function socket(v: Visitor): Promise<{ messages: LiveMessage[]; closed: Promise<number>; ws: WebSocket }> {
  const r = await v.fetch("/api/_live", { headers: { upgrade: "websocket" } });
  expect(r.status).toBe(101);
  const ws = (r as unknown as { webSocket: WebSocket }).webSocket;
  ws.accept();
  const messages: LiveMessage[] = [];
  ws.addEventListener("message", (e) => messages.push(JSON.parse(String(e.data)) as LiveMessage));
  const closed = new Promise<number>((res) => ws.addEventListener("close", (e) => res(e.code)));
  return { messages, closed, ws };
}

async function until<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() - t0 > ms) throw new Error(`condition not met in ${ms} ms: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("WebSocket change feed", () => {
  it("refuses the feed without a lease", async () => {
    expect((await h.visitor().fetch("/api/_live", { headers: { upgrade: "websocket" } })).status).toBe(409);
    const v = h.visitor();
    await v.lease();
    expect((await v.fetch("/api/_live")).status).toBe(426);
  });

  it("sends {seq, tables} after a commit, then a lease frame on reset", async () => {
    const v = h.visitor();
    await v.lease();
    const s = await socket(v);
    await v.fetch("/api/v1/notes", { method: "POST", body: JSON.stringify({ text: "feed me" }) });
    const commits = await until(() => s.messages.filter((m) => m.type === "commit"), (c) => c.length > 0);
    expect(commits[0]).toMatchObject({ type: "commit", tables: ["notes"] });
    expect(commits[0]!.type === "commit" && commits[0]!.seq).toBeGreaterThan(0);
    const r = await v.fetch("/api/v1/sim/reset", { method: "POST", body: "{}" });
    const { gen } = await r.json() as { gen: number };
    const lease = await until(() => s.messages.find((m) => m.type === "lease"), (m) => !!m);
    expect(lease).toEqual({ type: "lease", state: "reset", gen });
    // The slot closes the socket after the frame (code 4001); the local proxy delivers the close event late, so the
    // frame is what this case checks.
    s.ws.close(1000);
  });

  it("answers the tab's keepalive ping with pong (the hibernation auto-response) and ignores anything else", async () => {
    const v = h.visitor();
    await v.lease();
    const r = await v.fetch("/api/_live", { headers: { upgrade: "websocket" } });
    expect(r.status).toBe(101);
    const ws = (r as unknown as { webSocket: WebSocket }).webSocket;
    ws.accept();
    const frames: string[] = [];
    ws.addEventListener("message", (e) => frames.push(String(e.data)));
    ws.send(LIVE_PING);
    await until(() => frames.length, (n) => n === 1);
    // CompanyDO's webSocketMessage ignores every client frame, so only the auto-response can answer.
    ws.send("hello");
    ws.send(LIVE_PING);
    await until(() => frames.length, (n) => n === 2);
    await new Promise((res) => setTimeout(res, 200));
    expect(frames).toEqual([LIVE_PONG, LIVE_PONG]);
    ws.close(1000);
  });

  it("tells the tab when its lease ended", async () => {
    const v = h.visitor();
    const l = await v.lease();
    const s = await socket(v);
    const env = await h.coreEnv();
    await env.LOBBY.get(env.LOBBY.idFromName(DO_NAMES.lobby)).release({ slot: l.slot!, reason: "test" });
    const lease = await until(() => s.messages.find((m) => m.type === "lease"), (m) => !!m);
    expect(lease).toMatchObject({ type: "lease", state: "ended" });
  });
});

describe("alarm-driven runs", () => {
  it("starts queued runs inside alarm invocations, one live run per invocation", async () => {
    const v = h.visitor();
    await v.lease();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await v.json<{ runId: string }>("/api/v1/agent/runs", { method: "POST", body: JSON.stringify({ live: true, fetches: 2 }) });
      expect(r.status).toBe(201);
      ids.push(r.body.runId);
    }
    const runs = await until(async () => Promise.all(ids.map(async (id) => (await v.json<{ status: string; fetches: number }>(`/api/v1/agent/runs/${id}`)).body)), (rs) => rs.every((x) => x.status === "done"));
    expect(runs.map((x) => x.fetches)).toEqual([2, 2, 2]);
    // Each live run had its own invocation: the per-invocation counter never saw two runs' fetches together.
    const env = await h.coreEnv();
    const slot = (await h.ops()).lobby.leases.at(-1)!.slot;
    const counted = await env.COMPANY.get(env.COMPANY.idFromName(slot)).alarmFetches();
    expect(counted.peak).toBeLessThanOrEqual(2);
  });

  it("refuses a run's fetches past 40 in one alarm invocation", async () => {
    const v = h.visitor();
    const l = await v.lease();
    const r = await v.json<{ runId: string }>("/api/v1/agent/runs", { method: "POST", body: JSON.stringify({ live: true, fetches: 45 }) });
    await until(async () => (await v.json<{ status: string }>(`/api/v1/agent/runs/${r.body.runId}`)).body.status, (st) => st === "done");
    const env = await h.coreEnv();
    const counted = await env.COMPANY.get(env.COMPANY.idFromName(l.slot!)).alarmFetches();
    expect(counted.max).toBe(MAX_FETCHES_PER_ALARM);
    expect(counted.peak).toBe(MAX_FETCHES_PER_ALARM);
    expect(counted.peak).toBeLessThanOrEqual(40);
  });

  it("counts a run's fetches through the global fetch too, and refuses them past 40 in one alarm invocation", async () => {
    const v = h.visitor();
    const l = await v.lease();
    const env = await h.coreEnv();
    const co = env.COMPANY.get(env.COMPANY.idFromName(l.slot!));
    const one = await v.json<{ runId: string }>("/api/v1/agent/runs", { method: "POST", body: JSON.stringify({ live: true, fetches: 3, global: true }) });
    await until(async () => (await v.json<{ status: string }>(`/api/v1/agent/runs/${one.body.runId}`)).body.status, (st) => st === "done");
    expect((await co.alarmFetches()).count).toBe(3);
    const many = await v.json<{ runId: string }>("/api/v1/agent/runs", { method: "POST", body: JSON.stringify({ live: true, fetches: 45, global: true }) });
    await until(async () => (await v.json<{ status: string }>(`/api/v1/agent/runs/${many.body.runId}`)).body.status, (st) => st === "done");
    const counted = await co.alarmFetches();
    expect(counted.count).toBe(MAX_FETCHES_PER_ALARM);
    expect(counted.peak).toBe(MAX_FETCHES_PER_ALARM);
    // A fetch outside an alarm invocation (a request) is not charged to any alarm.
    expect((await v.fetch("/api/v1/notes")).status).toBe(200);
    expect((await co.alarmFetches()).count).toBe(MAX_FETCHES_PER_ALARM);
  });

  it("ticks the scheduler from the alarm only while the clock rate is above 0", async () => {
    const v = h.visitor();
    await v.lease();
    const ticks = async () => (await v.json<{ n: number }>("/api/v1/ticks")).body.n;
    await new Promise((r) => setTimeout(r, 300));
    expect(await ticks()).toBe(0);
    await v.fetch("/api/v1/clock", { method: "POST", body: JSON.stringify({ rate: 60 }) });
    await v.fetch("/api/v1/notes");   // a request after the rate change re-arms the alarm
    const n = await until(ticks, (x) => x >= 2);
    expect(n).toBeGreaterThanOrEqual(2);
    await v.fetch("/api/v1/clock", { method: "POST", body: JSON.stringify({ rate: 0 }) });
    await new Promise((r) => setTimeout(r, 200));
    const stopped = await ticks();
    await new Promise((r) => setTimeout(r, 400));
    expect(await ticks()).toBeLessThanOrEqual(stopped + 1);
  });

  it("measures a forced tick and replays the alarm without running a finished job again", async () => {
    const v = h.visitor();
    const l = await v.lease();
    const env = await h.coreEnv();
    const co = env.COMPANY.get(env.COMPANY.idFromName(l.slot!));
    const t = await co.measureTick();
    expect(t.ran).toBe(true);
    expect(t.rowsWritten).toBeGreaterThan(0);   // the fake's tick writes a row; the real engine's warm tick writes none
    const r = await v.json<{ runId: string }>("/api/v1/agent/runs", { method: "POST", body: JSON.stringify({ live: false, fetches: 1 }) });
    await until(async () => (await v.json<{ status: string }>(`/api/v1/agent/runs/${r.body.runId}`)).body.status, (st) => st === "done");
    await co.runAlarmNow();
    await co.runAlarmNow();
    expect((await v.json<{ fetches: number; status: string }>(`/api/v1/agent/runs/${r.body.runId}`)).body).toMatchObject({ status: "done", fetches: 1 });
  });

  it("applies RL_RUN per visitor to model admissions (6 per 60 s)", async () => {
    const v = h.visitor();
    await v.lease();
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await v.fetch("/api/v1/agent/runs", { method: "POST", body: JSON.stringify({ live: false }) })).status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(6);
    expect(statuses.slice(6)).toEqual([429, 429]);
  });
});
