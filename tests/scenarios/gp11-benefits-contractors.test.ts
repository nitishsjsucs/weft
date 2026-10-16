// Scenario GP11 (docs/wave2.md). Owner: w2-benefits-contractors. Scripted provider, createTestWeft(): the carrier
// issues the October invoice with three planted errors, reconciliation lists exactly those findings with billed,
// expected and deducted cents (idempotently) and a dispute through the API becomes a proposal; the open enrollment
// chase routine reminds non-electors in #general; contractor payouts convert through the fixed FX table and move
// pending, sent and delivered on the sim clock through the payment rail simulator.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { AgentRunRow, ContractorPayout, ReconFinding, RoutineRun } from "@weft/contracts";
import { contractorPayments, events, proposals, routines, simChatMessages } from "@weft/db";
import { DEFAULT_SCRIPTS_DIR, scriptedProvider } from "../../packages/agent/src/index";
import { OPEN_ENROLLMENT_CLOSES, RT_OPEN_ENROLLMENT } from "../../packages/routines/src/wave2/benefits";
import { createTestWeft, type TestWeft } from "./helpers";

let weft: TestWeft;
const OE_SCRIPT = {
  agents: {
    main: [
      { output: [{ type: "function_call" as const, name: "comms__send_message", arguments: "{{derived.comms.send_message}}" }] },
      { output: [{ type: "text" as const, text: "Reminded everyone who has not chosen yet in #general." }] },
    ],
  },
};
beforeAll(async () => {
  weft = await createTestWeft({ provider: scriptedProvider({ scriptsDir: DEFAULT_SCRIPTS_DIR, scripts: { rt_open_enrollment: OE_SCRIPT } }) });
});
afterAll(async () => { await weft?.close(); });

const get = (path: string, who = "usr_dana") => weft.app.request(path, { headers: weft.uiHeaders(who) });
const post = (path: string, body: unknown, who = "usr_dana") => weft.app.request(path, { method: "POST", headers: { ...weft.uiHeaders(who), "content-type": "application/json" }, body: JSON.stringify(body) });
const apiKey = () => readFileSync(join(weft.dataDir, "demo-mcp-key.txt"), "utf8").trim();
const viaKey = (path: string, body: unknown) => weft.app.request(path, { method: "POST", headers: { "x-api-key": apiKey(), "content-type": "application/json" }, body: JSON.stringify(body) });

