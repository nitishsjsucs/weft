// Demo-perfect round 2: a rate change that re-previews the Oct 30 draft withdraws the pending submit card filed on the
// old numbers (superseded, STALE_SUBJECT), so neither the Inbox nor the payroll banner keeps the old total. A card whose
// subject still matches stays pending, and the stored preview and hash of the withdrawn card are never rewritten.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { directExecutors, payroll } from "@weft/core";
import { proposals } from "@weft/db";
import { createTestWeft, type TestWeft } from "../src/testing";

let weft: TestWeft;
beforeAll(async () => { weft = await createTestWeft(); });
afterAll(async () => { await weft.close(); });
const session = (principalId: string) => ({ principalId, companyId: "cmp_larkspur", via: "ui" as const, keyScope: null });
const RUN = "pay_2026_10_30";

async function proposeSubmit(callId: string): Promise<string> {
  const h = await weft.executor.runs.openChatRun(session("usr_dana"), { threadId: null, surface: "human_ui", allowlist: ["payroll.submit_run"] });
  const o = await weft.executor.agent.exec(h, { callId, command: "payroll.submit_run", args: { run_id: RUN, exclude_blocked: true } });
  if (!o.ok || o.status !== "pending_approval") throw new Error(`expected a pending submit, got ${JSON.stringify(o).slice(0, 200)}`);
  return o.proposalId;
}
const row = async (id: string) => (await weft.db.select().from(proposals).where(eq(proposals.id, id)))[0]!;

describe("a draft refresh withdraws the stale submit card", () => {
  it("previewing an unchanged draft keeps the card pending", async () => {
    const id = await proposeSubmit("s0");
    const preview = await weft.app.request(`/v1/payrolls/${RUN}/preview`, { method: "POST", headers: weft.uiHeaders("usr_dana") });
    expect(preview.status).toBe(200);
    expect((await row(id)).status).toBe("pending");
  });

  it("approving the CA SUI rate change supersedes the card filed on the old total, and the new card files the new total", async () => {
    const pending = (await weft.db.select().from(proposals).where(eq(proposals.status, "pending"))).filter((p) => p.command === "payroll.submit_run");
    expect(pending).toHaveLength(1);
    const before = pending[0]!;
    const dana = directExecutors(weft.db, weft.clock, weft.sims).human("usr_dana");
    const notice = (await dana.exec("sim.deliver_notice", { scenario: "ca_de2088_rate_change" })) as { data: { notice_id: string } };
    const done = await dana.exec("tax.update_rate", { tax_account_id: "txa_0002", code: "sui", rate: "0.015", effective_from: "2026-01-01", source_notice_id: notice.data.notice_id });
    expect(done.ok).toBe(true);
    expect((done as { data: Record<string, unknown> }).data).toMatchObject({ refreshed_drafts: [RUN], superseded_submit_proposals: [before.id], superseded_note: payroll.STALE_SUBMIT_NOTE });
    const after = await row(before.id);
    expect(after).toMatchObject({ status: "superseded", decisionCode: "STALE_SUBJECT", decisionNote: payroll.STALE_SUBMIT_NOTE, decidedBy: null });
    // The withdrawn card keeps what it was shown with: headline, money and hash are untouched.
    expect({ h: after.headline, m: after.moneyCents, s: after.subjectHash }).toEqual({ h: before.headline, m: before.moneyCents, s: before.subjectHash });
    // Approving it is refused (it is no longer pending), so the old total can never be paid.
    const approve = await weft.app.request(`/v1/proposals/${before.id}/approve`, { method: "POST", headers: { ...weft.uiHeaders("usr_dana"), "content-type": "application/json" }, body: JSON.stringify({ reasonCode: null, note: null }) });
    expect(approve.status).not.toBe(200);
    // A fresh card files the re-previewed total, lower by the company tax the rate change saves.
    const fresh = await row(await proposeSubmit("s1"));
    expect(fresh.moneyCents).toBeLessThan(before.moneyCents!);
    expect(fresh.subjectHash).not.toBe(before.subjectHash);
    const run = await (await weft.app.request(`/v1/payrolls/${RUN}`, { headers: weft.uiHeaders("usr_dana") })).json() as { totals: { totalCost: { amount: number } } };
    expect(run.totals.totalCost.amount).toBeGreaterThanOrEqual(fresh.moneyCents!);
  });
});
