// Contract tests for carrier reconciliation and open enrollment (owner: w2-benefits-contractors, GP11).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { ReconFinding } from "@weft/contracts";
import { benefitReconFindings, events, proposals, simCarrierInvoices, simEmailMessages } from "@weft/db";
import { W2BenefitsOpenEnrollmentRow } from "../../../packages/contracts/src/ext/w2-benefits-contractors";
import { createTestWeft, type TestWeft } from "../src/testing";

let weft: TestWeft;
beforeAll(async () => { weft = await createTestWeft(); });
afterAll(async () => { await weft.close(); });
const get = (p: string, who = "usr_dana") => weft.app.request(p, { headers: weft.uiHeaders(who) });
const post = (p: string, body: unknown, who = "usr_dana") => weft.app.request(p, { method: "POST", headers: { ...weft.uiHeaders(who), "content-type": "application/json" }, body: JSON.stringify(body) });

describe("carrier reconciliation (GP11)", () => {
  it("POST run finds exactly the three planted errors with billed, expected and deducted cents", async () => {
    const res = await post("/v1/benefits/reconciliation/run", { month: "2026-10" });
    expect(res.status, await res.clone().text()).toBe(200);
    const out = await res.json() as { ok: true; status: "done"; data: { count: number; created: number; invoice_total_cents: number } };
    expect(out).toMatchObject({ ok: true, status: "done" });
    expect(out.data).toMatchObject({ count: 3, created: 3 });
    const list = ((await (await get("/v1/benefits/reconciliation?month=2026-10")).json()) as unknown[]).map((x) => ReconFinding.parse(x));
    expect(list.map((f) => f.kind)).toEqual(["terminated_but_billed", "missing_dependent", "wrong_tier"]);
    const [term, dep, tier] = list as [ReconFinding, ReconFinding, ReconFinding];
    // Owen Mercer, last day 2026-10-23: PPO, dental and vision ee billed for both periods, one period covered.
    expect(term).toMatchObject({ workerId: "wrk_0027", planId: null, billedCents: 2 * (9_500 + 800 + 300), expectedCents: 9_500 + 800 + 300, deductedCents: 2 * (9_500 + 800 + 300), status: "open" });
    expect(term.detail).toContain("2026-10-23");
    // Single coverage billed at family on PPO: 2 x 31,000 billed, 2 x 9,500 expected and deducted.
    expect(dep).toMatchObject({ billedCents: 62_000, expectedCents: 19_000, deductedCents: 19_000 });
    expect(dep.detail).toContain("no dependent on file");
    // Family enrollment billed at ee.
    expect(tier.expectedCents).toBe(tier.deductedCents);
    expect(tier.billedCents).toBeLessThan(tier.expectedCents);
    const ev = await weft.db.select().from(events).where(eq(events.type, "benefits.invoice_received"));
    expect(ev.map((e) => JSON.parse(e.payloadJson))).toEqual([{ month: "2026-10", carrier: "Juniper Mutual" }]);
  });

  it("is idempotent per month and carrier", async () => {
    const before = await weft.db.select().from(benefitReconFindings);
    const res = await post("/v1/benefits/reconciliation/run", { month: "2026-10" });
    const out = await res.json() as { data: { count: number; created: number; unchanged: number } };
    expect(out.data).toMatchObject({ count: 3, created: 0, unchanged: 3 });
    const after = await weft.db.select().from(benefitReconFindings);
    expect(after).toEqual(before);
    expect(await weft.db.select().from(simCarrierInvoices)).toHaveLength(1);
    expect(await weft.db.select().from(events).where(eq(events.type, "benefits.invoice_received"))).toHaveLength(1);
  });

  it("disputing a finding through the API is a proposal that drafts the carrier message; approval sends it and marks it disputed", async () => {
    const [f] = await weft.db.select().from(benefitReconFindings).where(eq(benefitReconFindings.kind, "missing_dependent"));
    const key = readFileSync(join(weft.dataDir, "demo-mcp-key.txt"), "utf8").trim();
    const res = await weft.app.request("/v1/tools/benefits__dispute_finding", { method: "POST", headers: { "x-api-key": key, "content-type": "application/json" }, body: JSON.stringify({ finding_id: f!.id }) });
    const out = await res.json() as { ok: true; status: string; proposalId: string };
    expect(out).toMatchObject({ ok: true, status: "pending_approval" });
    const [p] = await weft.db.select().from(proposals).where(eq(proposals.id, out.proposalId));
    expect(p!.status).toBe("pending");
    expect(p!.contentJson).toContain("billing@juniper-mutual.example");
    expect(p!.headline).toBe("Dispute missing dependent on the 2026-10 Juniper Mutual invoice");
    const dec = await post(`/v1/proposals/${out.proposalId}/approve`, {});
    expect(dec.status, await dec.clone().text()).toBe(200);
    const [after] = await weft.db.select().from(benefitReconFindings).where(eq(benefitReconFindings.id, f!.id));
    expect(after!.status).toBe("disputed");
    const mail = await weft.db.select().from(simEmailMessages).where(eq(simEmailMessages.relatedRef, f!.id));
    expect(mail).toHaveLength(1);
    expect(mail[0]!.body).toContain("$620.00");
    const again = await post("/v1/tools/benefits.dispute_finding", { finding_id: f!.id });
    expect(again.status).toBe(422);
    // Vic disputing from the Benefits screen acts directly (her click is the approval).
    const [w] = await weft.db.select().from(benefitReconFindings).where(eq(benefitReconFindings.kind, "wrong_tier"));
    const direct = await (await post("/v1/tools/benefits.dispute_finding", { finding_id: w!.id })).json() as { ok: boolean; status: string };
    expect(direct).toMatchObject({ ok: true, status: "done" });
  });

  it("refuses a bad month and filters by status", async () => {
    expect((await post("/v1/benefits/reconciliation/run", { month: "2026-13" })).status).toBe(400);
    expect((await get("/v1/benefits/reconciliation?month=oct")).status).toBe(400);
    const disputed = (await (await get("/v1/benefits/reconciliation?status=disputed")).json()) as ReconFinding[];
    expect(disputed.map((f) => f.kind)).toEqual(["missing_dependent", "wrong_tier"]);
  });
});

describe("open enrollment", () => {
  it("lists one row per eligible employee for 2027 with deterministic statuses", async () => {
    const rows = ((await (await get("/v1/benefits/open-enrollment")).json()) as unknown[]).map((r) => W2BenefitsOpenEnrollmentRow.parse(r));
    const eligible = await weft.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM workers WHERE type = 'employee' AND status IN ('active', 'onboarding') AND end_date IS NULL`);
    expect(rows).toHaveLength(eligible[0]!.n);   // on the wave 1 seed: 48 employees minus Owen Mercer, who has an end date
    expect(rows.every((r) => r.planYear === 2027)).toBe(true);
    expect(rows.some((r) => r.workerId === "wrk_0027")).toBe(false);
    const counts = rows.reduce<Record<string, number>>((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {});
    expect(counts.not_started! + counts.in_progress!).toBeGreaterThan(0);
    const pending = (await (await get("/v1/benefits/open-enrollment?status=not_started")).json()) as unknown[];
    expect(pending).toHaveLength(counts.not_started!);
  });
});
