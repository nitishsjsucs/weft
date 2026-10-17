// Telemetry (wave 4, docs/wave4.md section 3): the span tree of scripted chat and routine runs, exported to an
// in-memory exporter, and the canary test that no planted secret reaches any attribute or event.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { CHAT_ACT_TOOLS, CHAT_DOMAIN_ROUTES, CHAT_TOOLS_W3, PORTAL_TOOLS } from "@weft/contracts";
import type { ModelProvider, ModelStepResult, PrecheckResult, RoutineDef, RoutineRun, SimClock, ToolOutcome } from "@weft/contracts";
import { closeDb, migrate, openDb, type Db } from "@weft/db";
import { CHAT_TOOLS, createAgentRuntime, createSpendLedger, runTraceTags, scriptedProvider, setTraceRedactor, type Script, type WeftAgentRuntime } from "../src/index";
import { recallDocs, ROUTINE_RUN_SPAN, runMeta, traceMcpCall, traceRoutineRunSpan, type RunTraceInput } from "../src/otel";
import { routineRecallQuery } from "../src/runtime";
import { createFakeExecutor, type FakeExecutor } from "./fake-executor";

const clock: SimClock = { now: () => "2026-10-26T16:00:00.000Z", rate: () => 0, advance: async () => undefined, set: async () => undefined };
let dataDir: string;
let db: Db;
let n = 0;
const handle = () => ({ runId: `run_${String(++n).padStart(4, "0")}`, token: "tok" });

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
const contextManager = new AsyncLocalStorageContextManager();

beforeAll(() => {
  context.setGlobalContextManager(contextManager.enable());
  trace.setGlobalTracerProvider(provider);
});
afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
});
beforeEach(async () => {
  exporter.reset();
  runTraceTags.set(null);
  setTraceRedactor((v) => v);
  dataDir = mkdtempSync(join(tmpdir(), "weft-otel-"));
  db = openDb({ dataDir });
  await migrate(db);
});
afterEach(async () => {
  setTraceRedactor((v) => v);
  runTraceTags.set(null);
  await closeDb(db);
  rmSync(dataDir, { recursive: true, force: true });
});

const done = (data: unknown, summary: string, id = "res_0100"): ToolOutcome => ({ ok: true, status: "done", resultId: id, data, summary, actionSeq: null, artifactRef: null, tainted: false, label: "synthetic" });
const kind = (s: ReadableSpan) => s.attributes["openinference.span.kind"];
const children = (spans: ReadableSpan[], parent: ReadableSpan) => spans.filter((s) => s.parentSpanContext?.spanId === parent.spanContext().spanId);

const routine: RoutineDef = {
  id: "rt_agency_notice", name: "Agency notice handling", description: "d", ownerPrincipalId: "usr_0001", enabled: true, autonomy: "approve",
  trigger: { type: "event", event: "notice.received" }, filter: null, instructions: "Handle the notice.",
  tools: ["notices.get", "tax.update_rate", "notices.draft_response"],
  precheck: "agency_notice", budget: { steps: 6, usd: 0.1, minutes: 10 }, surface: { worthSurfacing: true, channel: null }, source: "prebuilt", taintedBy: null,
  checklist: [{ id: "rate", label: "propose tax.update_rate", check: "proposal_exists:tax.update_rate:{notice_id}" }],
};
const routineRun: RoutineRun = { id: "rtr_0001", routineId: routine.id, runKey: "k", triggerRef: "evt_0001", status: "running", agentRunId: null, precheck: null, summary: null, leftForHuman: [], surfaceHash: null, overdue: false, attended: true, startedAt: null, endedAt: null, costUsdMicros: 0 };
const precheck: PrecheckResult = { action: "run", severity: "interrupt", subjectRefs: ["ntc_0001"], findings: { agency: "ca_edd" }, derivedArgs: { "tax.update_rate": { account_id: "txa_0003", rate: "0.015" } } };
const trigger = { id: "evt_0001", type: "notice.received", ts: "2026-10-26T16:00:00.000Z", subjectRef: "ntc_0001", payload: { notice_id: "ntc_0001" }, attended: true, requestedBy: "usr_0001" };

function runtimeWith(fake: FakeExecutor, p: ModelProvider, extra: Partial<Parameters<typeof createAgentRuntime>[0]> = {}): WeftAgentRuntime {
  const ledger = createSpendLedger({ dir: join(dataDir, "spend"), caps: { runUsd: 0.1, dayUsd: 2, liveUsd: 0.5 } });
  return createAgentRuntime({
    db, clock, executor: fake, provider: p, ledger,
    routinesView: { get: async () => routine, checklist: async ({ agentRunId }) => [{ id: "rate", label: "propose tax.update_rate", passed: fake.proposals.some((x) => x.runId === agentRunId) }] },
    contextSource: { chat: async () => ({ actingFor: "Dana Reyes (demo) (usr_0001), role admin", grants: {}, companySummary: "Larkspur Robotics (demo).", openLoops: [] }) },
    ...extra,
  });
}

function chatExec(extra: Parameters<typeof createFakeExecutor>[0] = []): FakeExecutor {
  return createFakeExecutor([
    ...CHAT_TOOLS.filter((t) => t !== "payroll.get_run").map((name) => ({ name, effect: "read" as const })),
    { name: "payroll.get_run", effect: "read" as const, handler: () => done({ flagged: [{ worker: "Rowan Achebe (demo) (wrk_0014)", before_cents: 400000, after_cents: 432000 }] }, "Read pay_2026_10_30 flagged rows", "res_0200") },
    ...extra,
  ]);
}

