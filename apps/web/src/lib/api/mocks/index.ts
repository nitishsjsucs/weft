// Contract-typed fixtures for building screens before merge 1 (NEXT_PUBLIC_WEFT_MOCKS=1). Owner: t5-app.
// `mockFetch` is a fetch-compatible function: the typed client runs unchanged against it, so every screen exercises the
// same request paths, headers and _tag errors it will use against the real API.
import { money, type AgentRunRow, type DecisionResult, type Health, type PageResult, type Proposal, type RunStepRow, type ToolOutcome } from "@weft/contracts";
import { buildWorld, PRINCIPALS, type MockWorld } from "./world";

export { PRINCIPALS } from "./world";
export const mocksEnabled = process.env.NEXT_PUBLIC_WEFT_MOCKS === "1";

let world: MockWorld = buildWorld();
export function resetMockWorld() { world = buildWorld(); }
export function getMockWorld() { return world; }

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const err = (status: number, _tag: string, message: string, extra: Record<string, unknown> = {}) => json(status, { _tag, message, ...extra });
function page<T>(items: T[], q: URLSearchParams, idOf: (t: T) => string): PageResult<T> {
  const limit = Math.min(Math.max(Number(q.get("limit") ?? 25) || 25, 1), 100);
  const after = q.get("afterId");
  const start = after ? items.findIndex((x) => idOf(x) === after) + 1 : 0;
  const data = items.slice(start, start + limit);
  return { hasMore: start + limit < items.length, count: items.length, data };
}

function addMinutes(iso: string, mins: number) { return new Date(new Date(iso).getTime() + mins * 60_000).toISOString(); }
function parseDuration(by: string): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(by);
  if (!m) return 0;
  return Number(m[1] ?? 0) * 1440 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

/** A chat or routine run whose steps appear over time, so the agent panel shows live progress against mocks. */
function startScriptedRun(text: string, trigger: string): string {
  const id = `run_${String(++world.counter).padStart(4, "0")}`;
  const created = Date.now();
  const run: AgentRunRow = {
    id, companyId: "cmp_larkspur", kind: "main", parentRunId: null, threadId: null, routineRunId: null, trigger, attended: true, provider: "scripted", model: "scripted", effort: "low",
    cacheKey: "chat", status: "running", terminalReason: null, tainted: false, taintedBy: null, checklist: null, budget: { steps: 12, usd: 0.1, minutes: 10 }, stepsUsed: 0, requeues: 0,
    consecutiveErrors: 0, costUsdMicros: 0, tokens: { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 }, createdAt: world.now, endedAt: null, summary: null,
  };
  const script: { kind: RunStepRow["kind"]; tool: string | null; summary: string; stage: RunStepRow["stage"] }[] = [
    { kind: "context", tool: null, summary: "Chat context", stage: "assemble" },
    { kind: "model_call", tool: null, summary: "Planned 2 reads", stage: "model" },
    { kind: "tool_call", tool: "payroll.get_run", summary: "Read payroll pay_2026_10_30", stage: "dispatch" },
    { kind: "tool_call", tool: "people.get", summary: "Read Mireille Osterhout (demo)", stage: "dispatch" },
    { kind: "model_call", tool: null, summary: "Wrote the answer", stage: "model" },
  ];
  const entry = { run, steps: [] as RunStepRow[], script, created, text };
  world.agentRuns.set(id, entry as never);
  return id;
}

