// pnpm seed:record-showcase: records the rich world's showcase runs (packages/seed/src/rich/showcase.ts).
//
// It builds a fresh rich world without the showcase runs in .scratch/showcase/record (the spend ledger in its spend/
// folder is kept, so WEFT_LIVE_USD_CAP is cumulative across recordings), then plays SCRIPT on the sim clock: chat
// threads asked through POST /v1/agent/runs as the person named, routines fired the way the engine fires them (a cron
// slot unattended, or Run now as a person), one scheduler tick after each step. Then it diffs the database against
// the world before the script, collects the run workspace files and the memory calls in order, and writes the
// fixture the rich seed replays. Finally it seeds a second world with that fixture and checks it matches the recorded
// one table by table, with the same memory HEAD.
//
// Live only when asked for: WEFT_LIVE_OPENAI=1 WEFT_LLM=openai WEFT_SECRETS_FILE=<file>. WEFT_BACKGROUND_LLM=1 is set,
// so the unattended cron runs use the model too. The spend caps are the usual ones (WEFT_RUN_USD_CAP 0.10,
// WEFT_DAY_USD_CAP 2.00, WEFT_LIVE_USD_CAP 0.50 cumulative). The key is read by the provider only; nothing here
// prints it, and the fixture is scanned for it, for key shapes and for IP addresses before it is written.
//
//   pnpm seed:record-showcase                 scripted provider, writes .scratch/showcase/fixture.scripted.json
//   WEFT_LIVE_OPENAI=1 WEFT_LLM=openai WEFT_SECRETS_FILE=... pnpm seed:record-showcase --write
//                                              live, writes packages/seed/src/rich/showcase.json
//   pnpm seed:record-showcase --verify        seeds a rich world with the committed fixture and checks it applies
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const live = process.env.WEFT_LLM === "openai";
if (live && process.env.WEFT_LIVE_OPENAI !== "1") {
  console.error("record-showcase: a live recording is opt-in; set WEFT_LIVE_OPENAI=1 with WEFT_LLM=openai");
  process.exit(2);
}
if (argv.includes("--write") && !live) {
  console.error("record-showcase: --write records the committed fixture and needs the live model (WEFT_LLM=openai)");
  process.exit(2);
}
process.env.WEFT_DEV_AUTH = "1";
process.env.WEFT_CLOCK_RATE = "0";
process.env.WEFT_BACKGROUND_LLM = "1";
process.env.WEFT_LIVE_USD_CAP ??= "0.50";
// Hosted-only switches stay off: the recording is a plain Node world (git memory, file blobs, counter read ids).
for (const k of ["WEFT_MEMORY", "WEFT_BLOBS", "WEFT_EPHEMERAL_READ_IDS", "WEFT_PREBUILT_HASH", "WEFT_TRACE"]) delete process.env[k];

const { createWeft } = await import("../apps/api/src/index");
const { seedWorldProfile } = await import("../packages/seed/src/profile");
const { DIGEST_EXCLUDE } = await import("../packages/seed/src/index");
const showcase = await import("../packages/seed/src/rich/showcase");
const { cronSlot } = await import("../packages/seed/src/rich/index");
const { payroll, SEED_TIME } = await import("../packages/core/src/index");
const { loadSecret } = await import("../packages/agent/src/index");

type Weft = Awaited<ReturnType<typeof createWeft>>;
type Fixture = import("../packages/seed/src/rich/showcase").ShowcaseFixture;
type TableDiff = import("../packages/seed/src/rich/showcase").ShowcaseTableDiff;
type MemoryCall = import("../packages/seed/src/rich/showcase").ShowcaseMemoryCall;

const pt = (date: string, hour: number, minute = 0) => payroll.ptToUtc(date, hour, minute);
const FRI = "2026-10-23", MON = "2026-10-26";

// ---- the script ------------------------------------------------------------------------------------------------

/** A conversation thread: its id is derived from its key, so a re-recording keeps the same thread ids. */
const thread = (key: string) => `thr_${createHash("sha256").update(`weft-showcase:${key}`).digest("hex").slice(0, 20)}`;

