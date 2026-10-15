// Route tests for /v1/agent (owner: t4-agent). The agent routes are mounted on a small app with a fixed UI session,
// a real agent runtime and run store on a temp database, and the agent package's fake executor (the real one is T3's).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HumanSession, RunTrace, SimClock } from "@weft/contracts";
import { closeDb, migrate, openDb, type Db } from "@weft/db";
import { CHAT_TOOLS, createAgentRuntime, createSpendLedger, scriptedProvider, type TraceSummary, type WeftAgentRuntime } from "@weft/agent";
import { createFakeExecutor } from "../../../packages/agent/test/fake-executor";
import type { Weft, WeftEnv } from "../src/http/context";
import { toErrorResponse } from "../src/http/errors";
import { agentRoutes, createChatContextSource } from "../src/routes/agent";

const clock: SimClock = { now: () => "2026-10-26T16:00:00.000Z", rate: () => 0, advance: async () => undefined, set: async () => undefined };
const session: HumanSession = { principalId: "usr_dana", companyId: "cmp_larkspur", via: "ui", keyScope: null };
let dir: string;
let db: Db;
let app: Hono<WeftEnv>;
let agent: WeftAgentRuntime;
let n = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "weft-agent-routes-"));
  db = openDb({ dataDir: dir });
  await migrate(db);
  const fake = createFakeExecutor([
    ...CHAT_TOOLS.map((name) => ({ name, effect: "read" as const })),
    { name: "payroll.get_run", effect: "read" as const, handler: () => ({ ok: true as const, status: "done" as const, resultId: "res_0200", data: { flagged: [{ result_id: "res_0041", after_cents: 432000 }] }, summary: "Read pay_2026_10_30 flagged rows", actionSeq: null, artifactRef: null, tainted: false, label: "synthetic" as const }) },
  ]);
  const ledger = createSpendLedger({ dir: join(dir, "spend") });
  const provider = scriptedProvider({ scriptsDir: dir, scripts: { chat: { match: "raise", agents: { main: [
    { output: [{ type: "function_call", name: "payroll__get_run", arguments: { run_id: "pay_2026_10_30" } }] },
    { output: [{ type: "text", text: "Gross pay is $4,320.00 after the raise (res_0041)." }] },
  ] } } } });
  agent = createAgentRuntime({ db, clock, executor: fake, provider, ledger, routinesView: { get: async () => null } });
  const weft = {
    db, agent, ledger, provider, clock,
    executor: { runs: { openChatRun: async () => ({ runId: `run_${String(++n).padStart(4, "0")}`, token: "t" }) } },
  } as unknown as Weft;
  app = new Hono<WeftEnv>();
  app.onError((err, c) => toErrorResponse(err, c));
  app.use("*", async (c, next) => { c.set("weft", weft); c.set("session", session); await next(); });
  app.route("/", agentRoutes(weft));
});
afterAll(async () => {
  await agent.idle();
  await closeDb(db);
  rmSync(dir, { recursive: true, force: true });
});

async function startRun(text: string): Promise<string> {
  const res = await app.request("/v1/agent/runs", { method: "POST", body: JSON.stringify({ text, pageContext: null }), headers: { "content-type": "application/json" } });
  expect(res.status).toBe(202);
  return ((await res.json()) as { runId: string }).runId;
}

describe("/v1/agent routes", () => {
  it("POST returns the run id at once; polling the trace shows stage rows with timings, tokens, cache-hit ratio and USD", async () => {
    const runId = await startRun("Why is the raise flagged?");
    let trace: RunTrace & { summary: TraceSummary } | null = null;
    for (let i = 0; i < 50; i++) {
      const res = await app.request(`/v1/agent/runs/${runId}/trace`);
      expect(res.status).toBe(200);
      trace = (await res.json()) as RunTrace & { summary: TraceSummary };
      if (!["queued", "running"].includes(trace.run.status)) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(trace!.run.status).toBe("done");
    expect(trace!.run.summary).toContain("res_0041");
    const stages = new Set(trace!.summary.stages.map((s) => s.stage));
    for (const s of ["assemble", "admission", "model", "dispatch", "post", "terminal"]) expect(stages.has(s as never), s).toBe(true);
    expect(trace!.summary.modelCalls).toBe(2);
    expect(trace!.summary.tokens.input).toBeGreaterThan(0);
    expect(trace!.summary.cacheHitRatio).toBeGreaterThan(0);
    expect(trace!.summary.usd).toBe(0);
    expect(trace!.summary.stages.find((s) => s.kind === "tool_call")?.label).toBe("Read pay_2026_10_30 flagged rows");
    expect(trace!.proposals).toEqual([]);
  });

  it("SSE replays the steps and closes with the final status", async () => {
    const runId = await startRun("Why is the raise flagged?");
    await agent.settled(runId);
    const res = await app.request(`/v1/agent/runs/${runId}/events`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await res.text();
    expect(body.match(/event: step/g)?.length).toBeGreaterThan(5);
    expect(body).toContain("event: status");
    expect(body).toContain("\"status\":\"done\"");
  });

  it("lists runs, reads one, 404s an unknown id, cancels and rolls up costs", async () => {
    const list = (await (await app.request("/v1/agent/runs?limit=1")).json()) as { hasMore: boolean; count: number; data: { id: string }[] };
    expect(list.count).toBe(1);
    expect(list.hasMore).toBe(true);
    const one = await app.request(`/v1/agent/runs/${list.data[0]!.id}`);
    expect(one.status).toBe(200);
    const missing = await app.request("/v1/agent/runs/run_9999");
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { _tag: string })._tag).toBe("NotFound");
    const cancel = await app.request(`/v1/agent/runs/${list.data[0]!.id}/cancel`, { method: "POST" });
    expect(cancel.status).toBe(200);
    const costs = (await (await app.request("/v1/agent/costs?day=2026-10-15")).json()) as { daySpentUsd: number; provider: { live: boolean } };
    expect(costs).toMatchObject({ daySpentUsd: 0, provider: { live: false } });
  });

  it("the chat context source summarizes the company from DB rows", async () => {
    const c = await createChatContextSource(db).chat({ companyId: "cmp_larkspur", runId: "run_none" });
    expect(c.companySummary).toContain("active headcount 0");
    expect(c.companySummary).toContain("pending approvals: 0");
    expect(c.openLoops).toEqual([]);
    expect(c.actingFor).toBe("the person in this chat");
  });
});
