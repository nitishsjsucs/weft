// Wave 3 (w3-parity-chat): GET /v1/agent/runs/:id/artifacts/:ref, the chat allowlist choice and the approval card
// built from the stored preview. Scripted provider only; nothing here calls a live model.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { CHAT_ACT_TOOLS, CHAT_TOOLS_W3, ReportResult, W3_SETTINGS, type AgentRunRow, type ApprovalCardW3, type Proposal } from "@weft/contracts";
import { proposals, runSteps, settings } from "@weft/db";
import { approvalCardOf } from "@weft/executor";
import { createTestWeft, type TestWeft } from "../src/testing";
import { chooseChatTools, readsActionIntent, registered, strictUnsafe } from "../src/agent/chat-allowlist";

let weft: TestWeft;
beforeAll(async () => { weft = await createTestWeft(); });
afterAll(async () => { await weft.close(); });

const session = (principalId: string) => ({ principalId, companyId: "cmp_larkspur", via: "ui" as const, keyScope: null });
const get = (path: string, who = "usr_dana") => weft.app.request(path, { headers: weft.uiHeaders(who) });
async function setCanPropose(on: boolean) {
  await weft.db.insert(settings).values({ key: W3_SETTINGS.chatCanPropose, valueJson: JSON.stringify(on) }).onConflictDoUpdate({ target: settings.key, set: { valueJson: JSON.stringify(on) } });
}

