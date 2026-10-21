// The alarm multiplexer, the run host (one live run per alarm invocation), the scheduler host (ticks only while the
// clock runs) and the fetch counter (design 3.3 and 8.1).
import { describe, expect, it } from "vitest";
import type { RunHostJob } from "../../src/shared/contracts";
import { AlarmPlan } from "../../src/core/company/alarms";
import { durableRunHost, durableSchedulerHost, fetchCounter, FetchBudgetExceeded } from "../../src/core/company/hosts";

function storage() {
  const calls: number[] = [];
  let alarm: number | null = null;
  return { calls, get alarm() { return alarm; }, setAlarm: (t: number) => { calls.push(t); alarm = t; }, getAlarm: () => alarm };
}

describe("AlarmPlan", () => {
  it("sets the storage alarm only when the earliest due time moves earlier", async () => {
    const s = storage();
    const plan = new AlarmPlan(s);
    await plan.arm("tick", 5_000);
    await plan.arm("runs", 9_000);
    await plan.arm("outbox", 7_000);
    expect(s.calls).toEqual([5_000]);
    await plan.arm("runs", 1_000);
    expect(s.calls).toEqual([5_000, 1_000]);
    expect(plan.begin(1_000)).toEqual(new Set(["runs"]));
    expect(plan.next()).toBe(5_000);
    await plan.sync();
    expect(s.calls).toEqual([5_000, 1_000, 5_000]);
    plan.cancel("tick");
    expect(plan.next()).toBe(7_000);
    plan.clear();
    expect(plan.next()).toBeNull();
  });

  it("reads the stored alarm once before deciding", async () => {
    const s = storage();
    s.setAlarm(2_000);
    s.calls.length = 0;
    const plan = new AlarmPlan(s);
    await plan.arm("runs", 3_000);
    expect(s.calls).toEqual([]);
  });
});

const job = (runId: string, live: boolean, log: string[], extra?: () => Promise<void>): RunHostJob => ({
  runId, live, async start() { log.push(`start ${runId}`); await extra?.(); log.push(`end ${runId}`); },
});

describe("durable run host", () => {
  it("starts at most one live run per drain, everything before the next live one, in order", async () => {
    let arms = 0;
    const host = durableRunHost({ arm: () => { arms += 1; } });
    const log: string[] = [];
    host.submit(job("run_1", true, log));
    host.submit(job("run_2", false, log));
    host.submit(job("run_3", true, log));
    host.submit(job("run_4", false, log));
    await Promise.resolve();
    expect(host.pending()).toEqual(["run_1", "run_2", "run_3", "run_4"]);
    const a = await host.drain();
    expect(a).toMatchObject({ started: 2, remaining: 2, liveStarted: 1 });
    expect(log).toEqual(["start run_1", "start run_2", "end run_1", "end run_2"]);
    const b = await host.drain();
    expect(b).toMatchObject({ started: 2, remaining: 0, liveStarted: 1 });
    await Promise.resolve();
    expect(arms).toBeGreaterThanOrEqual(2);
  });

  it("starts a job submitted while draining in the same invocation when it is not live", async () => {
    const log: string[] = [];
    const host = durableRunHost({ arm: () => undefined });
    host.submit(job("run_1", true, log, async () => { host.submit(job("run_2", false, log)); }));
    const r = await host.drain();
    expect(r).toMatchObject({ started: 2, remaining: 0 });
    expect(log).toContain("end run_2");
  });

  it("keeps draining after a job throws", async () => {
    const host = durableRunHost({ arm: () => undefined });
    host.submit({ runId: "run_1", live: false, start: async () => { throw new Error("boom"); } });
    const log: string[] = [];
    host.submit(job("run_2", false, log));
    expect(await host.drain()).toMatchObject({ started: 2, remaining: 0 });
  });
});

describe("durable scheduler host", () => {
  it("arms ticks only while the clock rate is above 0", async () => {
    const arms: number[] = [];
    let rate = 0;
    let ticks = 0;
    const host = durableSchedulerHost({ arm: (at) => { arms.push(at); }, cancel: () => undefined });
    host.start({ intervalMs: 5_000, clockRate: () => rate, tick: async () => { ticks += 1; } });
    await Promise.resolve();
    expect(arms).toHaveLength(0);
    expect(await host.tick()).toBe(false);
    rate = 60;
    host.poke();
    await Promise.resolve();
    expect(arms).toHaveLength(1);
    host.poke();
    expect(arms).toHaveLength(1);
    expect(await host.tick()).toBe(true);
    expect(ticks).toBe(1);
    expect(arms).toHaveLength(2);
    rate = 0;
    expect(await host.tick()).toBe(false);
    await host.stop();
    expect(host.started).toBe(false);
  });

  it("re-arms after a tick that throws", async () => {
    const arms: number[] = [];
    const host = durableSchedulerHost({ arm: (at) => { arms.push(at); }, cancel: () => undefined });
    host.start({ intervalMs: 10, clockRate: () => 1, tick: async () => { throw new Error("tick failed"); } });
    await expect(host.tick()).rejects.toThrow("tick failed");
    expect(arms.length).toBe(2);
  });
});

describe("fetch counter", () => {
  it("counts per invocation and refuses the 41st fetch before it is sent", async () => {
    const c = fetchCounter(40);
    let sent = 0;
    const f = c.wrap((async () => { sent += 1; return new Response("ok"); }) as typeof fetch);
    for (let i = 0; i < 40; i++) await f("https://x.invalid/");
    await expect(f("https://x.invalid/")).rejects.toBeInstanceOf(FetchBudgetExceeded);
    expect(sent).toBe(40);
    expect(c.peak).toBe(40);
    c.reset();
    expect(c.count).toBe(0);
    await f("https://x.invalid/");
    expect(sent).toBe(41);
  });
});
