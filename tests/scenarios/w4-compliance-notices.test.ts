// Wave 4 compliance scenarios (w4-parity-compliance), scripted provider. Wave 4 round 1 (FG1): rt_compliance_notices is
// folded into rt_agency_notice, which is enabled and plays scenarios/rt_agency_notice.<plan>.json for the plan its
// precheck derives. Every seeded notice kind reaches its NOTICE_HANDLING branch; escalation is notices.escalate with
// the evidence pack; an informational kind is skipped with its reason. The due-soon reminder routine posts the
// calendar to #payroll; it ships disabled and the test enables it in its own world.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { AgentRunRow, RoutineRun } from "@weft/contracts";
import { NOTICE_HANDLING } from "@weft/contracts";
import { emitEvent } from "@weft/core";
import { filings, notices, proposals, routineRuns, simChatMessages, taxAccounts } from "@weft/db";
import { scriptedProvider } from "../../packages/agent/src/providers/scripted";
import { defaultScriptsDir } from "../../packages/agent/src/providers/factory";
import { complianceNoticeVariant } from "../../packages/core/src/compliance/script-variant";
import { PREBUILT } from "../../packages/routines/src/prebuilt";
import { createTestWeft, type TestWeft } from "./helpers";

let weft: TestWeft;
beforeAll(async () => {
  const variant = (info: { routineId: string; trigger: Record<string, unknown> }) => complianceNoticeVariant(weft.db)(info);
  weft = await createTestWeft({ provider: scriptedProvider({ scriptsDir: defaultScriptsDir(), variant }) });
  await weft.scheduler.tick();   // seeds the prebuilt routines
});
const NOTICE_ROUTINE = "rt_agency_notice";
afterAll(async () => {
  const engine = weft.routines as unknown as { drain(ms?: number): Promise<boolean> };
  await engine.drain(5_000);
  await weft?.close();
});

const post = (path: string, body: unknown, who = "usr_dana") => weft.app.request(path, { method: "POST", headers: { ...weft.uiHeaders(who), "content-type": "application/json" }, body: JSON.stringify(body) });
const settled = (runId: string) => (weft.agent as unknown as { settled(id: string): Promise<AgentRunRow> }).settled(runId);

/** Runs the scheduler until rt_agency_notice has handled `noticeId`, then returns its run and the run's proposals. */
async function handled(noticeId: string) {
  for (let i = 0; i < 25; i++) {
    await weft.scheduler.tick();
    const runs = await weft.db.select().from(routineRuns).where(eq(routineRuns.routineId, NOTICE_ROUTINE));
    const rr = runs.find((r) => JSON.stringify(r.precheckJson ?? "").includes(noticeId));
    if (!rr) continue;
    if (!rr.agentRunId) return { rr, run: null, open: [] as (typeof proposals.$inferSelect)[] };
    const run = await settled(rr.agentRunId);
    await (weft.routines as unknown as { drain(ms?: number): Promise<boolean> }).drain(5_000);
    const [after] = await weft.db.select().from(routineRuns).where(eq(routineRuns.id, rr.id));
    const open = (await weft.db.select().from(proposals)).filter((p) => p.status === "pending" && p.proposerRunId === rr.agentRunId);
    return { rr: after!, run, open };
  }
  throw new Error(`${NOTICE_ROUTINE} never ran for ${noticeId}`);
}

/** A notice of a kind the simulator has no scenario for, stored with structured fields, then notice.received. */
async function insertNotice(kind: string, extra: { formCode: string; agency: string; period?: string | null; taxAccountId: string | null }) {
  const n = (await weft.db.select().from(notices)).length + 1;
  const id = `ntc_${String(900 + n).padStart(4, "0")}`;
  const now = weft.clock.now();
  await weft.db.insert(notices).values({
    id, companyId: "cmp_larkspur", agency: extra.agency, kind, formCode: extra.formCode, title: `Simulated ${kind} notice (demo)`, receivedAt: now, respondBy: "2026-11-25",
    status: "new", taxAccountId: extra.taxAccountId, fileName: `${kind.toUpperCase()}.txt`, bodyText: `SIMULATED AGENCY NOTICE (demo). Kind ${kind}.`,
    extractedJson: JSON.stringify({ agency: extra.agency, formCode: extra.formCode, kind, accountNumber: null, taxAccountId: extra.taxAccountId, taxYear: 2026, effectiveFrom: null, respondBy: "2026-11-25", rates: [], amountCents: null, period: extra.period ?? null }),
    draftsJson: "[]", resolutionJson: null, responseConfirmation: null,
  });
  await emitEvent(weft.db, weft.clock, { body: { type: "notice.received", payload: { notice_id: id } }, subjectRef: id, attended: true, requestedBy: "usr_dana" });
  return id;
}

