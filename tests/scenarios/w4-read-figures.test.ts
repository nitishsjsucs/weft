// Fix group read-figures (docs/evals/model-comparison.md, the shared expense and time-off failures): the figures an
// expense or time-off answer needs are fields of the default chat reads, in the forms people ask for. Totals per
// person, category, band and pay run; balances left in hours and days; dates in the company time zone. Scripted
// provider: the dev questions EX-11 and TO-11 are answered on the first try, with no grounding repair.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentRunRow, RunStepRow, ToolOutcome } from "@weft/contracts";
import { check } from "../../packages/grounding/src/index";
import { OBSERVATION_CAP } from "../../packages/executor/src/workspace";
import { createTestWeft, type TestWeft } from "./helpers";

let weft: TestWeft;
beforeAll(async () => { weft = await createTestWeft(); });
afterAll(async () => { await weft?.close(); });

const S = { principalId: "usr_dana", companyId: "cmp_larkspur", via: "ui", keyScope: null } as const;
async function read<T = Record<string, unknown>>(command: string, args: Record<string, unknown>): Promise<T> {
  const o: ToolOutcome = await weft.executor.human.exec(S as never, command, args);
  if (!(o.ok && o.status === "done")) throw new Error(`${command}: ${JSON.stringify(o).slice(0, 400)}`);
  return o.data as T;
}
type Req = { id: string; requested_hours: number; requested_days: number; submitted_date: string; decided_date: string | null; balance_left: { available_minutes: number; available_hours: number; available_days: number } };
type Sum = { count: number; amount_cents: number; amount_display: string };

describe("expense reads carry the sums people ask for", () => {
  it("the approved claims: the total, and the total per person", async () => {
    const d = await read<{ totals: Sum; by_worker: (Sum & { worker: string })[] }>("expenses.list", { band: "approved", totals_by: ["worker"] });
    expect(d.totals).toEqual({ count: 4, amount_cents: 28_445, amount_display: "$284.45" });
    expect(d.by_worker[0]).toEqual({ worker: "Victor Huang (demo) (wrk_0041)", count: 1, amount_cents: 9_600, amount_display: "$96.00" });
    // Across every band, his two software claims; a worker filter gives the same figure as its plain total.
    const all = await read<{ by_worker: (Sum & { worker: string })[] }>("expenses.list", { totals_by: ["worker"] });
    expect(all.by_worker.find((w) => w.worker.includes("wrk_0041"))).toMatchObject({ count: 2, amount_display: "$192.00" });
    expect((await read<{ totals: Sum }>("expenses.list", { worker_id: "wrk_0041" })).totals.amount_display).toBe("$192.00");
  });

  it("per category and per band; the decided date is the company's (Pacific) date", async () => {
    const d = await read<{ by_category: (Sum & { category: string })[]; by_band: (Sum & { band: string })[]; expenses: { expense_id: string; decided_date: string | null }[] }>("expenses.list", { totals_by: ["category", "band"] });
    expect(d.by_category.find((c) => c.category === "meals")).toMatchObject({ count: 3, amount_display: "$163.60" });
    expect(d.by_band.map((b) => [b.band, b.count])).toEqual([["needs_review", 8], ["approved", 4], ["paid_out", 0], ["declined", 2]]);
    expect(d.by_band.slice(1).map((b) => b.amount_display)).toEqual(["$284.45", "$0.00", "$149.00"]);
    expect(d.expenses.find((e) => e.expense_id === "exp_0009")!.decided_date).toBe("2026-10-14");
    expect(d.expenses.find((e) => e.expense_id === "exp_0001")!.decided_date).toBeNull();
  });

  it("the default reads stay under the observation cap on the seeded world, so they are never offloaded", async () => {
    for (const [cmd, args] of [["expenses.list", {}], ["time_off.list_requests", {}], ["time_off.list_requests", { totals_by: ["worker", "policy"] }]] as const) {
      expect(JSON.stringify(await read(cmd, args)).length, cmd).toBeLessThan(OBSERVATION_CAP);
    }
  });
});

