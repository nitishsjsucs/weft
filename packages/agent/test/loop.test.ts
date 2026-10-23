import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelProvider, PrecheckResult, RoutineDef, RoutineRun, SimClock, ToolOutcome } from "@weft/contracts";
import { closeDb, migrate, openDb, type Db } from "@weft/db";
import { check, requestTrustOf, runEvidence } from "@weft/grounding";
import { CHAT_TOOLS, createAgentRuntime, createSpendLedger, defaultScriptsDir, frozenPrompt, LUNA, runLoop, scriptedProvider, summarize, type Script, type WeftAgentRuntime } from "../src/index";
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

  it("a tool-call preamble at the answer-by step is never taken as the answer", async () => {
    const fake = chatExec();
    const read = { output: [{ type: "function_call" as const, name: "payroll__get_run", arguments: { run_id: "pay_2026_10_30", flagged_only: true } }] };
    const script: Script = { match: "preamble", agents: { main: [read, read, read, { output: [{ type: "text", text: "Next I will read the raise action to confirm the change." }, read.output[0]!] }] } };
    const rt = runtimeWith(fake, scriptedProvider({ scriptsDir: dataDir, scripts: { chat_preamble: script } }));
    const h = handle();
    await rt.startChat(h, { text: "preamble: why is the NY raise flagged?", recipe: "chat", pageContext: null });
    const run = await rt.settled(h.runId);
    expect(run).toMatchObject({ status: "done", terminalReason: "DONE" });
    expect(run.summary).not.toContain("Next I will read");
  });

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