type Step =
  | { kind: "chat"; at: string; who: string; thread: string; text: string }
  | { kind: "cron"; at: string; routine: string }
  | { kind: "run_now"; at: string; routine: string; who: string }
  | { kind: "setting"; at: string; who: string; chatCanPropose: boolean };

/**
 * Friday evening after the week's last planted action (Owen Mercer's close-out at 5:30 pm), then Monday morning up to
 * the seed time (8:30 am PT): every row a step writes lands after the world's history, in time order. The three
 * pending time-off requests were filed at 8:30, so the steps that read them run at 8:30.
 */
const SCRIPT: Step[] = [
  // Friday: payroll questions before the Wednesday approval deadline.
  { kind: "chat", at: pt(FRI, 17, 52), who: "usr_dana", thread: thread("payroll-cost"), text: "Show payroll cost by month for 2026" },
  { kind: "chat", at: pt(FRI, 17, 55), who: "usr_dana", thread: thread("payroll-cost"), text: "Why is October so much lower than the rest of the year?" },
  { kind: "chat", at: pt(FRI, 18, 4), who: "usr_dana", thread: thread("flagged"), text: "Which paychecks are flagged in the Oct 30 payroll draft?" },
  { kind: "chat", at: pt(FRI, 18, 7), who: "usr_dana", thread: thread("flagged"), text: "Why is Lena Brooks flagged?" },
  { kind: "chat", at: pt(FRI, 18, 10), who: "usr_dana", thread: thread("flagged"), text: "Will Mira Delgado get paid on Oct 30?" },
  // Monday morning: the scheduled routines, the review before the deadline, and the week's questions.
  { kind: "cron", at: cronSlot("rt_compliance_training", MON), routine: "rt_compliance_training" },
  { kind: "run_now", at: pt(MON, 7, 40), routine: "rt_pre_payroll", who: "usr_theo" },
  { kind: "chat", at: pt(MON, 7, 46), who: "usr_dana", thread: thread("offboarding"), text: "Where are we with offboarding Owen Mercer and Jonah Pell?" },
  { kind: "chat", at: pt(MON, 7, 49), who: "usr_dana", thread: thread("offboarding"), text: "What is left to do before Jonah's last day?" },
  { kind: "cron", at: cronSlot("rt_compliance_reminders", MON), routine: "rt_compliance_reminders" },
  { kind: "cron", at: cronSlot("rt_exec_briefing", MON), routine: "rt_exec_briefing" },
  { kind: "cron", at: cronSlot("rt_weekly_cost_by_state", MON), routine: "rt_weekly_cost_by_state" },
  { kind: "cron", at: cronSlot("rt_first_day_message", MON), routine: "rt_first_day_message" },
  { kind: "chat", at: pt(MON, 8, 6), who: "usr_dana", thread: thread("deadlines"), text: "What filing and deposit deadlines are coming up?" },
  { kind: "chat", at: pt(MON, 8, 9), who: "usr_dana", thread: thread("expense-policy"), text: "What does our expense policy say about client dinners and hotel stays?" },
  { kind: "chat", at: pt(MON, 8, 11), who: "usr_dana", thread: thread("expense-policy"), text: "And what do we pay for mileage?" },
  { kind: "chat", at: pt(MON, 8, 13), who: "usr_dana", thread: thread("headcount"), text: "How many people are in each department?" },
  { kind: "chat", at: pt(MON, 8, 15), who: "usr_dana", thread: thread("headcount"), text: "And how many people joined and left each month so far this year?" },
  { kind: "run_now", at: pt(MON, 8, 17), routine: "rt_onboarding_nudge", who: "usr_sam" },
  { kind: "run_now", at: pt(MON, 8, 18), routine: "rt_new_hire_ready", who: "usr_sam" },
  { kind: "run_now", at: pt(MON, 8, 19), routine: "rt_people_digest", who: "usr_dana" },
  { kind: "run_now", at: pt(MON, 8, 20), routine: "rt_monthly_exec_report", who: "usr_dana" },
  // A request that ends in an approval card, then the bulk approval the agent refuses.
  { kind: "setting", at: pt(MON, 8, 21), who: "usr_dana", chatCanPropose: true },
  { kind: "chat", at: pt(MON, 8, 22), who: "usr_dana", thread: thread("bonus"), text: "Please propose a $1,500 bonus for Kofi Mensah, paid off-cycle on Friday, Oct 30, for taking over Jonah's test tooling." },
  { kind: "setting", at: pt(MON, 8, 24), who: "usr_dana", chatCanPropose: false },
  { kind: "chat", at: pt(MON, 8, 25), who: "usr_dana", thread: thread("bonus"), text: "Approve everything in my inbox" },
  // The requests filed at 8:30: the review of the oldest, and who is out next month.
  { kind: "run_now", at: SEED_TIME, routine: "rt_time_off_requests", who: "usr_dana" },
  { kind: "chat", at: SEED_TIME, who: "usr_dana", thread: thread("time-off"), text: "Who is out next month, and is any team short on coverage?" },
  { kind: "chat", at: SEED_TIME, who: "usr_dana", thread: thread("time-off"), text: "How many vacation hours will Ruth Okoro have left after Thanksgiving week?" },
];

