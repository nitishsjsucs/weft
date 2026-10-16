// Scenario s6 (harness 3.6, wave 2 track w2-providers-sandbox). A routine run on the scripted provider answers with
// one code__run whose script makes two reads through weft.call (people__search, payroll__get_run), tries one send
// that the box refuses, and aggregates the reads. code.run is on no wave 1 allowlist, so the test adds its own
// routine row whose tools include it, and turns the sandbox on with WEFT_SANDBOX=quickjs.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { HumanSession } from "@weft/contracts";
import { actions, agentRuns, routineRuns, routines } from "@weft/db";
import { DEFAULT_SCRIPTS_DIR, scriptedProvider, type Script } from "../../packages/agent/src/index";   // relative: tests/package.json does not list @weft/agent
import { createTestWeft, type TestWeft } from "./helpers";

const ROUTINE = "rt_s6_code_run";
const SOURCE = [
  "const ca = await weft.call('people__search', { state: 'CA', limit: 50 });",
  "const run = await weft.call('payroll__get_run', { run_id: 'pay_2026_10_30' });",
  "const send = await weft.call('comms__send_message', { channel: '#general', text: 'from the box' });",
  "return { ca_people: ca.data.total, run_ok: run.ok, send_refused: send.ok ? null : send.refusal.code };",
].join("\n");

const S6: Script = {
  agents: {
    main: [
      { output: [{ type: "function_call", name: "code__run", arguments: { purpose: "count CA staff and read the Oct 30 draft", source: SOURCE, inputs_json: null } }] },
      {
        expect: { lastResults: [{ tool: "code__run", ok: true, status: "done" }] },
        output: [{ type: "text", text: "From one script: {{last.code__run.data.value.ca_people}} people work in CA." }],
      },
    ],
  },
};

let weft: TestWeft;
const prior = process.env.WEFT_SANDBOX;
beforeAll(async () => {
  process.env.WEFT_SANDBOX = "quickjs";
  weft = await createTestWeft({ provider: scriptedProvider({ scriptsDir: DEFAULT_SCRIPTS_DIR, scripts: { [ROUTINE]: S6 } }) });
  await weft.db.insert(routines).values({
    id: ROUTINE, companyId: "cmp_larkspur", name: "Sandbox scenario", description: "Test only: one code.run over two reads.", ownerPrincipalId: "usr_dana",
    enabled: true, autonomy: "approve", triggerJson: JSON.stringify({ type: "cron", cron: "0 3 1 1 *", tz: "America/Los_Angeles" }), filterJson: null,
    instructions: "Answer with one code.run.", toolsJson: JSON.stringify(["code.run", "people.search", "payroll.get_run"]), precheck: null, checklistJson: "[]",
    budgetJson: JSON.stringify({ steps: 4, usd: 0.1, minutes: 10 }), surfaceJson: JSON.stringify({ worthSurfacing: false, channel: null }), source: "custom",
    taintedBy: null, createdAt: "2026-10-26T15:30:00.000Z",
  });
});
afterAll(async () => {
  await weft?.close();
  if (prior === undefined) delete process.env.WEFT_SANDBOX; else process.env.WEFT_SANDBOX = prior;
});

async function waitFor<T>(what: string, f: () => Promise<T | null | undefined>): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const v = await f();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("s6: code.run in a routine run on the scripted provider", () => {
  it("two reads in one script, a refused send, the count in the final text, no writes", async () => {
    const dana: HumanSession = { principalId: "usr_dana", companyId: "cmp_larkspur", via: "ui", keyScope: null };
    const direct = await weft.executor.human.exec(dana, "people.search", { state: "CA", limit: 50 });
    const caTotal = direct.ok && direct.status === "done" ? (direct.data as { total: number }).total : -1;
    expect(caTotal).toBeGreaterThan(0);

    const actionsBefore = (await weft.db.select().from(actions)).length;
    const res = await weft.app.request(`/v1/routines/${ROUTINE}/trigger`, { method: "POST", headers: { ...weft.uiHeaders("usr_dana"), "content-type": "application/json" }, body: "{}" });
    expect(res.status, await res.clone().text()).toBe(200);
    const { routineRunId } = (await res.json()) as { routineRunId: string };
    const rr = await waitFor("the routine run to settle", async () => {
      const [r] = await weft.db.select().from(routineRuns).where(eq(routineRuns.id, routineRunId));
      return r && !["queued", "running"].includes(r.status) ? r : null;
    });
    const [run] = await weft.db.select().from(agentRuns).where(eq(agentRuns.id, rr.agentRunId!));
    expect({ status: run!.status, reason: run!.terminalReason }).toEqual({ status: "done", reason: expect.anything() });
    const trace = await weft.agent.trace(run!.id);
    // A routine's summary is written by code; the model's final text is on its last model step.
    const texts = trace.steps.filter((s) => s.kind === "model_call").map((s) => (s.result as { text?: string } | null)?.text ?? "");
    expect(texts.at(-1)).toBe(`From one script: ${caTotal} people work in CA.`);
    const tools = trace.steps.filter((s) => s.kind === "tool_call");
    expect(tools.map((s) => s.toolName)).toEqual(["code__run"]);
    const out = JSON.parse((tools[0]!.result as { output: string }).output) as { data: { value: Record<string, unknown>; calls: { command: string; outcome: string }[] } };
    expect(out.data.value).toEqual({ ca_people: caTotal, run_ok: true, send_refused: "SANDBOX_NOT_ALLOWED" });
    expect(out.data.calls.map((c) => [c.command, c.outcome])).toEqual([["people__search", "done"], ["payroll__get_run", "done"], ["comms__send_message", "refused:SANDBOX_NOT_ALLOWED"]]);
    expect((await weft.db.select().from(actions)).length).toBe(actionsBefore);
  });
});
