// Live eval L5 (wave 3, w3-parity-chat). Opt-in, costs money (budget under $0.02, expected well below $0.01).
//   WEFT_SECRETS_FILE=~/Developer/projects/.weft.secrets.env WEFT_LIVE_OPENAI=1 WEFT_LLM=openai node_modules/.bin/tsx evals/live/l5-chat-propose.ts
// GP10 asked in chat on a live model: with agent.chat_can_propose on, the person asks for Hollis's missed Oct 1 to 15
// pay plus a $1,500.00 bonus. Pass when the run files exactly one payroll.propose_off_cycle proposal for wrk_0042 with
// reason missed_payroll and a 150000 cent bonus, executes nothing, finishes done, and stays under the cost cap.
// A fresh seed and a frozen clock live in .data/eval-l5/ of the checkout it runs in (gitignored); the spend ledger under
// it keeps the cap cumulative across reruns. Results go to evals/results/ (gitignored).
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

if (process.env.WEFT_LIVE_OPENAI !== "1" || process.env.WEFT_LLM !== "openai") {
  console.error("L5 is opt-in: set WEFT_LIVE_OPENAI=1 and WEFT_LLM=openai (see evals/live/README.md)");
  process.exit(2);
}
process.env.WEFT_DEV_AUTH = "1";
process.env.WEFT_LIVE_USD_CAP ??= "0.02";

const ROOT = resolve(import.meta.dirname, "../..");
const { createWeft } = await import("../../apps/api/src/index");
const { seedWorld } = await import("../../packages/seed/src/index");
const { summarize } = await import("../../packages/agent/src/index");
const db = await import("../../packages/db/src/index");
const { W3_SETTINGS } = await import("../../packages/contracts/src/index");

const WORKER = "wrk_0042";
const REQUEST = "Hollis Grey (demo) missed the Oct 1 to 15 payroll. Please propose an off-cycle payment for that period plus a $1,500.00 bonus, payday Oct 27.";
const base = join(ROOT, ".data/eval-l5");
mkdirSync(base, { recursive: true });
for (const f of readdirSync(base)) if (f !== "spend") rmSync(join(base, f), { recursive: true, force: true });

