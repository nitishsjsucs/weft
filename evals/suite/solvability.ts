// Held-out solvability on the scripted provider (owner: w4-eval-heldout; docs/wave4.md section 14). Every variant of
// every task of a held-out split runs through the suite runner twice, in scripted mode, at $0, on its pinned world:
// once with its oracle (evals/suite/tasks/<split>/oracles.ts) or, for a task the product path passes, with the
// product's own scripted path; and once with NULL_ORACLE, a plain "Done.". A solvable task passes the first and fails
// the second, so its graders accept the right answer and reject an empty one. No live model is ever called.
//   node_modules/.bin/tsx evals/suite/solvability.ts [--split test] [--ids CQ-61,RT-61] [--verbose]
// Output names task ids, variants and the failing grader ids only; --verbose adds the grader reasons (they can quote
// task figures, so keep that output out of fixer-visible places).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Script } from "../../packages/agent/src/providers/scripted";
import { scriptedProvider } from "../../packages/agent/src/index";
import type { EvalVariant } from "../../packages/contracts/src/telemetry";
import { loadTasks, REPO_ROOT } from "./loader";
import { newState, runPlain, type RunnerOptions } from "./runner";
import { HELD_OUT_SPLITS, type HeldOutSplit } from "./splits";
import type { EvalTask, SuiteTrial } from "./types";

export interface OracleModule {
  oracleFor(taskId: string, variant: string): Script | null;
  NULL_ORACLE: Script;
  PRODUCT_PATH_PASSES: readonly string[];
  BLOCKED_ON_HARNESS: readonly string[];
  WAITING_ON_PARITY: readonly string[];
}

export interface SolvabilityRow {
  taskId: string; variant: EvalVariant;
  path: "oracle" | "product" | "blocked" | "waiting";
  solved: boolean; nullPasses: boolean;
  failing: string[]; nullFailing: string[]; reasons: string[];
}

const failingGraders = (t: SuiteTrial) => [
  ...t.graders.filter((g) => g.applies && g.grader !== "G10" && !g.pass).map((g) => g.grader),
  ...(t.error ? [t.error.startsWith("WORLD_") ? t.error.split(":")[0]! : t.error.startsWith("HARNESS") ? "HARNESS" : "END_STATE"] : []),
];

async function one(task: EvalTask, variant: EvalVariant, script: Script | null, baseDir: string): Promise<SuiteTrial> {
  const provider = script ? () => scriptedProvider({ scriptsDir: join(REPO_ROOT, "scenarios"), scripts: { oracle: script }, scenario: "oracle" }) : undefined;
  const opts: RunnerOptions = { mode: "scripted", provider, baseDir, suiteCapUsd: 1, harnessSha: "solvability", requireDigest: true, wave: null };
  const state = await runPlain([{ task, variant, trial: 1 }], opts, newState());
  return state.trials[0]!;
}

/** Runs the oracle (or product path) and the null oracle for every task variant of the split. */
export async function solvability(split: HeldOutSplit, oracles: OracleModule, opts: { ids?: string[] | null; baseDir?: string } = {}): Promise<SolvabilityRow[]> {
  const tasks = loadTasks([split]).map((l) => l.task).filter((t) => !opts.ids || opts.ids.includes(t.id));
  const baseDir = opts.baseDir ?? mkdtempSync(join(tmpdir(), "weft-solvability-"));
  const rows: SolvabilityRow[] = [];
  try {
    for (const t of tasks) for (const v of t.variants) {
      const key = `${t.id}/${v}`;
      const script = oracles.oracleFor(t.id, v);
      const path: SolvabilityRow["path"] = oracles.WAITING_ON_PARITY.includes(t.id) ? "waiting" : oracles.BLOCKED_ON_HARNESS.includes(key) ? "blocked" : script ? "oracle" : oracles.PRODUCT_PATH_PASSES.includes(t.id) ? "product" : "oracle";
      const good = await one(t, v, script, baseDir);
      const bad = await one(t, v, oracles.NULL_ORACLE, baseDir);
      rows.push({
        taskId: t.id, variant: v, path, solved: good.success, nullPasses: bad.success, failing: failingGraders(good), nullFailing: failingGraders(bad),
        reasons: [good.error ?? "", ...good.graders.filter((g) => g.applies && !g.pass && g.grader !== "G10").map((g) => `${g.grader}: ${g.reasons.join("; ")}`)].filter(Boolean),
      });
    }
  } finally { if (!opts.baseDir) rmSync(baseDir, { recursive: true, force: true }); }
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const at = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] ?? null : null; };
  const split = (at("--split") ?? "test") as HeldOutSplit;
  if (!HELD_OUT_SPLITS.includes(split)) { console.error(`not a held-out split: ${split}`); process.exit(2); }
  const ids = at("--ids")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
  const verbose = argv.includes("--verbose");
  const oracles = (await import(`./tasks/${split}/oracles.ts`)) as OracleModule;
  const rows = await solvability(split, oracles, { ids, baseDir: process.env.WEFT_EVAL_DIR });
  for (const r of rows) {
    console.log(`${r.taskId} ${r.variant} ${r.path}: ${r.solved ? "solved" : `NOT SOLVED (${r.failing.join(", ")})`}; null reply ${r.nullPasses ? "PASSES" : `fails (${r.nullFailing.join(", ")})`}`);
    if (verbose && !r.solved) for (const x of r.reasons) console.log(`    ${x.slice(0, 600)}`);
  }
  const solved = rows.filter((r) => r.solved).length;
  const nullPass = rows.filter((r) => r.nullPasses).length;
  console.log(`${solved} of ${rows.length} task variants solved; a null reply passes ${nullPass}`);
  process.exit(rows.some((r) => !r.solved && (r.path === "oracle" || r.path === "product")) ? 1 : 0);
}
