import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelProvider, PrecheckResult, RoutineDef, RoutineRun, SimClock, ToolOutcome } from "@weft/contracts";
import { closeDb, migrate, openDb, type Db } from "@weft/db";
import { CHAT_TOOLS, createAgentRuntime, createSpendLedger, DEFAULT_SCRIPTS_DIR, frozenPrompt, scriptedProvider, summarize, type Script, type WeftAgentRuntime } from "../src/index";
import { createFakeExecutor, type FakeExecutor } from "./fake-executor";

const clock: SimClock = { now: () => "2026-10-26T16:00:00.000Z", rate: () => 0, advance: async () => undefined, set: async () => undefined };
let dataDir: string;
let db: Db;
let n = 0;
const handle = () => ({ runId: `run_${String(++n).padStart(4, "0")}`, token: "tok" });

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "weft-loop-"));
  db = openDb({ dataDir });
  await migrate(db);
});
afterEach(async () => {
  await closeDb(db);
  rmSync(dataDir, { recursive: true, force: true });
});

const done = (data: unknown, summary: string, id = "res_0100"): ToolOutcome => ({ ok: true, status: "done", resultId: id, data, summary, actionSeq: null, artifactRef: null, tainted: false, label: "synthetic" });

function noticeExecutor(): FakeExecutor {
  return createFakeExecutor([
    { name: "notices.get", effect: "read", handler: () => done({ notice_id: "ntc_0001", rate_new: "0.015" }, "Read CA_EDD_DE2088_2026.txt") },
    { name: "tax.get_rates", effect: "read" },
    { name: "tax.rate_change_impact", effect: "read" },
    { name: "tax.update_rate", effect: "write", gated: true },
    { name: "notices.draft_response", effect: "draft" },
    { name: "notices.send_response", effect: "external", gated: true },
  ]);
}

const routine: RoutineDef = {
  id: "rt_agency_notice", name: "Agency notice handling", description: "d", ownerPrincipalId: "usr_0001", enabled: true, autonomy: "approve",
  trigger: { type: "event", event: "notice.received" }, filter: null, instructions: "Handle the notice.",
  tools: ["notices.get", "tax.get_rates", "tax.rate_change_impact", "tax.update_rate", "notices.draft_response", "notices.send_response"],
  precheck: "agency_notice", budget: { steps: 6, usd: 0.1, minutes: 10 }, surface: { worthSurfacing: true, channel: null }, source: "prebuilt", taintedBy: null,
  checklist: [
    { id: "draft", label: "draft reply", check: "draft_exists:{notice_id}" },
    { id: "rate", label: "propose tax.update_rate", check: "proposal_exists:tax.update_rate:{notice_id}" },
    { id: "send", label: "propose notices.send_response", check: "proposal_exists:notices.send_response:{notice_id}" },
  ],
};
const routineRun: RoutineRun = { id: "rtr_0001", routineId: routine.id, runKey: "k", triggerRef: "evt_0001", status: "running", agentRunId: null, precheck: null, summary: null, leftForHuman: [], surfaceHash: null, overdue: false, attended: true, startedAt: null, endedAt: null, costUsdMicros: 0 };
const precheck: PrecheckResult = { action: "run", severity: "interrupt", subjectRefs: ["ntc_0001"], findings: { agency: "ca_edd" }, derivedArgs: { "tax.update_rate": { account_id: "txa_0003", rate: "0.015", effective_date: "2026-01-01", source_notice_id: "ntc_0001" } } };
const trigger = { id: "evt_0001", type: "notice.received", ts: "2026-10-26T16:00:00.000Z", subjectRef: "ntc_0001", payload: { notice_id: "ntc_0001" }, attended: true, requestedBy: "usr_0001" };