describe("time-off reads carry hours, days and the balance left", () => {
  it("a pending request has its hours and days and the worker's balance left on that policy", async () => {
    const d = await read<{ requests: Req[]; totals: Record<string, number> }>("time_off.list_requests", { worker_id: "wrk_0010" });
    const r = d.requests.find((x) => x.id === "tor_0003")!;
    expect(r).toMatchObject({ requested_hours: 24, requested_days: 3, submitted_date: "2026-10-26", decided_date: null });
    expect(r.balance_left).toEqual({ available_minutes: 5_340, available_hours: 89, available_days: 11.13 });
    expect(d.totals).toEqual({ count: 1, requested_minutes: 1_440, requested_hours: 24, requested_days: 3 });
  });

  it("time_off.get_balance and the portal read add hours and days to every balance", async () => {
    const d = await read<{ balances: Record<string, unknown>[] }>("time_off.get_balance", { worker_id: "wrk_0010" });
    expect(d.balances.find((b) => b.policyId === "top_vac_us")).toMatchObject({ availableMinutes: 5_340, available_hours: 89, available_days: 11.13, holds_hours: 24, holds_days: 3, used_hours: 0 });
  });

  it("totals per worker and per policy when asked", async () => {
    const d = await read<{ by_policy: { policy: string; requested_days: number }[]; by_worker: { worker: string }[] }>("time_off.list_requests", { totals_by: ["worker", "policy"] });
    expect(d.by_policy.find((p) => p.policy === "Larkspur Vacation")).toMatchObject({ count: 4, requested_hours: 80, requested_days: 10 });
    expect(d.by_worker).toHaveLength(6);
  });
});

type Trace = { run: AgentRunRow; steps: RunStepRow[] };
async function ask(text: string): Promise<{ run: AgentRunRow; trace: Trace }> {
  const headers = { ...weft.uiHeaders("usr_dana"), "content-type": "application/json" };
  const res = await weft.app.request("/v1/agent/runs", { method: "POST", headers, body: JSON.stringify({ text, pageContext: null }) });
  expect(res.status, await res.clone().text()).toBe(202);
  const { runId } = (await res.json()) as { runId: string };
  const run = await (weft.agent as unknown as { settled(id: string): Promise<AgentRunRow> }).settled(runId);
  const trace = (await (await weft.app.request(`/v1/agent/runs/${runId}/trace`, { headers })).json()) as Trace;
  return { run, trace };
}
const resultOf = (t: Trace, tool: string) => (t.steps.find((s) => s.kind === "tool_call" && s.toolName === tool)!.result as { outcome: { data: Record<string, unknown> } }).outcome.data;

describe("the dev questions answer on the first try (scripted EX-11 and TO-11)", () => {
  it("EX-11: the sums come from expenses.list, so the guard accepts them without a repair", async () => {
    const { run, trace } = await ask("Across every status, what do the travel claims add up to, and what do the mileage claims come to?");
    expect(run.status).toBe("done");
    expect(trace.steps.filter((s) => s.kind === "notice")).toEqual([]);
    expect(run.summary).toContain("$602.88");
    expect(run.summary).toContain("$155.04");
    // The root cause: without the totals the same answer is the model's own arithmetic, and the guard refuses it.
    const data = resultOf(trace, "expenses__list");
    const bare = Object.fromEntries(Object.entries(data).filter(([k]) => k !== "totals" && !k.startsWith("by_")));
    expect(check(run.summary!, [bare]).offending).toEqual(["$602.88", "$155.04"]);
    expect(check(run.summary!, [data]).ok).toBe(true);
  });

  it("TO-11: the balance left and the request's hours come from time_off.list_requests", async () => {
    const { run, trace } = await ask("How many vacation days will Ruth Okoro have left once her pending request is counted, and how many hours does that request take?");
    expect(run.status).toBe("done");
    expect(trace.steps.filter((s) => s.kind === "notice")).toEqual([]);
    expect(run.summary).toMatch(/11\.13 days \(89 hours\)/);
    expect(run.summary).toContain("24 hours");
    expect(trace.steps.filter((s) => s.kind === "tool_call").map((s) => s.toolName)).toEqual(["time_off__list_requests"]);
  });
});

describe("dates in the company time zone", () => {
  it("a decision made at 8 pm Pacific (03:00 UTC the next day) shows the Pacific date", async () => {
    await weft.clock.set("2026-10-27T03:00:00.000Z", 0);
    const out = await weft.executor.human.exec(S as never, "time_off.decide", { request_id: "tor_0005", decision: "deny", note: "Inside the waiting period" });
    expect(out.ok && out.status === "done", JSON.stringify(out).slice(0, 300)).toBe(true);
    const r = (await read<{ requests: Req[] }>("time_off.list_requests", { request_id: "tor_0005" })).requests[0]!;
    expect(r.decided_date).toBe("2026-10-26");
  });
});