describe("span tree", () => {
  it("a chat run exports AGENT, the stage CHAINs, LLM and TOOL spans with session, user, metadata and tags", async () => {
    const fake = chatExec();
    const script: Script = { match: "NY raise", agents: { main: [
      { output: [
        { type: "function_call", name: "payroll__get_run", arguments: { run_id: "pay_2026_10_30" } },
        { type: "function_call", name: "tax__update_rate", arguments: { rate: "0.02" } },
      ] },
      { output: [{ type: "text", text: "Gross pay for Rowan Achebe (demo) (wrk_0014) rose from $4,000.00 to $4,320.00 (res_0200)." }] },
    ] } };
    const rt = runtimeWith(fake, scriptedProvider({ scriptsDir: dataDir, scripts: { chat_ny: script } }));
    runTraceTags.set({ eval_task_id: "EX-01", eval_variant: "default", eval_split: "dev", eval_trial: 1 });
    const h = handle();
    await rt.startChat(h, { text: "Why is the NY raise flagged?", recipe: "chat", pageContext: null });
    const run = await rt.settled(h.runId);
    expect(run.status).toBe("done");

    const spans = exporter.getFinishedSpans();
    const roots = spans.filter((s) => !s.parentSpanContext);
    expect(roots).toHaveLength(1);
    const agent = roots[0]!;
    expect(agent.name).toBe("agent.run");
    expect(kind(agent)).toBe("AGENT");
    expect(agent.attributes["input.value"]).toBe("Why is the NY raise flagged?");
    expect(agent.attributes["output.value"]).toContain("res_0200");
    expect(agent.attributes["weft.run_id"]).toBe(h.runId);
    expect(new Set(spans.map((s) => s.spanContext().traceId)).size).toBe(1);

    const top = children(spans, agent);
    expect(top.every((s) => kind(s) === "CHAIN")).toBe(true);
    expect(top.map((s) => s.name)).toEqual(expect.arrayContaining(["admission", "assemble", "model", "dispatch", "post", "terminal"]));

    const models = top.filter((s) => s.name === "model");
    expect(models).toHaveLength(2);
    const llm = children(spans, models[0]!);
    expect(llm.map((s) => [s.name, kind(s)])).toEqual([["llm.responses", "LLM"]]);
    const a = llm[0]!.attributes;
    expect(a["llm.model_name"]).toBe("scripted");
    expect(a["llm.input_messages.0.message.role"]).toBe("system");
    expect(String(a["llm.input_messages.1.message.content"])).toContain("<request>Why is the NY raise flagged?</request>");
    expect(a["llm.output_messages.0.message.tool_calls.0.tool_call.function.name"]).toBe("payroll__get_run");
    expect(typeof a["llm.token_count.prompt"]).toBe("number");
    expect(a["llm.token_count.prompt_details.cache_read"]).toBeGreaterThanOrEqual(0);
    expect(a["llm.token_count.completion_details.reasoning"]).toBeGreaterThanOrEqual(0);
    expect(a["llm.cost.total"]).toBe(0);
    expect(JSON.parse(String(a["llm.invocation_parameters"]))).toMatchObject({ prompt_cache_key_set: true, store: false });
    expect(String(a["llm.invocation_parameters"])).not.toContain("weft:main");   // the cache key value itself never lands
    expect(a["llm.tools.0.tool.json_schema"]).toBeDefined();
    // The second model call sees the tool outputs as tool messages.
    const llm2 = children(spans, models[1]!)[0]!.attributes;
    const toolMsgs = Object.entries(llm2).filter(([k, v]) => k.endsWith(".message.role") && v === "tool");
    expect(toolMsgs).toHaveLength(2);

    const dispatch = top.find((s) => s.name === "dispatch")!;
    const tools = children(spans, dispatch);
    expect(tools.map((s) => [s.name, kind(s), s.attributes["weft.outcome"]])).toEqual([
      ["payroll__get_run", "TOOL", "ok"],
      ["tax__update_rate", "TOOL", "refused:UNAVAILABLE"],
    ]);
    expect(tools[0]!.status.code).toBe(SpanStatusCode.OK);
    expect(tools[1]!.status.code).toBe(SpanStatusCode.UNSET);   // a refusal is the harness working
    expect(tools[1]!.attributes["weft.refusal_code"]).toBe("UNAVAILABLE");
    expect(tools[0]!.attributes["tool.id"]).toBeTruthy();
    expect(typeof tools[0]!.attributes["weft.step_n"]).toBe("number");
    expect(JSON.parse(String(tools[0]!.attributes["tool.parameters"]))).toEqual({ run_id: "pay_2026_10_30" });

    const guards = spans.filter((s) => kind(s) === "GUARDRAIL");
    expect(guards.map((s) => s.attributes["weft.guardrail"]).sort()).toEqual(["grounding", "taint"]);
    expect(guards.find((s) => s.name === "grounding.check")!.attributes["weft.grounded"]).toBe(true);
    const terminal = top.find((s) => s.name === "terminal")!;
    expect(children(spans, terminal).map((s) => s.name)).toEqual(["taint.check"]);
    expect(terminal.attributes["weft.terminal_reason"]).toBe("DONE");

    for (const s of spans) {
      expect(s.attributes["user.id"], s.name).toBe("usr_0001");
      expect(s.attributes["session.id"], s.name).toBe("EX-01");   // no thread id: the eval task id
      expect(JSON.parse(String(s.attributes["tag.tags"])), s.name).toEqual(["chat", "eval", "EX-01", "variant:default"]);
      const meta = JSON.parse(String(s.attributes.metadata));
      expect(meta).toMatchObject({ run_id: h.runId, kind: "chat", provider: "scripted", eval_task_id: "EX-01", eval_split: "dev", eval_trial: 1, chat_can_propose: false });
      expect(meta.prompt_version).toMatch(/^[0-9a-f]{12}$/);
    }
  });

  it("a routine run carries routine_run session, the owner as user and proposal outcomes", async () => {
    const fake = createFakeExecutor([
      { name: "notices.get", effect: "read", handler: () => done({ notice_id: "ntc_0001" }, "Read the notice") },
      { name: "tax.update_rate", effect: "write", gated: true },
      { name: "notices.draft_response", effect: "draft" },
    ]);
    const script: Script = { agents: { main: [
      { output: [{ type: "function_call", name: "notices__get", arguments: { notice_id: "{{trigger.notice_id}}" } }, { type: "function_call", name: "tax__update_rate", arguments: "{{derived.tax.update_rate}}" }] },
      { output: [{ type: "text", text: "Proposed the rate change." }] },
    ] } };
    const rt = runtimeWith(fake, scriptedProvider({ scriptsDir: dataDir, scripts: { rt_agency_notice: script } }));
    const h = handle();
    await rt.startRoutineRun(h, { routine, routineRun, trigger, precheck });
    const run = await rt.settled(h.runId);
    expect(run.status).toBe("waiting");

    const spans = exporter.getFinishedSpans();
    const agent = spans.find((s) => s.name === "agent.run")!;
    expect(agent.attributes["output.value"]).toContain("Proposed");
    expect(String(agent.attributes["input.value"])).toContain("routine: rt_agency_notice");
    const tools = spans.filter((s) => kind(s) === "TOOL");
    expect(tools.map((s) => s.attributes["weft.outcome"])).toEqual(["ok", "proposal"]);
    expect(tools[1]!.attributes["weft.proposal_id"]).toMatch(/^prp_/);
    for (const s of spans) {
      expect(s.attributes["session.id"]).toBe("routine_run:rtr_0001");
      expect(s.attributes["user.id"]).toBe("usr_0001");
      expect(JSON.parse(String(s.attributes["tag.tags"]))).toEqual(["routine", "rt_agency_notice"]);
      expect(JSON.parse(String(s.attributes.metadata))).toMatchObject({ routine_id: "rt_agency_notice", routine_run_id: "rtr_0001", attended: true });
    }
  });

  it("a zero-token wake that finishes a waiting run is its own AGENT segment in the run's session", async () => {
    const fake = createFakeExecutor([
      { name: "notices.get", effect: "read", handler: () => done({ notice_id: "ntc_0001" }, "Read the notice") },
      { name: "tax.update_rate", effect: "write", gated: true },
      { name: "notices.draft_response", effect: "draft" },
    ]);
    const script: Script = { agents: { main: [
      { output: [{ type: "function_call", name: "tax__update_rate", arguments: "{{derived.tax.update_rate}}" }] },
      { output: [{ type: "text", text: "Proposed the rate change." }] },
    ] } };
    const rt = runtimeWith(fake, scriptedProvider({ scriptsDir: dataDir, scripts: { rt_agency_notice: script } }));
    const h = handle();
    await rt.startRoutineRun(h, { routine, routineRun, trigger, precheck });
    expect((await rt.settled(h.runId)).status).toBe("waiting");
    exporter.reset();
    fake.proposals[0]!.status = "executed";
    expect(await rt.wake(h.runId, { kind: "decision", attrs: { proposal_id: fake.proposals[0]!.id, status: "executed" }, text: "approved" })).toBe("done");
    const spans = exporter.getFinishedSpans();
    expect(spans.map((s) => [s.name, kind(s)])).toEqual([["terminal", "CHAIN"], ["agent.run", "AGENT"]]);
    const [terminal, agent] = spans as [ReadableSpan, ReadableSpan];
    expect(agent.parentSpanContext).toBeUndefined();
    expect(agent.attributes["weft.segment"]).toBe("zero_token_wake");
    expect(agent.attributes["weft.status"]).toBe("done");
    expect(agent.status.code).toBe(SpanStatusCode.OK);
    expect(agent.attributes["llm.token_count.prompt"]).toBeGreaterThan(0);   // the run's totals so far; the wake itself spent nothing
    expect(terminal.attributes).toMatchObject({ "weft.zero_token_wake": true, "weft.checklist_passed": 1, "weft.checklist_total": 1, "weft.terminal_reason": "DONE" });
    for (const s of spans) expect(s.attributes["session.id"]).toBe("routine_run:rtr_0001");
  });

  it("a run started inside another run's span is still its own trace", async () => {
    const fake = chatExec();
    const script: Script = { match: "flagged", agents: { main: [{ output: [{ type: "text", text: "Nothing is flagged." }] }] } };
    const rt = runtimeWith(fake, scriptedProvider({ scriptsDir: dataDir, scripts: { chat_x: script } }));
    const outer = trace.getTracer("t").startSpan("outer");
    const h = handle();
    await context.with(trace.setSpan(context.active(), outer), () => rt.startChat(h, { text: "Is anything flagged?", recipe: "chat", pageContext: null }));
    await rt.settled(h.runId);
    outer.end();
    const agent = exporter.getFinishedSpans().find((s) => s.name === "agent.run")!;
    expect(agent.parentSpanContext).toBeUndefined();
  });

  it("during an eval trial a run nests under the span that was active when the trial set its tags", async () => {
    const fake = chatExec();
    const script: Script = { match: "flagged", agents: { main: [{ output: [{ type: "text", text: "Nothing is flagged." }] }] } };
    const rt = runtimeWith(fake, scriptedProvider({ scriptsDir: dataDir, scripts: { chat_x: script } }));
    const task = trace.getTracer("t").startSpan("Task: eval");
    const h = handle();
    // The tags are set inside the task span; the run itself starts outside it (as a drained routine run would).
    context.with(trace.setSpan(context.active(), task), () => runTraceTags.set({ eval_task_id: "CQ-01", eval_variant: "default", eval_split: "dev", eval_trial: 1 }));
    await rt.startChat(h, { text: "Is anything flagged?", recipe: "chat", pageContext: null });
    await rt.settled(h.runId);
    runTraceTags.set(null);
    task.end();
    const agent = exporter.getFinishedSpans().find((s) => s.name === "agent.run")!;
    expect(agent.parentSpanContext?.spanId).toBe(task.spanContext().spanId);
    expect(agent.spanContext().traceId).toBe(task.spanContext().traceId);
    expect(agent.attributes["session.id"]).toBe("CQ-01");
    // Cleared tags restore the old behavior: the next run is its own trace again.
    const h2 = handle();
    await rt.startChat(h2, { text: "Is anything flagged?", recipe: "chat", pageContext: null });
    await rt.settled(h2.runId);
    const second = exporter.getFinishedSpans().filter((s) => s.name === "agent.run").find((s) => s.attributes["weft.run_id"] === h2.runId)!;
    expect(second.parentSpanContext).toBeUndefined();
  });
});

