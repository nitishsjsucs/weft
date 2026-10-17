// Restart survival (owner: w2-reliability, gate report item 2), and at the end the chat answer-by cap and the
// read-only chat tool list (gate report item 3), which live here because this is the track's one agent test file. Two runtimes on one database stand for the API before
// and after a restart. A waiting routine run keeps its handle (through the RunHandleStore) and its trigger (from the
// context step), so the next decision evaluates the real checklist and the run ends done with no extra model step.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelProvider, ModelStepRequest, ModelStepResult, PrecheckResult, RoutineDef, RoutineRun, RunHandle, SimClock, ToolOutcome } from "@weft/contracts";
import { closeDb, migrate, openDb, type Db } from "@weft/db";
import { CHAT_TOOLS, createAgentRuntime, createSpendLedger, scriptedProvider, type Script, type WeftAgentRuntime } from "../src/index";
import { CHAT_ANSWER_BY } from "../src/loop";
import type { RunHandleStore } from "../src/runtime";
import { createFakeExecutor, type FakeExecutor } from "./fake-executor";

const clock: SimClock = { now: () => "2026-10-26T16:00:00.000Z", rate: () => 0, advance: async () => undefined, set: async () => undefined };
let dataDir: string;
let db: Db;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "weft-restart-"));
  db = openDb({ dataDir });
  await migrate(db);
});
afterEach(async () => {
  await closeDb(db);
  rmSync(dataDir, { recursive: true, force: true });
});

const done = (data: unknown, summary: string): ToolOutcome => ({ ok: true, status: "done", resultId: "res_0100", data, summary, actionSeq: null, artifactRef: null, tainted: false, label: "synthetic" });

const routine: RoutineDef = {
  id: "rt_agency_notice", name: "Agency notice handling", description: "d", ownerPrincipalId: "usr_0001", enabled: true, autonomy: "approve",
  trigger: { type: "event", event: "notice.received" }, filter: null, instructions: "Handle the notice.",
  tools: ["notices.get", "tax.update_rate", "notices.draft_response", "notices.send_response"],
  precheck: "agency_notice", budget: { steps: 6, usd: 0.1, minutes: 10 }, surface: { worthSurfacing: true, channel: null }, source: "prebuilt", taintedBy: null,
  checklist: [
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
        { type: "function_call", name: "tax__update_rate", arguments: "{{derived.tax.update_rate}}" },
        { type: "function_call", name: "notices__send_response", arguments: { notice_id: "{{trigger.notice_id}}" } },
      ] },
      { output: [{ type: "text", text: "Proposed the rate change and the reply; both wait for approval." }] },
    ],
  },
};

function noticeExecutor(): FakeExecutor {
  return createFakeExecutor([
    { name: "notices.get", effect: "read", handler: () => done({ notice_id: "ntc_0001" }, "Read the notice") },
    { name: "tax.update_rate", effect: "write", gated: true },
    { name: "notices.draft_response", effect: "draft" },
    { name: "notices.send_response", effect: "external", gated: true },
  ]);
}

/** A persisted handle store shared by both "processes" (the API's is a 0600 file per run). */
function sharedHandles(): RunHandleStore & { saved: Map<string, RunHandle> } {
  const saved = new Map<string, RunHandle>();
  return {
    saved,
    save: async (h) => { saved.set(h.runId, JSON.parse(JSON.stringify(h)) as RunHandle); },
    load: async (id) => saved.get(id) ?? null,
    drop: async (id) => { saved.delete(id); },
  };
}

function runtime(fake: FakeExecutor, provider: ModelProvider, handleStore: RunHandleStore | undefined, seen: Record<string, unknown>[]): WeftAgentRuntime {
  const ledger = createSpendLedger({ dir: join(dataDir, "spend"), caps: { runUsd: 0.1, dayUsd: 2, liveUsd: 0.5 } });
  return createAgentRuntime({
    db, clock, executor: fake, provider, ledger, handleStore,
    routinesView: {
      get: async (id) => (id === routine.id ? routine : null),
      checklist: async ({ agentRunId, trigger: t }) => {
        seen.push(t);
        const has = (cmd: string) => fake.proposals.some((p) => p.runId === agentRunId && p.command === cmd && p.status !== "denied");
        return [{ id: "rate", label: "rate", passed: has("tax.update_rate") }, { id: "send", label: "send", passed: has("notices.send_response") }];
      },
    },
  });
}

