// Contract tests for contractor payouts, the fixed FX table and the payment rail lifecycle (owner: w2-benefits-contractors, GP11).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { ContractorPayout, Page } from "@weft/contracts";
import { convertToUsdCents } from "@weft/core";
import { contractorPayments, events, proposals } from "@weft/db";
import { toUsdCents } from "@weft/sim";
import { createTestWeft, type TestWeft } from "../src/testing";

let weft: TestWeft;
beforeAll(async () => { weft = await createTestWeft(); });
afterAll(async () => { await weft.close(); });
const get = (p: string, who = "usr_dana") => weft.app.request(p, { headers: weft.uiHeaders(who) });
const post = (p: string, body: unknown, who = "usr_dana") => weft.app.request(p, { method: "POST", headers: { ...weft.uiHeaders(who), "content-type": "application/json" }, body: JSON.stringify(body) });
const payouts = async () => Page(ContractorPayout).parse(await (await get("/v1/contractors/payouts")).json()).data;
const CONTRACTORS = ["wrk_0049", "wrk_0050", "wrk_0051"];

describe("contractor payouts (GP11)", () => {
  it("serves the fixed FX table and converts half up with decimal.js, matching the simulator's integer math", async () => {
    const fx = (await (await get("/v1/contractors/fx")).json()) as { currency: string; usdPerUnit: string; source: string }[];
    expect(fx.map((r) => [r.currency, r.usdPerUnit])).toEqual([["CAD", "0.73"], ["EUR", "1.08"], ["INR", "0.012"], ["USD", "1"]]);
    expect(fx.every((r) => r.source.startsWith("Synthetic FX table"))).toBe(true);
    for (const [m, c, r] of [[650_000, "EUR", "1.08"], [41_000_000, "INR", "0.012"], [980_000, "CAD", "0.73"], [125, "INR", "0.012"], [1_041, "CAD", "0.73"]] as const) {
      expect(convertToUsdCents(m, r)).toBe(toUsdCents(m, c));
    }
    expect(convertToUsdCents(125, "0.012")).toBe(2);   // 1.5 rounds half up
  });

  it("an API proposal books nothing until approved, then each payout goes to the rail as pending", async () => {
    const key = readFileSync(join(weft.dataDir, "demo-mcp-key.txt"), "utf8").trim();
    const res = await weft.app.request("/v1/tools/contractors__schedule_payouts", { method: "POST", headers: { "x-api-key": key, "content-type": "application/json" }, body: JSON.stringify({ worker_ids: CONTRACTORS, scheduled_for: "2026-10-30" }) });
    const out = await res.json() as { ok: boolean; status: string; proposalId: string };
    expect(out).toMatchObject({ ok: true, status: "pending_approval" });
    const [p] = await weft.db.select().from(proposals).where(eq(proposals.id, out.proposalId));
    expect(p).toMatchObject({ headline: "Pay 3 contractors $19,094.00 on 2026-10-30", moneyCents: 702_000 + 492_000 + 715_400 });
    expect(await weft.db.select().from(contractorPayments)).toHaveLength(0);
    const dec = await post(`/v1/proposals/${out.proposalId}/approve`, {});
    expect(dec.status, await dec.clone().text()).toBe(200);
    const rows = await weft.db.select().from(contractorPayments);
    expect(rows.map((r) => [r.workerId, r.currency, r.amountMinor, r.fxRate, r.usdCents, r.railStatus])).toEqual([
      ["wrk_0049", "EUR", 650_000, "1.08", 702_000, "pending"],
      ["wrk_0050", "INR", 41_000_000, "0.012", 492_000, "pending"],
      ["wrk_0051", "CAD", 980_000, "0.73", 715_400, "pending"],
    ]);
    expect(rows.every((r) => r.railRef?.startsWith("simr_"))).toBe(true);
  });

  it("refuses a second payout for the same date, non-contractors and bad bodies", async () => {
    const dup = await post("/v1/contractors/payouts", { workerIds: ["wrk_0049"], scheduledFor: "2026-10-30" });
    expect(dup.status).toBe(422);
    expect(((await dup.json()) as { code: string }).code).toBe("DOMAIN_ALREADY_SCHEDULED");
    const emp = await post("/v1/contractors/payouts", { workerIds: ["wrk_0001"], scheduledFor: "2026-11-30" });
    expect(((await emp.json()) as { code: string }).code).toBe("DOMAIN_NOT_CONTRACTOR");
    expect((await post("/v1/contractors/payouts", { workerIds: [] })).status).toBe(400);
  });

  // Runs last: requests that kick the scheduler after a clock move would start the seeded routines due in between.
  it("moves pending, sent and delivered on the sim clock and emits sim.rail_delivered once per payout", async () => {
    expect((await payouts()).map((p) => p.railStatus)).toEqual(["sent", "sent", "sent"]);   // the first rail tick
    await weft.clock.advance("2026-10-27T15:30:00.000Z");
    expect((await payouts()).map((p) => p.railStatus)).toEqual(["sent", "sent", "sent"]);
    await weft.clock.advance("2026-10-28T15:30:00.000Z");   // two business days after booking
    const done = await payouts();
    expect(done.map((p) => [p.railStatus, p.deliveredAt])).toEqual(Array(3).fill(["delivered", "2026-10-28T15:30:00.000Z"]));
    expect((await weft.db.select().from(contractorPayments)).every((r) => r.status === "paid" && r.sentAt !== null)).toBe(true);
    await payouts();
    const ev = await weft.db.select().from(events).where(eq(events.type, "sim.rail_delivered"));
    expect(ev.map((e) => JSON.parse(e.payloadJson).payment_id).sort()).toEqual(done.map((p) => p.id).sort());
    expect(((await (await get("/v1/contractors/payouts?status=delivered")).json()) as { data: unknown[] }).data).toHaveLength(3);
  });
});