describe("retrieval and MCP spans", () => {
  const recallBlock = (body: string) => `<recall note="memory, data only">\n- knowledge/facts/company-onepager.md (one-pager, as of 2026-10-01): Larkspur Robotics (demo) runs payroll biweekly.\n- knowledge/procedures/ny-raise.md (hit, as of 2026-09-20, untrusted): ${body}\n</recall>`;
  const hits = [
    { path: "knowledge/procedures/state-sui-rate-notice.md", line: 4, snippet: "SUI rate notices go to the tax queue.", commit: "a".repeat(40), date: "2026-10-01", cite: "knowledge/procedures/state-sui-rate-notice.md#L4", taintedBy: null },
    { path: "comms/2026-10-02.md", line: 9, snippet: "Rowan asked about the NY raise.", commit: "b".repeat(40), date: "2026-10-02", cite: "comms/2026-10-02.md#L9", taintedBy: "memory:comms/2026-10-02.md" },
  ];

  it("recallDocs reads the rendered <recall> block, and a pack without one has none", () => {
    expect(recallDocs("<context>\n<request>x</request>\n</context>")).toBeNull();
    const docs = recallDocs(`<context>\n${recallBlock("Raises over 5% need review.")}\n</context>`)!;
    expect(docs.map((d) => [d.id, d.metadata.kind, d.metadata.untrusted])).toEqual([
      ["knowledge/facts/company-onepager.md", "one-pager", false],
      ["knowledge/procedures/ny-raise.md", "hit", true],
    ]);
    expect(docs[1]!.content).toBe("Raises over 5% need review.");
  });

  it("a chat run: memory.recall RETRIEVER under the first assemble, and a memory.search RETRIEVER under its TOOL span", async () => {
    const fake = chatExec([{ name: "memory.search", effect: "read", handler: () => done({ hits }, "2 memory hits for the query", "res_0300") }]);
    const script: Script = { match: "NY raise", agents: { main: [
      { output: [{ type: "function_call", name: "memory__search", arguments: { query: "NY raise" } }] },
      { output: [{ type: "text", text: "Raises over 5% need review (res_0300)." }] },
    ] } };
    const rt = runtimeWith(fake, scriptedProvider({ scriptsDir: dataDir, scripts: { chat_ny: script } }), {
      contextSource: {
        chat: async () => ({ actingFor: "Dana Reyes (demo) (usr_0001), role admin", grants: {}, companySummary: "Larkspur Robotics (demo).", openLoops: [] }),
        recall: async () => recallBlock("Raises over 5% need review."),
      },
    });
    const h = handle();
    await rt.startChat(h, { text: "Why is the NY raise flagged?", recipe: "chat", pageContext: null });
    await rt.settled(h.runId);
    const spans = exporter.getFinishedSpans();
    const retrievers = spans.filter((s) => kind(s) === "RETRIEVER");
    expect(retrievers.map((s) => s.name).sort()).toEqual(["memory.recall", "memory.search"]);

    const recall = retrievers.find((s) => s.name === "memory.recall")!;
    const assembles = spans.filter((s) => s.name === "assemble");
    expect(assembles.length).toBeGreaterThanOrEqual(2);
    expect(recall.parentSpanContext?.spanId).toBe(assembles.sort((a, b) => (a.attributes["weft.step_n"] as number) - (b.attributes["weft.step_n"] as number))[0]!.spanContext().spanId);
    expect(recall.attributes["input.value"]).toBe("Why is the NY raise flagged?");
    expect(recall.attributes["retrieval.documents.0.document.id"]).toBe("knowledge/facts/company-onepager.md");
    expect(recall.attributes["retrieval.documents.1.document.content"]).toBe("Raises over 5% need review.");
    expect(JSON.parse(String(recall.attributes["retrieval.documents.1.document.metadata"]))).toMatchObject({ untrusted: true });
    expect(recall.attributes["session.id"]).toBe(spans.find((s) => s.name === "agent.run")!.attributes["session.id"]);

    const tool = spans.find((s) => kind(s) === "TOOL" && s.name === "memory__search")!;
    const search = retrievers.find((s) => s.name === "memory.search")!;
    expect(search.parentSpanContext?.spanId).toBe(tool.spanContext().spanId);
    expect(search.attributes["input.value"]).toBe("NY raise");
    expect(search.attributes["weft.documents"]).toBe(2);
    expect(search.attributes["retrieval.documents.0.document.id"]).toBe("knowledge/procedures/state-sui-rate-notice.md#L4");
    expect(JSON.parse(String(search.attributes["retrieval.documents.1.document.metadata"]))).toMatchObject({ tainted_by: "memory:comms/2026-10-02.md", line: 9 });
    expect(search.attributes["user.id"]).toBe("usr_0001");
  });

  it("traceMcpCall: a root TOOL span with the key's principal, mcp tags, weft.outcome and a RETRIEVER for search hits", () => {
    const settle = traceMcpCall({ command: "tax__update_rate", wireName: "tax__update_rate", args: { rate_id: "etr_0001", rate: "0.015" }, surface: "mcp", caller: "mcp", companyId: "cmp_larkspur", principalId: "usr_dana" });
    settle({ ok: true, status: "pending_approval", proposalId: "prp_0001", title: "Update rate", expiresAt: "2026-10-27T16:00:00.000Z", tainted: true }, false);
    traceMcpCall({ command: "vault__list", wireName: "vault__list", args: {}, surface: "mcp", caller: "mcp", companyId: "cmp_larkspur", principalId: "usr_dana" })(
      { ok: false, refusal: { code: "UNAVAILABLE", message: "vault.list is not exposed over MCP", hint: null, example: null }, tainted: true }, false);
    traceMcpCall({ command: "memory.search", wireName: "memory__search", args: { query: "SUI rate" }, surface: "mcp", caller: "mcp", companyId: "cmp_larkspur", principalId: "usr_dana" })(done({ hits }, "2 memory hits"), false);
    traceMcpCall({ command: "people__search", wireName: "people__search", args: {}, surface: "mcp", caller: "mcp", companyId: "cmp_larkspur", principalId: "usr_dana" })(
      { ok: false, refusal: { code: "INTERNAL", message: "The executor failed", hint: null, example: null }, tainted: true }, true);
    const spans = exporter.getFinishedSpans();
    const tools = spans.filter((s) => kind(s) === "TOOL");
    expect(tools.map((s) => [s.name, s.attributes["weft.outcome"], s.status.code])).toEqual([
      ["tax__update_rate", "proposal", SpanStatusCode.OK],
      ["vault__list", "refused:UNAVAILABLE", SpanStatusCode.UNSET],
      ["memory__search", "ok", SpanStatusCode.OK],
      ["people__search", "error", SpanStatusCode.ERROR],
    ]);
    for (const t of tools) {
      expect(t.parentSpanContext).toBeUndefined();
      expect(t.attributes["user.id"]).toBe("usr_dana");
      expect(JSON.parse(String(t.attributes["tag.tags"]))).toEqual(["mcp", t.name]);
      expect(JSON.parse(String(t.attributes.metadata))).toMatchObject({ kind: "mcp", surface: "mcp", company_id: "cmp_larkspur" });
      expect(t.attributes["session.id"]).toBeUndefined();
    }
    expect(new Set(tools.map((t) => t.spanContext().traceId)).size).toBe(4);
    expect(tools[0]!.attributes["weft.proposal_id"]).toBe("prp_0001");
    expect(tools[0]!.attributes["weft.tainted"]).toBe(true);
    const r = spans.find((s) => kind(s) === "RETRIEVER")!;
    expect(r.parentSpanContext?.spanId).toBe(tools[2]!.spanContext().spanId);
    expect(r.attributes["user.id"]).toBe("usr_dana");
  });
});