describe("a waiting routine run across a restart", () => {
  it("keeps its handle and trigger and ends done after approval in the new process", async () => {
    const fake = noticeExecutor();
    const provider = scriptedProvider({ scriptsDir: dataDir, scripts: { rt_agency_notice: S1 } });
    const store = sharedHandles();
    const before = runtime(fake, provider, store, []);
    const h = { runId: "run_0001", token: "tok_secret_0001" };
    await before.startRoutineRun(h, { routine, routineRun, trigger, precheck });
    expect((await before.settled(h.runId)).status).toBe("waiting");
    expect(store.saved.get(h.runId)?.token).toBe("tok_secret_0001");
    // The token never lands in run_steps, which the trace and the SSE feed read.
    expect(JSON.stringify(await before.store.steps(h.runId)).includes("tok_secret_0001")).toBe(false);

    // Restart: a fresh runtime on the same database, no in-memory maps.
    const seen: Record<string, unknown>[] = [];
    const after = runtime(fake, provider, store, seen);
    await after.boot();
    expect((await after.store.getRun(h.runId))?.status).toBe("waiting");

    fake.settleProposal(fake.proposals[0]!.id, true);
    // The checklist holds, but the rehydrated handle still sees the second proposal pending, so the run keeps waiting.
    expect(await after.wake(h.runId, { kind: "decision", attrs: { proposal_id: fake.proposals[0]!.id, status: "executed" }, text: "approved" })).toBe("waiting");
    // The checklist ran against the trigger from the context step, not an empty one.
    expect(seen[0]).toMatchObject({ event: "notice.received", event_id: "evt_0001", notice_id: "ntc_0001" });

    fake.settleProposal(fake.proposals[1]!.id, true);
    expect(await after.wake(h.runId, { kind: "decision", attrs: { proposal_id: fake.proposals[1]!.id, status: "executed" }, text: "approved" })).toBe("done");
    const run = (await after.store.getRun(h.runId))!;
    expect(run).toMatchObject({ status: "done", terminalReason: "DONE" });
    expect(store.saved.has(h.runId), "the handle is dropped once the run ends").toBe(false);
  });

  it("without a handle store a requeue after restart still fails with PROCESS_RESTART", async () => {
    const fake = noticeExecutor();
    const provider = scriptedProvider({ scriptsDir: dataDir, scripts: { rt_agency_notice: S1 } });
    const before = runtime(fake, provider, undefined, []);
    const h = { runId: "run_0002", token: "tok" };
    await before.startRoutineRun(h, { routine, routineRun: { ...routineRun, id: "rtr_0002" }, trigger, precheck });
    expect((await before.settled(h.runId)).status).toBe("waiting");
    const after = runtime(fake, provider, undefined, []);
    await after.boot();
    await after.requeue(h.runId, { kind: "decision", attrs: {}, text: "denied" });
    expect(await after.store.getRun(h.runId)).toMatchObject({ status: "failed", terminalReason: "PROCESS_RESTART" });
  });

  it("the boot rule still fails running runs and drops their handles", async () => {
    const fake = noticeExecutor();
    const provider = scriptedProvider({ scriptsDir: dataDir, scripts: { rt_agency_notice: S1 } });
    const store = sharedHandles();
    const before = runtime(fake, provider, store, []);
    const h = { runId: "run_0003", token: "tok" };
    await before.startRoutineRun(h, { routine, routineRun: { ...routineRun, id: "rtr_0003" }, trigger, precheck });
    await before.settled(h.runId);
    await before.store.updateRun(h.runId, { status: "running" });
    const after = runtime(fake, provider, store, []);
    await after.boot();
    expect(await after.store.getRun(h.runId)).toMatchObject({ status: "failed", terminalReason: "PROCESS_RESTART" });
    expect(store.saved.has(h.runId)).toBe(false);
  });
});

// ---- gate report item 3: chat stays read-only and answers by its fourth model step

const ZERO = { input: 10, cached: 0, cacheWrite: 0, output: 5, reasoning: 0 };
/** A fake model: each step returns the next scripted turn and records the request it saw. */
function fakeModel(turns: ((req: ModelStepRequest) => Partial<ModelStepResult>)[]): ModelProvider & { seen: ModelStepRequest[] } {
  const seen: ModelStepRequest[] = [];
  return {
    id: "scripted", model: "fake", label: "Fake model", live: false, seen,
    async step(req) {
      seen.push(req);
      const turn = turns[Math.min(seen.length - 1, turns.length - 1)]!(req);
      const calls = turn.toolCalls ?? [];
      return { stop: calls.length ? "tool_calls" : "final", text: "", toolCalls: calls, native: { turn: seen.length }, usage: ZERO, servedBy: "fake", requestId: null, ...turn };
    },
  };
}
const call = (n: number, name: string, args: unknown) => ({ callId: `call_${n}`, name, argumentsJson: JSON.stringify(args) });