describe("GP11 benefits reconciliation and contractor payouts", () => {
  it("reconciliation lists exactly the three planted errors, idempotently, and a dispute is a proposal", async () => {
    const run = await (await post("/v1/benefits/reconciliation/run", { month: "2026-10" })).json() as { ok: boolean; data: { count: number; invoice_lines: number } };
    expect(run).toMatchObject({ ok: true, data: { count: 3 } });
    const billable = await weft.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM benefit_enrollments e JOIN benefit_plans p ON p.id = e.plan_id WHERE e.status = 'active' AND p.type IN ('medical', 'dental', 'vision')`);
    expect(run.data.invoice_lines).toBe(billable[0]!.n);   // every medical, dental and vision enrollment is on the bill (38 + 34 + 30 on the wave 1 seed)
    const findings = (await (await get("/v1/benefits/reconciliation?month=2026-10")).json()) as ReconFinding[];
    expect(findings.map((f) => [f.kind, f.billedCents, f.expectedCents, f.deductedCents])).toEqual([
      ["terminated_but_billed", 21_200, 10_600, 21_200],
      ["missing_dependent", 62_000, 19_000, 19_000],
      ["wrong_tier", 19_000, 62_000, 62_000],
    ]);
    const again = await (await post("/v1/benefits/reconciliation/run", { month: "2026-10" })).json() as { data: { created: number; count: number } };
    expect(again.data).toMatchObject({ created: 0, count: 3 });
    expect(((await (await get("/v1/benefits/reconciliation")).json()) as unknown[]).length).toBe(3);

    const dispute = await (await viaKey("/v1/tools/benefits__dispute_finding", { finding_id: findings[0]!.id })).json() as { status: string; proposalId: string };
    expect(dispute.status).toBe("pending_approval");
    const [p] = await weft.db.select().from(proposals).where(eq(proposals.id, dispute.proposalId));
    expect(p).toMatchObject({ command: "benefits.dispute_finding", status: "pending", subjectRef: findings[0]!.id });
  });

  it("the open enrollment chase routine reminds non-electors in #general", async () => {
    const rows = (await (await get("/v1/benefits/open-enrollment")).json()) as { name: string; status: string }[];
    const waiting = rows.filter((r) => r.status === "not_started" || r.status === "in_progress");
    expect(waiting.length).toBeGreaterThan(0);
    expect(RT_OPEN_ENROLLMENT.enabled).toBe(false);
    expect(RT_OPEN_ENROLLMENT.tools.length).toBeLessThanOrEqual(8);
    // The routine is in PREBUILT; the insert is a no-op when the engine already seeded its row.
    const r = RT_OPEN_ENROLLMENT;
    await weft.db.insert(routines).values({
      id: r.id, companyId: "cmp_larkspur", name: r.name, description: r.description, ownerPrincipalId: r.ownerPrincipalId, enabled: r.enabled, autonomy: r.autonomy,
      triggerJson: JSON.stringify(r.trigger), filterJson: null, instructions: r.instructions, toolsJson: JSON.stringify(r.tools), precheck: r.precheck,
      checklistJson: JSON.stringify(r.checklist), budgetJson: JSON.stringify(r.budget), surfaceJson: JSON.stringify(r.surface), source: r.source, taintedBy: null, createdAt: weft.clock.now(),
    }).onConflictDoNothing();
    const trig = await (await post(`/v1/routines/${r.id}/trigger`, {})).json() as { routineRunId: string };
    expect(trig.routineRunId).toMatch(/^rtr_/);
    const page = (await (await get(`/v1/routines/${r.id}/runs`)).json()) as { data: RoutineRun[] };
    const rr = page.data[0]!;
    const agentRun = await (weft.agent as unknown as { settled(id: string): Promise<AgentRunRow> }).settled(rr.agentRunId!);
    expect(agentRun).toMatchObject({ status: "done", tainted: false });
    const chat = await weft.db.select().from(simChatMessages).where(eq(simChatMessages.channel, "#general"));
    const reminder = chat.find((m) => m.text.startsWith("Open enrollment reminder:"));
    expect(reminder, JSON.stringify(chat.map((m) => m.text))).toBeTruthy();
    for (const w of waiting) expect(reminder!.text).toContain(w.name);
    expect(rows.filter((x) => x.status === "elected").some((x) => reminder!.text.includes(x.name))).toBe(false);
    expect(OPEN_ENROLLMENT_CLOSES).toBe("2026-11-13");
  });

  it("contractor payouts convert through the fixed FX table and move pending, sent, delivered on the sim clock", async () => {
    const proposal = await (await viaKey("/v1/tools/contractors__schedule_payouts", { worker_ids: ["wrk_0049", "wrk_0050", "wrk_0051"], scheduled_for: "2026-10-30" })).json() as { status: string; proposalId: string };
    expect(proposal.status).toBe("pending_approval");
    expect((await post(`/v1/proposals/${proposal.proposalId}/approve`, {})).status).toBe(200);
    const booked = await weft.db.select().from(contractorPayments);
    expect(booked.map((b) => [b.currency, b.fxRate, b.usdCents, b.railStatus])).toEqual([["EUR", "1.08", 702_000, "pending"], ["INR", "0.012", 492_000, "pending"], ["CAD", "0.73", 715_400, "pending"]]);
    const list = async () => ((await (await get("/v1/contractors/payouts")).json()) as { data: ContractorPayout[] }).data.map((p) => p.railStatus);
    expect(await list()).toEqual(["sent", "sent", "sent"]);
    await weft.clock.advance("2026-10-28T15:29:00.000Z");
    expect(await list()).toEqual(["sent", "sent", "sent"]);
    await weft.clock.advance("2026-10-28T15:31:00.000Z");
    expect(await list()).toEqual(["delivered", "delivered", "delivered"]);
    expect(await weft.db.select().from(events).where(eq(events.type, "sim.rail_delivered"))).toHaveLength(3);
  });
});
