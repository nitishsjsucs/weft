// Builder smoke calls (harness 11.2, SPEC 9.10): run once with WEFT_LIVE_OPENAI=1, under $0.01, counted in the spend
// ledger. Prints a JSON report (never the key) and, with --record <dir>, saves sanitized response fixtures.
//   WEFT_SECRETS_FILE=~/Developer/projects/.weft.secrets.env WEFT_LIVE_OPENAI=1 tsx evals/live/smoke.ts --record packages/agent/test/fixtures
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { HistoryItem, ModelStepRequest, ToolSpec } from "@weft/contracts";
import { buildResponsesRequest, createOpenAIClient, createSpendLedger, frozenPrompt, handleResponse, loadSecret, reserveUsd, stepCostUsd, usdToMicros } from "../../packages/agent/src/index";

if (process.env.WEFT_LIVE_OPENAI !== "1") {
  console.error("smoke is opt-in: set WEFT_LIVE_OPENAI=1");
  process.exit(2);
}
const apiKey = loadSecret("OPENAI_API_KEY", process.env);
if (!apiKey) {
  console.error("PROVIDER_CONFIG: OPENAI_API_KEY is not set in the environment or WEFT_SECRETS_FILE");
  process.exit(2);
}
const recordDir = process.argv.includes("--record") ? resolve(process.argv[process.argv.indexOf("--record") + 1]!) : null;
const model = process.env.WEFT_MODEL || "gpt-5.6-luna";
const client = createOpenAIClient(apiKey);
const ledger = createSpendLedger({ dir: resolve(process.env.WEFT_SPEND_DIR ?? ".data/spend") });

const fmt = { anyOf: [{ type: "string", enum: ["concise", "detailed"] }, { type: "null" }] };
const tools: ToolSpec[] = [
  { name: "notices__get", description: "Read one agency notice by id. Returns the extracted fields (agency, rate, effective date, account). Example: {\"notice_id\":\"ntc_0001\",\"response_format\":null}", parameters: { type: "object", additionalProperties: false, required: ["notice_id", "response_format"], properties: { notice_id: { type: "string" }, response_format: fmt } } },
  { name: "tax__get_rates", description: "Read current tax rates for a state. Returns rate records with decimal-string rates. Example: {\"state\":\"CA\",\"response_format\":null}", parameters: { type: "object", additionalProperties: false, required: ["response_format", "state"], properties: { response_format: fmt, state: { type: "string" } } } },
];
const prompt = frozenPrompt("routine");
const context = (extra: string) => `<context n="5a1f0c2e9b7d">\nnow: 2026-10-26T15:30:00.000Z\nacting_for: usr_0001\n<trigger>{"event":"notice.received","notice_id":"ntc_0001"}</trigger>\n${extra}\n</context>`;
const report: Record<string, unknown> = { model, at: new Date().toISOString(), calls: [] as unknown[] };
let totalUsd = 0;

function sanitize(res: unknown): unknown {
  // Keep the shape; shorten the opaque encrypted reasoning so fixtures stay small.
  return JSON.parse(JSON.stringify(res, (k, v) => (k === "encrypted_content" && typeof v === "string" ? `${v.slice(0, 24)}...` : v)));
}

