import { describe, expect, it } from "vitest";
import {
  EvalTask, EVENT_PAYLOAD_PREFIXES, ID_PREFIXES, parseEventBody, PHOENIX, ROUTES, toolOutcomeCode, traceSessionId, TraceRunMeta,
  W4_PLANNED_COMMANDS, WAVE4_EVENT_TYPES, WAVE4_ID_PREFIXES,
} from "../src/index";

describe("wave 4 contracts", () => {
  it("adds id prefixes without collisions", () => {
    for (const p of WAVE4_ID_PREFIXES) expect(ID_PREFIXES).toContain(p);
    expect(new Set(ID_PREFIXES).size).toBe(ID_PREFIXES.length);
    expect(EVENT_PAYLOAD_PREFIXES).toContain("hnd_");
  });
  it("parses wave 4 events with id-only payloads and rejects free text", () => {
    expect(WAVE4_EVENT_TYPES).toContain("chat.agent_mentioned");
    expect(parseEventBody({ type: "handoff.opened", payload: { handoff_id: "hnd_0001" } }).type).toBe("handoff.opened");
    expect(() => parseEventBody({ type: "handoff.opened", payload: { handoff_id: "hnd_0001", note: "free text" } })).toThrow();
  });
  it("plans commands in namespaces the registry accepts, with honest approvals", () => {
    const ns = new Set(W4_PLANNED_COMMANDS.map((c) => c.name.split(".")[0]));
    for (const n of ns) expect(["compliance", "tax", "handoffs", "training", "notices", "benefits", "people", "comms", "portal", "expenses", "agent", "routines", "settings", "onboarding", "reports"]).toContain(n);
    for (const c of W4_PLANNED_COMMANDS) if (c.risk === "R3" || c.risk === "R4") expect(c.approval).toBe("always");
    expect(new Set(W4_PLANNED_COMMANDS.map((c) => c.name)).size).toBe(W4_PLANNED_COMMANDS.length);
  });
  it("routes every wave 4 row to a wave 4 owner", () => {
    const w4 = ROUTES.filter((r) => r.owner.startsWith("w4-"));
    expect(w4.length).toBe(36);
    expect(w4.filter((r) => r.path.startsWith("/v1/portal/")).every((r) => r.auth === "ui_only")).toBe(true);
  });
  it("telemetry names: outcome codes, session ids and the pinned Phoenix", () => {
    expect(toolOutcomeCode({ ok: true, proposalId: "prp_0001" })).toBe("proposal");
    expect(toolOutcomeCode({ ok: true, status: "done" })).toBe("ok");
    expect(toolOutcomeCode({ ok: false, refusal: { code: "NOT_PERMITTED" } })).toBe("refused:NOT_PERMITTED");
    expect(traceSessionId({ threadId: null, routineRunId: "rtr_0002" }, null)).toBe("routine_run:rtr_0002");
    expect(PHOENIX.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect([3070, 4070, 3170, 4170]).not.toContain(PHOENIX.httpPort);
    expect(TraceRunMeta.shape.chat_can_propose).toBeDefined();
  });
  it("parses an eval task in the evals.md 4.1 shape", () => {
    const t = EvalTask.parse({
      id: "EX-03", group: "expenses_timeoff_benefits", parity: ["R5", "Q4"], kind: "capability", split: "dev", surface: "chat", principal: "usr_dana",
      variants: ["default", "chat_can_propose"],
      world: { base: "seed@v4", clock: "2026-10-26T15:30:00.000Z", mutators: [], digest: null },
      input: { chat: "Approve the duplicate hotel claim from last week." },
      expect: { default: { proposals: [] }, chat_can_propose: { proposals: [{ command: "expenses.decide", args: { decision: "decline" } }] } },
      budget: { maxSteps: 6, maxUsd: 0.01 }, reference: "evals/suite/reference/EX-03.md",
    });
    expect(t.expect.default?.noConsequentialEffects).toBe(true);
    expect(() => EvalTask.parse({ ...t, id: "bad" })).toThrow();
  });
});