const S1: Script = {
  agents: {
    main: [
      { output: [
        { type: "function_call", name: "notices__draft_response", arguments: { notice_id: "{{trigger.notice_id}}", note: "We will apply the new rate." } },
        { type: "function_call", name: "tax__update_rate", arguments: "{{derived.tax.update_rate}}" },
        { type: "function_call", name: "notices__send_response", arguments: { notice_id: "{{trigger.notice_id}}" } },
      ] },
      { expect: { lastResults: [{ tool: "notices__draft_response", status: "done" }, { tool: "tax__update_rate", status: "pending_approval" }, { tool: "notices__send_response", status: "pending_approval" }] },
        output: [{ type: "text", text: "Proposed the rate change and the reply; both wait for approval." }] },
    ],
  },
};

function checklistFor(fake: FakeExecutor) {
  return async ({ agentRunId }: { agentRunId: string }) => {
    const has = (cmd: string) => fake.proposals.some((p) => p.runId === agentRunId && p.command === cmd && p.status !== "denied");
    return [
      { id: "draft", label: "draft reply", passed: fake.calls.some((c) => c.runId === agentRunId && c.command === "notices.draft_response") },
      { id: "rate", label: "propose tax.update_rate", passed: has("tax.update_rate") },
      { id: "send", label: "propose notices.send_response", passed: has("notices.send_response") },
    ];
  };
}

function runtimeWith(fake: FakeExecutor, provider: ModelProvider, extra: { liveUsd?: number } = {}): WeftAgentRuntime {
  const ledger = createSpendLedger({ dir: join(dataDir, "spend"), caps: { runUsd: 0.1, dayUsd: 2, liveUsd: extra.liveUsd ?? 0.5 } });
  return createAgentRuntime({ db, clock, executor: fake, provider, ledger, routinesView: { get: async () => routine, checklist: checklistFor(fake) } });
}

