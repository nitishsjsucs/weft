// weft.close() during an in-flight routine run (owner: w2-reliability, gate report item 1). close() drains the agent
// queue and the routines engine's pending finalizations within a bound, and a background write that still lands after
// the database closed is caught, so no CLIENT_CLOSED rejection goes unhandled.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentRuns, closeDb, openDb, proposals, routineRuns, runSteps } from "@weft/db";
import { seedWorld } from "@weft/seed";
import { createWeft } from "../src/compose";
import { createTestWeft, type TestWeft } from "../src/testing";

const unhandled: unknown[] = [];
const onUnhandled = (e: unknown) => { unhandled.push(e); };
beforeEach(() => { unhandled.length = 0; process.on("unhandledRejection", onUnhandled); });
afterEach(() => { process.off("unhandledRejection", onUnhandled); });

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function startNoticeRun(weft: Pick<TestWeft, "app" | "uiHeaders" | "scheduler" | "db">): Promise<string> {
  const res = await weft.app.request("/v1/sim/notices/deliver", {
    method: "POST", headers: { ...weft.uiHeaders("usr_dana"), "content-type": "application/json" }, body: JSON.stringify({ scenario: "ca_de2088_rate_change" }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  for (let i = 0; i < 10; i++) {
    await weft.scheduler.tick();
    const [rr] = await weft.db.select().from(routineRuns).where(eq(routineRuns.routineId, "rt_agency_notice"));
    if (rr?.agentRunId) return rr.id;
  }
  throw new Error("no agency notice routine run after delivering the notice");
}

describe("weft.close()", () => {
  it("resolves during an in-flight routine run with no unhandled rejection", async () => {
    const weft = await createTestWeft();
    const routineRunId = await startNoticeRun(weft);
    // The agent run is queued or running right now; close without waiting for it.
    await expect(weft.close()).resolves.toBeUndefined();
    await pause(300);
    expect(unhandled.map(String)).toEqual([]);
    expect(routineRunId).toMatch(/^rtr_/);
  });

  it("finishes the in-flight run's routine finalization before the database closes", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "weft-close-"));
    try {
      const weft = await createWeft({ dataDir, testMode: true });
      await seedWorld(weft);
      await weft.clock.set("2026-10-26T15:30:00.000Z", 0);
      const routineRunId = await startNoticeRun(Object.assign(weft, { uiHeaders: (p: string) => ({ "x-weft-principal": p, "x-weft-proxy": weft.proxySecret }) }));
      await weft.close();
      await pause(100);
      const db = openDb({ dataDir });
      const [rr] = await db.select().from(routineRuns).where(eq(routineRuns.id, routineRunId));
      await closeDb(db);
      // The scripted agency notice run proposes two changes and waits; the drain recorded that on the routine run.
      expect(rr?.status).toBe("waiting_approval");
      expect(unhandled.map(String)).toEqual([]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("catches the late writes of a run that outlives a zero drain bound", async () => {
    const prev = process.env.WEFT_CLOSE_DRAIN_MS;
    process.env.WEFT_CLOSE_DRAIN_MS = "0";
    try {
      const dataDir = mkdtempSync(join(tmpdir(), "weft-close-"));
      const weft = await createWeft({ dataDir, testMode: true });
      await seedWorld(weft);
      await weft.clock.set("2026-10-26T15:30:00.000Z", 0);
      await startNoticeRun(Object.assign(weft, { uiHeaders: (p: string) => ({ "x-weft-principal": p, "x-weft-proxy": weft.proxySecret }) }));
      await weft.close();
      // The scripted run keeps going against a closed database; every write it attempts must be caught.
      await pause(800);
      expect(unhandled.map(String)).toEqual([]);
      rmSync(dataDir, { recursive: true, force: true });
    } finally {
      if (prev === undefined) delete process.env.WEFT_CLOSE_DRAIN_MS; else process.env.WEFT_CLOSE_DRAIN_MS = prev;
    }
  });

  it("drains a finalization that starts at the moment close() is called", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "weft-close-"));
    const weft = await createWeft({ dataDir, testMode: true });
    await seedWorld(weft);
    await weft.clock.set("2026-10-26T15:30:00.000Z", 0);
    // Call close() from inside the terminal-step callback, just before the routines engine starts its finalization,
    // which is the race the gate report saw (CLIENT_CLOSED from a background read after the database closed).
    let closing: Promise<void> | null = null;
    const agent = weft.agent as { subscribe: (id: string, cb: (s: { stage: string }) => void) => () => void };
    const subscribe = agent.subscribe.bind(agent);
    agent.subscribe = (id, cb) => subscribe(id, (s) => { if (s.stage === "terminal" && !closing) closing = weft.close(); cb(s); });
    const routineRunId = await startNoticeRun(Object.assign(weft, { uiHeaders: (p: string) => ({ "x-weft-principal": p, "x-weft-proxy": weft.proxySecret }) }));
    for (let i = 0; i < 50 && !closing; i++) await pause(20);
    expect(closing).not.toBeNull();
    await closing;
    await pause(200);
    const db = openDb({ dataDir });
    const [rr] = await db.select().from(routineRuns).where(eq(routineRuns.id, routineRunId));
    await closeDb(db);
    expect(rr?.status).toBe("waiting_approval");
    expect(unhandled.map(String)).toEqual([]);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("is idempotent", async () => {
    const weft = await createTestWeft({ seed: false });
    await weft.close();
    await expect(weft.close()).resolves.toBeUndefined();
  });
});

// Gate report item 2: a waiting routine run keeps its trigger and handle across an API restart (two createWeft
// instances on one data dir) and completes after approval in the second process.
describe("restart survival", () => {
  it("a waiting routine run survives a restart and completes after approval", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "weft-restart-"));
    const ui = (w: { proxySecret: string }) => (p: string) => ({ "x-weft-principal": p, "x-weft-proxy": w.proxySecret });
    try {
      const first = await createWeft({ dataDir, testMode: true });
      await seedWorld(first);
      await first.clock.set("2026-10-26T15:30:00.000Z", 0);
      const routineRunId = await startNoticeRun(Object.assign(first, { uiHeaders: ui(first) }));
      await (first.agent as unknown as { idle(): Promise<void> }).idle();
      await (first.routines as unknown as { drain(ms: number): Promise<boolean> }).drain(2_000);
      const [before] = await first.db.select().from(routineRuns).where(eq(routineRuns.id, routineRunId));
      expect(before?.status).toBe("waiting_approval");
      const agentRunId = before!.agentRunId!;
      const [waiting] = await first.db.select().from(agentRuns).where(eq(agentRuns.id, agentRunId));
      expect(waiting?.status).toBe("waiting");
      // The handle is a bearer credential: it sits in a 0600 file under the data dir, never in run_steps.
      const handleFile = join(dataDir, "run", "handles", `${agentRunId}.json`);
      expect(statSync(handleFile).mode & 0o777).toBe(0o600);
      const token = (JSON.parse(readFileSync(handleFile, "utf8")) as { token: string }).token;
      const stepsJson = JSON.stringify(await first.db.select().from(runSteps).where(eq(runSteps.runId, agentRunId)));
      expect(stepsJson.includes(token)).toBe(false);
      await first.close();

      const second = await createWeft({ dataDir, testMode: true });
      try {
        const [booted] = await second.db.select().from(agentRuns).where(eq(agentRuns.id, agentRunId));
        expect(booted?.status, "the boot rule fails only running runs").toBe("waiting");
        const open = (await second.db.select().from(proposals)).filter((p) => p.status === "pending" && p.proposerRunId === agentRunId);
        expect(open.map((p) => p.command).sort()).toEqual(["notices.send_response", "tax.update_rate"]);
        const approve = async (id: string) => {
          const res = await second.app.request(`/v1/proposals/${id}/approve`, {
            method: "POST", headers: { ...ui(second)("usr_dana"), "content-type": "application/json" }, body: JSON.stringify({ reasonCode: null, note: null }),
          });
          expect(res.status, await res.clone().text()).toBe(200);
        };
        // One approval is not enough: the rehydrated handle still sees the other pending proposal, so the run waits.
        await approve(open[0]!.id);
        await (second.agent as unknown as { idle(): Promise<void> }).idle();
        const [half] = await second.db.select().from(agentRuns).where(eq(agentRuns.id, agentRunId));
        expect(half?.status, "the run must keep waiting for the second proposal").toBe("waiting");
        await approve(open[1]!.id);
        await (second.agent as unknown as { idle(): Promise<void> }).idle();
        await (second.routines as unknown as { drain(ms: number): Promise<boolean> }).drain(2_000);
        const [after] = await second.db.select().from(agentRuns).where(eq(agentRuns.id, agentRunId));
        expect(after).toMatchObject({ status: "done", terminalReason: "DONE" });
        const [rr] = await second.db.select().from(routineRuns).where(eq(routineRuns.id, routineRunId));
        expect(rr?.status).toBe("done");
        expect(existsSync(handleFile), "a finished run's handle file is removed").toBe(false);
        expect(unhandled.map(String)).toEqual([]);
      } finally {
        await second.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

// The routines engine watches each (routine run, agent run) pair. POST /v1/sim/reset rebuilds the world and agent run
// ids start over, so a watch keyed by the agent run id alone skipped the new run and its routine run never finalized
// (caught by e2e GP4, which resets before each test).
describe("routine finalization after a world reset", () => {
  it("finalizes a routine run whose agent run reuses an id from before the reset", async () => {
    const weft = await createTestWeft();
    try {
      const headers = { ...weft.uiHeaders("usr_dana"), "content-type": "application/json" };
      const fire = async () => {
        const res = await weft.app.request("/v1/routines/rt_people_digest/trigger", { method: "POST", headers, body: "{}" });
        expect(res.status, await res.clone().text()).toBe(200);
        const { routineRunId } = (await res.json()) as { routineRunId: string };
        const rr = await (weft.routines as unknown as { settled(id: string): Promise<{ status: string; agentRunId: string | null }> }).settled(routineRunId);
        return { routineRunId, ...rr };
      };
      const first = await fire();
      expect(first.status).toBe("done");
      const reset = await weft.app.request("/v1/sim/reset", { method: "POST", headers, body: "{}" });
      expect(reset.status, await reset.clone().text()).toBe(200);
      const second = await fire();
      expect(second.agentRunId).toBe(first.agentRunId);
      expect(second.routineRunId).not.toBe(first.routineRunId);
      expect(second.status).toBe("done");
    } finally {
      await weft.close();
    }
  });
});

// The engine also remembered proposal decisions by id. After a reset the new world's prp_0001 inherited the old
// prp_0001's denial, so a demo that denied a card, reset and delivered the DE 2088 notice saw the notice run escalate
// NOT_DONE on its pending rate change (caught by e2e GP1 after GP15, demo check round 1).
describe("proposal decisions after a world reset", () => {
  it("a denial before the reset never decides the new world's proposal with the same id", async () => {
    const weft = await createTestWeft();
    try {
      const headers = { ...weft.uiHeaders("usr_dana"), "content-type": "application/json" };
      const engine = weft.routines as unknown as { runs(id: string, limit?: number): Promise<{ id: string }[]>; settled(id: string): Promise<{ status: string; agentRunId: string | null }> };
      const deliver = async () => {
        const res = await weft.app.request("/v1/sim/notices/deliver", { method: "POST", headers, body: JSON.stringify({ scenario: "ca_de2088_rate_change" }) });
        expect(res.status, await res.clone().text()).toBe(200);
        let rr: { id: string } | undefined;
        for (let i = 0; i < 50 && !rr; i++) { await weft.scheduler.kick(); rr = (await engine.runs("rt_agency_notice", 1))[0]; if (!rr) await new Promise((r) => setTimeout(r, 50)); }
        expect(rr, "the notice starts the routine").toBeTruthy();
        const settled = await engine.settled(rr!.id);
        const run = await (await weft.app.request(`/v1/agent/runs/${settled.agentRunId}`, { headers })).json() as { status: string };
        const pending = (await (await weft.app.request("/v1/proposals?status=pending&limit=100", { headers })).json() as { data: { id: string; command: string }[] }).data;
        return { run, rate: pending.find((p) => p.command === "tax.update_rate") };
      };
      const first = await deliver();
      expect(first.run.status).toBe("waiting");
      expect(first.rate).toBeTruthy();
      const deny = await weft.app.request(`/v1/proposals/${first.rate!.id}/deny`, { method: "POST", headers, body: JSON.stringify({ reasonCode: "not_needed", note: null }) });
      expect(deny.status, await deny.clone().text()).toBe(200);
      const reset = await weft.app.request("/v1/sim/reset", { method: "POST", headers, body: "{}" });
      expect(reset.status, await reset.clone().text()).toBe(200);
      const second = await deliver();
      expect(second.rate?.id).toBe(first.rate!.id);   // ids restart, which is what made the old denial stick
      expect(second.run.status).toBe("waiting");
    } finally {
      await weft.close();
    }
  });
});