describe("chat grounding repair and receipt (wave 4 FM3)", () => {
  const headcount = () => done({ rows: [
    { department: "Engineering", headcount: 13 }, { department: "Sales", headcount: 9 }, { department: "Operations", headcount: 9 },
  ] }, "Counted 3 departments", "res_0300");
  const exec = () => createFakeExecutor([
    ...CHAT_TOOLS.map((name) => ({ name, effect: "read" as const })),
    { name: "reports.query", effect: "read" as const, handler: headcount },
    { name: "people.search", effect: "read" as const, handler: () => done({ people: [], count: 0 }, "Found 0 workers", "res_0301") },
    { name: "notices.get", effect: "read" as const, handler: () => done({ notice: { id: "ntc_0001", body: '<untrusted n="0123456789abcdef" source="notice:ntc_0001">The balance due is $4,321.00.</untrusted>' } }, "Read ntc_0001", "res_0302") },
  ]);
  const call = (name: string, args: Record<string, unknown> = {}) => ({ output: [{ type: "function_call" as const, name, arguments: args }] });
  const say = (text: string) => ({ output: [{ type: "text" as const, text }] });
  const notices = async (rt: WeftAgentRuntime, id: string) => (await rt.store.steps(id)).filter((s) => s.kind === "notice").map((s) => s.result as { notice: string; attrs: Record<string, string>; text: string });

  async function ask(fake: FakeExecutor, steps: Script["agents"]["main"], text: string, before?: (id: string) => void) {
    const rt = runtimeWith(fake, scriptedProvider({ scriptsDir: dataDir, scripts: { chat_fm3: { match: ".", agents: { main: steps } } } }));
    const h = handle();
    before?.(h.runId);
    await rt.startChat(h, { text, recipe: "chat", pageContext: null, allowlist: [...CHAT_TOOLS, "reports.query"] });
    return { rt, run: await rt.settled(h.runId), id: h.runId };
  }

  it("an ungrounded answer at the answer-by step gets the reserved repair instead of the receipt", async () => {
    const fake = exec();
    const { rt, run, id } = await ask(fake, [
      call("reports__query", { group_by: "department" }), call("people__search", { status: "active" }), call("people__search", { status: "onboarding" }),
      say("Engineering has 14 people."),
      say("Engineering has 13 people, Sales 9 and Operations 9."),
    ], "How many people are in each department?");
    expect(run).toMatchObject({ status: "done", stepsUsed: 5 });
    expect(run.summary).toBe("Engineering has 13 people, Sales 9 and Operations 9.");
    const repairs = (await notices(rt, id)).filter((n) => n.notice === "repair");
    expect(repairs).toHaveLength(1);
    expect(repairs[0]!.attrs).toMatchObject({ code: "UNGROUNDED", at: "last" });
    expect(repairs[0]!.text).toContain("This is your last step");
  });

  it("the reserved repair is separate from the early one and is used once", async () => {
    const fake = exec();
    const { rt, run, id } = await ask(fake, [
      call("reports__query", {}), say("Engineering has 14 people."), call("people__search", { status: "active" }),
      say("Engineering has 15 people."), say("Engineering has 16 people."),
    ], "How big is Engineering?");
    expect(run).toMatchObject({ status: "done", stepsUsed: 5 });
    expect((await notices(rt, id)).filter((n) => n.notice === "repair").map((n) => n.attrs.at ?? "early")).toEqual(["early", "last"]);
    expect(run.summary).not.toContain("16");
    expect(run.summary).toContain("Counted 3 departments (res_0300)");
  });

  it("after a repair, an identical re-read is served from the run and does not count toward the answer-by step", async () => {
    const fake = exec();
    const { rt, run, id } = await ask(fake, [
      call("reports__query", { group_by: "department" }), say("There are 32 people across 3 departments, 14 in Engineering."),
      call("reports__query", { group_by: "department" }), call("people__search", { status: "active" }),
      say("Engineering has 13 people, Sales 9 and Operations 9, so 31 in all."),
    ], "How many people are in each department?");
    expect(run).toMatchObject({ status: "done", stepsUsed: 5 });
    expect(run.summary).toBe("Engineering has 13 people, Sales 9 and Operations 9, so 31 in all.");
    // The executor saw the first read and the new one, never the repeat.
    expect(fake.calls.map((c) => c.command)).toEqual(["reports.query", "people.search"]);
    const steps = await rt.store.steps(id);
    const servedRow = steps.find((s) => s.kind === "tool_call" && (s.result as { servedFrom?: string }).servedFrom);
    expect((servedRow!.result as { servedFrom: string }).servedFrom).toBe("res_0300");
    expect(JSON.parse((servedRow!.result as { output: string }).output)._weft_served).toContain("not run again");
    expect(steps.some((s) => s.kind === "recite" && (s.result as { served?: boolean }).served)).toBe(true);
    // ANSWER_NOW moved from before step 4 to before step 5.
    const answerNow = steps.find((s) => s.kind === "notice" && (s.result as { attrs: { code?: string } }).attrs.code === "ANSWER_NOW")!;
    expect(steps.filter((s) => s.kind === "model_call" && s.n < answerNow.n)).toHaveLength(4);
  });

  it("the receipt leads with the draft's grounded sentences, says what it left out and passes the same checker", async () => {
    const fake = exec();
    const { rt, run, id } = await ask(fake, [
      call("reports__query", {}), say("Engineering has 13 people. Sales grew by 12 this year."), say("Engineering has 13 people. Sales grew by 11 this year."),
    ], "How are the teams doing?");
    expect(run.status).toBe("done");
    expect(run.summary!.startsWith("Engineering has 13 people.")).toBe(true);
    expect(run.summary).toContain("I left out 1 statement whose figures I could not match to a record in this run.");
    expect(run.summary).toContain("- Counted 3 departments (res_0300)");
    expect(run.summary).not.toMatch(/\b11\b/);
    const steps = await rt.store.steps(id);
    const results = steps.filter((s) => s.kind === "tool_call").map((s) => { const o = (s.result as { outcome: ToolOutcome }).outcome; return o.ok && o.status === "done" ? { resultId: o.resultId, data: o.data, summary: o.summary } : null; });
    expect(check(run.summary!, results)).toEqual({ ok: true, offending: [] });
    expect((steps.find((s) => s.stage === "terminal")!.result as { groundingFallback?: boolean }).groundingFallback).toBe(true);
  });

  it("a receipt with no draft (tool calls at the answer-by step) still leads with a readable line", async () => {
    const fake = exec();
    const { run } = await ask(fake, [call("people__search", { status: "a" }), call("people__search", { status: "b" }), call("people__search", { status: "c" }), call("people__search", { status: "d" })], "Who starts soon?");
    expect(run.summary).toMatch(/^I ran out of steps before I could finish the answer/);
    expect(run.summary).toContain("- Found 0 workers (res_0301)");
  });

  it("grounds the person's own figures and the clock's window bounds, but not in a run tainted before its first step", async () => {
    const answer = "I can't pay the $1,500.00 bonus myself. No one starts between October 26 and November 9, 2026.";
    const steps = [call("people__search", {}), say(answer), say("I can't pay the bonus myself.")];
    const request = "Pay Jordan a $1,500.00 bonus, and who starts in the next two weeks?";
    const clean = await ask(exec(), steps, request);
    expect(clean.run).toMatchObject({ status: "done", summary: answer, stepsUsed: 2 });
    const fake = exec();
    const tainted = await ask(fake, steps, request, (runId) => fake.taint(runId, "chat:msg_0001"));
    expect(tainted.run).toMatchObject({ status: "done", summary: "I can't pay the bonus myself.", stepsUsed: 3 });
    expect((await notices(tainted.rt, tainted.id)).find((n) => n.notice === "repair")!.text).toContain("$1,500.00");
  });

  it("still refuses a figure that only an untrusted leaf holds", async () => {
    const { rt, run, id } = await ask(exec(), [call("notices__get", { notice_id: "ntc_0001" }), say("The balance due is $4,321.00."), say("The notice states a balance; open ntc_0001 to read it.")], "What does the notice say?");
    expect(run.summary).toBe("The notice states a balance; open ntc_0001 to read it.");
    expect((await notices(rt, id)).find((n) => n.notice === "repair")!.text).toContain("$4,321.00");
  });
});

