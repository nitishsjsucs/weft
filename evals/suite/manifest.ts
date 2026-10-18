// Held-out manifests (owner: w4-eval-heldout): sha256 of every task, reference note and the split's world mutators and
// oracles, plus per-group counts, the only numbers other tracks may see. Any edit to a held-out file changes a hash, so
// it shows in review and fails tests/evals-antileak.test.ts until the manifest is rewritten on purpose. One manifest per
// held-out split: the active test split and each retired split (evals/suite/splits.ts).
//   node_modules/.bin/tsx evals/suite/manifest.ts --write [split]    rewrite that split's manifest (default: every one)
//   node_modules/.bin/tsx evals/suite/manifest.ts [split]            check, exit 1 on drift
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HELD_OUT_SPLITS, SPLITS, type HeldOutSplit } from "./splits";

export interface ManifestSpec {
  split: HeldOutSplit;
  taskDir: string;
  referenceDir: string;
  manifestPath: string;
  /** The split's world mutators and oracles, hashed with the tasks. */
  hashedExtra: string[];
}

export function manifestSpec(split: HeldOutSplit): ManifestSpec {
  const taskDir = `evals/suite/tasks/${split}`;
  return { split, taskDir, referenceDir: `evals/suite/reference/${split}`, manifestPath: SPLITS[split].manifest!, hashedExtra: [`${taskDir}/worlds.ts`, `${taskDir}/oracles.ts`] };
}

/** The active held-out split's paths (kept as constants: most callers mean this one). */
export const TASK_DIR = "evals/suite/tasks/test";
export const REFERENCE_DIR = "evals/suite/reference/test";
export const MANIFEST_PATH = SPLITS.test.manifest!;

export interface TestManifest {
  split: HeldOutSplit;
  author: "w4-eval-heldout";
  algorithm: "sha256";
  /** held_out for the split confirmations run on; retired for a split kept frozen and runnable for continuity. */
  status: "held_out" | "retired";
  /** The Phoenix dataset name the split's runs record into (evals/suite/splits.ts). */
  dataset: string;
  taskCount: number;
  /** Per capability group counts: the only held-out numbers other tracks may see. */
  groups: Record<string, number>;
  kinds: Record<string, number>;
  files: Record<string, string>;
}

const sha = (path: string) => `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
const sortObj = <T>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

export function testTaskFiles(root: string, split: HeldOutSplit = "test"): string[] {
  const { taskDir } = manifestSpec(split);
  return readdirSync(join(root, taskDir)).filter((f) => f.endsWith(".json")).sort().map((f) => `${taskDir}/${f}`);
}

export function buildTestManifest(root: string, split: HeldOutSplit = "test"): TestManifest {
  const spec = manifestSpec(split);
  const tasks = testTaskFiles(root, split);
  const groups: Record<string, number> = {};
  const kinds: Record<string, number> = {};
  const files: Record<string, string> = {};
  for (const rel of tasks) {
    const t = JSON.parse(readFileSync(join(root, rel), "utf8")) as { group: string; kind: string; reference: string };
    groups[t.group] = (groups[t.group] ?? 0) + 1;
    kinds[t.kind] = (kinds[t.kind] ?? 0) + 1;
    files[rel] = sha(join(root, rel));
    files[t.reference] = sha(join(root, t.reference));
  }
  for (const rel of spec.hashedExtra) files[rel] = sha(join(root, rel));
  const info = SPLITS[split];
  return {
    split, author: "w4-eval-heldout", algorithm: "sha256", status: info.status === "retired" ? "retired" : "held_out", dataset: info.dataset!,
    taskCount: tasks.length, groups: sortObj(groups), kinds: sortObj(kinds), files: sortObj(files),
  };
}

/** Differences between the manifest on disk and the files: changed, missing and unlisted paths. */
export function manifestDrift(root: string, split: HeldOutSplit = "test"): string[] {
  const spec = manifestSpec(split);
  const want = buildTestManifest(root, split);
  let have: TestManifest;
  try { have = JSON.parse(readFileSync(join(root, spec.manifestPath), "utf8")) as TestManifest; } catch { return [`${spec.manifestPath} is missing or not JSON`]; }
  const out: string[] = [];
  for (const [p, h] of Object.entries(want.files)) {
    if (!(p in have.files)) out.push(`unlisted: ${p}`);
    else if (have.files[p] !== h) out.push(`changed: ${p}`);
  }
  for (const p of Object.keys(have.files)) if (!(p in want.files)) out.push(`missing: ${p}`);
  if (have.taskCount !== want.taskCount) out.push(`taskCount ${have.taskCount} on disk, ${want.taskCount} in the folder`);
  if (JSON.stringify(have.groups) !== JSON.stringify(want.groups)) out.push("group counts differ");
  if (have.status !== want.status) out.push(`status ${have.status} on disk, ${want.status} in evals/suite/splits.ts`);
  if (have.dataset !== want.dataset) out.push(`dataset ${have.dataset} on disk, ${want.dataset} in evals/suite/splits.ts`);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = resolve(import.meta.dirname, "../..");
  const args = process.argv.slice(2);
  const named = args.filter((a) => !a.startsWith("--")) as HeldOutSplit[];
  for (const s of named) if (!HELD_OUT_SPLITS.includes(s)) { console.error(`not a held-out split: ${s}`); process.exit(2); }
  const splits = named.length ? named : HELD_OUT_SPLITS;
  let drifted = 0;
  for (const split of splits) {
    const spec = manifestSpec(split);
    if (args.includes("--write")) {
      writeFileSync(join(root, spec.manifestPath), `${JSON.stringify(buildTestManifest(root, split), null, 2)}\n`);
      console.log(`wrote ${spec.manifestPath}`);
    } else {
      const drift = manifestDrift(root, split);
      for (const d of drift) console.log(`${split}: ${d}`);
      drifted += drift.length;
    }
  }
  process.exit(drifted ? 1 : 0);
}
