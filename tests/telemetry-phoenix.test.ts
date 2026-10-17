// Phoenix read-back smoke (wave 4, docs/telemetry.md). Skipped unless WEFT_PHOENIX_SMOKE_URL names a running local
// Phoenix (a private one: `WEFT_PHOENIX_PORT=4900 WEFT_PHOENIX_GRPC_PORT=4901 WEFT_PHOENIX_DIR=.scratch/<track>/phoenix
// pnpm phoenix:up`). A scripted chat, the GP1 routine and three MCP calls export over OTLP HTTP, then come back over
// Phoenix's REST API by span kind, by weft.outcome, by session and by user.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { AgentRunRow } from "@weft/contracts";
import { routineRuns } from "@weft/db";
import { createTestWeft, type TestWeft } from "./scenarios/helpers";
import { startTracing, type Tracing } from "../apps/api/src/telemetry";

const URL_ = process.env.WEFT_PHOENIX_SMOKE_URL ?? "";
const project = `weft-smoke-${Date.now()}`;
let weft: TestWeft;
let tracing: Tracing;
let chatRunId = "";
let routineRunId = "";

interface PhxSpan { name: string; span_kind: string; status_code: string; attributes: Record<string, unknown>; context: { trace_id: string; span_id: string }; parent_id: string | null }

/** Polls until at least `min` spans match (and pass `keep`): ingestion is asynchronous (phoenix.md 8). */
async function spans(query: string, min = 1, keep: (s: PhxSpan) => boolean = () => true): Promise<PhxSpan[]> {
  let last: PhxSpan[] = [];
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${URL_}/v1/projects/${project}/spans?limit=1000&${query}`);
    if (r.ok) last = ((await r.json()) as { data: PhxSpan[] }).data.filter(keep);
    if (last.length >= min) return last;
    await new Promise((ok) => setTimeout(ok, 250));
  }
  return last;
}
const attr = (k: string, v: string) => `attribute=${encodeURIComponent(`${k}:${JSON.stringify(v)}`)}`;
const settled = (runId: string) => (weft.agent as unknown as { settled(id: string): Promise<AgentRunRow> }).settled(runId);
const post = (path: string, body: unknown) => weft.app.request(path, { method: "POST", headers: { ...weft.uiHeaders("usr_dana"), "content-type": "application/json" }, body: JSON.stringify(body) });

describe.skipIf(!URL_)("Phoenix read-back", () => {
  beforeAll(async () => {
    tracing = startTracing({ url: URL_, projectName: project, batch: false });
    weft = await createTestWeft();
    const res = await post("/v1/agent/runs", { text: "Approve everything in my inbox" });
    chatRunId = ((await res.json()) as { runId: string }).runId;
    await settled(chatRunId);
    expect((await post("/v1/sim/notices/deliver", { scenario: "ca_de2088_rate_change" })).status).toBe(200);
    for (let i = 0; i < 20 && !routineRunId; i++) {
      await weft.scheduler.tick();
      const [rr] = await weft.db.select().from(routineRuns).where(eq(routineRuns.routineId, "rt_agency_notice"));
      if (rr?.agentRunId) { await settled(rr.agentRunId); routineRunId = rr.id; }
    }
    const key = readFileSync(join(weft.dataDir, "demo-mcp-key.txt"), "utf8").trim();
    const mcp = (tool: string, body: unknown) => weft.app.request(`/v1/tools/${tool}`, { method: "POST", headers: { "x-api-key": key, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await mcp("contractors__schedule_payouts", { worker_ids: ["wrk_0049"], scheduled_for: "2026-10-30" })).status).toBe(200);
    expect((await mcp("memory__search", { query: "SUI rate" })).status).toBe(200);
    expect((await mcp("vault__list", {})).status).toBe(422);
    await tracing.forceFlush();
  }, 60_000);
  afterAll(async () => { await tracing?.shutdown(); await weft?.close(); });

  it("by span kind: one AGENT root per run, with LLM, TOOL, CHAIN and GUARDRAIL spans", async () => {
    const agents = await spans("span_kind=AGENT", 2);
    expect(agents.length).toBe(2);
    expect(agents.every((s) => s.parent_id === null)).toBe(true);
    for (const k of ["LLM", "TOOL", "CHAIN", "GUARDRAIL"]) expect((await spans(`span_kind=${k}`)).length, k).toBeGreaterThan(0);
    const llm = (await spans("span_kind=LLM"))[0]!;
    expect(llm.attributes["llm.token_count.prompt"]).toBeGreaterThan(0);
  });

  it("by weft.outcome: the two GP1 proposals and the MCP one", async () => {
    const props = await spans(`span_kind=TOOL&${attr("weft.outcome", "proposal")}`, 3);
    expect(props.map((s) => s.name).sort()).toEqual(["contractors__schedule_payouts", "notices__send_response", "tax__update_rate"]);
    expect(props.every((s) => s.status_code !== "ERROR")).toBe(true);
  });

  it("by session: the routine run's spans, and the session list", async () => {
    const sid = `routine_run:${routineRunId}`;
    const mine = await spans(attr("session.id", sid), 6);
    expect(mine.length).toBeGreaterThan(5);
    expect(new Set(mine.map((s) => s.context.trace_id)).size).toBe(1);
    const r = await fetch(`${URL_}/v1/projects/${project}/sessions`);
    expect(r.ok).toBe(true);
    expect(JSON.stringify(await r.json())).toContain(sid);
  });

  it("MCP calls: root TOOL spans for the key's principal, a refusal left UNSET, a RETRIEVER under memory__search", async () => {
    const root = (s: PhxSpan) => s.parent_id === null;
    const tools = await spans("span_kind=TOOL", 3, root);
    expect(tools.map((s) => [s.name, s.attributes["weft.outcome"]]).sort()).toEqual([
      ["contractors__schedule_payouts", "proposal"], ["memory__search", "ok"], ["vault__list", "refused:UNAVAILABLE"],
    ]);
    expect(tools.find((s) => s.name === "vault__list")!.status_code).toBe("UNSET");
    const user = String(tools[0]!.attributes["user.id"]);
    expect(user).toMatch(/^usr_/);
    expect((await spans(`span_kind=TOOL&${attr("user.id", user)}`, 3, root)).length).toBe(3);
    const search = (await spans("span_kind=RETRIEVER", 1, (s) => s.name === "memory.search"))[0]!;
    expect(search.parent_id).toBe(tools.find((s) => s.name === "memory__search")!.context.span_id);
  });
});