const weft = await createWeft({ dataDir: base, strict: true });
const t0 = Date.now();
const reasons: string[] = [];
let runId: string | null = null;
let usd = 0, steps = 0;
let notes: Record<string, unknown> = {};
try {
  await seedWorld(weft as never);
  await weft.clock.set("2026-10-26T15:30:00.000Z", 0);
  // The GP10 world: Hollis was held out of the Oct 1 to 15 run, and his raise to $82,000.00 took effect Oct 6.
  // Raw statements through the libsql client: evals/ has no drizzle-orm of its own.
  const q = (text: string, args: (string | number)[] = []) => (weft.db as unknown as { $client: { execute(x: { sql: string; args: (string | number)[] }): Promise<{ rows: Record<string, unknown>[] }> } }).$client.execute({ sql: text, args });
  const runId0 = String((await q("SELECT id FROM payroll_runs WHERE subtype = 'regular' AND period_start = '2026-10-01' AND period_end = '2026-10-15'")).rows[0]!.id);
  await q("UPDATE paychecks SET status = 'excluded' WHERE payroll_run_id = ? AND worker_id = ?", [runId0, WORKER]);
  await q("DELETE FROM ytd_ledger WHERE worker_id = ? AND source = ?", [WORKER, `payroll:${runId0}`]);
  const rateId = String((await q("SELECT id FROM pay_rates WHERE worker_id = ? AND effective_to IS NULL", [WORKER])).rows[0]!.id);
  await q("UPDATE pay_rates SET effective_to = '2026-10-05' WHERE id = ?", [rateId]);
  await weft.db.insert(db.payRates).values({ id: "prt_9201", workerId: WORKER, kind: "salary", amountCents: 8_200_000, currency: "USD", effectiveFrom: "2026-10-06", effectiveTo: null, createdActionSeq: null });
  await weft.db.insert(db.settings).values({ key: W3_SETTINGS.chatCanPropose, valueJson: "true" }).onConflictDoUpdate({ target: db.settings.key, set: { valueJson: "true" } });

  const actionsBefore = (await weft.db.select().from(db.actions)).length;
  const headers = { "x-weft-principal": "usr_dana", "x-weft-proxy": weft.proxySecret, "content-type": "application/json", host: `127.0.0.1:${weft.ports.api}` };
  const res = await weft.app.request("/v1/agent/runs", { method: "POST", headers, body: JSON.stringify({ text: REQUEST, pageContext: null }) });
  if (res.status !== 202) throw new Error(`start answered ${res.status}`);
  const started = (await res.json()) as { runId: string; chatMode: string };
  runId = started.runId;
  if (started.chatMode !== "act") reasons.push(`chat mode ${started.chatMode}`);
  const run = await (weft.agent as unknown as { settled(id: string): Promise<{ status: string; stepsUsed: number; summary: string | null }> }).settled(runId);
  const trace = await weft.agent.trace(runId);
  const s = summarize(trace.steps);
  usd = s.usd; steps = run.stepsUsed;
  const props = (await weft.db.select().from(db.proposals)).filter((p) => p.proposerRunId === runId);
  const off = props.filter((p) => p.command === "payroll.propose_off_cycle");
  const args = off[0]?.argsJson ? (JSON.parse(off[0].argsJson) as { worker_ids?: string[]; reason?: string; bonus_cents?: Record<string, number>; period_start?: string; period_end?: string }) : null;
  if (off.length !== 1) reasons.push(`${off.length} off-cycle proposals`);
  if (props.length !== off.length) reasons.push(`other proposals: ${props.map((p) => p.command).join(", ")}`);
  if (args && (JSON.stringify(args.worker_ids) !== JSON.stringify([WORKER]) || args.reason !== "missed_payroll" || args.bonus_cents?.[WORKER] !== 150_000 || args.period_start !== "2026-10-01" || args.period_end !== "2026-10-15")) reasons.push(`args ${JSON.stringify(args)}`);
  if ((await weft.db.select().from(db.actions)).length !== actionsBefore) reasons.push("an action executed from chat");
  if (run.status !== "done") reasons.push(`status ${run.status}`);
  if (run.stepsUsed > 4) reasons.push(`${run.stepsUsed} model steps`);
  if (usd > 0.02) reasons.push(`cost $${usd.toFixed(4)} over $0.02`);
  notes = { answer: run.summary, calls: trace.steps.filter((x) => x.kind === "tool_call").map((x) => ({ tool: x.toolName, args: x.toolArgs, outcome: x.outcome })), cacheHitRatio: s.cacheHitRatio, tokens: s.tokens };
} catch (e) {
  reasons.push(e instanceof Error ? e.message : String(e));
} finally {
  await weft.close();
}
let sha = "nogit";
try { sha = execSync("git rev-parse --short HEAD", { cwd: ROOT }).toString().trim(); } catch { /* not a repo */ }
const outDir = join(ROOT, "evals/results");
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const out = join(outDir, `${new Date().toISOString().slice(0, 10)}-${sha}-L5.json`);
const result = { id: "L5", pass: reasons.length === 0, reasons, runId, modelSteps: steps, usd, wallMs: Date.now() - t0, notes };
writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), sha, model: process.env.WEFT_MODEL || "gpt-5.6-luna", totalUsd: usd, results: [result] }, null, 2) + "\n");
console.log(`L5 ${result.pass ? "PASS" : "FAIL"} steps=${steps} usd=${usd.toFixed(4)} ${reasons.join("; ")}`);
console.log(`results in ${out}`);
process.exit(result.pass ? 0 : 1);