describe("shared grounding evidence, month day ranges and request-only windows (round 2, FG4)", () => {
  const EN_DASH = "\u2013";
  const timeOff = () => done({ count: 1, requests: [{ id: "tor_0003", worker_id: "wrk_0010", status: "pending", start_date: "2026-11-23", end_date: "2026-11-27", conflict: { dates: ["2026-11-23", "2026-11-25"], out: 3, of: 9 } }] }, "Found 1 time-off request", "res_0003");
  const exec = () => createFakeExecutor([
    ...CHAT_TOOLS.map((name) => ({ name, effect: "read" as const })),
    { name: "time_off.list_requests", effect: "read" as const, handler: timeOff },
    { name: "people.search", effect: "read" as const, handler: () => done({ people: [], count: 0 }, "Found 0 workers", "res_0301") },
  ]);
  const call = (name: string, args: Record<string, unknown> = {}) => ({ output: [{ type: "function_call" as const, name, arguments: args }] });
  const say = (text: string) => ({ output: [{ type: "text" as const, text }] });
  const repairs = async (rt: WeftAgentRuntime, id: string) => (await rt.store.steps(id)).filter((s) => s.kind === "notice" && (s.result as { notice: string }).notice === "repair").map((s) => (s.result as { text: string }).text);

  async function ask(fake: FakeExecutor, steps: Script["agents"]["main"], text: string, provider?: (p: ModelProvider) => ModelProvider) {
    const scripted = scriptedProvider({ scriptsDir: dataDir, scripts: { chat_fg4: { match: ".", agents: { main: steps } } } });
    const rt = runtimeWith(fake, provider ? provider(scripted) : scripted);
    const h = handle();
    await rt.startChat(h, { text, recipe: "chat", pageContext: null, allowlist: [...CHAT_TOOLS, "time_off.list_requests"] });
    return { rt, run: await rt.settled(h.runId), id: h.runId, h };
  }

  it("R8, CP-04 shape: a draft with month day ranges is grounded first time, so it keeps its dates", async () => {
    const draft = `I can't approve time-off requests. Ruth Okoro's pending request is tor_0003, for November 23${EN_DASH}27, 2026, with 3 of 9 out on November 23${EN_DASH}25.`;
    const { rt, run, id } = await ask(exec(), [call("time_off__list_requests", { worker_id: "wrk_0010", status: "pending" }), say(draft), say("Open the request in the inbox.")], "Approve Ruth Okoro's time-off request.");
    expect(run).toMatchObject({ status: "done", summary: draft, stepsUsed: 2 });
    expect(await repairs(rt, id)).toEqual([]);
  });

  it("R1: the guard's verdict is the helper's verdict over the run's own rows (FG1's G5 reads the same rows)", async () => {
    const draft = "Ruth Okoro is off November 23 to 28. I can't pay the $1,500.00 bonus.";
    const { rt, run, id } = await ask(exec(), [call("time_off__list_requests", {}), say(draft), say("Ruth Okoro is off November 23 to 27. I can't pay the $1,500.00 bonus.")], "Pay Ruth a $1,500.00 bonus and tell me when she is off.");
    const rows = await rt.store.steps(id);
    const ev = runEvidence(rows);
    expect(ev.opts.request).toBe("Pay Ruth a $1,500.00 bonus and tell me when she is off.");
    expect(ev.opts.now).toBe(clock.now());
    // The repair the guard sent names exactly what the helper's evidence refuses; the answer it accepted passes it.
    expect(check(draft, ev.results, ev.opts)).toEqual({ ok: false, offending: ["November 23 to 28"] });
    expect(await repairs(rt, id)).toEqual([expect.stringContaining(": November 23 to 28.")]);
    expect(run).toMatchObject({ status: "done", summary: "Ruth Okoro is off November 23 to 27. I can't pay the $1,500.00 bonus." });
    expect(check(run.summary!, ev.results, ev.opts)).toEqual({ ok: true, offending: [] });
    // The pack row comes first and is an assemble row too; the decision is on the next one.
    expect(rows[0]).toMatchObject({ stage: "assemble", kind: "context" });
    expect(requestTrustOf(rows)).toBe(true);
  });

  it("RC1 decision: the answer's own relative phrase derives no window bound; the request's does", async () => {
    const answer = "Nobody else is out next week, November 2 to 8.";
    const own = await ask(exec(), [call("people__search", {}), say(answer), say("Nobody else is out.")], "Is anyone else out?");
    expect(own.run).toMatchObject({ status: "done", summary: "Nobody else is out." });
    expect(await repairs(own.rt, own.id)).toEqual([expect.stringContaining(": November 2 to 8.")]);
    const asked = await ask(exec(), [call("people__search", {}), say(answer)], "Is anyone else out next week?");
    expect(asked.run).toMatchObject({ status: "done", summary: answer, stepsUsed: 2 });
  });

  it("a resumed chat segment keeps the stored request trust (the pack row is not the decision)", async () => {
    // Segment 1 runs the read, then its second model step throws; segment 2 resumes the same rows on the script.
    let calls = 0;
    const flaky = (p: ModelProvider): ModelProvider => ({ ...p, step: async (r) => { calls++; if (calls === 2) throw new Error("connection reset"); return p.step(r); } });
    const answer = "I can't pay the $1,500.00 bonus myself; nobody starts between October 26 and November 9, 2026.";
    const steps = [call("people__search", {}), say(answer), say("I can't pay the bonus myself.")];
    const fake = exec();
    const first = await ask(fake, steps, "Pay Jordan a $1,500.00 bonus, and who starts in the next two weeks?", flaky);
    expect(first.run.status).not.toBe("done");
    await first.rt.store.updateRun(first.id, { status: "queued", terminalReason: null, endedAt: null });
    const resumed = await runLoop({
      store: first.rt.store, executor: fake, provider: scriptedProvider({ scriptsDir: dataDir, scripts: { chat_fg4: { match: ".", agents: { main: steps } } } }),
      ledger: createSpendLedger({ dir: join(dataDir, "spend2"), caps: { runUsd: 0.1, dayUsd: 2, liveUsd: 0.5 } }), clock, prices: LUNA,
      checklist: async () => null, isCancelled: () => false, signalFor: () => undefined, modelTimeoutMs: 10_000,
    }, first.h);
    expect(resumed).toMatchObject({ status: "done", summary: answer });
    expect(await repairs(first.rt, first.id)).toEqual([]);
    // Every assemble row of both segments records the same decision (segment 2 once wrote false here).
    const decisions = (await first.rt.store.steps(first.id)).flatMap((s) => {
      const v = s.stage === "assemble" && s.kind === "context" ? (s.result as { requestTrusted?: unknown } | null)?.requestTrusted : undefined;
      return v === undefined ? [] : [v];
    });
    expect(decisions.length).toBeGreaterThan(2);
    expect(decisions.every((v) => v === true)).toBe(true);
  });
});

