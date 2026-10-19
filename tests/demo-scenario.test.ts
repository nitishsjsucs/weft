import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestWeft, type TestWeft } from "./scenarios/helpers";
import { clientConfig } from "../apps/mcp/src/main";
import { phoenixProjectLinks } from "../scripts/phoenix-links";
import { DEMO_PHOENIX_PROJECT, DEMO_SCENARIOS, SEED_CLOCK, START_COMMAND, describeScenario, findScenario, prepareScenario, runCli, type ApiCall, type CliIo } from "../scripts/demo-scenario";

const ROOT = resolve(import.meta.dirname, "..");

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
  it("the MCP step's client config in the doc is what pnpm mcp:config builds, and the helper names the command", () => {
    expect(findScenario("trace-mcp").steps.join(" ")).toContain("pnpm mcp:config");
    expect((JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts["mcp:config"]).toBe("tsx scripts/mcp-config.ts");
    const doc = readFileSync(join(ROOT, "docs/demo-scenarios.md"), "utf8");
    const block = doc.slice(doc.indexOf("## 8.")).match(/```json\n([\s\S]*?)\n```/)![1]!;
    expect(JSON.parse(block)).toEqual(clientConfig({ root: "/Users/you/Developer/projects/weft", pnpm: "/opt/homebrew/bin/pnpm", pathDirs: ["/opt/homebrew/bin"] }));
  });
  it("names the scenarios when an unknown one is asked for", () => {
    expect(() => findScenario("nope")).toThrow(/unknown scenario "nope"; use one of: notice, payroll/);
  });
  it("the start command traces into the Phoenix project the trace step names, and the header and the doc agree", () => {
    const assignments = START_COMMAND.split(" ").filter((w) => /^WEFT_[A-Z_]+=/.test(w));
    expect(assignments).toEqual(expect.arrayContaining(["WEFT_TRACE=phoenix", `WEFT_PHOENIX_PROJECT=${DEMO_PHOENIX_PROJECT}`, "WEFT_CLOCK_RATE=0", "WEFT_LLM=openai"]));
    const trace = findScenario("trace-mcp").steps.join(" ");
    expect(trace).toContain(`WEFT_TRACE=phoenix WEFT_PHOENIX_PROJECT=${DEMO_PHOENIX_PROJECT}`);
    expect(trace).toContain(`project ${DEMO_PHOENIX_PROJECT}`);
    // The script's header comment and docs/demo-scenarios.md show the same command (line breaks aside).
    const header = readFileSync(join(ROOT, "scripts/demo-scenario.ts"), "utf8").split("\nimport ")[0]!.replace(/\\\n\/\/\s*/g, "");
    const doc = readFileSync(join(ROOT, "docs/demo-scenarios.md"), "utf8").replace(/\\\n/g, "");
    for (const a of assignments) {
      expect(header, `script header: ${a}`).toContain(a);
      expect(doc, `docs/demo-scenarios.md: ${a}`).toContain(a);
    }
    expect(header).toContain("pnpm dev --fresh");
    expect(doc).toContain(`project ${DEMO_PHOENIX_PROJECT}`);
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
    expect(p).toMatchObject({ profile: "base", clock: SEED_CLOCK, rate: 0, pending: 0, warnings: [] });
    expect(p.scenario.name).toBe("notice");
    const after = Number((await weft.db.all<{ n: number }>("SELECT COUNT(*) AS n FROM agent_runs" as never))[0]?.n ?? 0);
    expect(after).toBeLessThanOrEqual(before);
  });

  it("starts a take on the world's own profile, or the one it is given", async () => {
    const bodies: unknown[] = [];
    const spy: ApiCall = async (method, path, body) => { if (path === "/v1/sim/reset") bodies.push(body); return api(method, path, body); };
    await prepareScenario("payroll", spy);
    // A rich dev world (the pnpm dev default) resets to rich; the reset itself is not run here, the base world stays.
    const rich: ApiCall = async (method, path, body) => {
      if (path === "/v1/health") return { status: 200, json: { seedProfile: "rich" } };
      if (path === "/v1/sim/reset") { bodies.push(body); return { status: 200, json: { ok: true } }; }
      return api(method, path, body);
    };
    expect((await prepareScenario("payroll", rich)).profile).toBe("rich");
    await prepareScenario("payroll", rich, { profile: "base" }).catch(() => undefined);
    expect(bodies).toEqual([{ profile: "base" }, { profile: "rich" }, { profile: "base" }]);
  });

  it("accepts the seed's own waiting proposals and refuses one made after the seed", async () => {
    const withSeeded: ApiCall = async (method, path, body) => {
      const r = await api(method, path, body);
      if (path.startsWith("/v1/proposals")) return { status: 200, json: { data: [{ id: "prp_0019", createdAt: "2026-10-26T15:00:00.000Z" }] } };
      return r;
    };
    expect((await prepareScenario("notice", withSeeded)).pending).toBe(1);
    const withNew: ApiCall = async (method, path, body) => {
      const r = await api(method, path, body);
      if (path.startsWith("/v1/proposals")) return { status: 200, json: { data: [{ id: "prp_0099", createdAt: "2026-10-26T16:00:00.000Z" }] } };
      return r;
    };
    await expect(prepareScenario("notice", withNew)).rejects.toThrow(/newer than the seed.*prp_0099/);
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

describe("demo:scenario CLI: target and confirmation before the reset", () => {
  let weft: TestWeft;
  let calls: string[] = [];
  let api: ApiCall;
  beforeAll(async () => {
    weft = await createTestWeft();
    api = async (method, path, body) => {
      calls.push(`${method} ${path}`);
      const res = await weft.app.request(path, { method, headers: { ...weft.uiHeaders("usr_dana"), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, json: await res.json().catch(() => null) };
    };
  });
  afterAll(async () => { await weft?.close(); });

  const io = (over: Partial<CliIo> & { answer?: string } = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const asked: string[] = [];
    const targets: { apiPort: number; dataDir: string }[] = [];
    const x: CliIo = {
      env: { WEFT_DATA_DIR: "/tmp/weft-demo-target" }, isTTY: false, root: ROOT,
      ask: async (q) => { asked.push(q); return over.answer ?? ""; },
      log: (l) => out.push(l), error: (l) => err.push(l),
      api: (t) => { targets.push(t); return api; },
      ...over,
    };
    return { x, out, err, asked, targets };
  };
  const clockMoved = async () => {
    await api("POST", "/v1/sim/clock/advance", { by: "P1D" });
    expect(((await api("GET", "/v1/sim/clock")).json as { now: string }).now).not.toBe(SEED_CLOCK);
  };
  const clock = async () => ((await api("GET", "/v1/sim/clock")).json as { now: string }).now;

  it("without a terminal and without --yes it prints the target and refuses before any API call", async () => {
    await clockMoved();
    calls = [];
    const t = io();
    expect(await runCli(["notice", "--api-port", "5862"], t.x)).toBe(2);
    expect(t.out[0]).toBe("demo:scenario notice: target API http://127.0.0.1:5862, data dir /tmp/weft-demo-target");
    expect(t.err.join(" ")).toMatch(/not resetting http:\/\/127\.0\.0\.1:5862 without a confirmation; pass --yes/);
    expect(t.targets).toEqual([]);
    expect(calls).toEqual([]);
    expect(t.asked).toEqual([]);
    expect(await clock()).not.toBe(SEED_CLOCK);
  });

  it("on a terminal it asks, naming the target; anything but y or yes leaves the world alone", async () => {
    calls = [];
    for (const answer of ["", "n", "no", "maybe"]) {
      const t = io({ isTTY: true, answer });
      expect(await runCli(["notice"], t.x)).toBe(1);
      expect(t.asked).toHaveLength(1);
      expect(t.asked[0]).toContain("Reset the world behind http://127.0.0.1:4070 (data dir /tmp/weft-demo-target) to the seed?");
      expect(t.asked[0]).toMatch(/\[y\/N\] $/);
    }
    expect(calls).toEqual([]);
    expect(await clock()).not.toBe(SEED_CLOCK);
  });

  it("a yes on the terminal, or --yes from a script, resets the target and prints the click path", async () => {
    calls = [];
    const t = io({ isTTY: true, answer: "Y" });
    expect(await runCli(["time-off", "--web-port", "5863"], t.x)).toBe(0);
    expect(t.targets).toEqual([{ apiPort: 4070, webPort: 5863, dataDir: "/tmp/weft-demo-target" }]);
    // The first write is the reset; before it, only the world's seed profile is read.
    expect(calls.slice(0, 2)).toEqual(["GET /v1/health", "POST /v1/sim/reset"]);
    expect(await clock()).toBe(SEED_CLOCK);
    expect(t.out[0]).toMatch(/^demo:scenario time-off: target API http:\/\/127\.0\.0\.1:4070, data dir \/tmp\/weft-demo-target$/);
    expect(t.out.join("\n")).toContain("Open http://127.0.0.1:5863/app/time-off");

    await clockMoved();
    calls = [];
    const s = io();
    expect(await runCli(["--yes", "notice"], s.x)).toBe(0);
    expect(s.asked).toEqual([]);
    expect(calls.slice(0, 2)).toEqual(["GET /v1/health", "POST /v1/sim/reset"]);
    expect(await runCli(["--yes", "notice", "--profile", "medium"], io().x)).toBe(2);
    expect(await clock()).toBe(SEED_CLOCK);
  });

  it("trace-mcp prints the Phoenix links, the cost one on LLM spans; without a Phoenix client it calls none", async () => {
    const phx: string[] = [];
    const t = io({
      phoenixFetch: async (url, init) => {
        phx.push(`${init?.method ?? "GET"} ${url}`);
        return new Response(JSON.stringify({ data: { name: DEMO_PHOENIX_PROJECT, id: "UHJvamVjdDo5" } }), { status: 200 });
      },
    });
    expect(await runCli(["--yes", "trace-mcp"], t.x)).toBe(0);
    expect(phx).toEqual([`GET http://127.0.0.1:6206/v1/projects/${DEMO_PHOENIX_PROJECT}`]);
    const text = t.out.join("\n");
    expect(text).toContain("open the cost link printed below, the Spans tab already filtered to span_kind == 'LLM'");
    expect(text).toContain(`Phoenix project ${DEMO_PHOENIX_PROJECT}, last 7 days:`);
    const links = phoenixProjectLinks("http://127.0.0.1:6206", "UHJvamVjdDo5");
    expect(text).toContain(`  cost     ${links.cost}`);
    expect(text).toContain(`  traces   ${links.traces}`);
    expect(text).toContain(`  metrics  ${links.metrics}`);
    const quiet = io();
    expect(await runCli(["--yes", "trace-mcp"], quiet.x)).toBe(0);
    expect(quiet.out.join("\n")).not.toContain("Phoenix project");
  });

  it("an unknown scenario fails before the target is touched; list prints the start command", async () => {
    calls = [];
    const t = io({ isTTY: true, answer: "y" });
    expect(await runCli(["nope", "--yes"], t.x)).toBe(2);
    expect(t.err.join(" ")).toMatch(/unknown scenario "nope"/);
    expect(calls).toEqual([]);
    const l = io();
    expect(await runCli(["list"], l.x)).toBe(0);
    expect(l.out.at(-1)).toBe(`Start the world with: ${START_COMMAND}`);
  });
});