// ---------------------------------------------------------------------------------------------------- canary

const FAKE_KEY = "sk-weftcanary0000000000000000000000000000AbCd";
const VAULT_VALUE = "vault-canary-plaintext-7Qp2";
const ROUTING = "routing number 021000021";
const ACCOUNT = "account number 123456789012";
const forms = (v: string) => [v, Buffer.from(v).toString("base64"), Buffer.from(v).toString("base64url"), Buffer.from(v).toString("hex"), Buffer.from(v).toString("base64").replace(/=+$/, "")];
const SECRETS = [FAKE_KEY, VAULT_VALUE];

/** A stand-in for the executor's Redactor (the brain's tests may not import the vault): secret forms plus patterns. */
function canaryRedact<T>(v: T): T {
  if (typeof v === "string") {
    let s: string = v;
    for (const sec of SECRETS) for (const f of forms(sec).sort((a, b) => b.length - a.length)) s = s.split(f).join("[redacted]");
    s = s.replace(/(\b(?:routing|aba|rtn)[^0-9\n]{0,24})\d{9}\b/gi, "$1[redacted]").replace(/(\b(?:account|acct)(?:[ _-]?(?:no|number|num))?[^0-9\n]{0,24})\d{6,17}\b/gi, "$1[redacted]");
    return s as T;
  }
  if (Array.isArray(v)) return v.map((x) => canaryRedact(x)) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, canaryRedact(x)])) as T;
  return v;
}