describe("runLoop on a routine (GP1 shape)", () => {
  it("one batch gives 2 proposals and waiting; both approvals end done with zero additional model steps", async () => {
    const fake = noticeExecutor();
    const rt = runtimeWith(fake, scriptedProvider({ scriptsDir: dataDir, scripts: { rt_agency_notice: S1 } }));
    const h = handle();
    await rt.startRoutineRun(h, { routine, routineRun, trigger, precheck });
    let run = await rt.settled(h.runId);
    expect(run.status).toBe("waiting");
    expect(run.terminalReason).toBe("WAITING_APPROVAL");
    expect(run.stepsUsed).toBe(2);
    expect(fake.proposals.map((p) => p.command)).toEqual(["tax.update_rate", "notices.send_response"]);
    expect(fake.calls.find((c) => c.command === "tax.update_rate")?.args).toEqual(precheck.derivedArgs!["tax.update_rate"]);

    const steps = await rt.store.steps(h.runId);
    expect(new Set(steps.map((s) => s.stage))).toEqual(new Set(["assemble", "admission", "model", "dispatch", "post", "terminal"]));
    const tools = steps.filter((s) => s.kind === "tool_call");
    expect(tools).toHaveLength(3);
    const outputs = tools.map((t) => JSON.parse((t.result as { output: string }).output) as Record<string, unknown>);
    expect(outputs.slice(0, 2).every((o) => !("_weft_plan" in o))).toBe(true);
    expect(outputs[2]!._weft_plan).toBe("[x] draft reply  [x] propose tax.update_rate  [x] propose notices.send_response | steps 1/6 | $0.0000");
    expect(steps.filter((s) => s.kind === "model_call").every((s) => s.prefixHash && s.timings && s.usage)).toBe(true);

    fake.settleProposal(fake.proposals[0]!.id, true);
    expect(await rt.wake(h.runId, { kind: "decision", attrs: { proposal_id: fake.proposals[0]!.id, status: "executed" }, text: "approved" })).toBe("waiting");
    fake.settleProposal(fake.proposals[1]!.id, true);
    expect(await rt.wake(h.runId, { kind: "decision", attrs: { proposal_id: fake.proposals[1]!.id, status: "executed" }, text: "approved" })).toBe("done");
    run = (await rt.store.getRun(h.runId))!;
    expect(run.status).toBe("done");
    expect(run.stepsUsed).toBe(2);
    expect((await rt.store.steps(h.runId)).filter((s) => s.kind === "model_call")).toHaveLength(2);
  });

  it("the trace shows stage rows with timings, tokens, cache-hit ratio and USD", async () => {
    const fake = noticeExecutor();
    const rt = runtimeWith(fake, scriptedProvider({ scriptsDir: dataDir, scripts: { rt_agency_notice: S1 } }));
    const h = handle();
    await rt.startRoutineRun(h, { routine, routineRun, trigger, precheck });
    await rt.settled(h.runId);
    const trace = await rt.trace(h.runId);
    const s = summarize(trace.steps);
    expect(s.modelCalls).toBe(2);
    expect(s.toolCalls).toBe(3);
    expect(s.tokens.input).toBeGreaterThan(0);
    expect(s.cacheHitRatio).toBeGreaterThan(0);
    expect(s.usd).toBe(0);
    expect(s.prefixHashes).toHaveLength(1);
    expect(s.stages.find((x) => x.kind === "tool_call")?.label).toBe("Ran notices.draft_response");
  });

  it("a failing checklist gets one NOT_DONE notice, then escalates", async () => {
    const fake = noticeExecutor();
    const script: Script = { agents: { main: [{ output: [{ type: "text", text: "Nothing to do." }] }, { output: [{ type: "text", text: "Still nothing." }] }] } };
    const rt = runtimeWith(fake, scriptedProvider({ scriptsDir: dataDir, scripts: { rt_agency_notice: script } }));
    const h = handle();
    await rt.startRoutineRun(h, { routine, routineRun, trigger, precheck });
    const run = await rt.settled(h.runId);
    expect(run).toMatchObject({ status: "escalated", terminalReason: "NOT_DONE", stepsUsed: 2 });
    const notices = (await rt.store.steps(h.runId)).filter((s) => s.kind === "notice");
    expect(notices).toHaveLength(1);
    expect((notices[0]!.result as { text: string }).text).toContain("propose tax.update_rate");
  });

  it("stopping rule 4: the step budget escalates with BUDGET_EXCEEDED", async () => {
    const fake = noticeExecutor();
    const step = { output: [{ type: "function_call" as const, name: "notices__get", arguments: { notice_id: "ntc_0001" } }] };
    const rt = runtimeWith(fake, scriptedProvider({ scriptsDir: dataDir, scripts: { rt_agency_notice: { agents: { main: Array.from({ length: 8 }, () => step) } } } }));
    const h = handle();
    await rt.startRoutineRun(h, { routine, routineRun, trigger, precheck });
    expect(await rt.settled(h.runId)).toMatchObject({ status: "escalated", terminalReason: "BUDGET_EXCEEDED", stepsUsed: 6 });
  });

  it("stopping rule 3: incomplete twice fails with MODEL_INCOMPLETE and runs no tool", async () => {
    const fake = noticeExecutor();
    const rt = runtimeWith(fake, scriptedProvider({ scriptsDir: dataDir, scripts: { rt_agency_notice: { agents: { main: [{ output: [{ type: "function_call", name: "notices__get", arguments: {} }], stop: "incomplete" }] } } } }));
    const h = handle();
    await rt.startRoutineRun(h, { routine, routineRun, trigger, precheck });
    expect(await rt.settled(h.runId)).toMatchObject({ status: "failed", terminalReason: "MODEL_INCOMPLETE" });
    expect(fake.calls).toHaveLength(0);
    const attempts = (await rt.store.steps(h.runId)).filter((s) => s.kind === "model_call").map((s) => s.attempt);
    expect(attempts).toEqual([1, 2]);
  });

  it("stopping rule 2: a refusal ends refused with the text shown", async () => {
    const fake = noticeExecutor();
    const rt = runtimeWith(fake, scriptedProvider({ scriptsDir: dataDir, scripts: { rt_agency_notice: { agents: { main: [{ output: [{ type: "text", text: "I can't help with that." }], stop: "refusal" }] } } } }));
    const h = handle();
    await rt.startRoutineRun(h, { routine, routineRun, trigger, precheck });
    expect(await rt.settled(h.runId)).toMatchObject({ status: "refused", terminalReason: "REFUSED", summary: "I can't help with that." });
  });

  it("stopping rule 5: 3 failures of the same tool escalate with REPEATED_ERRORS", async () => {
    const fake = noticeExecutor();
    const bad = { output: [{ type: "function_call" as const, name: "nope__missing", arguments: {} }] };
    const rt = runtimeWith(fake, scriptedProvider({ scriptsDir: dataDir, scripts: { rt_agency_notice: { agents: { main: [bad, bad, bad, bad] } } } }));
    const h = handle();
    await rt.startRoutineRun(h, { routine, routineRun, trigger, precheck });
    expect(await rt.settled(h.runId)).toMatchObject({ status: "escalated", terminalReason: "REPEATED_ERRORS", stepsUsed: 3 });
  });

  it("the live cap refuses admission with BUDGET_EXCEEDED before any model call", async () => {
    const fake = noticeExecutor();
    const inner = scriptedProvider({ scriptsDir: dataDir, scripts: { rt_agency_notice: S1 } });
    let calls = 0;
    const live: ModelProvider = { ...inner, id: "openai", model: "gpt-5.6-luna", live: true, step: async (r) => { calls++; return inner.step(r); } };
    const rt = runtimeWith(fake, live, { liveUsd: 0.001 });
    const h = handle();
    await rt.startRoutineRun(h, { routine, routineRun, trigger, precheck });
    expect(await rt.settled(h.runId)).toMatchObject({ status: "escalated", terminalReason: "BUDGET_EXCEEDED" });
    expect(calls).toBe(0);
    const adm = (await rt.store.steps(h.runId)).find((s) => s.stage === "admission");
    expect(adm?.result).toMatchObject({ cap: "live" });
  });

  it("a live Claude provider gets model calls through admission, reserving its real 16,000-token max_tokens", async () => {
    const fake = noticeExecutor();
    const inner = scriptedProvider({ scriptsDir: dataDir, scripts: { rt_agency_notice: S1 } });
    let calls = 0;
    const claude: ModelProvider = { ...inner, id: "claude", model: "claude-opus-5-5", live: true, outputTokensFor: (n) => Math.max(n, 16_000), step: async (r) => { calls++; return inner.step(r); } };
    const rt = runtimeWith(fake, claude, { liveUsd: 5 });
    const h = handle();
    await rt.startRoutineRun(h, { routine, routineRun, trigger, precheck });
    await rt.settled(h.runId);
    expect(calls).toBeGreaterThan(0);
    const adm = (await rt.store.steps(h.runId)).find((s) => s.stage === "admission" && s.outcome === "ok");
    // 16,000 output tokens at $20 per million is 320,000 micro dollars before any input.
    expect((adm?.result as { reserveMicros: number }).reserveMicros).toBeGreaterThan(320_000);
  });
});

