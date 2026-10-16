// Regression tests for the round 2 review: the frozen run allowlist (harness 5.3), proposal expiry finalizing the
// proposing runs, and routines.enable and routines.disable emitting known events.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { CHAT_TOOLS, type AgentRunRow } from "@weft/contracts";
import { agentRuns, paychecks, proposals, routineRuns, routines } from "@weft/db";
import { createTestWeft, type TestWeft } from "./helpers";

let weft: TestWeft;
beforeEach(async () => { weft = await createTestWeft(); expect(weft.stubs, "stubbed parts").toEqual([]); });
afterEach(async () => { await weft?.close(); });

const post = (path: string, body: unknown, who = "usr_dana") => weft.app.request(path, { method: "POST", headers: { ...weft.uiHeaders(who), "content-type": "application/json" }, body: JSON.stringify(body) });
const settled = (runId: string) => (weft.agent as unknown as { settled(id: string): Promise<AgentRunRow> }).settled(runId);
const dana = { principalId: "usr_dana", companyId: "cmp_larkspur", via: "ui" as const, keyScope: null };

describe("run allowlist", () => {
  it("a chat run cannot call a tool it was not given", async () => {
    const h = await weft.executor.runs.openChatRun(dana, { threadId: null, surface: "human_ui", allowlist: CHAT_TOOLS });
    const send = await weft.executor.agent.exec(h, { callId: "1", command: "comms__send_message", args: { channel: "#general", text: "Payroll is cancelled this week." } });
    expect(send).toMatchObject({ ok: false, refusal: { code: "UNAVAILABLE" } });
    const note = await weft.executor.agent.exec(h, { callId: "2", command: "memory__write_note", args: { path: "knowledge/procedures/x.md", title: "x", body: "1. x", sources: [] } });
    expect(note).toMatchObject({ ok: false, refusal: { code: "UNAVAILABLE" } });
    expect(await weft.executor.agent.exec(h, { callId: "3", command: "people__search", args: { query: "Dana" } })).toMatchObject({ ok: true });
    const sent = await weft.db.all<{ text: string }>(`SELECT text FROM sim_chat_messages` as never);
    expect(sent.map((m) => m.text)).not.toContain("Payroll is cancelled this week.");
  });

  it("a routine run is limited to the routine's tools", async () => {
    await weft.scheduler.tick();   // seeds the prebuilt routines
    const h = await weft.executor.runs.openRoutineRun({ routineId: "rt_pre_payroll", routineRunId: "rtr_9001", triggerRef: "manual", attended: false });
    const out = await weft.executor.agent.exec(h, { callId: "1", command: "it__create_account", args: { worker_id: "wrk_0001", app: "slack" } });
    expect(out).toMatchObject({ ok: false, refusal: { code: "UNAVAILABLE" } });
  });
});

describe("proposal expiry", () => {
  it("finalizes the agent run and the routine run that made the proposals", async () => {
    const res = await post("/v1/sim/notices/deliver", { scenario: "ca_de2088_rate_change" });
    expect(res.status, await res.clone().text()).toBe(200);
    let agentRunId: string | null = null;
    for (let i = 0; i < 20 && !agentRunId; i++) {
      await weft.scheduler.tick();
      const [rr] = await weft.db.select().from(routineRuns).where(eq(routineRuns.routineId, "rt_agency_notice"));
      agentRunId = rr?.agentRunId ?? null;
    }
    expect(agentRunId).not.toBeNull();
    expect(await settled(agentRunId!)).toMatchObject({ status: "waiting" });
    const adv = await post("/v1/sim/clock/advance", { by: "PT73H" });
    expect(adv.status, await adv.clone().text()).toBe(200);
    for (let i = 0; i < 5; i++) await weft.scheduler.tick();
    const open = (await weft.db.select().from(proposals)).filter((p) => p.proposerRunId === agentRunId);
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((p) => p.status === "expired")).toBe(true);
    const run = await settled(agentRunId!);
    expect(run.status).not.toBe("waiting");
    const [rr] = await weft.db.select().from(routineRuns).where(eq(routineRuns.routineId, "rt_agency_notice"));
    expect(rr?.status).not.toBe("waiting_approval");
    expect(rr?.endedAt).not.toBeNull();
    const [ar] = await weft.db.select().from(agentRuns).where(eq(agentRuns.id, agentRunId!));
    expect(ar?.endedAt).not.toBeNull();
    expect(JSON.parse(rr?.leftForHumanJson ?? "[]")).toEqual([]);
    // The routines engine reads decisions this way (not from memory), so a restart keeps them.
    const view = await weft.executor.readOnly.exec("cmp_larkspur", "actions.get_run", { run_id: agentRunId });
    expect(view.ok && view.status === "done" && (view.data as { proposals: { status: string }[] }).proposals.map((p) => p.status)).toEqual(open.map(() => "expired"));
  });
});