function planted(): string {
  const b64 = Buffer.from(FAKE_KEY).toString("base64");
  const hex = Buffer.from(VAULT_VALUE).toString("hex");
  return `key ${FAKE_KEY} b64 ${b64} hex ${hex} vault ${VAULT_VALUE} ${ROUTING} ${ACCOUNT}`;
}

/** A provider that plants secrets in an error message, tool args and model text. */
function plantingProvider(): ModelProvider {
  let i = 0;
  const usage = { input: 1200, cached: 1024, cacheWrite: 0, output: 80, reasoning: 32 };
  return {
    id: "scripted", model: "scripted", label: "canary", live: false,
    async step(): Promise<ModelStepResult> {
      i++;
      if (i === 1) return { stop: "error", text: "", toolCalls: [], native: [], usage: { ...usage, input: 0, cached: 0, output: 0, reasoning: 0 }, servedBy: "scripted", requestId: `req_${FAKE_KEY}`, error: { code: "PROVIDER_UNAVAILABLE", message: `upstream said ${planted()}`, retryable: true } };
      if (i === 2) {
        const calls = [{ callId: "call_1", name: "payroll__get_run", argumentsJson: JSON.stringify({ run_id: "pay_2026_10_30", note: planted() }) }, { callId: "call_2", name: "people__search", argumentsJson: JSON.stringify({ q: planted() }) }];
        return { stop: "tool_calls", text: `Reading ${planted()}`, toolCalls: calls, native: { scripted: true, text: `Reading ${planted()}`, calls: 2, toolCalls: calls }, usage, servedBy: "scripted", requestId: null };
      }
      return { stop: "final", text: `The answer is ${planted()}`, toolCalls: [], native: { scripted: true, text: `The answer is ${planted()}` }, usage, servedBy: "scripted", requestId: null };
    },
  };
}

