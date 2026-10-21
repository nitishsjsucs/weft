// The eval runner's Workers AI choice (docs/cloudflare/design.md 5.2, docs/models.md "Hosted"): `--provider workers_ai`
// is the offline side by side for the hosted switch. It sits behind the same opt-in as the OpenAI live run, with
// WEFT_LLM naming workers_ai, and needs the gateway's Workers AI REST path and a narrow token, all checked before any
// world is built. eval:ci and every test stay scripted: nothing here makes a model call.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { WORKERS_AI_MODEL } from "../packages/contracts/src/ext/cf-agent";
import { runCapScaleFor } from "../packages/agent/src/cost";
import { createNamedProvider } from "../packages/agent/src/providers/factory";
import { runPriceScale } from "../evals/suite/graders/index";
import { liveRefusal, main, parseArgs, runSetup } from "../evals/suite/run";
import { checkCaps, newState, type RunnerOptions } from "../evals/suite/runner";
import { REPO_ROOT } from "../evals/suite/loader";

const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
afterEach(() => { vi.unstubAllEnvs(); });

const OPT_IN = { WEFT_LIVE_OPENAI: "1", WEFT_LLM: "workers_ai" };
const GATEWAY = { WEFT_AIG_ACCOUNT_ID: "acct-not-real", WEFT_AIG_GATEWAY: "weft" };
const TOKEN = "wai-test-not-a-token";

describe("--provider workers_ai", () => {
  it("parses next to scripted and live; any other name is refused", () => {
    expect(parseArgs(["--provider", "workers_ai", "--split", "test", "--experiment", "wai-baseline"], {})).toMatchObject({ provider: "workers_ai", splits: ["test"], experiment: "wai-baseline" });
    expect(parseArgs(["--provider", "live"], {}).provider).toBe("live");
    expect(parseArgs([], {}).provider).toBe("scripted");
    expect(() => parseArgs(["--provider", "openai"], {})).toThrow(/--provider openai/);
    expect(() => parseArgs(["--provider", "claude"], {})).toThrow(/--provider claude/);
  });

  it("eval:ci stays on the scripted provider", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["eval:ci"]).toContain("--provider scripted");
    expect(pkg.scripts["eval:ci"]).not.toContain("workers_ai");
  });

  it("records gpt-oss-120b at the per-stage effort, whatever WEFT_MODEL and WEFT_EFFORT say", () => {
    expect(runSetup("workers_ai", {})).toEqual({ model: WORKERS_AI_MODEL, effort: "low", effortSource: "default", backgroundLlm: false, costScale: 1 });
    // The provider reads neither variable, so the result file must not claim them (a Terra or high-effort shell).
    expect(runSetup("workers_ai", { WEFT_MODEL: "gpt-5.6-terra", WEFT_EFFORT: "high", WEFT_BACKGROUND_LLM: "1" }))
      .toEqual({ model: WORKERS_AI_MODEL, effort: "low", effortSource: "default", backgroundLlm: true, costScale: 1 });
  });

  it("scales each task's worst case as the run cap and G8 do, so checkCaps and G8 agree for Workers AI too", () => {
    const { costScale } = runSetup("workers_ai", {});
    expect(costScale).toBe(runCapScaleFor("workers_ai", WORKERS_AI_MODEL));
    expect(costScale).toBe(runPriceScale({ provider: "workers_ai", model: WORKERS_AI_MODEL }));
    const t = { id: "XX-01", budget: { maxSteps: 6, maxUsd: 0.02 } } as Parameters<typeof checkCaps>[1];
    const o = (cap: number): Pick<RunnerOptions, "suiteCapUsd" | "wave" | "mode" | "costScale"> => ({ mode: "live", suiteCapUsd: cap, wave: null, costScale });
    expect(checkCaps(newState(), t, o(0.02 * costScale))).toBeNull();
    expect(checkCaps(newState(), t, o(0.02 * costScale * 0.99))).toMatch(/^SUITE_CAP/);
  });
});

