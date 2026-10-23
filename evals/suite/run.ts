// pnpm eval:suite: the wave 4 eval suite (docs/evals.md, research/wave4/evals.md). Owner: w4-eval-suite.
//   pnpm eval:suite validate                         load and validate every task file
//   pnpm eval:suite digests [--write]                rebuild every world, compare (or pin) the digests
//   pnpm eval:suite [--split dev|test|retired-r1|all] [--variant default|chat_can_propose] [--k n] [--ids RT-01,CQ-01] [--legacy]
//                   [--provider scripted|live|workers_ai] [--cap 0.15] [--stage w4-eval-suite --stage-cap 0.10] [--phoenix] [--gate]
//                   [--experiment baseline]   the Phoenix experiment name (one split and variant; else -<split>-<variant> is added)
// --gate (CI: `pnpm eval:ci`, the scripted provider over both splits and both variants, no network) exits 1 on any unsafe
// action, taint miss, canary hit or harness error. Task success is reported, never gated: the scripted model cannot branch.
// Live runs are opt-in (WEFT_LIVE_OPENAI=1 WEFT_LLM=openai, the key only from WEFT_SECRETS_FILE). --provider workers_ai is
// the hosted switch's live side by side (docs/models.md, "Hosted"): the same opt-in with WEFT_LLM=workers_ai, the
// gateway's Workers AI REST path (WEFT_AIG_ACCOUNT_ID, WEFT_AIG_GATEWAY) and WEFT_WORKERS_AI_TOKEN; eval:ci and the
// tests never select it. WEFT_TRACE=phoenix or
// --phoenix records every trial as a Phoenix experiment run on the local Phoenix (WEFT_PHOENIX_URL, default
// http://127.0.0.1:6206). Results: evals/results/<date>-<sha>-suite.json (gitignored) and the Markdown report beside it.
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { EvalSplit, EvalTask } from "../../packages/contracts/src/evals";
import type { EvalVariant } from "../../packages/contracts/src/telemetry";
import { PHOENIX, TRACE_ENV } from "../../packages/contracts/src/telemetry";
import { loadTasks, REPO_ROOT } from "./loader";
import { ACTIVE_SPLITS, ALL_SPLITS } from "./splits";
import { finalCanaryScan, newState, planTrials, runPlain, runTrial, settleTrial, SuiteStop, type RunnerOptions } from "./runner";
import { metrics, renderReport, type SuiteResultFile } from "./report";
import { buildWorld, worldDigest, worldKey } from "./worlds/index";
import { WORKERS_AI_MODEL, WORKERS_AI_PROVIDER_ID } from "../../packages/contracts/src/ext/cf-agent";
import { effortOverrideFromEnv, WORKERS_AI_TOKEN_ENV } from "../../packages/agent/src/providers/factory";
import { aiGatewayFromEnv } from "../../packages/agent/src/providers/gateway";
import { loadSecret } from "../../packages/agent/src/secrets";
import { runCapScaleFor } from "../../packages/agent/src/cost";

/** What --provider accepts: scripted (eval:ci, $0), live (OpenAI) or workers_ai (the hosted switch over REST). */
export const SUITE_PROVIDERS = ["scripted", "live", WORKERS_AI_PROVIDER_ID] as const;
export type SuiteProvider = (typeof SUITE_PROVIDERS)[number];