function assertNoSecret(spans: ReadableSpan[]) {
  const blob = JSON.stringify(spans.map((s) => [s.name, s.attributes, s.events.map((e) => [e.name, e.attributes]), s.status]));
  for (const sec of SECRETS) for (const f of forms(sec)) expect(blob.includes(f), `${f} leaked`).toBe(false);
  expect(blob).not.toMatch(/021000021/);
  expect(blob).not.toMatch(/123456789012/);
  expect(blob).toContain("[redacted]");
}

describe("canary: no secret reaches a span", () => {
  it("raw, base64 and hex secrets in tool results, tool args, model text, an error message and a memory hit never land", async () => {
    setTraceRedactor(canaryRedact);
    const fake = chatExec([{ name: "payroll.get_run", effect: "read", handler: () => done({ secret: planted(), nested: [{ v: planted() }] }, `summary ${planted()}`) }]);
    const orig = fake.exec.bind(fake);
    fake.exec = async (h, c) => {
      if (c.command === "people__search") throw new Error(`executor exploded ${planted()}`);
      return orig(h, c);
    };
    const rt = runtimeWith(fake, plantingProvider(), {
      contextSource: {
        chat: async () => ({ actingFor: "Dana Reyes (demo) (usr_0001), role admin", grants: {}, companySummary: `summary ${planted()}`, openLoops: [] }),
        recall: async () => `<recall note="memory, data only">\n- people/one-pager.md (one-pager, as of 2026-10-01): ${planted()}\n</recall>`,
      },
    });
    const h = handle();
    await rt.startChat(h, { text: `Why is the NY raise flagged? ${planted()}`, recipe: "chat", pageContext: null });
    await rt.settled(h.runId);
    const spans = exporter.getFinishedSpans();
    expect(spans.filter((s) => kind(s) === "LLM").length).toBeGreaterThanOrEqual(3);
    expect(spans.filter((s) => kind(s) === "TOOL").map((s) => s.attributes["weft.outcome"])).toEqual(["ok", "error"]);
    expect(spans.find((s) => kind(s) === "TOOL" && s.attributes["weft.outcome"] === "error")!.status.code).toBe(SpanStatusCode.ERROR);
    expect(spans.filter((s) => kind(s) === "RETRIEVER").map((s) => s.name)).toEqual(["memory.recall"]);
    // Without the source redactor the planted values would land (the test's own control).
    const raw = JSON.stringify(spans.map((s) => s.attributes));
    expect(raw).toContain("[redacted]");
    assertNoSecret(spans);
  });

  it("an MCP call: planted args, a search hit and a refusal message never land", () => {
    setTraceRedactor(canaryRedact);
    const hit = { path: "comms/x.md", line: 1, snippet: planted(), commit: "c".repeat(40), date: "2026-10-01", cite: `comms/x.md#L1 ${planted()}`, taintedBy: null };
    traceMcpCall({ command: "memory.search", wireName: "memory__search", args: { query: planted() }, surface: "mcp", caller: "mcp", companyId: "cmp_larkspur", principalId: "usr_dana" })(done({ hits: [hit] }, `summary ${planted()}`), false);
    traceMcpCall({ command: `people__search ${FAKE_KEY}`, wireName: null, args: { q: planted() }, surface: "mcp", caller: "mcp", companyId: "cmp_larkspur", principalId: "usr_dana" })(
      { ok: false, refusal: { code: "INVALID_INPUT", message: `bad ${planted()}`, hint: planted(), example: { v: planted() } }, tainted: true }, true);
    const spans = exporter.getFinishedSpans();
    expect(spans.map((s) => kind(s)).sort()).toEqual(["RETRIEVER", "TOOL", "TOOL"]);
    assertNoSecret(spans);
  });

  it("the control: with an identity redactor the same run does leak, so the canary is meaningful", async () => {
    const fake = chatExec([{ name: "payroll.get_run", effect: "read", handler: () => done({ secret: planted() }, "s") }]);
    const rt = runtimeWith(fake, plantingProvider());
    const h = handle();
    await rt.startChat(h, { text: "Why is the NY raise flagged?", recipe: "chat", pageContext: null });
    await rt.settled(h.runId);
    expect(JSON.stringify(exporter.getFinishedSpans().map((s) => s.attributes))).toContain(FAKE_KEY);
  });

  it("an exception event carries a redacted message and no stack", async () => {
    setTraceRedactor(canaryRedact);
    const boom: ModelProvider = { id: "scripted", model: "scripted", label: "boom", live: false, step: async () => { throw new Error(`script broke ${planted()}`); } };
    const rt = runtimeWith(chatExec(), boom);
    const h = handle();
    await rt.startChat(h, { text: "Why?", recipe: "chat", pageContext: null });
    await rt.settled(h.runId);
    const spans = exporter.getFinishedSpans();
    const ev = spans.flatMap((s) => s.events);
    expect(ev.length).toBeGreaterThan(0);
    expect(ev.every((e) => !("exception.stacktrace" in (e.attributes ?? {})))).toBe(true);
    expect(spans.find((s) => s.name === "agent.run")!.status.code).toBe(SpanStatusCode.ERROR);
    assertNoSecret(spans);
  });
});

