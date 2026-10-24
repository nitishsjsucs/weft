// Conversation threads on the API (the Agent page; packages/contracts/src/ext/agent-page.ts). POST /v1/agent/runs takes
// an optional threadId and the run records it; a follow-up's context pack holds the thread's earlier turns (question
// and final answer only, at most three, bounded, never a tool result); a tainted earlier turn taints the follow-up and
// gives it nothing (harness 6.2); GET /v1/agent/runs filters by thread_id and trigger under the run visibility rules.
// The side panel's null threadId behaves as before. Base world, scripted provider.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { AgentRunRow, RunTrace } from "@weft/contracts";
import { agentRuns, runTaint } from "@weft/db";
import { executorInternals } from "@weft/executor";
import type { ConversationRunRow } from "../../../packages/contracts/src/ext/agent-page";
import { createTestWeft, type TestWeft } from "../src/testing";

let weft: TestWeft;
const DANA = "usr_dana", THEO = "usr_theo", IMANI = "usr_imani";
let seq = 0;
const thread = () => `thr_test${String(++seq).padStart(6, "0")}`;

async function ask(text: string, threadId: string | null, who = DANA): Promise<{ status: number; runId: string; body: Record<string, unknown> }> {
  const res = await weft.app.request("/v1/agent/runs", { method: "POST", headers: { ...weft.uiHeaders(who), "content-type": "application/json" }, body: JSON.stringify({ text, pageContext: null, threadId }) });
  const body = (await res.json()) as Record<string, unknown>;
  const runId = String(body.runId ?? "");
  const rt = weft.agent as unknown as { settled?: (id: string) => Promise<unknown> };
  if (res.status === 202 && typeof rt.settled === "function") await rt.settled(runId);
  return { status: res.status, runId, body };
}
async function list<T = AgentRunRow>(query: string, who = DANA): Promise<{ status: number; data: T[]; raw: Record<string, unknown> }> {
  const res = await weft.app.request(`/v1/agent/runs${query}`, { headers: weft.uiHeaders(who) });
  const raw = (await res.json()) as Record<string, unknown>;
  return { status: res.status, data: (raw.data ?? []) as T[], raw };
}
async function packOf(runId: string): Promise<string> {
  const res = await weft.app.request(`/v1/agent/runs/${runId}/trace`, { headers: weft.uiHeaders(DANA) });
  const t = (await res.json()) as RunTrace;
  return String((t.steps.find((s) => s.kind === "context")?.result as { text?: string } | null)?.text ?? "");
}
const earlierOf = (pack: string) => { const i = pack.indexOf("<earlier_conversation"); return i < 0 ? "" : pack.slice(i, pack.indexOf("</earlier_conversation>") + 23); };
const row = async (runId: string) => (await weft.db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1))[0]!;
const taintOf = async (runId: string) => (await weft.db.select().from(runTaint).where(eq(runTaint.runId, runId)).limit(1))[0];

beforeAll(async () => { weft = await createTestWeft(); }, 120_000);
afterAll(async () => { await weft.close(); });

