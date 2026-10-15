import { describe, expect, it, beforeEach } from "vitest";
import { TOTALS_FIELDS, type DecisionResult } from "@weft/contracts";
import { createClient } from "../src/lib/api/client";
import { mockFetch, resetMockWorld } from "../src/lib/api/mocks";
import { createSseParser, mergeSteps } from "../src/lib/api/sse";
import { nextPeriodEnd } from "../src/components/app/format";

const as = (who: string) => createClient({ baseUrl: "/api", fetch: mockFetch, principal: () => who });

describe("contract-typed mocks", () => {
  beforeEach(() => resetMockWorld());

  it("seed draft has 4 Needs Review and 44 Ready, and 12 totals that satisfy the SPEC 7.4 identities", async () => {
    const api = as("usr_dana");
    const run = await api.get("/v1/payrolls/:id", { params: { id: "pay_2026_10_30" } });
    const pcs = await api.get("/v1/payrolls/:id/paychecks", { params: { id: "pay_2026_10_30" }, query: { limit: 100 } });
    expect(pcs.data.filter((p) => p.reviewGroup === "needs_review").map((p) => p.workerId).sort()).toEqual(["wrk_0022", "wrk_0024", "wrk_0036", "wrk_0048"]);
    expect(pcs.data.filter((p) => p.reviewGroup === "ready")).toHaveLength(44);
    const t = run.totals!;
    expect(Object.keys(t).sort()).toEqual([...TOTALS_FIELDS].sort());
    expect(t.netPay.amount).toBe(t.grossPay.amount - t.workerTaxes.amount - t.preTaxDeductions.amount - t.postTaxDeductions.amount);
    expect(t.totalCost.amount).toBe(t.grossPay.amount + t.reimbursements.amount + t.employerTaxes.amount + t.employerBenefitContributions.amount + t.transactionFees.amount);
    expect(t.cashRequirement.amount).toBe(t.totalCost.amount);
  });

  it("approve records the Viewing as principal; deny needs a reason code", async () => {
    const r = (await as("usr_theo").post("/v1/proposals/:id/approve", { params: { id: "prp_0001" }, body: { reasonCode: null, note: null } })) as DecisionResult;
    expect(r.ok && r.proposal.decidedBy).toBe("usr_theo");
    await expect(as("usr_dana").post("/v1/proposals/:id/deny", { params: { id: "prp_0002" }, body: { reasonCode: null, note: null } })).rejects.toMatchObject({ status: 400 });
    const again = (await as("usr_dana").post("/v1/proposals/:id/approve", { params: { id: "prp_0001" }, body: {} })) as DecisionResult;
    expect(again).toMatchObject({ ok: false, code: "NOT_PENDING" });
  });

  it("submit refuses blocked lines unless excludeBlocked", async () => {
    const api = as("usr_theo");
    const refused = await api.post("/v1/payrolls/:id/submit", { params: { id: "pay_2026_10_30" }, body: { excludeBlocked: false } });
    expect(refused).toMatchObject({ ok: false, refusal: { code: "BLOCKED_LINES" } });
    const ok = await api.post("/v1/payrolls/:id/submit", { params: { id: "pay_2026_10_30" }, body: { excludeBlocked: true } });
    expect(ok).toMatchObject({ ok: true, status: "done" });
    expect((await api.get("/v1/payrolls/:id", { params: { id: "pay_2026_10_30" } })).status).toBe("processing");
  });

  it("unknown routes answer 501 NotImplemented like the scaffold", async () => {
    await expect(as("usr_dana").get("/v1/stats")).rejects.toMatchObject({ status: 501 });
  });
});

describe("run streaming helpers", () => {
  it("parses SSE frames across chunk boundaries and skips comments", () => {
    const got: [string, string][] = [];
    const feed = createSseParser((e, d) => got.push([e, d]));
    feed(": ping\n\nevent: step\ndata: {\"n\":1");
    feed("}\n\ndata: plain\n\n");
    expect(got).toEqual([["step", "{\"n\":1}"], ["message", "plain"]]);
  });
  it("merges steps by number, newest wins, sorted", () => {
    const s = (n: number, outcome: string) => ({ n, outcome }) as never;
    expect(mergeSteps([s(2, "a"), s(1, "a")], [s(2, "b"), s(3, "a")]).map((x) => `${x.n}${x.outcome}`)).toEqual(["1a", "2b", "3a"]);
  });
  it("computes the next semi-monthly period end", () => {
    expect(nextPeriodEnd("2026-10-31")).toBe("2026-11-15");
    expect(nextPeriodEnd("2026-11-15")).toBe("2026-11-30");
    expect(nextPeriodEnd("2026-12-31")).toBe("2027-01-15");
    expect(nextPeriodEnd("2027-02-15")).toBe("2027-02-28");
  });
});