describe("wave 4 round 1: routine runs without an agent run, empty recall and provider retries (FM11)", () => {
  const routineScript: Script = { agents: { main: [
    { output: [{ type: "function_call", name: "tax__update_rate", arguments: "{{derived.tax.update_rate}}" }] },
    { output: [{ type: "text", text: "Proposed the rate change." }] },
  ] } };
  const rateExec = () => createFakeExecutor([
    { name: "notices.get", effect: "read", handler: () => done({ notice_id: "ntc_0001" }, "Read the notice") },
    { name: "tax.update_rate", effect: "write", gated: true },
    { name: "notices.draft_response", effect: "draft" },
  ]);
  const withRecall = (recall: () => Promise<string>, seen: { query: string; subjectRefs: string[] }[] = []) => ({
    contextSource: {
      chat: async () => ({ actingFor: "Dana Reyes (demo) (usr_0001), role admin", grants: {}, companySummary: "Larkspur Robotics (demo).", openLoops: [] }),
      recall: async (i: { query: string; subjectRefs: string[] }) => { seen.push({ query: i.query, subjectRefs: i.subjectRefs }); return recall(); },
    },
  });

  it("a skipped routine run is one CHAIN span with its status and the precheck reason, in its routine run session", () => {
    traceRoutineRunSpan({ routineId: "rt_agency_notice", routineRunId: "rtr_0009", triggerRef: "evt_0004", attended: false, status: "skipped", reason: "Notice ntc_0004 is already escalated.", precheck: "agency_notice", event: "notice.received", at: "2026-10-26T16:00:00.000Z" });
    const spans = exporter.getFinishedSpans();
    expect(spans.map((s) => [s.name, kind(s)])).toEqual([[ROUTINE_RUN_SPAN, "CHAIN"]]);
    const s = spans[0]!;
    expect(s.parentSpanContext?.spanId).toBeUndefined();
    expect(s.attributes).toMatchObject({ "weft.status": "skipped", "weft.precheck_reason": "Notice ntc_0004 is already escalated.", "weft.routine_id": "rt_agency_notice", "weft.routine_run_id": "rtr_0009", "weft.agent_run": false, "session.id": "routine_run:rtr_0009", "user.id": "routine:rt_agency_notice", "output.value": "Notice ntc_0004 is already escalated." });
    expect(JSON.parse(String(s.attributes["tag.tags"]))).toEqual(["routine", "rt_agency_notice", "no_agent_run", "status:skipped", "unattended"]);
    expect(JSON.parse(String(s.attributes.metadata))).toMatchObject({ routine_id: "rt_agency_notice", status: "skipped", agent_run: false });
    expect(s.status.code).toBe(SpanStatusCode.OK);
  });

  it("during an eval trial the skip nests under the trial's span and carries the eval tags", async () => {
    const tracer = trace.getTracer("test");
    await tracer.startActiveSpan("trial", async (trial) => {
      runTraceTags.set({ eval_task_id: "NT-01", eval_split: "dev", eval_variant: "default", eval_trial: 1 });
      traceRoutineRunSpan({ routineId: "rt_people_digest", routineRunId: "rtr_0010", triggerRef: "cron:2026-10-26T16:00:00.000Z", attended: false, status: "skipped", reason: "Nothing new since the last run.", precheck: "people_digest", event: null, at: "2026-10-26T16:00:00.000Z" });
      runTraceTags.set(null);
      trial.end();
    });
    const spans = exporter.getFinishedSpans();
    const skip = spans.find((s) => s.name === ROUTINE_RUN_SPAN)!;
    expect(skip.parentSpanContext?.spanId).toBe(spans.find((s) => s.name === "trial")!.spanContext().spanId);
    expect(JSON.parse(String(skip.attributes["tag.tags"]))).toEqual(expect.arrayContaining(["eval", "NT-01", "variant:default"]));
  });

  it("an empty run-start recall is a RETRIEVER with 0 documents and its reason; the query carries the precheck findings (FM4)", async () => {
    const seen: { query: string; subjectRefs: string[] }[] = [];
    const rt = runtimeWith(rateExec(), scriptedProvider({ scriptsDir: dataDir, scripts: { rt_agency_notice: routineScript } }), withRecall(async () => "", seen));
    const h = handle();
    const pre: PrecheckResult = { ...precheck, findings: { notice: { id: "ntc_0002", agency: "ny_dtf", kind: "missing_filing", form: "ny_nys45", form_code: "NYS-45", period: "2026-Q3", status: "new" }, plan: "file_return" } };
    await rt.startRoutineRun(h, { routine, routineRun, trigger, precheck: pre });
    await rt.settled(h.runId);
    expect(seen[0]!.query).toBe("Agency notice handling file_return file return missing_filing missing filing ny_dtf ny dtf ny_nys45 ny nys45 NYS-45 2026-Q3");
    expect(seen[0]!.query).not.toContain("ntc_0002");
    const spans = exporter.getFinishedSpans();
    const r = spans.filter((s) => kind(s) === "RETRIEVER");
    expect(r.map((s) => s.name)).toEqual(["memory.recall"]);
    expect(r[0]!.attributes).toMatchObject({ "weft.documents": 0, "weft.recall_reason": "no_block", "input.value": seen[0]!.query });
    expect(r[0]!.parentSpanContext?.spanId).toBe(spans.find((s) => s.name === "assemble")!.spanContext().spanId);
  });

  it("a recall source that throws leaves the pack unchanged, the run still starts, and the span says recall_error", async () => {
    const rt = runtimeWith(rateExec(), scriptedProvider({ scriptsDir: dataDir, scripts: { rt_agency_notice: routineScript } }), withRecall(async () => { throw new Error("git grep failed"); }));
    const h = handle();
    await rt.startRoutineRun(h, { routine, routineRun, trigger, precheck });
    expect((await rt.settled(h.runId)).status).toBe("waiting");
    const r = exporter.getFinishedSpans().find((s) => kind(s) === "RETRIEVER")!;
    expect(r.attributes).toMatchObject({ "weft.documents": 0, "weft.recall_reason": "recall_error", "weft.recall_detail": "git grep failed" });
  });

  it("a provider retry is tagged on the LLM span that retries, with the code it retries", async () => {
    const rt = runtimeWith(chatExec(), plantingProvider());
    const h = handle();
    await rt.startChat(h, { text: "Why is the NY raise flagged?", recipe: "chat", pageContext: null });
    await rt.settled(h.runId);
    const llm = exporter.getFinishedSpans().filter((s) => kind(s) === "LLM").sort((a, b) => Number(a.attributes["weft.llm_call"]) - Number(b.attributes["weft.llm_call"]));
    expect(llm.slice(0, 3).map((s) => [s.attributes["weft.llm_call"], s.attributes["weft.retry"], s.attributes["weft.retry_of"] ?? null])).toEqual([[1, false, null], [2, true, "PROVIDER_UNAVAILABLE"], [3, false, null]]);
    expect(llm.filter((s) => s.attributes["weft.retry"] === true)).toHaveLength(1);
    expect(llm[0]!.attributes["weft.error_retryable"]).toBe(true);
  });

  it("routineRecallQuery keeps the routine name first and leaves ids, numbers and long text out", () => {
    expect(routineRecallQuery("Weekly people digest", { headcount: 48, by_state: { CA: 22 }, slot: "cron:x" })).toBe("Weekly people digest");
    expect(routineRecallQuery("Agency notice handling", { notice: { id: "ntc_0001", agency: "ca_edd", kind: "rate_change", code: "sui", respond_by: "2026-11-05" }, impact: { rate_delta: "0.019" } }))
      .toBe("Agency notice handling rate_change rate change ca_edd ca edd sui");
  });

  it("canary: a planted secret in a precheck reason, the recall query and a recall error never lands", async () => {
    setTraceRedactor(canaryRedact);
    traceRoutineRunSpan({ routineId: "rt_agency_notice", routineRunId: "rtr_0011", triggerRef: `evt ${planted()}`, attended: true, status: "skipped", reason: `Notice could not be read: ${planted()}`, precheck: "agency_notice", event: "notice.received", at: "2026-10-26T16:00:00.000Z" });
    const rt = runtimeWith(rateExec(), scriptedProvider({ scriptsDir: dataDir, scripts: { rt_agency_notice: routineScript } }), withRecall(async () => { throw new Error(`recall broke ${planted()}`); }));
    const h = handle();
    const pre: PrecheckResult = { ...precheck, findings: { notice: { kind: `rate_change ${FAKE_KEY}`, agency: VAULT_VALUE, form: planted().slice(0, 30) } } };
    await rt.startRoutineRun(h, { routine, routineRun, trigger, precheck: pre });
    await rt.settled(h.runId);
    const spans = exporter.getFinishedSpans();
    expect(spans.some((s) => s.name === ROUTINE_RUN_SPAN)).toBe(true);
    expect(spans.some((s) => s.attributes["weft.recall_reason"] === "recall_error")).toBe(true);
    assertNoSecret(spans);
  });
});

