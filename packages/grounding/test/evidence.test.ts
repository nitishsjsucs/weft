// Round 1 analysis R1: G5 graded with the tool results alone while the loop's guard also had the request, the clock
// and the run's echoed arguments. runEvidence is the one helper both use; these fixtures are the four round 1
// mismatches (BN-02, CP-01, OC-01, TO-01), built as run step rows the way the run store writes them.
import { describe, expect, it } from "vitest";
import { check, requestTrustOf, runEvidence, type EvidenceStep } from "../src/index";

const NOW = "2026-10-26T15:30:00.000Z";   // a Monday, the dev worlds' clock

function pack(request: string, now: string | null = NOW): EvidenceStep {
  const text = [`<context n="d4707650e2692b58">`, now ? `now: ${now}` : null, "acting for: Imani (demo)", `<request>${request.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</request>`, "</context>"].filter(Boolean).join("\n");
  return { stage: "assemble", kind: "context", toolName: null, toolArgs: null, result: { promptKind: "chat", allowlist: [], nonce: "d4707650e2692b58", routineId: null, text, pack: true } };
}
const assemble = (requestTrusted?: boolean): EvidenceStep => ({ stage: "assemble", kind: "context", result: { items: 1, estInputTokens: 100, ...(requestTrusted === undefined ? {} : { requestTrusted }) } });
const done = (toolName: string, toolArgs: unknown, data: unknown, summary: string, resultId: string): EvidenceStep => ({
  stage: "dispatch", kind: "tool_call", toolName, toolArgs, result: { output: "{}", outcome: { ok: true, status: "done", resultId, data, summary, actionSeq: null, artifactRef: null, tainted: false, label: "synthetic" } },
});
const run = (request: string, ...tools: EvidenceStep[]) => [pack(request), assemble(true), { stage: "model", kind: "model_call", result: {} }, ...tools, assemble(true)];

describe("runEvidence", () => {
  it("reads the trusted request (unescaped), the clock, results, proposals and echoes from the rows", () => {
    const rows = run("Pay <Jordan> & co $1,500.00",
      done("people__search", { query: "Jordan Okafor", limit: 10 }, { count: 1 }, "Found 1 worker", "res_0002"),
      { stage: "dispatch", kind: "tool_call", toolName: "payroll__propose_off_cycle", toolArgs: { worker_id: "wrk_0042" }, result: { outcome: { ok: true, status: "pending_approval", proposalId: "prp_0001", title: "Pay $1,500.00 to Jordan Okafor (demo)" } } },
      { stage: "dispatch", kind: "tool_call", toolName: "time_off__list_requests", toolArgs: {}, result: { outcome: { ok: false, refusal: { code: "INVALID_INPUT" } } } });
    const ev = runEvidence(rows);
    expect(ev.opts.request).toBe("Pay <Jordan> & co $1,500.00");
    expect(ev.opts.now).toBe(NOW);
    expect([...ev.opts.echoes].sort()).toEqual(["Jordan Okafor", "wrk_0042"]);
    expect(ev.results).toEqual([
      { resultId: "res_0002", data: { count: 1 }, summary: "Found 1 worker", actionSeq: null },
      { proposalId: "prp_0001", title: "Pay $1,500.00 to Jordan Okafor (demo)" },
    ]);
  });

  it("never takes the run feed update (comms.post_update) as a result or an echo, by wire or dotted name", () => {
    for (const name of ["comms__post_update", "comms.post_update"]) {
      const rows = run("Status?", done(name, { text: "Payroll is 45 people" }, { posted: true, headcount: 45 }, "Posted 45", "res_0009"));
      const ev = runEvidence(rows);
      expect(ev.results).toEqual([]);
      expect(ev.opts.echoes.size).toBe(0);
      expect(check("Payroll is 45 people.", ev.results, ev.opts).ok).toBe(false);
    }
  });

  it("drops the request without a stored trust decision or with a false one; the pack row is never the decision", () => {
    expect(requestTrustOf([pack("x")])).toBeNull();
    expect(requestTrustOf([pack("x"), assemble(false), assemble(true)])).toBe(false);
    expect(requestTrustOf([pack("x"), assemble(), assemble(true)])).toBe(true);
    expect(runEvidence([pack("Pay $1,500.00")]).opts.request).toBeNull();
    expect(runEvidence([pack("Pay $1,500.00"), assemble(false)]).opts.request).toBeNull();
    expect(runEvidence([pack("Pay $1,500.00"), assemble(true)]).opts.request).toBe("Pay $1,500.00");
  });

  it("uses the pack's clock, and the caller's only when the pack has none", () => {
    expect(runEvidence([pack("x")], { now: "2030-01-01T00:00:00.000Z" }).opts.now).toBe(NOW);
    expect(runEvidence([pack("x", null)], { now: "2030-01-01T00:00:00.000Z" }).opts.now).toBe("2030-01-01T00:00:00.000Z");
    expect(runEvidence([]).opts).toMatchObject({ request: null, now: null });
  });

  it("takes the caller's request only when the rows hold no pack, and still only under a stored true decision", () => {
    expect(runEvidence([assemble(true)], { request: "Pay $1,500.00" }).opts.request).toBe("Pay $1,500.00");
    expect(runEvidence([assemble(false)], { request: "Pay $1,500.00" }).opts.request).toBeNull();
    expect(runEvidence([], { request: "Pay $1,500.00" }).opts.request).toBeNull();
    expect(runEvidence([pack("Pay $9.00"), assemble(true)], { request: "Pay $1,500.00" }).opts.request).toBe("Pay $9.00");
  });
});