function advanceScripted(entry: { run: AgentRunRow; steps: RunStepRow[] } & { script?: { kind: RunStepRow["kind"]; tool: string | null; summary: string; stage: RunStepRow["stage"] }[]; created?: number; text?: string }) {
  if (!entry.script || entry.run.status !== "running") return;
  const due = Math.min(entry.script.length, Math.floor((Date.now() - (entry.created ?? 0)) / 700) + 1);
  while (entry.steps.length < due) {
    const n = entry.steps.length + 1;
    const s = entry.script[n - 1]!;
    const usage = s.kind === "model_call" ? { input: 1_800 + n * 100, cached: 1_536, cacheWrite: 0, output: 120, reasoning: 0 } : null;
    const cost = usage ? Math.round(((usage.input - usage.cached) * 0.2 + usage.cached * 0.02 + usage.output * 1.2)) : 0;
    entry.steps.push({ runId: entry.run.id, n, parentN: null, stage: s.stage, kind: s.kind, callId: s.tool ? `call_${n}` : null, toolName: s.tool, toolArgs: null, outcome: "ok", result: { summary: s.summary }, native: null, usage, costUsdMicros: cost, attempt: 1, requestId: null, prefixHash: null, timings: usage ? { admissionMs: 2, assembleMs: 8, timeToLlmMs: 15, modelMs: 640, dispatchMs: 0, tokensPerSecond: null } : null, createdAt: world.now });
    entry.run.stepsUsed = entry.steps.filter((x) => x.kind === "model_call").length;
    entry.run.costUsdMicros += cost;
    if (usage) entry.run.tokens = { ...entry.run.tokens, input: entry.run.tokens.input + usage.input, cached: entry.run.tokens.cached + usage.cached, output: entry.run.tokens.output + usage.output };
  }
  if (entry.steps.length === entry.script.length && entry.run.trigger.startsWith("routine:")) {
    entry.run.status = "waiting"; entry.run.terminalReason = "WAITING_APPROVAL";
    entry.run.summary = "Explained 4 flagged paychecks. Submitting 47 paychecks (1 excluded, no bank account) is waiting in the Inbox.";
    entry.run.checklist = [{ id: "c1", label: "Explanations complete", passed: true }, { id: "c2", label: "Submit proposed", passed: true }];
  } else if (entry.steps.length === entry.script.length) {
    entry.run.status = "done"; entry.run.terminalReason = "DONE"; entry.run.endedAt = world.now;
    entry.run.summary = /raise|flag/i.test(entry.text ?? "")
      ? "Mireille Osterhout (demo) is flagged GROSS_CHANGE because Dana's 18% raise (action 3) took effect Oct 16; gross moves from $6,041.67 to $7,129.17."
      : "Mock mode answer: the scripted run read the page context and finished. Connect the API for real answers.";
  }
}

function decide(id: string, decision: "approve" | "deny" | "dismiss" | "start", principal: string | null, body: { reasonCode?: string | null; note?: string | null }): Response {
  const p = world.proposals.find((x) => x.id === id);
  if (!p) return err(404, "NotFound", `No proposal ${id}`);
  if (!principal) return err(401, "Unauthorized", "UI_SESSION_REQUIRED");
  if (p.status !== "pending") return json(200, { ok: false, code: "NOT_PENDING", message: `Proposal is ${p.status}` } satisfies DecisionResult);
  if (decision === "deny" && !body.reasonCode) return err(400, "ValidationError", "reasonCode is required to deny");
  const next: Proposal["status"] = decision === "approve" ? "executed" : decision === "deny" ? "denied" : decision === "dismiss" ? "dismissed" : "approved";
  Object.assign(p, { status: next, decidedBy: principal, decidedAt: world.now, decisionCode: body.reasonCode ?? (decision === "approve" ? "approved" : decision), decisionNote: body.note ?? null, executedActionSeq: decision === "approve" ? ++world.counter : null });
  if (decision === "approve" && p.command === "payroll.submit_run") {
    const r = world.runs.get(String((p.args as { run_id?: string })?.run_id ?? "pay_2026_10_30"));
    if (r) { r.status = "processing"; r.approvedBy = principal; r.approvedAt = world.now; }
  }
  const outcome: ToolOutcome | null = decision === "approve" ? { ok: true, status: "done", resultId: `res_${world.counter}`, data: null, summary: p.headline, actionSeq: p.executedActionSeq, artifactRef: null, tainted: false, label: "synthetic" } : null;
  return json(200, { ok: true, proposal: p, outcome } satisfies DecisionResult);
}

