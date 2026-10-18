import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestWeft, type TestWeft } from "./scenarios/helpers";
import { DEMO_SCENARIOS, SEED_CLOCK, describeScenario, findScenario, prepareScenario, type ApiCall } from "../scripts/demo-scenario";

describe("demo:scenario registry", () => {
  it("has unique names, a start path, steps and dash-free text for every scenario", () => {
    const names = DEMO_SCENARIOS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThanOrEqual(6);
    for (const s of DEMO_SCENARIOS) {
      expect(s.start, s.name).toMatch(/^\/app(\/|$)/);
      expect(s.steps.length, s.name).toBeGreaterThan(0);
      expect(s.minutes, s.name).toBeGreaterThanOrEqual(1);
      expect(s.minutes, s.name).toBeLessThanOrEqual(4);
      for (const text of [s.title, ...s.steps, ...s.prompts]) expect(text, s.name).not.toMatch(/[\u2013\u2014]/);
    }
  });
  it("names the scenarios when an unknown one is asked for", () => {
    expect(() => findScenario("nope")).toThrow(/unknown scenario "nope"; use one of: notice, payroll/);
  });
  it("prints the start URL on the given web port, the steps and the prompts", () => {
    const text = describeScenario(findScenario("time-off"), 5461);
    expect(text).toContain("Open http://127.0.0.1:5461/app/time-off");
    expect(text).toContain("  1. Time Off, Requests");
    expect(text).toContain("Type:\n  Should Imani approve Ruth's Thanksgiving vacation?");
  });
});

describe("demo:scenario against a world", () => {
  let weft: TestWeft;
  let api: ApiCall;
  beforeAll(async () => {
    weft = await createTestWeft();
    api = async (method, path, body) => {
      const res = await weft.app.request(path, { method, headers: { ...weft.uiHeaders("usr_dana"), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, json: await res.json().catch(() => null) };
    };
  });
  afterAll(async () => { await weft?.close(); });

  it("resets a used world to the seed clock with no pending proposals, and calls no model", async () => {
    await api("POST", "/v1/sim/clock/advance", { by: "P1D" });
    expect(((await api("GET", "/v1/sim/clock")).json as { now: string }).now).not.toBe(SEED_CLOCK);
    const before = Number((await weft.db.all<{ n: number }>("SELECT COUNT(*) AS n FROM agent_runs" as never))[0]?.n ?? 0);
    const p = await prepareScenario("notice", api);
    expect(p).toMatchObject({ clock: SEED_CLOCK, rate: 0, pending: 0, warnings: [] });
    expect(p.scenario.name).toBe("notice");
    const after = Number((await weft.db.all<{ n: number }>("SELECT COUNT(*) AS n FROM agent_runs" as never))[0]?.n ?? 0);
    expect(after).toBeLessThanOrEqual(before);
  });

  it("refuses when the reset fails", async () => {
    const failing: ApiCall = async (method, path, body) => (path === "/v1/sim/reset" ? { status: 501, json: { _tag: "NotImplemented" } } : api(method, path, body));
    await expect(prepareScenario("payroll", failing)).rejects.toThrow(/reset answered 501/);
  });

  it("warns when the clock is running", async () => {
    const running: ApiCall = async (method, path, body) => {
      const r = await api(method, path, body);
      return path === "/v1/sim/clock" ? { status: 200, json: { ...(r.json as object), rate: 1 } } : r;
    };
    const p = await prepareScenario("chart-memory", running);
    expect(p.warnings.join(" ")).toMatch(/WEFT_CLOCK_RATE=0/);
  });
});