describe("routine enable and disable", () => {
  it("approving a drafted routine's enable proposal enables it, and disable turns a prebuilt routine off", async () => {
    const res = await post("/v1/routines/draft", { prompt: "Every Friday, post open approvals to #payroll" });
    expect(res.status, await res.clone().text()).toBe(200);
    const [card] = (await weft.db.select().from(proposals)).filter((p) => p.kind === "routine_enable" && p.status === "pending");
    expect(card).toBeTruthy();
    const ok = await post(`/v1/proposals/${card!.id}/approve`, { reasonCode: null, note: null });
    expect(ok.status, await ok.clone().text()).toBe(200);
    const [r] = await weft.db.select().from(routines).where(eq(routines.id, card!.subjectRef!));
    expect(r?.enabled).toBe(true);
    const off = await post("/v1/routines/rt_people_digest/disable", {});
    expect(off.status, await off.clone().text()).toBe(200);
    const [d] = await weft.db.select().from(routines).where(eq(routines.id, "rt_people_digest"));
    expect(d?.enabled).toBe(false);
  });
});

describe("rate change refreshes open drafts", () => {
  it("an approved CA SUI change is applied to the open Oct 30 draft before anyone submits it", async () => {
    const res = await post("/v1/sim/notices/deliver", { scenario: "ca_de2088_rate_change" });
    expect(res.status, await res.clone().text()).toBe(200);
    let rate: typeof proposals.$inferSelect | undefined;
    for (let i = 0; i < 20 && !rate; i++) {
      await weft.scheduler.tick();
      const [rr] = await weft.db.select().from(routineRuns).where(eq(routineRuns.routineId, "rt_agency_notice"));
      if (rr?.agentRunId) await settled(rr.agentRunId);
      rate = (await weft.db.select().from(proposals)).find((p) => p.command === "tax.update_rate" && p.status === "pending");
    }
    expect(rate).toBeTruthy();
    const ok = await post(`/v1/proposals/${rate!.id}/approve`, { reasonCode: null, note: null });
    expect(ok.status, await ok.clone().text()).toBe(200);
    const rows = await weft.db.select().from(paychecks).where(eq(paychecks.payrollRunId, "pay_2026_10_30"));
    const sui = rows.flatMap((r) => (JSON.parse(r.taxesJson) as { code: string; jurisdiction: string; payer: string; rate: string | null; amount_cents: number }[])
      .filter((t) => t.code === "sui" && t.jurisdiction === "CA" && t.payer === "employer"));
    expect(sui.length).toBeGreaterThan(0);
    expect(new Set(sui.map((t) => t.rate))).toEqual(new Set(["0.015"]));
  });
});

describe("ui-only commands through /v1/tools", () => {
  it("an admin API key cannot toggle a routine through the generic tool route", async () => {
    await weft.scheduler.tick();
    const admin = readFileSync(join(weft.dataDir, "demo-api-key.txt"), "utf8").trim();
    const res = await weft.app.request("/v1/tools/routines__disable", { method: "POST", headers: { "x-api-key": admin, "content-type": "application/json" }, body: JSON.stringify({ routine_id: "rt_people_digest" }) });
    expect(await res.json()).toMatchObject({ ok: false, refusal: { code: "NOT_PERMITTED" } });
    const [d] = await weft.db.select().from(routines).where(eq(routines.id, "rt_people_digest"));
    expect(d?.enabled).toBe(true);
  });
});
