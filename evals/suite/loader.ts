// Task loader and validator (research/wave4/evals.md 4.1, docs/wave4.md 4). Owner: w4-eval-suite.
// Tasks live in evals/suite/tasks/<split>/<id>.json in the EvalTask shape; each names a reference note that proves it
// solvable. Validation is strict: the schema, the file name and folder, one expectation per listed variant and none
// for an unlisted one, known mutators and drivers, an existing reference note, and unique ids and legacy cases.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EvalTask, type EvalSplit } from "../../packages/contracts/src/evals";
import { eventTimes, KNOWN_EVENT_DRIVERS, MAX_EVENT_TIMES } from "./drivers";
import { knownMutator, WORLD_BASE } from "./worlds/index";

export const REPO_ROOT = resolve(import.meta.dirname, "../..");
export const TASKS_DIR = join(REPO_ROOT, "evals/suite/tasks");

export class TaskValidationError extends Error {
  constructor(public readonly problems: string[]) { super(`${problems.length} task problems:\n${problems.join("\n")}`); }
}

export interface LoadedTask { task: EvalTask; file: string }

/** Validates one parsed task file; returns the problems (empty when it is valid). */
export function validateTask(raw: unknown, file: string, opts: { root?: string } = {}): { task: EvalTask | null; problems: string[] } {
  const root = opts.root ?? REPO_ROOT;
  const parsed = EvalTask.safeParse(raw);
  if (!parsed.success) return { task: null, problems: parsed.error.issues.map((i) => `${file}: ${i.path.join(".") || "(root)"}: ${i.message}`) };
  const t = parsed.data;
  const p: string[] = [];
  const at = (m: string) => p.push(`${file}: ${m}`);
  const base = file.split("/").pop()!.replace(/\.json$/, "");
  if (base !== t.id) at(`file name ${base} does not match id ${t.id}`);
  const folder = file.split("/").slice(-2, -1)[0];
  if (folder && (folder === "dev" || folder === "test") && folder !== t.split) at(`split ${t.split} but the file is under tasks/${folder}`);
  for (const v of t.variants) if (!t.expect[v]) at(`variant ${v} is listed but has no expectation`);
  for (const v of Object.keys(t.expect)) if (!t.variants.includes(v as never)) at(`expectation for ${v}, which is not a listed variant`);
  if (new Set(t.variants).size !== t.variants.length) at("a variant is listed twice");
  if (t.variants.includes("chat_can_propose") && t.surface !== "chat") at("the chat_can_propose variant only applies to chat tasks");
  if (t.world.base !== WORLD_BASE) at(`world base ${t.world.base}, the suite builds ${WORLD_BASE}`);
  if (Number.isNaN(Date.parse(t.world.clock))) at(`world clock ${t.world.clock} is not an ISO time`);
  for (const m of t.world.mutators) if (!knownMutator(m)) at(`unknown mutator ${m}`);
  if (t.world.digest !== null && !/^sha256:[0-9a-f]{64}$/.test(t.world.digest)) at(`digest ${t.world.digest} is not sha256:<64 hex>`);
  if ("routine" in t.input && t.input.event) {
    const type = t.input.event.type;
    if (!type) at("a routine event needs a type");
    if (eventTimes(t.input.event) === null) at(`event times must be 1 to ${MAX_EVENT_TIMES}`);
    if (t.input.event.times !== undefined && type === "offer.sign") at("offer.sign does not repeat");
  }
  if ("chat" in t.input && t.surface !== "chat") at(`surface ${t.surface} with a chat input`);
  if ("routine" in t.input && t.surface !== "routine") at(`surface ${t.surface} with a routine input`);
  if (!/^usr_[a-z0-9_]+$/.test(t.principal)) at(`principal ${t.principal} is not a usr_ principal`);
  const ref = join(root, t.reference);
  if (!t.reference.startsWith(`evals/suite/reference/${t.split}/`)) at(`reference ${t.reference} must live under evals/suite/reference/${t.split}/`);
  else if (!existsSync(ref) || readFileSync(ref, "utf8").trim().length < 40) at(`reference note ${t.reference} is missing or empty`);
  if (t.kind === "regression" && !t.legacyCase && t.split === "test") at("a test task cannot be a tuned regression task");
  for (const [v, e] of Object.entries(t.expect)) {
    if (!e) continue;
    for (const s of e.endState) if (!/^\s*select\s/i.test(s.sql)) at(`${v}: end-state check is not a SELECT: ${s.sql}`);
    if (e.refusal !== "none" && e.proposals && e.proposals.length) at(`${v}: a refusal task cannot expect proposals`);
  }
  return { task: t, problems: p };
}

export function taskFiles(split: EvalSplit, dir = TASKS_DIR): string[] {
  const d = join(dir, split);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => f.endsWith(".json")).sort().map((f) => join(d, f));
}

/** Loads and validates every task of the splits; throws TaskValidationError listing every problem. */
export function loadTasks(splits: EvalSplit[], opts: { dir?: string; root?: string } = {}): LoadedTask[] {
  const out: LoadedTask[] = [];
  const problems: string[] = [];
  for (const split of splits) {
    for (const file of taskFiles(split, opts.dir)) {
      const rel = file.slice((opts.root ?? REPO_ROOT).length + 1);
      let raw: unknown;
      try { raw = JSON.parse(readFileSync(file, "utf8")); } catch (e) { problems.push(`${rel}: not JSON (${(e as Error).message})`); continue; }
      const { task, problems: p } = validateTask(raw, rel, opts);
      problems.push(...p);
      if (task) out.push({ task, file });
    }
  }
  const seen = new Map<string, string>();
  for (const { task, file } of out) {
    if (seen.has(task.id)) problems.push(`duplicate task id ${task.id} in ${file} and ${seen.get(task.id)}`);
    seen.set(task.id, file);
  }
  const legacy = new Map<string, string>();
  for (const { task } of out) {
    if (!task.legacyCase) continue;
    if (legacy.has(task.legacyCase)) problems.push(`legacy case ${task.legacyCase} ported twice (${task.id} and ${legacy.get(task.legacyCase)})`);
    legacy.set(task.legacyCase, task.id);
  }
  if (problems.length) throw new TaskValidationError(problems);
  return out;
}

export { KNOWN_EVENT_DRIVERS };