describe("POST /v1/agent/runs with a threadId", () => {
  it("records the thread on the run; the side panel's null leaves it empty", async () => {
    const t = thread();
    const a = await ask("Show payroll cost by month", t);
    expect(a.status).toBe(202);
    expect(a.body.threadId).toBe(t);
    expect((await row(a.runId)).threadId).toBe(t);
    const panel = await ask("Show payroll cost by month", null);
    expect(panel.body.threadId).toBeUndefined();
    expect((await row(panel.runId)).threadId).toBeNull();
    expect(earlierOf(await packOf(panel.runId))).toBe("");
  });

  it("refuses a malformed thread id", async () => {
    for (const bad of ["thr_x", "run_0001", "thr_has spaces in it", `thr_${"a".repeat(41)}`]) {
      expect((await ask("Hello", bad)).status, bad).toBe(400);
    }
  });

  it("a follow-up reads the earlier question and final answer, labeled, and never a tool result", async () => {
    const t = thread();
    const first = await ask("Why is the NY raise flagged in the Oct 30 payroll?", t);
    const firstTrace = (await (await weft.app.request(`/v1/agent/runs/${first.runId}/trace`, { headers: weft.uiHeaders(DANA) })).json()) as RunTrace;
    expect(firstTrace.run.status).toBe("done");
    const toolSummaries = firstTrace.steps.filter((s) => s.kind === "tool_call").map((s) => (s.result as { outcome?: { summary?: string } } | null)?.outcome?.summary ?? "").filter(Boolean);
    expect(toolSummaries.length).toBeGreaterThan(0);
    const follow = await ask("And who approves it?", t);
    const block = earlierOf(await packOf(follow.runId));
    expect(block).toContain('<earlier_conversation turns="1">');
    expect(block).toContain("<question>Why is the NY raise flagged in the Oct 30 payroll?</question>");
    expect(block).toContain("<answer>");
    for (const s of toolSummaries) expect(block, s).not.toContain(s);
    expect(block).not.toMatch(/\bres_\d+/);
    expect(block).not.toContain("payroll__get_run");
    // The run on the side panel (no thread) in between is not part of the thread.
    expect(block).not.toContain("Show payroll cost by month");
  });

  it("holds at most the last three turns and about 2,000 characters", async () => {
    const t = thread();
    for (const word of ["alpha", "bravo", "charlie", "delta"]) await ask(`Tell me about ${word} ${"padding ".repeat(80)}`, t);
    const last = await ask("And now?", t);
    const block = earlierOf(await packOf(last.runId));
    expect(block).toContain('turns="3"');
    expect(block).not.toContain("about alpha");
    for (const w of ["bravo", "charlie", "delta"]) expect(block).toContain(`about ${w}`);
    const text = [...block.matchAll(/<(question|answer)>([\s\S]*?)<\/\1>/g)].reduce((s, m) => s + m[2]!.length, 0);
    expect(text).toBeLessThanOrEqual(2_000 * 1.1);   // escaped text: an & or < reads longer than it counts
  });

  it("another person cannot follow up in someone else's thread", async () => {
    const t = thread();
    await ask("Show payroll cost by month", t, DANA);
    const theo = await ask("What did Vic ask?", t, THEO);
    expect(theo.status).toBe(404);
    expect(String((theo.body as { message?: string }).message)).toContain(t);
  });
});

describe("taint across a thread (harness 6.2)", () => {
  it("an untainted thread's follow-up is untainted", async () => {
    const t = thread();
    await ask("Show payroll cost by month", t);
    const follow = await ask("Thanks", t);
    expect((await taintOf(follow.runId))?.tainted).toBe(false);
    expect((await row(follow.runId)).tainted).toBe(false);
  });

  it("a tainted earlier turn taints the follow-up as thread:<id> and contributes neither its question nor its answer", async () => {
    const t = thread();
    const first = await ask("Show payroll cost by month", t);
    await executorInternals(weft.executor)!.taintRun(first.runId, "chat:simc_0001");
    const follow = await ask("And for September?", t);
    const taint = await taintOf(follow.runId);
    expect(taint?.tainted).toBe(true);
    expect(taint?.taintedBy).toBe(`thread:${t}`);
    expect((await row(follow.runId)).tainted).toBe(true);
    expect(earlierOf(await packOf(follow.runId))).toBe("");
    // The taint stays with the thread: a later turn is tainted too, even though the follow-up only inherited it.
    const later = await ask("One more", t);
    expect((await taintOf(later.runId))?.taintedBy).toBe(`thread:${t}`);
  });

  it("the executor's run_taint row counts even when the agent_runs mirror says untainted", async () => {
    const t = thread();
    const first = await ask("Show payroll cost by month", t);
    await weft.db.update(runTaint).set({ tainted: true, taintedBy: "notice:ntc_9999", sinceStep: 1 }).where(eq(runTaint.runId, first.runId));
    expect((await row(first.runId)).tainted).toBe(false);
    const follow = await ask("And for September?", t);
    expect((await taintOf(follow.runId))?.taintedBy).toBe(`thread:${t}`);
    expect(earlierOf(await packOf(follow.runId))).toBe("");
  });
});