export interface CliArgs {
  cmd: "run" | "validate" | "digests"; write: boolean; gate: boolean; splits: EvalSplit[]; variants: EvalVariant[] | null; k: number; ids: string[] | null; legacy: boolean;
  provider: SuiteProvider; cap: number; stage: string; stageCap: number | null; phoenix: boolean; outDir: string; experiment: string | null;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliArgs {
  const a: CliArgs = { cmd: "run", write: false, gate: false, splits: ["dev"], variants: null, k: 1, ids: null, legacy: false, provider: "scripted", cap: 0.15, stage: env.WEFT_EVAL_STAGE ?? "w4-eval-suite", stageCap: null, phoenix: env[TRACE_ENV.switch] === "phoenix", outDir: join(REPO_ROOT, "evals/results"), experiment: null };
  const rest = [...argv];
  if (rest[0] && !rest[0].startsWith("--")) { const c = rest.shift()!; if (c !== "run" && c !== "validate" && c !== "digests") throw new Error(`unknown command ${c}`); a.cmd = c; }
  const val = (flag: string) => { const v = rest.shift(); if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`); return v; };
  while (rest.length) {
    const f = rest.shift()!;
    if (f === "--split") { const v = val(f); a.splits = v === "all" ? [...ACTIVE_SPLITS] : [v as EvalSplit]; if (!a.splits.every((s) => ALL_SPLITS.includes(s))) throw new Error(`--split ${v}`); }
    else if (f === "--variant") { const v = val(f); a.variants = v === "both" ? ["default", "chat_can_propose"] : [v as EvalVariant]; if (!a.variants.every((x) => x === "default" || x === "chat_can_propose")) throw new Error(`--variant ${v}`); }
    else if (f === "--k") { a.k = Number(val(f)); if (!Number.isInteger(a.k) || a.k < 1 || a.k > 8) throw new Error("--k is 1 to 8"); }
    else if (f === "--ids") a.ids = val(f).split(",").map((s) => s.trim()).filter(Boolean);
    else if (f === "--legacy") a.legacy = true;
    else if (f === "--provider") { const v = val(f); if (!(SUITE_PROVIDERS as readonly string[]).includes(v)) throw new Error(`--provider ${v}`); a.provider = v as SuiteProvider; }
    else if (f === "--cap") { a.cap = Number(val(f)); if (!(a.cap >= 0 && a.cap <= 3)) throw new Error("--cap is $0 to $3"); }
    else if (f === "--stage") a.stage = val(f);
    else if (f === "--stage-cap") a.stageCap = Number(val(f));
    else if (f === "--phoenix") a.phoenix = true;
    else if (f === "--no-phoenix") a.phoenix = false;
    else if (f === "--write") a.write = true;
    else if (f === "--gate") a.gate = true;
    else if (f === "--out") a.outDir = resolve(val(f));
    else if (f === "--experiment") { a.experiment = val(f); if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(a.experiment)) throw new Error("--experiment is 1 to 80 letters, digits, dots, dashes or underscores"); }
    else throw new Error(`unknown flag ${f}`);
  }
  return a;
}

function selectTasks(args: CliArgs): EvalTask[] {
  let tasks = loadTasks(args.splits).map((l) => l.task);
  if (args.legacy) tasks = tasks.filter((t) => t.legacyCase);
  if (args.ids) { const want = new Set(args.ids); tasks = tasks.filter((t) => want.has(t.id)); const missing = args.ids.filter((id) => !tasks.some((t) => t.id === id)); if (missing.length) throw new Error(`no task ${missing.join(", ")}`); }
  return tasks;
}

const sha = () => { try { return execSync("git rev-parse --short HEAD", { cwd: REPO_ROOT }).toString().trim(); } catch { return "nogit"; } };
const fullSha = () => { try { return execSync("git rev-parse HEAD", { cwd: REPO_ROOT }).toString().trim(); } catch { return "nogit"; } };

/**
 * What a run records about its model setup (experiment metadata and the result file): the model (WEFT_MODEL, default
 * Luna), the reasoning effort (WEFT_EFFORT when set, else the per-stage default "low"), whether unattended routine runs
 * call the model (WEFT_BACKGROUND_LLM=1) and the cost factor on each task's worst case. A bad WEFT_EFFORT throws here,
 * before any world is built or any money is spent. workers_ai always runs gpt-oss-120b at the per-stage effort (the
 * provider reads neither WEFT_MODEL nor WEFT_EFFORT), and its factor is the one its run cap and G8 use.
 */
export function runSetup(provider: CliArgs["provider"], env: NodeJS.ProcessEnv = process.env): { model: string; effort: string; effortSource: "WEFT_EFFORT" | "default"; backgroundLlm: boolean; costScale: number } {
  if (provider === "scripted") return { model: "scripted", effort: "low", effortSource: "default", backgroundLlm: false, costScale: 1 };
  if (provider === WORKERS_AI_PROVIDER_ID) {
    return { model: WORKERS_AI_MODEL, effort: "low", effortSource: "default", backgroundLlm: env.WEFT_BACKGROUND_LLM === "1", costScale: runCapScaleFor(WORKERS_AI_PROVIDER_ID, WORKERS_AI_MODEL) };
  }
  const model = (env.WEFT_MODEL ?? "").trim() || "gpt-5.6-luna";
  const override = effortOverrideFromEnv(env);
  return { model, effort: override ?? "low", effortSource: override ? "WEFT_EFFORT" : "default", backgroundLlm: env.WEFT_BACKGROUND_LLM === "1", costScale: runCapScaleFor("openai", model) };
}

/**
 * Why a run with a model may not start, or null. Both live providers are opt-in (WEFT_LIVE_OPENAI=1 and WEFT_LLM
 * naming the provider, which the trial worlds then build); workers_ai also needs the gateway (WEFT_AIG_ACCOUNT_ID,
 * WEFT_AIG_GATEWAY) and WEFT_WORKERS_AI_TOKEN from the environment or WEFT_SECRETS_FILE. Checked before any world is
 * built; names only, never a value.
 */
export function liveRefusal(provider: CliArgs["provider"], env: NodeJS.ProcessEnv = process.env): string | null {
  if (provider === "scripted") return null;
  const optedIn = (llm: string) => env.WEFT_LIVE_OPENAI === "1" && env.WEFT_LLM === llm;
  if (provider === "live") return optedIn("openai") ? null : "a live suite run is opt-in: set WEFT_LIVE_OPENAI=1 and WEFT_LLM=openai (docs/evals.md)";
  if (!optedIn(WORKERS_AI_PROVIDER_ID)) return "a workers_ai suite run is opt-in: set WEFT_LIVE_OPENAI=1 and WEFT_LLM=workers_ai (docs/models.md)";
  if (!aiGatewayFromEnv(env)) return "--provider workers_ai needs WEFT_AIG_ACCOUNT_ID and WEFT_AIG_GATEWAY (the gateway's Workers AI REST path, docs/models.md)";
  if (!loadSecret(WORKERS_AI_TOKEN_ENV, env)) return `--provider workers_ai needs ${WORKERS_AI_TOKEN_ENV} in the environment or in WEFT_SECRETS_FILE (docs/models.md)`;
  return null;
}

/** Rebuilds each distinct world once and compares (or, with --write, pins) every task's digest. */
export async function digests(tasks: EvalTask[], opts: { write: boolean; baseDir: string; files?: Map<string, string> }): Promise<{ id: string; pinned: string | null; actual: string }[]> {
  const cache = new Map<string, string>();
  const out: { id: string; pinned: string | null; actual: string }[] = [];
  for (const t of tasks) {
    const key = worldKey(t.world);
    if (!cache.has(key)) {
      const w = await buildWorld(t.world, { dataDir: join(opts.baseDir, "digest"), mode: "scripted" });
      try { cache.set(key, await worldDigest(w)); } finally { await w.weft.close(); }
    }
    out.push({ id: t.id, pinned: t.world.digest, actual: cache.get(key)! });
  }
  if (opts.write && opts.files) {
    for (const r of out) {
      const file = opts.files.get(r.id);
      if (!file || r.pinned === r.actual) continue;
      const raw = JSON.parse(readFileSync(file, "utf8")) as { world: { digest: string | null } };
      raw.world.digest = r.actual;
      writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
    }
  }
  return out;
}

function providerOfFile(name: string): string {
  return name.includes(`-${WORKERS_AI_PROVIDER_ID}`) ? WORKERS_AI_PROVIDER_ID : name.includes("-scripted") ? "scripted" : "live";
}

function previousResult(outDir: string, exclude: string, provider: string): SuiteResultFile | null {
  if (!existsSync(outDir)) return null;
  const files = readdirSync(outDir).filter((f) => f.endsWith("-suite.json") && join(outDir, f) !== exclude && providerOfFile(f) === provider).sort();
  for (const f of files.reverse()) { try { return JSON.parse(readFileSync(join(outDir, f), "utf8")) as SuiteResultFile; } catch { /* skip */ } }
  return null;
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const baseDir = resolve(process.env.WEFT_EVAL_DIR ?? join(REPO_ROOT, ".data/eval-suite"));
  if (args.cmd === "validate") {
    const all = loadTasks(ALL_SPLITS);
    console.log(`${all.length} tasks valid (${ALL_SPLITS.map((s) => `${all.filter((l) => l.task.split === s).length} ${s}`).join(", ")})`);
    return 0;
  }
  if (args.cmd === "digests") {
    const loaded = loadTasks(args.splits).filter((l) => !args.ids || args.ids.includes(l.task.id));
    const res = await digests(loaded.map((l) => l.task), { write: args.write, baseDir, files: new Map(loaded.map((l) => [l.task.id, l.file])) });
    const bad = res.filter((r) => r.pinned !== r.actual);
    for (const r of bad) console.log(`${r.id}: pinned ${r.pinned ?? "none"}, world gives ${r.actual}${args.write ? " (pinned now)" : ""}`);
    console.log(`${res.length - bad.length} of ${res.length} worlds reproduce their digest${args.write && bad.length ? `; wrote ${bad.length}` : ""}`);
    return bad.length && !args.write ? 1 : 0;
  }

  const live = args.provider !== "scripted";
  // Scripted worlds take their provider from WEFT_LLM, so a shell with live settings exported must not make eval:ci live.
  if (!live) process.env.WEFT_LLM = "scripted";
  if (live) {
    const refusal = liveRefusal(args.provider);
    if (refusal) { console.error(refusal); return 2; }
    process.env.WEFT_DEV_AUTH = "1";
    process.env.WEFT_LIVE_USD_CAP ??= String(args.cap);
  }
  const tasks = selectTasks(args);
  const variants: EvalVariant[] = args.variants ?? ["default", "chat_can_propose"];
  const harnessSha = sha();
  const harnessCommit = fullSha();
  const setup = runSetup(args.provider);
  if (live) console.error(`model ${setup.model}, effort ${setup.effort} (${setup.effortSource}), WEFT_BACKGROUND_LLM ${setup.backgroundLlm ? "1" : "unset"}, commit ${harnessCommit}`);
  const opts: RunnerOptions = {
    mode: live ? "live" : "scripted", baseDir, suiteCapUsd: args.cap, harnessSha, requireDigest: true, costScale: setup.costScale,
    wave: { stage: args.stage, stageCapUsd: args.stageCap ?? args.cap },
    log: (l) => console.error(l),
  };
  const startedAt = new Date().toISOString();
  const state = newState();
  const experimentIds: string[] = [];
  let phoenixProject: string | null = null;
  let capture: Awaited<ReturnType<typeof import("./phoenix").startOtlpCapture>> | null = null;
  try {
    if (args.phoenix) {
      const ph = await import("./phoenix");
      // Only a Phoenix on this machine: the capture proxy forwards every dataset, experiment and span to this URL.
      const publicUrl = (await import("./judges/phoenix")).assertLocal(process.env[TRACE_ENV.url] ?? `http://${PHOENIX.host}:${process.env.WEFT_PHOENIX_PORT ?? PHOENIX.httpPort}`);
      const version = await ph.phoenixUp(publicUrl);
      if (!version) { console.error(`no Phoenix at ${publicUrl}; start one (pnpm phoenix:up) or drop --phoenix`); return 2; }
      // Phoenix prices the trial spans the way cost.ts does (docs/telemetry.md, "Cost: Weft and Phoenix").
      console.error(await (await import("../../scripts/phoenix-pricing")).syncModelPricingLine(publicUrl));
      capture = await ph.startOtlpCapture(publicUrl, Number(process.env.WEFT_EVAL_CAPTURE_PORT ?? 4922));
      opts.otlp = () => capture!.payloads;
      const combos = [...new Set(tasks.map((t) => t.split))].flatMap((split) => variants.map((variant) => ({ split, variant })))
        .filter(({ split, variant }) => tasks.some((t) => t.split === split && t.variants.includes(variant)));
      for (const { split, variant } of combos) {
        const these = tasks.filter((t) => t.split === split && t.variants.includes(variant));
        if (!these.length || state.stoppedEarly) continue;
        const name = args.experiment ? (combos.length === 1 ? args.experiment : `${args.experiment}-${split}-${variant}`) : `weft-eval-${startedAt.slice(0, 10)}-${harnessSha}-${variant}`;
        const { record } = await ph.recordExperiment({
          baseUrl: capture.url, publicUrl, split, variant, tasks: these, k: args.k, name,
          metadata: {
            harness_sha: harnessSha, harness_commit: harnessCommit, model: setup.model, provider: args.provider, effort: setup.effort, effort_source: setup.effortSource,
            background_llm: setup.backgroundLlm, k: args.k, split, phoenix_version: version, label: args.experiment, default_settings: variant === "default",
          },
          trial: async (task, n) => {
            if (state.stoppedEarly) return null;
            try { const t = await runTrial({ task, variant, trial: n }, opts, state); settleTrial(t, opts, state); return t; } catch (e) { if (e instanceof SuiteStop) return null; throw e; }
          },
        });
        experimentIds.push(record.experimentId);
        phoenixProject ??= record.projectName;
        console.error(`experiment ${name}: ${record.compareUrl}`);
      }
      await new Promise((r) => setTimeout(r, 1500));   // the last task span's export
    } else {
      await runPlain(planTrials(tasks, variants, args.k), opts, state);
    }
  } finally {
    await capture?.close();
  }
  const wholeRun = finalCanaryScan(state, capture?.payloads ?? []);
  const result: SuiteResultFile = {
    startedAt, endedAt: new Date().toISOString(), harnessSha, harnessCommit, backgroundLlm: setup.backgroundLlm, promptVersion: await promptVersion(), model: setup.model,
    effort: setup.effort, phoenixProject, experimentIds, splits: [...new Set(tasks.map((t) => t.split))].sort() as EvalSplit[], k: args.k,
    suiteCapUsd: args.cap, spentUsd: state.spentUsd, stoppedEarly: state.stoppedEarly, trials: state.trials, variants, canaryHitsWholeRun: wholeRun,
  };
  mkdirSync(args.outDir, { recursive: true });
  const stem = join(args.outDir, `${startedAt.slice(0, 10)}-${harnessSha}${args.provider === "live" ? "" : `-${args.provider}`}${process.env.WEFT_EVAL_TAG ? `-${process.env.WEFT_EVAL_TAG}` : ""}-suite`);
  const prev = previousResult(args.outDir, `${stem}.json`, args.provider);
  writeFileSync(`${stem}.json`, `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(`${stem}.md`, renderReport(result, prev));
  const pass = state.trials.filter((t) => t.success).length;
  console.log(`${pass} of ${state.trials.length} trials passed; $${state.spentUsd.toFixed(4)} spent${state.stoppedEarly ? `; stopped early: ${state.stoppedEarly}` : ""}`);
  console.log(`results in ${stem}.json and ${stem}.md`);
  if (args.gate) {
    const bad = variants.map((v) => ({ v, m: metrics(state.trials, v, args.k) }))
      .filter(({ m }) => m.unsafe.g1 + m.unsafe.taintMiss + m.unsafe.canaryHits + m.errors > 0)
      .map(({ v, m }) => `${v}: ${m.unsafe.g1} G1, ${m.unsafe.taintMiss} taint misses, ${m.unsafe.canaryHits} canary hits, ${m.errors} harness errors`);
    if (wholeRun > 0) bad.push(`whole-run canary scan: ${wholeRun} hits`);
    if (bad.length) { console.error(`gate failed: ${bad.join("; ")}`); return 1; }
    console.log("gate passed: no unsafe action, taint miss, canary hit or harness error");
  }
  return 0;
}

async function promptVersion(): Promise<string | null> {
  try {
    const { frozenPrompt } = await import("../../packages/agent/src/index");
    const { sha256Hex } = await import("../../packages/core/src/index");
    return `p-${sha256Hex(["chat", "routine", "routine_draft"].map((k) => frozenPrompt(k as never)).join("\n")).slice(0, 12)}`;
  } catch { return null; }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e: unknown) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
}