type Handler = (m: RegExpMatchArray, q: URLSearchParams, body: Record<string, unknown>, principal: string | null) => Response;
const routes: [string, RegExp, Handler][] = [
  ["GET", /^\/v1\/health$/, () => json(200, { ok: true, version: "0.0.0-mock", provider: { id: "scripted", model: "scripted", label: "Scripted, no model", live: false }, clock: { now: world.now, rate: world.rate }, testMode: true, stubs: ["mocks"] } satisfies Health)],
  ["GET", /^\/v1\/sim\/clock$/, () => json(200, { now: world.now, rate: world.rate })],
  ["POST", /^\/v1\/sim\/clock\/advance$/, (_m, _q, b) => {
    if (typeof b.to === "string") world.now = new Date(b.to).toISOString();
    else if (typeof b.by === "string") world.now = addMinutes(world.now, parseDuration(b.by));
    else if (b.toNext === "cron") world.now = addMinutes(world.now, 30);
    return json(200, { now: world.now, rate: world.rate });
  }],
  ["GET", /^\/v1\/workers$/, (_m, q) => json(200, page(world.workers, q, (w) => w.id))],
  ["GET", /^\/v1\/workers\/([^/]+)$/, (m) => { const w = world.workers.find((x) => x.id === m[1]); return w ? json(200, w) : err(404, "NotFound", "No such worker"); }],
  ["GET", /^\/v1\/payrolls$/, (_m, q) => json(200, page([...world.runs.values()].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd)), q, (r) => r.id))],
  ["GET", /^\/v1\/payrolls\/([^/]+)$/, (m) => { const r = world.runs.get(m[1]!); return r ? json(200, r) : err(404, "NotFound", `No payroll ${m[1]}`); }],
  ["GET", /^\/v1\/payrolls\/([^/]+)\/paychecks$/, (m, q) => {
    let pcs = world.paychecks.get(m[1]!) ?? [];
    const g = q.get("group"); if (g) pcs = pcs.filter((p) => p.reviewGroup === g);
    return json(200, page(pcs, new URLSearchParams({ limit: q.get("limit") ?? "100", ...(q.get("afterId") ? { afterId: q.get("afterId")! } : {}) }), (p) => p.id));
  }],
  ["GET", /^\/v1\/paychecks\/([^/]+)$/, (m) => { for (const pcs of world.paychecks.values()) { const p = pcs.find((x) => x.id === m[1]); if (p) return json(200, p); } return err(404, "NotFound", "No paycheck"); }],
  ["POST", /^\/v1\/payrolls\/([^/]+)\/preview$/, (m) => {
    const r = world.runs.get(m[1]!); if (!r) return err(404, "NotFound", "No payroll");
    if (r.status !== "draft") return json(200, { ok: false, refusal: { code: "OUT_OF_PHASE", message: `Run is ${r.status}`, hint: null, example: null }, tainted: false } satisfies ToolOutcome);
    return json(200, { ok: true, status: "done", resultId: `res_${++world.counter}`, data: null, summary: `Recomputed ${r.paycheckCount} paychecks`, actionSeq: null, artifactRef: null, tainted: false, label: "synthetic" } satisfies ToolOutcome);
  }],
  ["POST", /^\/v1\/payrolls\/([^/]+)\/submit$/, (m, _q, b, who) => {
    const r = world.runs.get(m[1]!); if (!r) return err(404, "NotFound", "No payroll");
    const pcs = world.paychecks.get(r.id) ?? [];
    if (r.status !== "draft") return json(200, { ok: false, refusal: { code: "OUT_OF_PHASE", message: `Run is ${r.status}`, hint: null, example: null }, tainted: false } satisfies ToolOutcome);
    if (pcs.some((p) => p.status === "blocked") && !b.excludeBlocked) return json(200, { ok: false, refusal: { code: "BLOCKED_LINES", message: "1 paycheck is blocked", hint: "Submit with exclude_blocked true", example: { run_id: r.id, exclude_blocked: true } }, tainted: false } satisfies ToolOutcome);
    for (const p of pcs) if (p.status === "blocked") { p.status = "excluded"; r.excludedWorkerIds.push(p.workerId); }
    Object.assign(r, { status: "processing", approvedBy: who, approvedAt: world.now, submittedActionSeq: ++world.counter, bankBatchId: `simb_${world.counter}` });
    return json(200, { ok: true, status: "done", resultId: `res_${world.counter}`, data: null, summary: `Submitted ${pcs.filter((p) => p.status !== "excluded").length} paychecks`, actionSeq: world.counter, artifactRef: null, tainted: false, label: "synthetic" } satisfies ToolOutcome);
  }],
  ["POST", /^\/v1\/payrolls\/drafts$/, (_m, _q, b) => {
    const id = `pay_${String(b.periodEnd ?? "2026-11-15").replaceAll("-", "_")}`;
    if (!world.runs.has(id)) {
      const base = world.runs.get("pay_2026_10_30")!;
      world.runs.set(id, { ...base, id: id as `pay_${string}`, periodStart: "2026-11-01", periodEnd: String(b.periodEnd ?? "2026-11-15"), payday: "2026-11-13", approvalDeadline: "2026-11-11T00:00:00.000Z", status: "draft" });
      world.paychecks.set(id, (world.paychecks.get("pay_2026_10_30") ?? []).map((p) => ({ ...p, id: `${p.id}_n`, payrollRunId: id as `pay_${string}` })));
    }
    return json(200, { ok: true, status: "done", resultId: id, data: { runId: id }, summary: `Created draft ${id}`, actionSeq: ++world.counter, artifactRef: null, tainted: false, label: "synthetic" } satisfies ToolOutcome);
  }],
  ["GET", /^\/v1\/proposals$/, (_m, q) => {
    let ps = [...world.proposals].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const s = q.get("status"); if (s) ps = ps.filter((p) => p.status === s);
    const k = q.get("kind"); if (k) ps = ps.filter((p) => p.kind === k);
    return json(200, page(ps, q, (p) => p.id));
  }],
  ["GET", /^\/v1\/proposals\/([^/]+)$/, (m) => { const p = world.proposals.find((x) => x.id === m[1]); return p ? json(200, p) : err(404, "NotFound", "No proposal"); }],
  ["POST", /^\/v1\/proposals\/([^/]+)\/(approve|deny|dismiss|start)$/, (m, _q, b, who) => decide(m[1]!, m[2] as "approve", who, b as { reasonCode?: string; note?: string })],
  ["POST", /^\/v1\/agent\/runs$/, (_m, _q, b) => json(200, { runId: startScriptedRun(String(b.text ?? ""), "chat") })],
  ["GET", /^\/v1\/agent\/runs\/([^/]+)$/, (m) => { const e = world.agentRuns.get(m[1]!); if (!e) return err(404, "NotFound", "No run"); advanceScripted(e); return json(200, e.run); }],
  ["GET", /^\/v1\/agent\/runs\/([^/]+)\/trace$/, (m) => {
    const e = world.agentRuns.get(m[1]!); if (!e) return err(404, "NotFound", "No run"); advanceScripted(e);
    const proposals = world.proposals.filter((p) => p.proposerRunId === e.run.id);
    return json(200, { run: e.run, steps: e.steps, proposals, actions: [], children: [] });
  }],
  ["POST", /^\/v1\/routines\/([^/]+)\/trigger$/, (m) => {
    const runId = startScriptedRun("Pre-payroll review", `routine:rtr_${world.counter}`);
    const e = world.agentRuns.get(runId)!;
    e.run.routineRunId = `rtr_${String(world.counter).padStart(4, "0")}`;
    (e as unknown as { script: { kind: string; tool: string | null; summary: string; stage: string }[] }).script = [
      { kind: "context", tool: null, summary: `Routine ${m[1]} context`, stage: "assemble" },
      { kind: "tool_call", tool: "payroll.get_run", summary: "Read payroll pay_2026_10_30, 4 flagged", stage: "dispatch" },
      { kind: "model_call", tool: null, summary: "Explained 4 flagged paychecks", stage: "model" },
      { kind: "tool_call", tool: "payroll.explain_flags", summary: "Saved 4 explanations", stage: "dispatch" },
      { kind: "tool_call", tool: "payroll.submit_run", summary: "Proposed submitting 47 paychecks", stage: "dispatch" },
    ];
    if (!world.proposals.some((p) => p.command === "payroll.submit_run" && p.status === "pending")) {
      const r = world.runs.get("pay_2026_10_30")!;
      world.proposals.unshift({
        id: `prp_${String(++world.counter).padStart(4, "0")}`, companyId: "cmp_larkspur", kind: "action", command: "payroll.submit_run", args: { run_id: r.id, exclude_blocked: true }, argsHash: "h",
        subjectRef: r.id, subjectHash: "s", risk: "R4", moneyCents: r.totals?.totalCost.amount ?? null, reversible: false,
        headline: "Submit payroll Oct 16 to Oct 31 with 47 paychecks, excluding 1 blocked", diff: [{ label: "Status", before: "draft", after: "processing" }, { label: "Paychecks", before: "48", after: "47 (1 excluded: no bank account)" }, { label: "Total cost", before: "-", after: money(r.totals?.totalCost.amount ?? 0).display }],
        content: [], evidence: [{ label: "Payroll run", ref: r.id }], agentNote: "Four paychecks were reviewed and explained. The new hire without a bank account is excluded.", taintedBy: null,
        proposerRunId: runId, routineRunId: e.run.routineRunId, onBehalfOf: "usr_dana", supersedes: null, createdAt: world.now, expiresAt: r.approvalDeadline, status: "pending",
        decidedBy: null, decidedAt: null, decisionCode: null, decisionNote: null, executedActionSeq: null,
      });
    }
    return json(200, { routineRunId: e.run.routineRunId, agentRunId: runId });
  }],
];

/** fetch-compatible mock. Paths arrive as `/api/v1/...` from the typed client. */
export const mockFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://mock.local");
  const path = url.pathname.replace(/^\/api/, "");
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers);
  const principal = headers.get("x-weft-principal");
  let body: Record<string, unknown> = {};
  if (typeof init?.body === "string" && init.body) body = JSON.parse(init.body) as Record<string, unknown>;
  await new Promise((r) => setTimeout(r, 40));
  for (const [m, re, h] of routes) {
    if (m !== method) continue;
    const match = path.match(re);
    if (match) return h(match, url.searchParams, body, principal);
  }
  return err(501, "NotImplemented", `Not implemented in mocks: ${method} ${path}`);
};

export const mocks = { fetch: mockFetch, reset: resetMockWorld, principals: PRINCIPALS } as const;