describe("rt_agency_notice handles every notice kind (rt_compliance_notices folded in)", () => {
  it("one routine answers notice.received with at most 8 tools; the folded routine stays disabled and never runs", async () => {
    const r = PREBUILT.find((x) => x.id === NOTICE_ROUTINE);
    expect(r).toMatchObject({ enabled: true, trigger: { type: "event", event: "notice.received" } });
    expect(r!.tools.length).toBeLessThanOrEqual(8);
    expect(r!.tools).toContain("notices.escalate");
    expect(r!.tools).not.toContain("handoffs.open");
    expect(PREBUILT.find((x) => x.id === "rt_compliance_notices")).toMatchObject({ enabled: false });
    expect(PREBUILT.filter((x) => x.enabled && x.trigger.type === "event" && x.trigger.event === "notice.received").map((x) => x.id)).toEqual([NOTICE_ROUTINE]);
    expect(Object.keys(NOTICE_HANDLING).sort()).toEqual(["benefit_charge", "deposit_schedule_change", "futa_credit_reduction", "late_deposit_penalty", "missing_filing", "rate_change", "registration_confirmed"]);
  });

  it("a rate change keeps the GP1 batch: draft, propose the rate and the reply", async () => {
    const res = await post("/v1/sim/notices/deliver", { scenario: "ca_de2088_rate_change" });
    const id = (await res.json()).data.notice_id as string;
    const { rr, open } = await handled(id);
    expect(open.map((p) => p.command).sort()).toEqual(["notices.send_response", "tax.update_rate"]);
    expect(rr.status).not.toBe("failed");
  });

  it("missing_filing with the return on record but not filed: prepares it, proposes filing (R4) and the reply", async () => {
    const res = await post("/v1/sim/notices/deliver", { scenario: "ny_missing_filing" });
    const id = (await res.json()).data.notice_id as string;
    const { rr, run, open } = await handled(id);
    expect(open.map((p) => p.command).sort()).toEqual(["notices.send_response", "tax.file_return"]);
    const ret = open.find((p) => p.command === "tax.file_return")!;
    expect(ret.risk).toBe("R4");
    const [f] = await weft.db.select().from(filings).where(and(eq(filings.form, "ny_nys45"), eq(filings.period, "2026-Q3")));
    expect(JSON.parse(ret.argsJson!)).toEqual({ filing_id: f!.id });
    expect(f!.status).toBe("draft");
    expect(f!.preparedJson).not.toBeNull();
    const [n] = await weft.db.select().from(notices).where(eq(notices.id, id));
    expect(JSON.parse(n!.draftsJson as string).at(-1).body).toContain("is prepared from our processed payroll");
    // The notice stays open for a person: a human can still escalate it afterwards (GP16).
    expect(["new", "in_review", "proposed"]).toContain(n!.status);
    expect(rr.status).not.toBe("failed");
    expect(run?.status).toBe("waiting");
  });

  it("deposit_schedule_change proposes the schedule the notice states; approving updates the account", async () => {
    const res = await post("/v1/sim/notices/deliver", { scenario: "irs_deposit_schedule_change" });
    const id = (await res.json()).data.notice_id as string;
    const { open } = await handled(id);
    expect(open.map((p) => p.command)).toEqual(["tax.set_deposit_schedule"]);
    expect(JSON.parse(open[0]!.argsJson!)).toEqual({ tax_account_id: "txa_0001", schedule: "semiweekly", effective_from: "2027-01-01", source_notice_id: id });
    const ok = await post(`/v1/proposals/${open[0]!.id}/approve`, {}, "usr_theo");
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect((await weft.db.select().from(taxAccounts).where(eq(taxAccounts.id, "txa_0001")))[0]!.depositSchedule).toBe("semiweekly");
    expect((await weft.db.select().from(notices).where(eq(notices.id, id)))[0]!.status).toBe("resolved");
  });

  it("late_deposit_penalty requests abatement in a proposed reply and escalates the payment decision", async () => {
    const id = await insertNotice("late_deposit_penalty", { formCode: "CP161", agency: "irs", taxAccountId: "txa_0001" });
    const { open } = await handled(id);
    expect(open.map((p) => p.command)).toEqual(["notices.send_response"]);
    const [n] = await weft.db.select().from(notices).where(eq(notices.id, id));
    expect(n!.status).toBe("escalated");
    expect(JSON.parse(n!.resolutionJson as string)).toMatchObject({ outcome: "escalated", reason_code: "penalty_dispute" });
  });

  it("futa_credit_reduction and registration_confirmed are informational: skipped with the reason, nothing changes", async () => {
    const id = await insertNotice("futa_credit_reduction", { formCode: "FUTA credit reduction", agency: "irs", taxAccountId: "txa_0001" });
    const { rr, open } = await handled(id);
    expect(open).toEqual([]);
    expect(rr.status).toBe("skipped");
    expect(rr.summary).toContain("informational");
  });

  it("benefit_charge escalates to the tax specialist with the evidence pack", async () => {
    const id = await insertNotice("benefit_charge", { formCode: "DE 428T", agency: "ca_edd", taxAccountId: "txa_0002" });
    await handled(id);
    const [n] = await weft.db.select().from(notices).where(eq(notices.id, id));
    expect(n!.status).toBe("escalated");
    expect(JSON.parse(n!.resolutionJson as string)).toMatchObject({ outcome: "escalated", reason_code: "agency_call_needed" });
  });

  it("an unknown kind is escalated as unrecognized with the evidence pack", async () => {
    const id = await insertNotice("power_of_attorney_request", { formCode: "Form 2848", agency: "irs", taxAccountId: "txa_0001" });
    await handled(id);
    const [n] = await weft.db.select().from(notices).where(eq(notices.id, id));
    expect(n!.status).toBe("escalated");
    const r = JSON.parse(n!.resolutionJson as string) as { reason_code: string; evidence: { label: string; ref: string }[] };
    expect(r.reason_code).toBe("unrecognized_notice");
    expect(r.evidence.map((e) => e.label)).toEqual(expect.arrayContaining(["notice", "tax account", "parser extract"]));
  });
});