describe("runLoop on chat", () => {
  const chatExec = () => createFakeExecutor([
    ...CHAT_TOOLS.map((name) => ({ name, effect: "read" as const })),
    { name: "payroll.get_run", effect: "read" as const, handler: () => done({ flagged: [{ worker: "Rowan Achebe (demo) (wrk_0014)", rule: "GROSS_CHANGE", before_cents: 400000, after_cents: 432000, action_seq: 41, result_id: "res_0041" }] }, "Read pay_2026_10_30 flagged rows", "res_0200") },
  ]);

  it("chat sees exactly the 14 read tools and an ungrounded answer gets one repair, then a grounded answer is done", async () => {
    const fake = chatExec();
    let seen: string[] = [];
    const orig = fake.registry.toolSpecs.bind(fake.registry);
    fake.registry.toolSpecs = (i) => { seen = i.allowlist; return orig(i); };
    const script: Script = { match: "NY raise", agents: { main: [
      { output: [{ type: "function_call", name: "payroll__get_run", arguments: { run_id: "pay_2026_10_30", flagged_only: true } }] },
      { output: [{ type: "text", text: "Gross pay rose to $4,400.00 for Rowan." }] },
      { output: [{ type: "text", text: "Gross pay for Rowan Achebe (demo) (wrk_0014) rose from $4,000.00 to $4,320.00 after the raise applied as action 41 (res_0041)." }] },
    ] } };
    const rt = runtimeWith(fake, scriptedProvider({ scriptsDir: dataDir, scripts: { chat_ny: script } }));
    const h = handle();
    await rt.startChat(h, { text: "Why is the NY raise flagged?", recipe: "chat", pageContext: null });
    const run = await rt.settled(h.runId);
    expect(seen).toEqual([...CHAT_TOOLS]);
    expect(seen).toHaveLength(14);
    expect(run.status).toBe("done");
    expect(run.summary).toContain("res_0041");
    expect(run.cacheKey).toBe("weft:main:chat:cmp_larkspur");
    const notices = (await rt.store.steps(h.runId)).filter((s) => s.kind === "notice");
    expect(notices).toHaveLength(1);
    expect((notices[0]!.result as { text: string }).text).toContain("$4,400.00");
  });

  it("two ungrounded answers are replaced by a grounded template of the cited results", async () => {
    const fake = chatExec();
    const script: Script = { match: "NY raise", agents: { main: [
      { output: [{ type: "function_call", name: "payroll__get_run", arguments: {} }] },
      { output: [{ type: "text", text: "It is $9,999.00." }] },
      { output: [{ type: "text", text: "It is $8,888.00." }] },
    ] } };
    const rt = runtimeWith(fake, scriptedProvider({ scriptsDir: dataDir, scripts: { chat_ny: script } }));
    const h = handle();
    await rt.startChat(h, { text: "Why is the NY raise flagged?", recipe: "chat", pageContext: null });
    const run = await rt.settled(h.runId);
    expect(run.status).toBe("done");
    expect(run.summary).toContain("Read pay_2026_10_30 flagged rows (res_0200)");
    expect(run.summary).not.toContain("8,888");
  });
});