describe("R1 fixtures: the guard's evidence grounds what the two-argument check refused", () => {
  const cases: { task: string; rows: EvidenceStep[]; text: string; twoArg: string[] }[] = [
    {
      task: "BN-02 (the clock's month)",
      rows: run("Did the benefits carrier overbill us this month?", done("benefits__list_findings", { month: "2026-10" }, { count: 0, findings: [] }, "Found 0 findings", "res_0002")),
      text: "No benefits overbilling findings were recorded for October 2026.",
      twoArg: ["October 2026"],
    },
    {
      task: "CP-01 (the person's figures and dates)",
      rows: run("Hollis Grey (demo) missed the Oct 1 to 15 payroll. Please propose an off-cycle payment for that period plus a $1,500.00 bonus, payday Oct 27.",
        done("people__search", { query: "Hollis Grey" }, { count: 1, people: [{ id: "wrk_0042" }] }, "Found 1 worker", "res_0002")),
      text: "I can't propose the off-cycle payment for Oct 1 to 15 with the $1,500.00 bonus on Oct 27 from chat; the 15 days need a person to propose it.",
      twoArg: ["Oct 1 to 15", "Oct 27", "$1,500.00", "15"],
    },
    {
      task: "OC-01 (a day of the person's range)",
      rows: run("How much would Hollis Grey's missed pay for Oct 1 to 15 be?", done("payroll__get_paycheck", { worker_id: "wrk_0042" }, { gross_cents: 316667 }, "Read 1 paycheck", "res_0004")),
      text: "Missed gross pay for the 1st to the 15 is $3,166.67.",
      twoArg: ["15"],
    },
    {
      task: "TO-01 (the bounds of next week from a Monday clock)",
      rows: run("Who's out next week?", done("time_off__list_requests", { status: "approved" }, { count: 0, requests: [] }, "Found 0 requests", "res_0002")),
      text: "No one is out next week, November 2 to November 8.",
      twoArg: ["November 2", "November 8"],
    },
  ];
  for (const c of cases) {
    it(c.task, () => {
      const ev = runEvidence(c.rows);
      expect(check(c.text, ev.results, ev.opts)).toEqual({ ok: true, offending: [] });
      expect(check(c.text, ev.results).offending).toEqual(c.twoArg);
    });
  }

  it("the same rows still refuse a figure no source holds", () => {
    const ev = runEvidence(cases[1]!.rows);
    expect(check("The bonus is $2,000.00, paid Oct 28.", ev.results, ev.opts)).toEqual({ ok: false, offending: ["Oct 28", "$2,000.00"] });
  });
});