describe("GET /v1/agent/runs filters", () => {
  let danaThread: string;
  let theoRun: string;
  beforeAll(async () => {
    danaThread = thread();
    await ask("Show payroll cost by month", danaThread, DANA);
    await ask("Why is the NY raise flagged in the Oct 30 payroll?", danaThread, DANA);
    theoRun = (await ask("Show payroll cost by month", null, THEO)).runId;
    const res = await weft.app.request("/v1/sim/notices/deliver", { method: "POST", headers: { ...weft.uiHeaders(DANA), "content-type": "application/json" }, body: JSON.stringify({ scenario: "ca_de2088_rate_change" }) });
    expect(res.status).toBe(200);
    const rt = weft.agent as unknown as { idle?: () => Promise<void> };
    await rt.idle?.();
  }, 120_000);

  it("thread_id lists that conversation, with each run's question", async () => {
    const r = await list<ConversationRunRow>(`?thread_id=${danaThread}`);
    expect(r.status).toBe(200);
    expect(r.data).toHaveLength(2);
    expect(r.data.every((x) => x.threadId === danaThread && x.askedFrom === "agent")).toBe(true);
    expect(r.data.map((x) => x.question).sort()).toEqual(["Show payroll cost by month", "Why is the NY raise flagged in the Oct 30 payroll?"]);
  });

  it("trigger=chat lists only the viewer's own conversations; trigger=background lists routine and notice runs", async () => {
    const chats = await list<ConversationRunRow>("?trigger=chat&limit=100");
    expect(chats.data.length).toBeGreaterThan(0);
    expect(chats.data.every((x) => x.trigger === "chat")).toBe(true);
    expect(chats.data.some((x) => x.id === theoRun)).toBe(false);
    expect(chats.data.every((x) => "question" in x)).toBe(true);
    const theo = await list<ConversationRunRow>("?trigger=chat&limit=100", THEO);
    expect(theo.data.map((x) => x.id)).toContain(theoRun);
    const bg = await list("?trigger=background&limit=100");
    expect(bg.data.length).toBeGreaterThan(0);
    expect(bg.data.every((x) => x.trigger.startsWith("routine:"))).toBe(true);
    expect(bg.data.some((x) => (x.cacheKey ?? "").includes("rt_agency_notice"))).toBe(true);
    // Unfiltered, the list is as before: every run the viewer may read, without the conversation fields.
    const all = await list("?limit=100");
    expect(all.data.some((x) => x.id === theoRun)).toBe(true);
    expect(all.data.every((x) => !("question" in x))).toBe(true);
    expect(all.data.length).toBeGreaterThanOrEqual(chats.data.length + bg.data.length);
  });

  it("another person's thread reads as empty, and a manager's background work keeps her run scope", async () => {
    expect((await list(`?thread_id=${danaThread}`, THEO)).data).toEqual([]);
    const danaBg = await list("?trigger=background&limit=100");
    const imaniBg = await list("?trigger=background&limit=100", IMANI);
    expect(imaniBg.status).toBe(200);
    expect(imaniBg.data.length).toBeLessThan(danaBg.data.length);
    const imaniAll = new Set((await list("?limit=100", IMANI)).data.map((x) => x.id));
    expect(imaniBg.data.every((x) => imaniAll.has(x.id))).toBe(true);
  });

  it("refuses an unknown trigger or a malformed thread_id", async () => {
    expect((await list("?trigger=routine")).status).toBe(400);
    expect((await list("?thread_id=nope")).status).toBe(400);
  });
});
