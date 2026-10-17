// The held-out manifest (owner: w4-eval-heldout): sha256 of every test task, reference note and the test world
// mutators, plus per-group counts, the only numbers other tracks may see. Any edit to a test file changes a hash, so it
// shows in review and fails tests/evals-antileak.test.ts until the manifest is rewritten on purpose.
//   node_modules/.bin/tsx evals/suite/tasks/test/manifest.ts --write    rewrite evals/suite/test-manifest.json
//   node_modules/.bin/tsx evals/suite/tasks/test/manifest.ts            check, exit 1 on drift
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const TASK_DIR = "evals/suite/tasks/test";
export const REFERENCE_DIR = "evals/suite/reference/test";
export const MANIFEST_PATH = "evals/suite/test-manifest.json";
export const HASHED_EXTRA = [`${TASK_DIR}/worlds.ts`];

export interface TestManifest {
  split: "test";
  author: "w4-eval-heldout";
  algorithm: "sha256";
  taskCount: number;
  /** Per capability group counts: the only test split numbers other tracks may see. */
  groups: Record<string, number>;
  kinds: Record<string, number>;
  files: Record<string, string>;
}

const sha = (path: string) => `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
const sortObj = <T>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

export function testTaskFiles(root: string): string[] {
  return readdirSync(join(root, TASK_DIR)).filter((f) => f.endsWith(".json")).sort().map((f) => `${TASK_DIR}/${f}`);
}

export function buildTestManifest(root: string): TestManifest {
  const tasks = testTaskFiles(root);
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
  for (const rel of HASHED_EXTRA) files[rel] = sha(join(root, rel));
  return { split: "test", author: "w4-eval-heldout", algorithm: "sha256", taskCount: tasks.length, groups: sortObj(groups), kinds: sortObj(kinds), files: sortObj(files) };
}

/** Differences between the manifest on disk and the files: changed, missing and unlisted paths. */
export function manifestDrift(root: string): string[] {
  const want = buildTestManifest(root);
  let have: TestManifest;
  try { have = JSON.parse(readFileSync(join(root, MANIFEST_PATH), "utf8")) as TestManifest; } catch { return [`${MANIFEST_PATH} is missing or not JSON`]; }
  const out: string[] = [];
  for (const [p, h] of Object.entries(want.files)) {
    if (!(p in have.files)) out.push(`unlisted: ${p}`);
    else if (have.files[p] !== h) out.push(`changed: ${p}`);
  }
  for (const p of Object.keys(have.files)) if (!(p in want.files)) out.push(`missing: ${p}`);
  if (have.taskCount !== want.taskCount) out.push(`taskCount ${have.taskCount} on disk, ${want.taskCount} in the folder`);
  if (JSON.stringify(have.groups) !== JSON.stringify(want.groups)) out.push("group counts differ");
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = resolve(import.meta.dirname, "../../../..");
  if (process.argv.includes("--write")) {
    writeFileSync(join(root, MANIFEST_PATH), `${JSON.stringify(buildTestManifest(root), null, 2)}\n`);
    console.log(`wrote ${MANIFEST_PATH}`);
  } else {
    const drift = manifestDrift(root);
    for (const d of drift) console.log(d);
    process.exit(drift.length ? 1 : 0);
  }
}
