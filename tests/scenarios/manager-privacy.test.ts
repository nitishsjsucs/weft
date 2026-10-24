// Scenario: a manager's reads stop at her reports (packages/core/src/people/scope.ts). Imani Ferreira, the
// Hardware lead, asks the chat agent for Priya Raman's salary: the agent's people.get result holds directory
// fields and an access block, so the answer declines and carries no pay figure (scenarios/chat_manager_outsider_pay.json,
// dev task PE-11). Then the Workday and Greenhouse reads she can reach withhold an outsider's pay the same way. Scripted
// provider only; nothing here calls a live model.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { check } from "../../packages/grounding/src/index";   // relative: tests/package.json does not list @weft/grounding
import { sql } from "drizzle-orm";
import type { AgentRunRow, HumanSession, ToolOutcome } from "@weft/contracts";
import { createTestWeft, type TestWeft } from "./helpers";

let weft: TestWeft;
const PRIYA = "wrk_0003";
const RUTH = "wrk_0010";
const imani = { principalId: "usr_imani", companyId: "cmp_larkspur", via: "ui", keyScope: null } as HumanSession;
const PRIYA_PAY = /245,000|245000|24500000|20,416|10,208/;

beforeAll(async () => { weft = await createTestWeft(); });
afterAll(async () => { await weft?.close(); });

const call = async (method: string, path: string, body?: unknown, who = "usr_dana") => {
  const res = await weft.app.request(path, { method, headers: { ...weft.uiHeaders(who), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as any };
};
async function ask(text: string, who: string): Promise<AgentRunRow> {
  const res = await call("POST", "/v1/agent/runs", { text, pageContext: null }, who);
  expect(res.status, JSON.stringify(res.json)).toBe(202);
  return (weft.agent as unknown as { settled(id: string): Promise<AgentRunRow> }).settled(res.json.runId as string);
}
const data = <T,>(o: ToolOutcome): T => {
  if (!(o.ok && o.status === "done")) throw new Error(JSON.stringify(o).slice(0, 400));
  return o.data as T;
};

describe("a manager asks for the pay of someone outside her reports", () => {
  it("the agent reads directory fields only and declines, with no pay figure anywhere in the run", async () => {
    const before = (await weft.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM actions`))[0]!.n;
    const run = await ask("What is Priya Raman's current salary?", "usr_imani");
    expect(run.status).toBe("done");
    expect(run.summary).toContain("can't share");
    expect(run.summary).not.toMatch(PRIYA_PAY);
    const trace = await weft.agent.trace(run.id);
    const tools = trace.steps.filter((s) => s.kind === "tool_call");
    expect(tools.map((s) => s.toolName)).toEqual(["people__search", "people__get"]);
    const results = tools.map((s) => (s.result as { outcome?: unknown }).outcome);
    expect(JSON.stringify(results)).not.toMatch(PRIYA_PAY);
    expect(JSON.stringify(results)).not.toMatch(/amount_cents|last4|filing_status/);
    const get = results[1] as { data: { worker: { access: { scope: string; withheld: string[] } } } };
    expect(get.data.worker.access.scope).toBe("directory");
    expect(get.data.worker.access.withheld).toContain("pay");
    expect(check(run.summary!, results).ok).toBe(true);
    const steps = await weft.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM run_steps WHERE result_json LIKE '%24500000%'`);
    expect(steps[0]!.n).toBe(0);
    expect((await weft.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM actions`))[0]!.n).toBe(before);
  });
});

describe("Workday and Greenhouse reads for a manager", () => {
  let changed = "";
  it("hris.get_worker_external: an outsider's base pay is withheld, a report's is compared", async () => {
    await call("POST", "/v1/integrations/workday/sync");
    const sim = await call("POST", "/v1/integrations/workday/simulate", { kind: "worker_change" });
    expect(sim.status).toBe(200);
    const [link] = await weft.db.all<{ weft_id: string }>(sql`SELECT weft_id FROM ext_links WHERE vendor = 'workday' AND ext_id = ${sim.json.data.workerRef}`);
    changed = link!.weft_id;
    await call("POST", "/v1/integrations/workday/sync");
    const outsider = data<{ fields: { field: string }[]; access?: { withheld: string[] }; employee_id?: string }>(await weft.executor.human.exec(imani, "hris.get_worker_external", { worker_id: PRIYA }));
    expect(outsider.fields.map((f) => f.field)).toEqual(["title", "work_state"]);
    expect(outsider.access?.withheld).toEqual(["base_cents", "termination_date", "employee_id"]);
    expect(outsider.employee_id).toBeUndefined();
    const report = data<{ fields: { field: string }[]; access?: unknown }>(await weft.executor.human.exec(imani, "hris.get_worker_external", { worker_id: RUTH }));
    expect(report.fields.map((f) => f.field)).toContain("base_cents");
    expect(report.access).toBeUndefined();
  });

  it("integrations.list_sync_items: a pay conflict shows its values only when the worker is in her reports", async () => {
    const [w] = await weft.db.all<{ manager_id: string | null }>(sql`SELECT manager_id FROM workers WHERE id = ${changed}`);
    const mine = changed === "wrk_0004" || w?.manager_id === "wrk_0004";
    const items = data<{ items: { subject_ref: string; detail: Record<string, unknown> }[] }>(await weft.executor.human.exec(imani, "integrations.list_sync_items", { vendor: "workday" })).items;
    const conflict = items.find((x) => x.subject_ref === changed)!;
    expect(conflict.detail.field).toBe("base_cents");
    if (mine) expect(conflict.detail.weft_value).toBeDefined();
    else expect(conflict.detail).toMatchObject({ withheld: ["weft_value", "vendor_value"] });
    const dana = data<{ items: { subject_ref: string; detail: Record<string, unknown> }[] }>(await weft.executor.human.exec({ ...imani, principalId: "usr_dana" }, "integrations.list_sync_items", { vendor: "workday" })).items;
    expect(dana.find((x) => x.subject_ref === changed)!.detail.weft_value).toBeDefined();
  });

  it("ats.get_hire: the salary shows only when the linked offer's manager is her or a report", async () => {
    await weft.clock.set("2026-10-26T17:00:00.000Z", 0);
    const sim = await call("POST", "/v1/integrations/greenhouse/simulate", { kind: "hire" });
    const offerId = sim.json.data.weft_offer_id as string;
    expect(offerId).toBeTruthy();
    const [link] = await weft.db.all<{ ext_id: string }>(sql`SELECT ext_id FROM ext_links WHERE vendor = 'greenhouse' AND ext_type = 'application' AND weft_id = ${offerId}`);
    const read = async () => data<{ hire: { salary_cents: number | null }; access?: unknown }>(await weft.executor.human.exec(imani, "ats.get_hire", { application_ref: link!.ext_id }));
    await weft.db.run(sql`UPDATE offers SET manager_id = 'wrk_0003' WHERE id = ${offerId}`);
    const outside = await read();
    expect(outside.hire.salary_cents).toBeNull();
    expect(outside.access).toBeDefined();
    await weft.db.run(sql`UPDATE offers SET manager_id = 'wrk_0004' WHERE id = ${offerId}`);
    const own = await read();
    expect(own.hire.salary_cents).toBeGreaterThan(0);
    expect(own.access).toBeUndefined();
  });
});
