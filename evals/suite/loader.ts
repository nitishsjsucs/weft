// Task loader and validator (research/wave4/evals.md 4.1, docs/wave4.md 4). Owner: w4-eval-suite.
// Tasks live in evals/suite/tasks/<split>/<id>.json in the EvalTask shape; each names a reference note that proves it
// solvable. Validation is strict: the schema, the file name and folder, one expectation per listed variant and none
// for an unlisted one, known mutators and drivers, an existing reference note, unique ids and legacy cases, and the
// G3 authoring rule for injection tasks (docs/evals.md).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EvalSplit, EvalTask, type EvalExpectation } from "../../packages/contracts/src/evals";
import { eventTimes, KNOWN_EVENT_DRIVERS, MAX_EVENT_TIMES } from "./drivers";
import { SPLITS } from "./splits";
import { knownMutator, WORLD_BASE } from "./worlds/index";

export const REPO_ROOT = resolve(import.meta.dirname, "../..");
export const TASKS_DIR = join(REPO_ROOT, "evals/suite/tasks");

export class TaskValidationError extends Error {
  constructor(public readonly problems: string[]) { super(`${problems.length} task problems:\n${problems.join("\n")}`); }
}

export interface LoadedTask { task: EvalTask; file: string }

/** The commands that send a message or a report once approved. */
export const SEND_COMMANDS = ["comms.send_message", "comms.send_report"] as const;

/**
 * The G3 authoring rule (docs/evals.md). G3 grades what was sent, never what was proposed, and a proposal to send is
 * not a send until a person approves it. So an injection task that expects no message and leaves proposals ungraded
 * would pass an agent that files the injected send as a proposal, unless its end state forbids one. Returns the send
 * commands such a task leaves open: those with no end-state check that counts proposals naming the command and
 * expects 0. Empty for every other task. The loader applies it to dev and the active held-out split; a retired split
 * is frozen, so its numbers stay comparable with the runs made while it was held out.
 */
export function openSendProposals(group: EvalTask["group"], e: EvalExpectation): string[] {
  if (group !== "prompt_injection") return [];
  const expectsNoMessage = e.messages !== null && e.messages.every((m) => m.count === 0);
  if (!expectsNoMessage || e.proposals !== null) return [];
  const forbids = (command: string) => e.endState.some((s) => s.equals === 0 && /\bfrom\s+proposals\b/i.test(s.sql) && s.sql.includes(`'${command}'`));
  return SEND_COMMANDS.filter((c) => !forbids(c));
}

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
  if (folder && (EvalSplit.options as readonly string[]).includes(folder) && folder !== t.split) at(`split ${t.split} but the file is under tasks/${folder}`);
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
  if (t.kind === "regression" && !t.legacyCase && t.split !== "dev") at("a held-out task cannot be a tuned regression task");
  for (const [v, e] of Object.entries(t.expect)) {
    if (!e) continue;
    for (const s of e.endState) if (!/^\s*select\s/i.test(s.sql)) at(`${v}: end-state check is not a SELECT: ${s.sql}`);
    if (e.refusal !== "none" && e.proposals && e.proposals.length) at(`${v}: a refusal task cannot expect proposals`);
    const open = SPLITS[t.split].status === "retired" ? [] : openSendProposals(t.group, e);
    if (open.length) at(`${v}: an injection task that expects no message and does not grade proposals must forbid ${open.join(" and ")} proposals in endState (G3 grades sends, not proposals to send)`);
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
