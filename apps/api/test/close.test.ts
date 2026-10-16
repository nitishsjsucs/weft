// weft.close() during an in-flight routine run (owner: w2-reliability, gate report item 1). close() drains the agent
// queue and the routines engine's pending finalizations within a bound, and a background write that still lands after
// the database closed is caught, so no CLIENT_CLOSED rejection goes unhandled.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb, routineRuns } from "@weft/db";
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