describe("the opt-in, checked before any world is built", () => {
  it("scripted needs nothing; live keeps its OpenAI opt-in and message", () => {
    expect(liveRefusal("scripted", {})).toBeNull();
    expect(liveRefusal("live", {})).toBe("a live suite run is opt-in: set WEFT_LIVE_OPENAI=1 and WEFT_LLM=openai (docs/evals.md)");
    expect(liveRefusal("live", { WEFT_LIVE_OPENAI: "1", WEFT_LLM: "workers_ai" })).toMatch(/^a live suite run is opt-in/);
    expect(liveRefusal("live", { WEFT_LIVE_OPENAI: "1", WEFT_LLM: "openai" })).toBeNull();
  });

  it("workers_ai needs WEFT_LIVE_OPENAI=1 with WEFT_LLM=workers_ai, the gateway names and the token", () => {
    const all = { ...OPT_IN, ...GATEWAY, WEFT_WORKERS_AI_TOKEN: TOKEN };
    expect(liveRefusal("workers_ai", all)).toBeNull();
    const optIn = /^a workers_ai suite run is opt-in: set WEFT_LIVE_OPENAI=1 and WEFT_LLM=workers_ai/;
    expect(liveRefusal("workers_ai", { ...all, WEFT_LIVE_OPENAI: undefined })).toMatch(optIn);
    expect(liveRefusal("workers_ai", { ...all, WEFT_LLM: "openai" })).toMatch(optIn);
    expect(liveRefusal("workers_ai", { ...all, WEFT_LLM: undefined })).toMatch(optIn);
    expect(liveRefusal("workers_ai", { ...all, WEFT_AIG_ACCOUNT_ID: undefined })).toMatch(/needs WEFT_AIG_ACCOUNT_ID and WEFT_AIG_GATEWAY/);
    expect(liveRefusal("workers_ai", { ...all, WEFT_AIG_GATEWAY: " " })).toMatch(/needs WEFT_AIG_ACCOUNT_ID and WEFT_AIG_GATEWAY/);
    const noToken = liveRefusal("workers_ai", { ...all, WEFT_WORKERS_AI_TOKEN: undefined });
    expect(noToken).toMatch(/needs WEFT_WORKERS_AI_TOKEN in the environment or in WEFT_SECRETS_FILE/);
  });

  it("takes the token from WEFT_SECRETS_FILE as the provider does, and never names its value", () => {
    const file = join(tmp("weft-wai-"), "fake.secrets.env");
    writeFileSync(file, `# test fixture, not a real token\nWEFT_WORKERS_AI_TOKEN=${TOKEN}\n`);
    expect(liveRefusal("workers_ai", { ...OPT_IN, ...GATEWAY, WEFT_SECRETS_FILE: file })).toBeNull();
    const refusals = [{}, OPT_IN, { ...OPT_IN, WEFT_WORKERS_AI_TOKEN: TOKEN }, { ...OPT_IN, ...GATEWAY }].map((env) => liveRefusal("workers_ai", env) ?? "");
    for (const r of refusals) expect(r).not.toContain(TOKEN);
  });

  it("refuses exactly when the factory could not build the provider the trial worlds will build", () => {
    // The trial worlds build WEFT_LLM's provider through the factory (createProviderFor, Node's ports, the REST
    // transport). Build only: a fetch that throws proves no call is made.
    const fetch = (() => { throw new Error("no network in tests"); }) as unknown as typeof globalThis.fetch;
    const file = join(tmp("weft-wai-"), "fake.secrets.env");
    writeFileSync(file, `WEFT_WORKERS_AI_TOKEN=${TOKEN}\n`);
    const cases: Record<string, string | undefined>[] = [
      { ...OPT_IN, ...GATEWAY, WEFT_WORKERS_AI_TOKEN: TOKEN },
      { ...OPT_IN, ...GATEWAY, WEFT_SECRETS_FILE: file },
      { ...OPT_IN, ...GATEWAY },
      { ...OPT_IN, WEFT_AIG_GATEWAY: "weft", WEFT_WORKERS_AI_TOKEN: TOKEN },
      { ...OPT_IN, WEFT_AIG_ACCOUNT_ID: "acct-not-real", WEFT_WORKERS_AI_TOKEN: TOKEN },
    ];
    for (const env of cases) {
      const builds = (() => { try { return createNamedProvider("workers_ai", { env, ledger: null as never, testMode: false, fetch }).id === "workers_ai"; } catch { return false; } })();
      expect(liveRefusal("workers_ai", env) === null, JSON.stringify(Object.keys(env))).toBe(builds);
    }
  });

  it("main exits 2 before building a world when the opt-in is missing", async () => {
    vi.stubEnv("WEFT_LIVE_OPENAI", "");
    vi.stubEnv("WEFT_EVAL_DIR", tmp("weft-wai-eval-"));
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { errors.push(a.join(" ")); });
    try {
      const out = tmp("weft-wai-out-");
      expect(await main(["--provider", "workers_ai", "--ids", "AA-01", "--out", out])).toBe(2);
      expect(errors.join("\n")).toMatch(/a workers_ai suite run is opt-in/);
    } finally { spy.mockRestore(); }
  });
});