function chatRuntime(fake: FakeExecutor, provider: ModelProvider): WeftAgentRuntime {
  const ledger = createSpendLedger({ dir: join(dataDir, "spend"), caps: { runUsd: 0.1, dayUsd: 2, liveUsd: 0.5 } });
  return createAgentRuntime({ db, clock, executor: fake, provider, ledger, routinesView: { get: async () => null } });
}

const chatExecutor = () => createFakeExecutor([
  ...CHAT_TOOLS.filter((n) => n !== "payroll.get_run").map((name) => ({ name, effect: name === "comms.post_update" ? "draft" as const : "read" as const })),
  { name: "payroll.get_run", effect: "read", handler: () => done({ flagged: [{ worker: "Lena Brooks (wrk_0026)", rule: "GROSS_CHANGE", before_cents: 491667, after_cents: 580167, result_id: "res_0001" }] }, "Read pay_2026_10_30 flagged rows") },
]);

describe("chat answer-by cap and read-only tools", () => {
  it("chat is not offered comms__post_update, and a call to it is refused without reaching the executor", async () => {
    const fake = chatExecutor();
    const model = fakeModel([
      () => ({ toolCalls: [call(1, "comms__post_update", { text: "Looking." }), call(2, "payroll__get_run", { run_id: "pay_2026_10_30" })] }),
      () => ({ text: "Lena Brooks (wrk_0026) rose from $4,916.67 to $5,801.67 (res_0001)." }),
    ]);
    const rt = chatRuntime(fake, model);
    const h = { runId: "run_0101", token: "tok" };
    await rt.startChat(h, { text: "Why is the NY raise flagged?", recipe: "chat", pageContext: null });
    const run = await rt.settled(h.runId);
    expect(model.seen[0]!.tools.map((t) => t.name)).not.toContain("comms__post_update");
    expect(model.seen[0]!.tools).toHaveLength(CHAT_TOOLS.length - 1);
    expect(fake.calls.map((c) => c.command)).toEqual(["payroll.get_run"]);
    expect(run).toMatchObject({ status: "done", stepsUsed: 2 });
  });

  it("a model that keeps calling tools is stopped at the answer-by step with a grounded answer", async () => {
    const fake = chatExecutor();
    let n = 0;
    const model = fakeModel([() => ({ toolCalls: [call(++n, "payroll__get_run", { run_id: "pay_2026_10_30", extra: n })] })]);
    const rt = chatRuntime(fake, model);
    const h = { runId: "run_0102", token: "tok" };
    await rt.startChat(h, { text: "Why is the NY raise flagged?", recipe: "chat", pageContext: null });
    const run = await rt.settled(h.runId);
    expect(run.status).toBe("done");
    expect(run.stepsUsed).toBe(CHAT_ANSWER_BY);
    // The calls of the last step never ran, and the step before it carried the answer-now notice.
    expect(fake.calls).toHaveLength(CHAT_ANSWER_BY - 1);
    const last = model.seen[CHAT_ANSWER_BY - 1]!.history.at(-1);
    expect(last).toMatchObject({ kind: "notice", notice: "budget", attrs: { code: "ANSWER_NOW" } });
    expect(run.summary).toContain("res_");
  });

  // Wave 4 (FM3, CQ-03): the answer-by step keeps one reserved repair, so the receipt no longer replaces an answer
  // the model could fix; the repaired answer is the last model step and a second miss still gets the receipt.
  it("an ungrounded answer at the answer-by step gets one reserved repair, then the grounded receipt", async () => {
    const fake = chatExecutor();
    let n = 0;
    const model = fakeModel([
      () => ({ toolCalls: [call(++n, "payroll__get_run", { run_id: "pay_2026_10_30" })] }),
      () => ({ toolCalls: [call(++n, "payroll__get_run", { run_id: "pay_2026_10_30" })] }),
      () => ({ toolCalls: [call(++n, "payroll__get_run", { run_id: "pay_2026_10_30" })] }),
      () => ({ text: "Gross pay rose by $9,999.99." }),
      () => ({ text: "Gross pay rose by $8,888.88." }),
    ]);
    const rt = chatRuntime(fake, model);
    const h = { runId: "run_0103", token: "tok" };
    await rt.startChat(h, { text: "Why is the NY raise flagged?", recipe: "chat", pageContext: null });
    const run = await rt.settled(h.runId);
    expect(run).toMatchObject({ status: "done", stepsUsed: CHAT_ANSWER_BY + 1 });
    expect(run.summary).not.toContain("9,999.99");
    expect(run.summary).not.toContain("8,888.88");
    const repairs = (await rt.store.steps(h.runId)).filter((s) => s.kind === "notice" && (s.result as { notice: string }).notice === "repair");
    expect(repairs.map((s) => (s.result as { attrs: { at?: string } }).attrs.at)).toEqual(["last"]);
  });
});