async function call(label: string, history: HistoryItem[], opts: { cacheKey?: string; maxOut?: number; raw?: (b: Record<string, unknown>) => Record<string, unknown>; stripIds?: boolean } = {}) {
  const req: ModelStepRequest = { runId: "smoke", agentKind: "main", model, frozenPrompt: prompt, tools, toolChoice: { mode: "auto" }, history, effort: "low", maxOutputTokens: opts.maxOut ?? 8000, cacheKey: opts.cacheKey ?? "weft:main:rt_agency_notice:cmp_smoke" };
  let body = buildResponsesRequest(req, { stripReplayIds: opts.stripIds });
  if (opts.raw) body = opts.raw(body);
  const estIn = Math.ceil(JSON.stringify(body).length / 4);
  const rsv = await ledger.reserve({ runId: `smoke:${label}`, usdMicros: usdToMicros(reserveUsd(estIn, req.maxOutputTokens)), model, live: true });
  if (!rsv.ok) throw new Error(`BUDGET_EXCEEDED cap ${rsv.cap}`);
  const t0 = Date.now();
  try {
    const res = (await client.responses.create(body as never)) as unknown as Record<string, unknown>;
    const r = handleResponse(res as never, model);
    const usd = stepCostUsd(r.usage);
    totalUsd += usd;
    await ledger.settle(rsv.reservationId, usdToMicros(usd));
    const details = (res.usage as { input_tokens_details?: Record<string, unknown> } | undefined)?.input_tokens_details ?? {};
    (report.calls as unknown[]).push({ label, ms: Date.now() - t0, status: res.status, stop: r.stop, calls: r.toolCalls.map((c) => `${c.name} ${c.argumentsJson}`), text: r.text.slice(0, 200), usage: r.usage, input_tokens_details_keys: Object.keys(details), usd, requestId: r.requestId });
    return { res, r };
  } catch (e) {
    await ledger.settle(rsv.reservationId, usdToMicros(reserveUsd(estIn, 0)));
    const err = e as { status?: number; message?: string };
    (report.calls as unknown[]).push({ label, error: { status: err.status ?? null, message: String(err.message ?? e).slice(0, 400) } });
    return null;
  }
}

const save = (name: string, v: unknown) => {
  if (!recordDir) return;
  mkdirSync(recordDir, { recursive: true });
  writeFileSync(join(recordDir, `${name}.json`), JSON.stringify(sanitize(v), null, 2) + "\n");
};

// 1. A strict tool call.
const h1: HistoryItem[] = [{ kind: "context", text: context("<request>Read the notice in the trigger.</request>") }];
const c1 = await call("1_strict_tool_call", h1);
if (c1) save("tool-call", c1.res);

// 2. Round trip with encrypted reasoning, replaying items with their ids under store:false; A/B on _weft_plan.
if (c1 && c1.r.toolCalls.length) {
  const out = (plan: boolean) => c1.r.toolCalls.map((c, i, all) => ({
    callId: c.callId, name: c.name,
    output: JSON.stringify({ ok: true, status: "done", resultId: "res_0001", summary: "Read CA_EDD_DE2088_2026.txt", data: { notice_id: "ntc_0001", agency: "ca_edd", rate_old: "0.034", rate_new: "0.015", effective_date: "2026-01-01", account: "txa_0003" }, ...(plan && i === all.length - 1 ? { _weft_plan: "[ ] draft reply  [ ] propose tax.update_rate  [ ] propose notices.send_response | steps 1/6 | $0.0004" } : {}) }),
  }));
  const base: HistoryItem[] = [...h1, { kind: "model", provider: "openai", native: c1.r.native }];
  const a = await call("2a_round_trip_plan_in_output", [...base, { kind: "tool_outputs", outputs: out(true) }]);
  let strip = false;
  if (!a) {
    strip = true;
    await call("2a_round_trip_plan_in_output_stripped_ids", [...base, { kind: "tool_outputs", outputs: out(true) }], { stripIds: true });
  }
  await call("2b_round_trip_plan_as_user_item", [...base, { kind: "tool_outputs", outputs: out(false) }, { kind: "user", text: "[ ] draft reply  [ ] propose tax.update_rate  [ ] propose notices.send_response | steps 1/6 | $0.0004" }], { stripIds: strip });
  report.replayNeedsStrippedIds = strip;
}

// 3. Two parallel reads.
const c3 = await call("3_parallel_reads", [{ kind: "context", text: context("<request>Read the notice in the trigger and, independently, the current CA tax rates. Do both now in one turn.</request>") }], { cacheKey: "weft:main:rt_agency_notice:cmp_smoke" });
if (c3) save("parallel-calls", c3.res);

// 4. cached_tokens on a repeated 1,024+ token prefix (same key as calls 1 and 3).
await call("4_repeat_prefix_cached", h1);

// 5. A different prompt_cache_key, then the first key again.
await call("5a_other_key", h1, { cacheKey: "weft:main:chat:cmp_smoke" });
await call("5b_first_key_again", h1);

// Fixture: an incomplete response (tiny output budget).
const inc = await call("6_incomplete_fixture", h1, { maxOut: 16 });
if (inc) save("incomplete", inc.res);

report.totalUsd = totalUsd;
report.promptChars = prompt.length;
console.log(JSON.stringify(report, null, 2));
