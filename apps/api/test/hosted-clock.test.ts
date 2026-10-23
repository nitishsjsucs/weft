// The hosted clock's bounds (docs/cloudflare/design.md 6.3, HOSTED_CLOCK_LIMITS). On a durable world one advance moves
// the clock at most 7 days and never past 60 days after HOSTED_CLOCK.at: an advance from the seed morning to 2031
// wrote 10,162 rows, read 165,354 and queued 263 runs in one request. The refusal comes before anything is read or
// written (metered on the emulated storage). "+1 hour", "+1 day" and "next routine" keep working, and a Node world
// keeps moving its clock as far as it is asked.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureTestPrincipals } from "@weft/core";
import { createTestWeft } from "../src/testing";
import { buildSeededWorld, openDurableWorld, testFixtures, type DurableTestWorld, type SeededWorld } from "./support/durable-world";
import { HOSTED_CLOCK, HOSTED_CLOCK_LIMITS } from "../../../packages/contracts/src/ext/cf-hosted";

const DAY = 86_400_000;
let seed: SeededWorld;
let w: DurableTestWorld;
beforeAll(async () => { seed = await buildSeededWorld(); testFixtures(); w = await openDurableWorld(seed, { copy: true }); }, 180_000);
afterAll(async () => { await w?.close(); seed?.dispose(); });

const advance = async (body: unknown) => {
  const res = await w.weft.app.request("/v1/sim/clock/advance", { method: "POST", headers: { ...w.headers("usr_dana"), "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as { now?: string; code?: string; message?: string } };
};
const iso = (ms: number) => new Date(ms).toISOString();

describe("a hosted world's clock", () => {
  it("refuses one advance to 2031 with 400 CLOCK_LIMIT before it reads, writes or queues anything", async () => {
    const before = w.storage.stats();
    const runs = w.runHost.submitted.length;
    const r = await advance({ to: "2031-01-01T00:00:00.000Z" });
    const after = w.storage.stats();
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: "CLOCK_LIMIT", message: expect.stringContaining("at most 7 days") });
    expect(after.rowsWritten - before.rowsWritten).toBe(0);
    // Only the request's own session lookup; no cron slot, no routine, no event.
    expect(after.rowsRead - before.rowsRead).toBeLessThan(50);
    expect(w.runHost.submitted.length).toBe(runs);
    expect(w.weft.clock.now()).toBe(HOSTED_CLOCK.at);
    expect((await advance({ by: "P8D" })).body.code).toBe("CLOCK_LIMIT");
    expect((await advance({ by: "P7DT1M" })).body.code).toBe("CLOCK_LIMIT");
  });

  it("keeps +1 hour, +1 day and next routine working, and one advance of up to 7 days", async () => {
    expect(await advance({ by: "PT1H" })).toMatchObject({ status: 200, body: { now: "2026-10-26T16:30:00.000Z" } });
    expect(await advance({ by: "P1D" })).toMatchObject({ status: 200, body: { now: "2026-10-27T16:30:00.000Z" } });
    expect(await advance({ toNext: "cron" })).toMatchObject({ status: 200, body: { now: "2026-10-28T16:00:00.000Z" } });
    expect(await advance({ by: `P${HOSTED_CLOCK_LIMITS.maxStepDays}D` })).toMatchObject({ status: 200, body: { now: "2026-11-04T16:00:00.000Z" } });
  });

  it(`never moves past ${HOSTED_CLOCK_LIMITS.maxDaysFromStart} days after the hosted start, and says to reset`, async () => {
    const edge = Date.parse(HOSTED_CLOCK.at) + HOSTED_CLOCK_LIMITS.maxDaysFromStart * DAY;
    await w.weft.clock.set(iso(edge - 2 * DAY), 0);
    const before = w.storage.stats();
    const r = await advance({ by: "P3D" });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: "CLOCK_LIMIT", message: expect.stringContaining("reset the demo company") });
    expect(w.storage.stats().rowsWritten - before.rowsWritten).toBe(0);
    expect(await advance({ to: iso(edge) })).toMatchObject({ status: 200, body: { now: iso(edge) } });
    expect((await advance({ by: "PT1M" })).body.code).toBe("CLOCK_LIMIT");
  });
});

describe("a Node world's clock", () => {
  it("still moves as far as it is asked (no hosted bound)", async () => {
    const weft = await createTestWeft();
    await ensureTestPrincipals(weft.db);
    try {
      const res = await weft.app.request("/v1/sim/clock/advance", { method: "POST", headers: { ...weft.uiHeaders("usr_dana"), "content-type": "application/json" }, body: JSON.stringify({ by: "P8D" }) });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { now: string }).now).toBe("2026-11-03T15:30:00.000Z");
    } finally {
      await weft.close();
    }
  }, 120_000);
});