describe("rt_compliance_reminders", () => {
  it("ships disabled; a manual run posts the due-soon rows to #payroll with dates from the calendar", async () => {
    const r = PREBUILT.find((x) => x.id === "rt_compliance_reminders");
    expect(r).toMatchObject({ enabled: false, trigger: { type: "cron", cron: "0 8 * * 1-5" } });
    const before = (await weft.db.select().from(simChatMessages)).length;
    const res = await post("/v1/routines/rt_compliance_reminders/trigger", {});
    const body = await res.json();
    const engine = weft.routines as unknown as { settled(id: string): Promise<RoutineRun>; drain(ms?: number): Promise<boolean>; getRun(id: string): Promise<RoutineRun> };
    const run = await engine.settled(body.routineRunId);
    if (run.agentRunId) await settled(run.agentRunId);
    await engine.drain(5_000);
    const msgs = (await weft.db.select().from(simChatMessages)).slice(before);
    expect(msgs.map((m) => m.channel)).toEqual(["#payroll"]);
    expect(msgs[0]!.text).toContain("Compliance due soon:");
    expect(msgs[0]!.text).toContain("Form 941 for 2026-Q3: due Nov 2");
    expect(msgs[0]!.text).not.toMatch(/\u2014|\u2013/);
    expect((await engine.getRun(run.id)).status).toBe("done");
  });
});