// ---- world ------------------------------------------------------------------------------------------------------

const SCRATCH = join(ROOT, ".scratch/showcase");
const headers = (w: Weft, principal: string) => ({ "x-weft-principal": principal, "x-weft-proxy": w.proxySecret, "content-type": "application/json", host: `127.0.0.1:${w.ports.api}` });
async function call<T>(w: Weft, method: string, path: string, principal: string, body?: unknown): Promise<T> {
  const res = await w.app.request(path, { method, headers: headers(w, principal), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  if (res.status >= 300) throw new Error(`${method} ${path} as ${principal} answered ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text) as T;
}

/** A fresh data dir, keeping the spend ledger when asked. */
function freshDir(dir: string, keepSpend: boolean): void {
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) if (!(keepSpend && f === "spend")) rmSync(join(dir, f), { recursive: true, force: true });
}

async function richWorld(dir: string, opts: { showcase: boolean; fixturePath?: string }): Promise<Weft> {
  const weft = await createWeft({ dataDir: dir, strict: true });
  await seedWorldProfile(weft as never, "rich", { showcase: opts.showcase, ...(opts.fixturePath ? { showcaseFixture: opts.fixturePath } : {}) });
  await weft.clock.set(SEED_TIME, 0);
  return weft;
}

// ---- dump and diff ---------------------------------------------------------------------------------------------

/** Tables that are not world content, or that the world rebuilds itself: migrations, hosted runtime state, run
 * handles (bearer tokens), memory (replayed through the store instead) and the prebuilt routine rows (every boot
 * writes them from the code). */
const SKIP_TABLES = new Set(["__drizzle_migrations", "kv_state", "run_handles", "_weft_dirty", "mem_objects", "mem_refs", "mem_log", "routines", "run_files", "outbox"]);
/** Settings rows that are the clock (the seed sets it) or wall time. */
const SKIP_SETTINGS = new Set(["clock.base_sim", "clock.base_wall", "clock.rate"]);

interface TableDump { columns: string[]; key: string[]; rowid: boolean; rows: Map<string, unknown[]> }
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const cellOut = (v: unknown): unknown => (v instanceof ArrayBuffer ? { $blob: hex(new Uint8Array(v)) } : ArrayBuffer.isView(v) ? { $blob: hex(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) } : v);

/** Raw reads through the libsql client (the root package has no drizzle of its own). */
async function q<T>(w: Weft, text: string, args: unknown[] = []): Promise<T[]> {
  const client = (w.db as unknown as { $client: { execute(x: { sql: string; args: unknown[] }): Promise<{ rows: T[] }> } }).$client;
  return (await client.execute({ sql: text, args })).rows;
}

async function dumpAll(w: Weft): Promise<Map<string, TableDump>> {
  const out = new Map<string, TableDump>();
  const tables = await q<{ name: string }>(w, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND substr(name, 1, 4) <> '_cf_' ORDER BY name");
  for (const { name } of tables) {
    if (SKIP_TABLES.has(name)) continue;
    const info = await q<{ name: string; type: string; pk: number }>(w, `PRAGMA table_info("${name}")`);
    const columns = info.map((c) => c.name);
    const pk = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
    const aliased = pk.length === 1 && /^integer$/i.test(pk[0]!.type);
    const rowid = !aliased;
    const key = pk.length ? pk.map((c) => c.name) : ["rowid"];
    const list = columns.map((c) => `"${c}"`).join(", ");
    const rows = await q<Record<string, unknown>>(w, `SELECT ${rowid ? "rowid AS __rowid, " : ""}${list} FROM "${name}" ORDER BY ${rowid ? "rowid" : `"${pk[0]!.name}"`}`);
    const m = new Map<string, unknown[]>();
    for (const r of rows) {
      if (name === "settings" && SKIP_SETTINGS.has(String(r.key))) continue;
      const vals = [...(rowid ? [r.__rowid] : []), ...columns.map((c) => cellOut(r[c]))];
      const k = JSON.stringify(key.map((c) => (c === "rowid" ? r.__rowid : r[c])));
      m.set(k, vals);
    }
    out.set(name, { columns, key, rowid, rows: m });
  }
  return out;
}

function diffDumps(a: Map<string, TableDump>, b: Map<string, TableDump>): Record<string, TableDiff> {
  const out: Record<string, TableDiff> = {};
  for (const [name, tb] of b) {
    const ta = a.get(name);
    if (ta && JSON.stringify(ta.columns) !== JSON.stringify(tb.columns)) throw new Error(`table ${name} changed shape during the recording`);
    const off = tb.rowid ? 1 : 0;
    const keyOf = (vals: unknown[]) => Object.fromEntries(tb.key.map((k) => [k, k === "rowid" ? vals[0] : vals[off + tb.columns.indexOf(k)]]));
    const d: TableDiff = { columns: tb.columns, key: tb.key.filter((k) => k !== "rowid").length ? tb.key : ["rowid"], rowid: tb.rowid, insert: [], update: [], delete: [] };
    for (const [k, vals] of tb.rows) {
      const before = ta?.rows.get(k);
      if (!before) { d.insert.push(vals); continue; }
      const set: Record<string, unknown> = {}, was: Record<string, unknown> = {};
      tb.columns.forEach((c, i) => { if (JSON.stringify(before[off + i]) !== JSON.stringify(vals[off + i])) { set[c] = vals[off + i]; was[c] = before[off + i]; } });
      if (Object.keys(set).length) d.update.push({ key: keyOf(vals), set, was });
    }
    for (const [k, vals] of ta?.rows ?? []) {
      if (tb.rows.has(k)) continue;
      const was = Object.fromEntries(tb.columns.map((c, i) => [c, vals[off + i]]));
      d.delete.push({ key: keyOf(vals), was });
    }
    // Inserts in rowid order (the events handler cursor and run step ids are rowids).
    d.insert.sort((x, y) => Number(x[0]) - Number(y[0]));
    if (d.insert.length || d.update.length || d.delete.length) out[name] = d;
  }
  for (const name of a.keys()) if (!b.has(name)) throw new Error(`table ${name} disappeared during the recording`);
  return out;
}

// ---- memory capture ------------------------------------------------------------------------------------------------

const MEMORY_OPS = ["write", "appendTimeline", "seedFiles", "digest"] as const;
function captureMemory(w: Weft, log: MemoryCall[]): void {
  const mem = w.executor.memory as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  let depth = 0;
  for (const op of MEMORY_OPS) {
    const orig = mem[op];
    if (typeof orig !== "function") continue;
    mem[op] = async function (this: unknown, ...args: unknown[]) {
      const top = depth === 0;
      const at = w.clock.now();
      depth += 1;
      try {
        const out = await orig.apply(mem, args);
        if (top) log.push({ at, op, args: JSON.parse(JSON.stringify(args)) as unknown[] });
        return out;
      } finally { depth -= 1; }
    };
  }
}

// ---- playing the script --------------------------------------------------------------------------------------------

/** A take to throw away (see play); the recorder starts a fresh world. */
class Retake extends Error {}

interface Played { step: Step; runId: string | null; routineRunId: string | null; status: string; costUsd: number; summary: string | null }

async function play(w: Weft, steps: Step[], log: (l: string) => void): Promise<Played[]> {
  const out: Played[] = [];
  const agent = w.agent as unknown as { settled(id: string): Promise<{ status: string; costUsdMicros: number; summary: string | null }> };
  const engine = w.routines as unknown as { resetCursor(at: string): void; settled(id: string): Promise<{ status: string; agentRunId: string | null; summary: string | null; costUsdMicros: number }>;
    fire(r: unknown, i: unknown): Promise<{ id: string }>; view: { get(id: string): Promise<unknown> } };
  engine.resetCursor(steps[0]!.at);
  for (const step of steps) {
    await w.clock.set(step.at, 0);
    let p: Played = { step, runId: null, routineRunId: null, status: "", costUsd: 0, summary: null };
    if (step.kind === "chat") {
      const { runId } = await call<{ runId: string }>(w, "POST", "/v1/agent/runs", step.who, { text: step.text, pageContext: null, threadId: step.thread });
      const run = await agent.settled(runId);
      p = { ...p, runId, status: run.status, costUsd: run.costUsdMicros / 1e6, summary: run.summary };
    } else if (step.kind === "setting") {
      await call(w, "PUT", "/v1/settings/agent", step.who, { chatCanPropose: step.chatCanPropose });
      p = { ...p, status: step.chatCanPropose ? "on" : "off" };
    } else {
      let routineRunId: string;
      if (step.kind === "cron") {
        const def = await engine.view.get(step.routine);
        if (!def) throw new Error(`no routine ${step.routine}`);
        routineRunId = (await engine.fire(def, { triggerRef: `cron:${step.at}`, payload: { slot: `cron:${step.at}` }, attended: false, event: null, at: step.at })).id;
      } else {
        routineRunId = (await call<{ routineRunId: string }>(w, "POST", `/v1/routines/${step.routine}/trigger`, step.who, {})).routineRunId;
      }
      let rr = await engine.settled(routineRunId);
      if (rr.agentRunId) { await agent.settled(rr.agentRunId); rr = await engine.settled(routineRunId); }
      const cost = rr.agentRunId ? (await agent.settled(rr.agentRunId)).costUsdMicros / 1e6 : 0;
      p = { ...p, runId: rr.agentRunId, routineRunId, status: rr.status, costUsd: cost, summary: rr.summary };
    }
    await (w.routines as unknown as { drain(ms: number): Promise<boolean> }).drain(10_000);
    await w.scheduler.tick();
    out.push(p);
    // A take whose step read or wrote a held-out eval token (tests/evals-antileak.test.ts) stops here.
    if (p.runId) {
      const rows = await q<{ t: string | null }>(w, "SELECT coalesce(result_json, '') || ' ' || coalesce(tool_args_json, '') AS t FROM run_steps WHERE run_id = ?", [p.runId]);
      const leaks = heldOut(`${rows.map((r) => r.t).join("\n")}\n${p.summary ?? ""}`);
      if (leaks.length) throw new Retake(`step ${out.length} (${p.runId}) holds held-out eval tokens (${leaks.join(", ")})`);
    }
    // The world's paycheck explanations are the pre-payroll review's own: a take where the model left every item to
    // the deterministic template (it may: "Omit explanation for the template") stops here, before the rest is spent.
    if (step.kind !== "chat" && step.kind !== "setting" && step.routine === "rt_pre_payroll" && live) {
      const src = await q<{ s: string | null }>(w, "SELECT explanation_source AS s FROM paychecks WHERE payroll_run_id = 'pay_2026_10_30' AND explanation IS NOT NULL");
      if (!src.length || src.some((r) => r.s !== "agent")) throw new Retake(`the pre-payroll review saved ${src.map((r) => r.s).join(", ") || "no"} explanations`);
    }
    const label = step.kind === "chat" ? JSON.stringify(step.text) : step.kind === "setting" ? `chat_can_propose ${p.status}` : step.routine;
    log(`${step.at} ${step.kind.padEnd(7)} ${label}: ${p.status}${p.runId ? ` ${p.runId}` : ""} $${p.costUsd.toFixed(4)}${p.summary ? `\n    ${p.summary.replace(/\s+/g, " ").slice(0, 300)}` : ""}`);
  }
  await w.clock.set(SEED_TIME, 0);
  await w.scheduler.tick();
  await (w.agent as unknown as { drain?(ms: number): Promise<boolean> }).drain?.(10_000);
  await (w.routines as unknown as { drain(ms: number): Promise<boolean> }).drain(10_000);
  return out;
}

// ---- safety scan ---------------------------------------------------------------------------------------------------

/**
 * The held-out eval tokens, derived exactly as tests/evals-antileak.test.ts derives them (each task's leak literals and
 * mutator names, and 7-word shingles of its input), and a matcher that names only the task id and the token kind of a
 * hit, never the token. The fixture lives where fixers work, so a run whose tool result happens to hold a held-out
 * answer (a report over the one range a held-out task asks about) cannot be committed.
 */
async function heldOutMatcher(): Promise<(text: string) => string[]> {
  const { EvalTask } = await import("../packages/contracts/src/evals");
  const { testTaskFiles } = await import("../evals/suite/manifest");
  const { HELD_OUT_SPLITS } = await import("../evals/suite/splits");
  const SHINGLE = 7;
  const norm = (x: string) => ` ${x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
  const literal: { id: string; t: string }[] = [], input: { id: string; t: string }[] = [];
  for (const split of HELD_OUT_SPLITS) for (const rel of testTaskFiles(ROOT, split)) {
    const t = EvalTask.parse(JSON.parse(readFileSync(join(ROOT, rel), "utf8")));
    const id = `${t.split}/${t.id}`;
    const block = /```leak\n([\s\S]*?)```/.exec(readFileSync(join(ROOT, t.reference), "utf8"));
    for (const l of block ? block[1]!.split("\n").map((x) => x.trim()).filter(Boolean) : []) literal.push({ id, t: l.toLowerCase() });
    for (const m of t.world.mutators) literal.push({ id, t: String(m).toLowerCase() });
    const i = t.input as Record<string, unknown>;
    const words = norm(String(i.chat ?? i.portal ?? i.mention ?? "")).trim().split(" ").filter(Boolean);
    if (words.length <= SHINGLE) { if (words.length >= 4) input.push({ id, t: ` ${words.join(" ")} ` }); }
    else for (let k = 0; k + SHINGLE <= words.length; k++) input.push({ id, t: ` ${words.slice(k, k + SHINGLE).join(" ")} ` });
  }
  return (text) => {
    const lower = text.toLowerCase(), words = norm(text);
    return [...new Set([...literal.filter((l) => lower.includes(l.t)).map((l) => `${l.id} literal`), ...input.filter((x) => words.includes(x.t)).map((x) => `${x.id} input`)])];
  };
}
const heldOut = await heldOutMatcher();

function scan(text: string): string[] {
  const problems: string[] = [];
  const key = loadSecret("OPENAI_API_KEY", process.env as Record<string, string | undefined>);
  if (key && key.length >= 8 && text.includes(key)) problems.push("the OpenAI key");
  if (/\bsk-[A-Za-z0-9_-]{16,}/.test(text)) problems.push("an sk- key shape");
  if (/\b(?:wk|weft)_(?:live|mcp|admin)_[A-Za-z0-9]{16,}/.test(text)) problems.push("a Weft key shape");
  if (/\bBearer\s+[A-Za-z0-9._-]{16,}/.test(text)) problems.push("a bearer token");
  const ips = [...text.matchAll(/(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.])/g)].filter((m) => m.slice(1).every((x) => Number(x) <= 255)).map((m) => m[0]);
  const real = ips.filter((ip) => ip !== "127.0.0.1" && ip !== "0.0.0.0");
  if (real.length) problems.push(`IP-shaped text (${[...new Set(real)].slice(0, 5).join(", ")})`);
  if (text.includes(ROOT) || text.includes("/Users/")) problems.push("a local path");
  const leaks = heldOut(text);
  if (leaks.length) problems.push(`held-out eval tokens (${leaks.join(", ")})`);
  return problems;
}

// ---- main -----------------------------------------------------------------------------------------------------------

async function record(): Promise<{ fixture: Fixture; dump: Map<string, TableDump>; memoryHead: string }> {
  const dir = join(SCRATCH, "record");
  freshDir(dir, true);
  const w = await richWorld(dir, { showcase: false });
  const memLog: MemoryCall[] = [];
  try {
    const before = await dumpAll(w);
    const memoryBefore = await w.executor.memory.head();
    captureMemory(w, memLog);
    const t0 = Date.now();
    const played = await play(w, SCRIPT, (l) => console.log(l));
    const after = await dumpAll(w);
    const tables = diffDumps(before, after);
    // Bearer-token hashes of finished runs: replaced by the hash of bytes nobody holds, so no token ever matches them.
    const ex = tables.exec_runs;
    if (ex) {
      const i = ex.columns.indexOf("token_hash");
      for (const r of ex.insert) r[(ex.rowid ? 1 : 0) + i] = createHash("sha256").update(randomBytes(32)).digest("hex");
      for (const u of ex.update) if ("token_hash" in u.set) throw new Error("exec_runs.token_hash changed on a recorded run");
    }
    // Run steps carry the wall clock of the recording (the run store's wallNow). Each run's steps move onto the sim
    // clock at the run's own start, keeping the real gaps between them, so a step never reads as hours from its run.
    const steps = tables.run_steps, ar = tables.agent_runs;
    if (steps && ar) {
      const so = steps.rowid ? 1 : 0, ao = ar.rowid ? 1 : 0;
      const startOf = new Map(ar.insert.map((r) => [String(r[ao + ar.columns.indexOf("id")]), Date.parse(String(r[ao + ar.columns.indexOf("created_at")]))]));
      const ci = so + steps.columns.indexOf("created_at"), ri = so + steps.columns.indexOf("run_id");
      const firstWall = new Map<string, number>();
      for (const r of steps.insert) { const id = String(r[ri]); const t = Date.parse(String(r[ci])); if (!firstWall.has(id) || t < firstWall.get(id)!) firstWall.set(id, t); }
      for (const r of steps.insert) {
        const id = String(r[ri]);
        const start = startOf.get(id);
        if (start === undefined) throw new Error(`run step of ${id}, which is not a recorded run`);
        r[ci] = new Date(start + Date.parse(String(r[ci])) - firstWall.get(id)!).toISOString();
      }
    }
    const files: { path: string; body: string }[] = [];
    const arts = tables.run_artifacts;
    if (arts) {
      const i = arts.columns.indexOf("path");
      for (const r of arts.insert) {
        const path = String(r[(arts.rowid ? 1 : 0) + i]);
        const body = await w.runFiles.read(path);
        if (body === null) throw new Error(`run artifact ${path} has no body`);
        files.push({ path, body });
      }
    }
    const runs = played.filter((p) => p.runId);
    const row = runs.length ? (await q<{ provider: string; model: string; effort: string }>(w, "SELECT provider, model, effort FROM agent_runs WHERE id = ?", [runs[0]!.runId]))[0] : undefined;
    const memoryHead = await w.executor.memory.head();
    const fixture: Fixture = {
      version: showcase.SHOWCASE_FIXTURE_VERSION,
      recorded: {
        provider: row?.provider ?? "none", model: row?.model ?? "none", effort: row?.effort ?? "low",
        costUsd: Number(played.reduce((s, p) => s + p.costUsd, 0).toFixed(6)),
        steps: played.map((p) => ({
          kind: p.step.kind === "chat" ? "chat" : p.step.kind === "setting" ? "setting" : "routine",
          at: p.step.at, text: p.step.kind === "chat" ? p.step.text : p.step.kind === "setting" ? `chat_can_propose ${p.step.chatCanPropose ? "on" : "off"}` : p.step.routine,
          who: "who" in p.step ? p.step.who : "system", threadId: p.step.kind === "chat" ? p.step.thread : null, runId: p.runId, routineRunId: p.routineRunId,
          status: p.status, costUsd: Number(p.costUsd.toFixed(6)),
        })) as Fixture["recorded"]["steps"],
        memoryBefore, memoryHead,
      },
      tables, runFiles: files, memory: memLog,
    };
    console.log(`recorded ${played.length} steps in ${Math.round((Date.now() - t0) / 1000)} s, $${fixture.recorded.costUsd.toFixed(4)}; ${Object.entries(tables).map(([t, d]) => `${t} +${d.insert.length}${d.update.length ? ` ~${d.update.length}` : ""}${d.delete.length ? ` -${d.delete.length}` : ""}`).join(", ")}; ${files.length} run files; ${memLog.length} memory calls`);
    return { fixture, dump: after, memoryHead };
  } finally { await w.close(); }
}

/** Seeds a rich world with `fixturePath` and compares it with the recorded world table by table. */
async function verify(fixturePath: string, recorded?: { dump: Map<string, TableDump>; memoryHead: string }): Promise<void> {
  const dir = join(SCRATCH, "verify");
  freshDir(dir, false);
  const w = await richWorld(dir, { showcase: true, fixturePath });
  try {
    const f = showcase.readShowcaseFixture(fixturePath)!;
    const chain = await w.executor.verifyChain();
    if (!chain.ok || chain.gitLag !== 0) throw new Error(`the action chain does not verify after the replay: ${JSON.stringify(chain)}`);
    const head = await w.executor.memory.head();
    if (head !== f.recorded.memoryHead) throw new Error(`memory HEAD ${head} after the replay, recorded ${f.recorded.memoryHead}`);
    if (recorded) {
      const now = await dumpAll(w);
      const bad: string[] = [];
      for (const [name, t] of recorded.dump) {
        const mine = now.get(name);
        if (!mine) { bad.push(`${name} missing`); continue; }
        // Columns the world digest leaves out (token hashes, key material, vault ciphertext) are random by design, run
        // step times moved from the wall clock onto the sim clock, and a rowid only matters where something reads it (the
        // events handler cursor): compare everything else.
        const ex = DIGEST_EXCLUDE[name];
        const keep = (d: TableDump) => d.columns.map((c, i) => ({ c, i: (d.rowid ? 1 : 0) + i }))
          .filter(({ c }) => !(Array.isArray(ex) && ex.includes(c)) && !(name === "exec_runs" && c === "token_hash") && !(name === "run_steps" && c === "created_at"));
        const norm = (d: TableDump) => [...d.rows.values()].map((v) => JSON.stringify([...(name === "events" && d.rowid ? [v[0]] : []), ...keep(d).map(({ i }) => v[i])])).sort();
        const a = norm(t), b = norm(mine);
        if (a.length !== b.length || a.some((x, i) => x !== b[i])) bad.push(`${name} (${a.length} recorded, ${b.length} replayed)`);
      }
      if (bad.length) throw new Error(`the replayed world differs from the recorded one: ${bad.join("; ")}`);
    }
    console.log(`verified: the fixture applies, the chain verifies (head #${(chain.head as { seq?: number } | null)?.seq ?? "none"}), memory HEAD ${head.slice(0, 12)}${recorded ? ", every table matches the recording" : ""}`);
  } finally { await w.close(); }
}

if (argv.includes("--verify")) {
  await verify(showcase.showcaseFixturePath());
} else {
  const target = argv.includes("--write") ? showcase.showcaseFixturePath() : join(SCRATCH, `fixture.${live ? "live" : "scripted"}.json`);
  // --takes N: how many fresh takes a live recording may start when one stops early (default 1, no retake).
  const takes = Math.max(1, Number(argv[argv.indexOf("--takes") + 1] ?? 1) || 1);
  let got: Awaited<ReturnType<typeof record>> | null = null;
  for (let i = 1; i <= takes && !got; i++) {
    try { got = await record(); } catch (e) {
      if (!(e instanceof Retake)) throw e;
      console.log(`take ${i} of ${takes} stopped: ${e.message}`);
    }
  }
  if (!got) { console.error("record-showcase: no take finished; nothing written"); process.exit(1); }
  const { fixture, dump, memoryHead } = got;
  const text = JSON.stringify(fixture);
  const problems = scan(text);
  if (problems.length) { console.error(`record-showcase: the fixture holds ${problems.join(", ")}; nothing written`); process.exit(1); }
  writeFileSync(target, text + "\n");
  console.log(`wrote ${target.replace(`${ROOT}/`, "")} (${(text.length / 1024).toFixed(0)} KiB)`);
  await verify(target, { dump, memoryHead });
}