describe("default scenarios in scenarios/", () => {
  it("rt_agency_notice.json drives the GP1 batch to waiting with 2 proposals", async () => {
    const fake = noticeExecutor();
    const rt = runtimeWith(fake, scriptedProvider({ scriptsDir: DEFAULT_SCRIPTS_DIR }));
    const h = handle();
    await rt.startRoutineRun(h, { routine, routineRun, trigger, precheck });
    expect(await rt.settled(h.runId)).toMatchObject({ status: "waiting", stepsUsed: 2 });
    expect(fake.proposals.map((p) => p.command)).toEqual(["tax.update_rate", "notices.send_response"]);
  });

  it("chat_approve_all.json declines with no tool call and a grounded answer", async () => {
    const fake = createFakeExecutor(CHAT_TOOLS.map((name) => ({ name, effect: "read" as const })));
    const rt = runtimeWith(fake, scriptedProvider({ scriptsDir: DEFAULT_SCRIPTS_DIR }));
    const h = handle();
    await rt.startChat(h, { text: "Approve everything in my inbox", recipe: "chat", pageContext: null });
    const run = await rt.settled(h.runId);
    expect(run.status).toBe("done");
    expect(run.summary).toMatch(/can't approve/);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("template fallback (SPEC 9.6)", () => {
  const down: ModelProvider = {
    id: "openai", model: "gpt-5.6-luna", label: "OpenAI gpt-5.6-luna", live: true,
    step: async () => ({ stop: "error", text: "", toolCalls: [], native: [], usage: { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 }, servedBy: "gpt-5.6-luna", requestId: null, error: { code: "PROVIDER_CONFIG", message: "401", retryable: false } }),
  };

  it("a routine whose live model fails finishes on the deterministic templates", async () => {
    const fake = noticeExecutor();
    const rt = runtimeWith(fake, down);
    const h = handle();
    await rt.startRoutineRun(h, { routine, routineRun, trigger, precheck });
    const run = await rt.settled(h.runId);
    expect(run).toMatchObject({ status: "waiting", model: "template", provider: "scripted" });
    expect(fake.proposals.map((p) => p.command)).toEqual(["tax.update_rate", "notices.send_response"]);
  });

  it("an unattended routine under a live provider runs on templates from the start", async () => {
    const fake = noticeExecutor();
    let liveCalls = 0;
    const rt = runtimeWith(fake, { ...down, step: async (r) => { liveCalls++; return down.step(r); } });
    const h = handle();
    await rt.startRoutineRun(h, { routine, routineRun: { ...routineRun, attended: false }, trigger, precheck });
    expect(await rt.settled(h.runId)).toMatchObject({ status: "waiting", model: "template" });
    expect(liveCalls).toBe(0);
  });
});

describe("runtime rules", () => {
  it("boot rule: a running run at start fails with PROCESS_RESTART", async () => {
    const fake = noticeExecutor();
    const rt = runtimeWith(fake, scriptedProvider({ scriptsDir: dataDir, scripts: {} }));
    const h = handle();
    await rt.store.createRun({
      id: h.runId, companyId: "cmp_larkspur", kind: "main", parentRunId: null, threadId: null, routineRunId: null, trigger: "chat", attended: true, provider: "scripted",
      model: "scripted", effort: "low", cacheKey: "weft:main:chat:cmp_larkspur", status: "running", terminalReason: null, tainted: false, taintedBy: null, checklist: null,
      budget: { steps: 12, usd: 0.1, minutes: 10 }, stepsUsed: 1, requeues: 0, consecutiveErrors: 0, costUsdMicros: 0, tokens: { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 },
      createdAt: clock.now(), endedAt: null, summary: null,
    });
    await rt.boot();
    expect(await rt.store.getRun(h.runId)).toMatchObject({ status: "failed", terminalReason: "PROCESS_RESTART" });
  });

  it("requeues are capped at 2; a third wake escalates", async () => {
    const fake = noticeExecutor();
    const script: Script = { agents: { main: [
      { output: [{ type: "function_call", name: "tax__update_rate", arguments: "{{derived.tax.update_rate}}" }, { type: "function_call", name: "notices__draft_response", arguments: {} }, { type: "function_call", name: "notices__send_response", arguments: {} }] },
      { output: [{ type: "text", text: "Waiting." }] },
      { output: [{ type: "function_call", name: "tax__update_rate", arguments: "{{derived.tax.update_rate}}" }] },
      { output: [{ type: "text", text: "Waiting again." }] },
      { output: [{ type: "function_call", name: "tax__update_rate", arguments: "{{derived.tax.update_rate}}" }] },
      { output: [{ type: "text", text: "Waiting again." }] },
    ] } };
    const rt = runtimeWith(fake, scriptedProvider({ scriptsDir: dataDir, scripts: { rt_agency_notice: script } }));
    const h = handle();
    await rt.startRoutineRun(h, { routine, routineRun, trigger, precheck });
    expect((await rt.settled(h.runId)).status).toBe("waiting");
    for (let i = 0; i < 2; i++) {
      for (const p of fake.proposals.filter((x) => x.command === "tax.update_rate" && x.status === "pending")) fake.settleProposal(p.id, false);
      expect(await rt.wake(h.runId, { kind: "decision", attrs: { status: "denied" }, text: "denied" })).toBe("requeued");
      expect((await rt.settled(h.runId)).status).toBe("waiting");
    }
    for (const p of fake.proposals.filter((x) => x.command === "tax.update_rate" && x.status === "pending")) fake.settleProposal(p.id, false);
    expect(await rt.wake(h.runId, { kind: "decision", attrs: { status: "denied" }, text: "denied" })).toBe("escalated");
  });
});

describe("prompts", () => {
  it("every frozen prompt holds at least 1,024 tokens of content and no dates, nonces or dashes", () => {
    for (const kind of ["chat", "routine", "routine_draft"] as const) {
      const p = frozenPrompt(kind);
      expect(p.length / 4.2, kind).toBeGreaterThan(1024);
      expect(p).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(p).not.toMatch(new RegExp(String.fromCharCode(91, 0x2013, 0x2014, 93)));
      expect(frozenPrompt(kind)).toBe(p);
    }
  });
});