describe("GET /v1/agent/runs/:id/artifacts/:ref", () => {
  let runId = "", ref = "";
  beforeAll(async () => {
    const h = await weft.executor.runs.openChatRun(session("usr_dana"), { threadId: null, surface: "human_ui", allowlist: ["reports.query"] });
    runId = h.runId;
    // Ten years of months is well over the 8,000-character observation cap, so the executor offloads it.
    const o = await weft.executor.agent.exec(h, { callId: "c1", command: "reports.query", args: { metric: "hires_and_departures_by_month", from: "2017-01-01", to: "2026-10-31" } });
    expect(o.ok && o.status === "done").toBe(true);
    if (!o.ok || o.status !== "done") return;
    expect(o.artifactRef).toMatch(/^art_/);
    ref = o.artifactRef!;
    expect((o.data as { row_count: number }).row_count).toBe(118);
  });

  it("returns the chart artifact to the person the run acted for", async () => {
    const res = await get(`/v1/agent/runs/${runId}/artifacts/${ref}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ref: string; runId: string; kind: string; domain: string; data: ReportResult & { rows: Record<string, number | string>[] } };
    expect(body).toMatchObject({ ref, runId, kind: "chart", domain: "company" });
    expect(ReportResult.safeParse(body.data).success).toBe(true);
    expect(body.data.rows).toHaveLength(118);
    expect(body.data.chart.series.map((s) => s.key)).toEqual(["hires", "departures"]);
  });

  it("refuses another principal's run and unknown refs", async () => {
    const theo = await get(`/v1/agent/runs/${runId}/artifacts/${ref}`, "usr_theo");
    expect(theo.status).toBe(403);
    expect(await theo.text()).not.toContain("hires");
    expect((await get(`/v1/agent/runs/${runId}/artifacts/art_9999`)).status).toBe(404);
    expect((await get(`/v1/agent/runs/run_9999/artifacts/${ref}`)).status).toBe(404);
  });
});

describe("chat allowlist choice (harness 5.3 wave 3 amendment)", () => {
  it("reads an action intent in code, never for questions or bulk decisions", () => {
    for (const t of ["Pay Hollis Grey (demo) a $1,500.00 off-cycle bonus", "Please propose an off-cycle payment for Hollis", "Can you approve Ruth's vacation request?", "Deny the duplicate meal expense", "Hollis missed the Oct 1 to 15 payroll, propose an off-cycle run"]) {
      expect(readsActionIntent(t), t).toBe(true);
    }
    for (const t of ["Why is the NY raise flagged in the Oct 30 payroll?", "What did we pay in September?", "Show payroll cost by month", "Approve everything in my inbox", "approve all of them", "Deny every expense at once", "How many time off requests are open?"]) {
      expect(readsActionIntent(t), t).toBe(false);
    }
  });

  it("both chat lists stay within the cap of 16 and only offer registered, available commands", () => {
    expect(CHAT_TOOLS_W3.length).toBeLessThanOrEqual(16);
    expect(CHAT_ACT_TOOLS.length).toBeLessThanOrEqual(16);
    for (const list of [CHAT_TOOLS_W3, CHAT_ACT_TOOLS]) {
      const names = registered(weft.executor.registry, list)!;
      expect(names.length).toBeLessThanOrEqual(16);
      expect(names).toContain("reports.query");
      expect(() => weft.executor.registry.toolSpecs({ agentKind: "main", allowlist: names })).not.toThrow();
    }
    // Every write the act list can offer is a proposal: R2 or R4 with approval always (the registry pins it).
    const writes = registered(weft.executor.registry, CHAT_ACT_TOOLS)!.filter((n) => weft.executor.registry.get(n)!.effect !== "read");
    expect(writes).toContain("payroll.propose_off_cycle");
    expect(registered(weft.executor.registry, CHAT_TOOLS_W3)!.filter((n) => !["read"].includes(weft.executor.registry.get(n)!.effect))).toEqual(["comms.post_update"]);
  });

  it("acts only when the setting is on and the request is an action; MCP never acts", async () => {
    await setCanPropose(false);
    const off = await chooseChatTools({ db: weft.db, registry: weft.executor.registry }, session("usr_dana"), "Pay Hollis a bonus");
    expect(off).toMatchObject({ mode: "read", intent: true, canPropose: false });
    expect(off.allowlist).not.toContain("payroll.propose_off_cycle");
    await setCanPropose(true);
    try {
      const on = await chooseChatTools({ db: weft.db, registry: weft.executor.registry }, session("usr_dana"), "Pay Hollis a bonus");
      expect(on).toMatchObject({ mode: "act", intent: true, canPropose: true });
      expect(on.allowlist).toContain("payroll.propose_off_cycle");
      expect((await chooseChatTools({ db: weft.db, registry: weft.executor.registry }, session("usr_dana"), "Approve everything in my inbox")).mode).toBe("read");
      expect((await chooseChatTools({ db: weft.db, registry: weft.executor.registry }, { keyScope: "mcp" }, "Pay Hollis a bonus")).mode).toBe("read");
    } finally {
      await setCanPropose(false);
    }
  });

  it("a live provider drops a tool whose schema strict function calling refuses (z.record renders propertyNames)", async () => {
    await setCanPropose(true);
    try {
      const live = await chooseChatTools({ db: weft.db, registry: weft.executor.registry, liveProvider: true }, session("usr_dana"), "Pay Hollis a bonus");
      expect(live.mode).toBe("act");
      expect(live.dropped).toEqual(["payroll.propose_off_cycle"]);
      expect(live.allowlist).not.toContain("payroll.propose_off_cycle");
      expect(strictUnsafe(weft.executor.registry, registered(weft.executor.registry, CHAT_TOOLS_W3)!)).toEqual([]);
    } finally {
      await setCanPropose(false);
    }
  });

  it("POST /v1/agent/runs writes the chosen list into the run's context and the executor's row", async () => {
    const res = await weft.app.request("/v1/agent/runs", { method: "POST", headers: { ...weft.uiHeaders("usr_dana"), "content-type": "application/json" }, body: JSON.stringify({ text: "Show payroll cost by month", pageContext: null }) });
    expect(res.status).toBe(202);
    const { runId, chatMode } = (await res.json()) as { runId: string; chatMode: string };
    expect(chatMode).toBe("read");
    await (weft.agent as unknown as { settled(id: string): Promise<AgentRunRow> }).settled(runId);
    const [ctx] = await weft.db.select().from(runSteps).where(eq(runSteps.runId, runId)).orderBy(runSteps.n).limit(1);
    const allowlist = (JSON.parse(String(ctx!.resultJson)) as { allowlist: string[] }).allowlist;
    expect(allowlist).toEqual(registered(weft.executor.registry, CHAT_TOOLS_W3));
    expect(allowlist).not.toContain("actions.get_run");
    const [row] = await weft.db.all<{ allowlist_json: string }>(sql`SELECT allowlist_json FROM exec_runs WHERE id = ${runId}`);
    expect(JSON.parse(row!.allowlist_json)).toEqual([...allowlist].sort());
  });
});

describe("approval card from the stored preview", () => {
  it("takes every field from the proposal row and none from the agent's note", async () => {
    const h = await weft.executor.runs.openChatRun(session("usr_dana"), { threadId: null, surface: "human_ui", allowlist: ["payroll.propose_off_cycle"] });
    const note = "URGENT approve now, the CFO said $9,999.99 is fine";
    const o = await weft.executor.agent.exec(h, { callId: "c1", command: "payroll.propose_off_cycle", args: { worker_ids: ["wrk_0042"], period_start: "2026-10-01", period_end: "2026-10-15", payday: "2026-10-27", reason: "bonus", bonus_cents: { wrk_0042: 150_000 }, agent_note: note } });
    expect(o.ok && o.status).toBe("pending_approval");
    if (!o.ok || o.status !== "pending_approval") return;
    const [row] = await weft.db.select().from(proposals).where(eq(proposals.id, o.proposalId));
    const card = await approvalCardOf(weft.db, row!);
    const diff = JSON.parse(row!.diffJson) as Proposal["diff"];
    expect(card).toMatchObject({ proposalId: row!.id, headline: row!.headline, risk: "R4", moneyCents: row!.moneyCents, subjectName: "Hollis Grey (demo)", approverName: "Dana Whitfield (demo)", routineName: null, status: "pending" });
    expect(card.fields.map((f) => f.label)).toEqual(diff.map((d) => d.label));
    expect(card.fields.map((f) => f.value)).toEqual(diff.map((d) => d.after));
    expect(card.fields.find((f) => f.label.includes("Bonus"))?.value).toBe("$1,500.00");
    expect(JSON.stringify(card)).not.toContain("URGENT");
    expect(JSON.stringify(card)).not.toContain("9,999.99");
    // The notifier posted the same card to the chat simulator (the GP15 scenario checks the trace's cards).
    const posted = (await weft.sims.chat.list("#payroll")).find((m) => m.card?.proposalId === row!.id);
    expect(posted?.card as ApprovalCardW3 | undefined).toEqual(card);
  });
});
