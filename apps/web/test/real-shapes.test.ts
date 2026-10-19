// Shapes seen from the merged API on 2026-10-15 (scratch integration of t1 to t4): SSE frames, tool step results,
// GET /v1/sim/state, audit reasons. These pin the UI's adapters so a contract drift shows up here first.
import { describe, expect, it, beforeEach } from "vitest";
import type { RunStepRow } from "@weft/contracts";
import { createSseParser, classifyFrame, type SseFrame } from "../src/lib/api/sse";
import { stepSummary, toolLabel } from "../src/components/app/agent/run-steps";
import { nextCronSlot, notReversibleText } from "../src/components/app/format";
import { mockFetch, resetMockWorld } from "../src/lib/api/mocks";

const step = (over: Partial<RunStepRow>): RunStepRow => ({
  runId: "run_0001", n: 5, parentN: null, stage: "dispatch", kind: "tool_call", callId: "call_1", toolName: "payroll__explain_flags", toolArgs: null,
  outcome: "ok", result: null, native: null, usage: null, costUsdMicros: 0, attempt: 1, requestId: null, prefixHash: null, timings: null,
  createdAt: "2026-10-26T15:30:00.000Z", ...over,
});

describe("SSE frames from GET /v1/agent/runs/:id/events", () => {
  it("parses a recorded stream: step frames, then a status frame", () => {
    const frames: SseFrame[] = [];
    const feed = createSseParser((event, data) => frames.push(classifyFrame(event, JSON.parse(data))));
    const s5 = JSON.stringify(step({ n: 5 }));
    const s6 = JSON.stringify(step({ n: 6, toolName: "payroll__submit_run", outcome: "pending:prp_0001" }));
    feed(`event: step\ndata: ${s5}\n\nevent: st`);
    feed(`ep\ndata: ${s6}\n\n: keep-alive\n\nevent: status\ndata: {"status":"waiting"}\n\n`);
    expect(frames.map((f) => f.kind)).toEqual(["step", "step", "status"]);
    expect(frames[2]).toEqual({ kind: "status", status: "waiting" });
    const second = frames[1];
    expect(second?.kind === "step" ? second.step.outcome : null).toBe("pending:prp_0001");
  });

  it("accepts full run rows and traces, and ignores unknown objects", () => {
    expect(classifyFrame("message", { id: "run_0001", status: "done" }).kind).toBe("run");
    expect(classifyFrame("message", { run: { id: "run_0001" }, steps: [] }).kind).toBe("trace");
    expect(classifyFrame("message", { status: "done" }).kind).toBe("status");
    expect(classifyFrame("message", { hello: 1 }).kind).toBe("other");
    expect(classifyFrame("message", null).kind).toBe("other");
  });
});

describe("step chips from the API's tool results", () => {
  it("reads { output, outcome } results: summary for done, title for a pending proposal, refusal message", () => {
    expect(stepSummary(step({ result: { output: "{}", outcome: { ok: true, status: "done", summary: "Explanations for pay_2026_10_30: 0 agent, 4 template, 0 refused" } } })))
      .toBe("Explanations for the Oct 30 run: 0 agent, 4 template, 0 refused");
    expect(stepSummary(step({ outcome: "pending:prp_0001", result: { output: "{}", outcome: { ok: true, status: "pending_approval", proposalId: "prp_0001", title: "Submit payroll pay_2026_10_30" } } })))
      .toBe("Submit the Oct 30 run");
    expect(stepSummary(step({ outcome: "refused:NOT_PERMITTED", result: { outcome: { ok: false, refusal: { code: "NOT_PERMITTED", message: "Not allowed here" } } } }))).toBe("Not allowed here");
  });

  it("falls back to the dotted tool name, and keeps the older { summary } form", () => {
    expect(stepSummary(step({ result: null }))).toBe("payroll.explain_flags");
    expect(stepSummary(step({ result: { summary: "Read the run" } }))).toBe("Read the run");
    expect(toolLabel("people__get")).toBe("people.get");
    expect(toolLabel(null)).toBeNull();
  });
});

describe("simulator clock helpers", () => {
  it("finds the next weekday 9:00 AM PT slot strictly after now", () => {
    expect(nextCronSlot("2026-10-26T15:30:00.000Z")).toBe("2026-10-26T16:00:00.000Z");   // Mon 8:30 PT to 9:00
    expect(nextCronSlot("2026-10-26T15:31:00.000Z")).toBe("2026-10-26T16:00:00.000Z");   // off the quarter hour
    expect(nextCronSlot("2026-10-26T16:00:00.000Z")).toBe("2026-10-27T16:00:00.000Z");   // at 9:00, the next day
    expect(nextCronSlot("2026-10-30T17:00:00.000Z")).toBe("2026-11-02T17:00:00.000Z");   // Fri after 9:00, Mon (PST)
    expect(nextCronSlot("not a date")).toBeNull();
  });
});

describe("audit reasons", () => {
  it("does not double the phrase when the API's reason already says it", () => {
    expect(notReversibleText("people.accept_offer is not reversible.")).toBe("people.accept_offer is not reversible.");
    expect(notReversibleText("A funded payroll cannot be undone; run an off-cycle correction instead.")).toBe("A funded payroll cannot be undone; run an off-cycle correction instead.");
    expect(notReversibleText("filed with the agency simulator")).toBe("Not reversible: filed with the agency simulator");
    expect(notReversibleText(null)).toBe("Not reversible: no reverse command");
  });
});

describe("mock GET /v1/sim/state matches the API's keys", () => {
  beforeEach(() => resetMockWorld());
  it("sends idpAccounts as a count, snake_case rows and no nextEvent", async () => {
    const s = (await (await mockFetch("/api/v1/sim/state", { headers: { "x-weft-principal": "usr_dana" } })).json()) as Record<string, unknown>;
    expect(Object.keys(s).sort()).toEqual(["agencyMail", "bankBatches", "catalog", "clock", "deviceOrders", "faults", "idpAccounts", "registrations"]);
    expect(typeof s.idpAccounts).toBe("number");
    expect(Object.keys((s.bankBatches as Record<string, unknown>[])[0] ?? {})).toEqual(expect.arrayContaining(["payroll_run_id", "total_cents", "settle_at", "entryCount"]));
  });
});

describe("mock GET /v1/workers/:id returns a WorkerDetail like the API", () => {
  beforeEach(() => resetMockWorld());
  it("wraps the worker and adds pay rates, bank account and tax profile; benefits and IT accounts filter by worker", async () => {
    const get = async (p: string) => (await mockFetch(`/api${p}`, { headers: { "x-weft-principal": "usr_dana" } })).json() as Promise<Record<string, unknown>>;
    const d = await get("/v1/workers/wrk_0001");
    expect(Object.keys(d).sort()).toEqual(["bankAccount", "department", "manager", "payRates", "profile", "taxProfile", "worker", "workplace"]);
    expect((d.worker as { id: string }).id).toBe("wrk_0001");
    const enr = await get("/v1/benefits/enrollments?workerId=wrk_0001");
    expect((enr.data as { workerId: string }[]).every((e) => e.workerId === "wrk_0001")).toBe(true);
    const it = await get("/v1/it/accounts?workerId=wrk_0001");
    expect((it.data as unknown[]).length).toBeGreaterThan(0);
  });
});