describe("otel.ts hygiene", () => {
  it("never reads key-like environment variables", () => {
    const src = readFileSync(join(import.meta.dirname, "../src/otel.ts"), "utf8");
    expect(src).not.toMatch(/process\.env/);
    expect(src).not.toMatch(/(KEY|SECRET|TOKEN)\b/);
  });
});

describe("chat_can_propose run metadata", () => {
  const input = (allowlist: readonly string[], promptKind: RunTraceInput["promptKind"] = "chat"): RunTraceInput => ({
    run: { id: "run_meta", companyId: "co_1", trigger: "chat", attended: true, provider: "scripted", model: "m", routineRunId: null } as unknown as RunTraceInput["run"],
    promptKind, allowlist, routineId: null, principal: "usr_0001", input: "q", prompt: "p",
  });

  it("is false for the wave 3 chat list, a routed domain read and the portal list, true for the act list", () => {
    expect(runMeta(input(CHAT_TOOLS_W3), null).chat_can_propose).toBe(false);
    for (const r of CHAT_DOMAIN_ROUTES) {
      const routed = CHAT_TOOLS_W3.map((n) => (n === "comms.post_update" ? r.tool : n));
      expect(runMeta(input(routed), null).chat_can_propose, r.tool).toBe(false);
    }
    expect(runMeta(input(PORTAL_TOOLS), null).chat_can_propose).toBe(false);
    expect(runMeta(input(CHAT_ACT_TOOLS), null).chat_can_propose).toBe(true);
    expect(runMeta(input(CHAT_TOOLS_W3), { eval_variant: "chat_can_propose" }).chat_can_propose).toBe(true);
    expect(runMeta(input(["tax.update_rate"], "routine"), null).chat_can_propose).toBe(false);
  });
});

describe("redaction memory", () => {
  it("evicts the oldest token when full, so a newly learned value is still scrubbed when quoted bare", async () => {
    const { traceRedactText, LEARN_MAX, learnedSize } = await import("../src/otel");
    setTraceRedactor(<T,>(v: T): T => (typeof v === "string" ? (v.replace(/(routing number )(\d{9})/g, "$1[redacted]") as T) : v));
    for (let i = 0; i < LEARN_MAX + 50; i++) traceRedactText(`routing number ${String(100000000 + i)}`);
    expect(learnedSize()).toBe(LEARN_MAX);
    const newest = String(100000000 + LEARN_MAX + 49);
    expect(traceRedactText(`unmatched: ${newest}`)).toBe("unmatched: [redacted]");
    expect(traceRedactText(`unmatched: ${String(100000000)}`)).toBe(`unmatched: ${String(100000000)}`);
    setTraceRedactor(<T,>(v: T): T => v);
  });
});