describe("default scenarios in scenarios/", () => {
  it("rt_agency_notice.json drives the GP1 batch to waiting with 2 proposals", async () => {
    const fake = noticeExecutor();
    const rt = runtimeWith(fake, scriptedProvider({ scriptsDir: defaultScriptsDir() }));
    const h = handle();
    await rt.startRoutineRun(h, { routine, routineRun, trigger, precheck });
    expect(await rt.settled(h.runId)).toMatchObject({ status: "waiting", stepsUsed: 2 });
    expect(fake.proposals.map((p) => p.command)).toEqual(["tax.update_rate", "notices.send_response"]);
  });

  it("chat_approve_all.json declines with no tool call and a grounded answer", async () => {
    const fake = createFakeExecutor(CHAT_TOOLS.map((name) => ({ name, effect: "read" as const })));
    const rt = runtimeWith(fake, scriptedProvider({ scriptsDir: defaultScriptsDir() }));
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

  it("a routine on a local model whose server is down also finishes on the templates", async () => {
    const fake = noticeExecutor();
    const local: ModelProvider = { ...down, id: "openai_compat", model: "local", label: "local", live: false,
      step: async () => ({ ...(await down.step({} as never)), error: { code: "PROVIDER_UNAVAILABLE", message: "connection refused", retryable: true } }) };
    const rt = runtimeWith(fake, local);
    const h = handle();
    await rt.startRoutineRun(h, { routine, routineRun, trigger, precheck });
    expect(await rt.settled(h.runId)).toMatchObject({ status: "waiting", model: "template" });
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

  it("the loop's step timer is a retryable PROVIDER_TIMEOUT, not a cancellation", async () => {
    const fake = noticeExecutor();
    let calls = 0;
    const slow: ModelProvider = {
      id: "openai_compat", model: "local", label: "local", live: false,
      step: (r) => new Promise((resolve) => { calls++; r.signal?.addEventListener("abort", () => resolve({ stop: "error", text: "", toolCalls: [], native: [], usage: { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 }, servedBy: "local", requestId: null, error: { code: "PROVIDER_TIMEOUT", message: "the step was cancelled", retryable: false } })); }),
    };
    const ledger = createSpendLedger({ dir: join(dataDir, "spend"), caps: { runUsd: 0.1, dayUsd: 2, liveUsd: 0.5 } });
    const rt = createAgentRuntime({ db, clock, executor: fake, provider: slow, ledger, modelTimeoutMs: 50, routinesView: { get: async () => routine, checklist: checklistFor(fake) } });
    const h = handle();
    await rt.startRoutineRun(h, { routine, routineRun, trigger, precheck });
    const run = await rt.settled(h.runId);
    // Retried as a timeout (more than one call), then PROVIDER_DOWN hands the routine to the templates.
    expect(calls).toBeGreaterThan(1);
    expect(run).toMatchObject({ status: "waiting", model: "template" });
  });

  it("boot rule: a run still queued from the previous process fails with PROCESS_RESTART instead of sitting queued", async () => {
    const fake = noticeExecutor();
    const rt = runtimeWith(fake, scriptedProvider({ scriptsDir: dataDir, scripts: {} }));
    const h = handle();
    await rt.store.createRun({
      id: h.runId, companyId: "cmp_larkspur", kind: "main", parentRunId: null, threadId: null, routineRunId: null, trigger: "chat", attended: true, provider: "scripted",
      model: "scripted", effort: "low", cacheKey: "weft:main:chat:cmp_larkspur", status: "queued", terminalReason: null, tainted: false, taintedBy: null, checklist: null,
      budget: { steps: 12, usd: 0.1, minutes: 10 }, stepsUsed: 0, requeues: 0, consecutiveErrors: 0, costUsdMicros: 0, tokens: { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 },
      createdAt: clock.now(), endedAt: null, summary: null,
    });
    await rt.boot();
    expect(await rt.store.getRun(h.runId)).toMatchObject({ status: "failed", terminalReason: "PROCESS_RESTART", summary: "The process restarted before this run started. Run it again." });
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
