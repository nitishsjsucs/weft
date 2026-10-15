// Contract tests for the /v1 payrolls routes (owner: t1-payroll). Until merge 1 the world is the local payroll fixture
// (packages/core/test/payroll/fixture-world.ts) and mutations run through a stand-in HumanExecutor that applies the
// command's zod schema and maps Refused errors to ToolOutcome refusals with the registry's errorHints.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isWeftError, Paycheck, PayrollRun, type HumanExecutor, type HumanSession, type ToolOutcome } from "@weft/contracts";
import { principals } from "@weft/db";
import { commands, idMinter, payroll, type CommandDeps } from "@weft/core";
import { createTestWeft, type TestWeft } from "../src/testing";
import { buildFixtureWorld, CO, fakeBank, PS, TS, type FixtureIds } from "../../../packages/core/test/payroll/fixture-world";

let weft: TestWeft;
let ids: FixtureIds;
const bank = fakeBank();

function standInHuman(w: TestWeft): HumanExecutor {
  return {
    async exec(session: HumanSession, name: string, args: unknown): Promise<ToolOutcome> {
      const def = commands.find((c) => c.name === name);
      if (!def) throw new Error(`unknown command ${name}`);
      const deps: CommandDeps = { tx: w.db, sims: { bank: bank.bank } as never, clock: w.clock, newId: idMinter(w.db), resolveCredential: async () => "test" };
      const ctx = { companyId: session.companyId, principal: { id: session.principalId, kind: "human" as const, role: "admin" }, onBehalfOf: null, surface: "human_ui" as const, agentKind: null, run: null, tainted: false, routineRunId: null, approvedProposalId: null, now: w.clock.now() };
      try {
        const input = def.input.parse(args);
        if (def.amountCents) await def.amountCents(input, ctx, deps);
        const out = await def.run(input, ctx, deps);
        return { ok: true, status: "done", resultId: String((out.data as { run_id?: string }).run_id ?? ""), data: out.data, summary: out.summary, actionSeq: null, artifactRef: null, tainted: false, label: "synthetic" };
      } catch (e) {
        if (isWeftError(e) && e._tag === "Refused") {
          const code = String(e.extra.code);
          const h = (def.errorHints as Record<string, { hint: string; example: unknown }>)[code];
          return { ok: false, refusal: { code: code as never, message: e.message, hint: h?.hint ?? null, example: h?.example ?? null }, tainted: false };
        }
        throw e;
      }
    },
    decide: async () => { throw new Error("not in this test"); },
    rollback: async () => { throw new Error("not in this test"); },
    onProposalDecided: () => undefined,
  };
}

beforeAll(async () => {
  weft = await createTestWeft({ seed: false });
  ids = await buildFixtureWorld(weft.db);
  await weft.db.insert(principals).values({ id: "usr_theo", companyId: CO, kind: "human", display: "Theo Marsh (demo)", role: "payroll_admin", grantsJson: "{}" });
  await payroll.seedPayHistory(weft.db, { newId: idMinter(weft.db), bank: bank.bank, credential: "x", approvedBy: "usr_theo", draftCreatedAt: TS }, { companyId: CO, payScheduleId: PS });
  (weft as { executor: unknown }).executor = { human: standInHuman(weft), redact: (s: string) => s, system: weft.executor.system, readOnly: weft.executor.readOnly, expireProposals: async () => 0 };
});
afterAll(async () => { await weft.close(); });

const get = (path: string) => weft.app.request(path, { headers: weft.uiHeaders("usr_theo") });
const post = (path: string, body: unknown) => weft.app.request(path, { method: "POST", headers: { ...weft.uiHeaders("usr_theo"), "content-type": "application/json" }, body: JSON.stringify(body) });

describe("GET payroll reads", () => {
  it("GET /v1/payrolls pages runs with totals and the anomaly summary", async () => {
    const res = await get("/v1/payrolls?limit=2");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hasMore: boolean; count: number; data: unknown[] };
    expect(body).toMatchObject({ hasMore: true, count: 2 });
    const runs = body.data.map((d) => PayrollRun.parse(d));
    expect(runs.map((r) => r.id)).toEqual(["pay_2026_09_15", "pay_2026_09_30"]);
    const next = (await (await get(`/v1/payrolls?afterId=${runs[1]!.id}`)).json()) as { data: { id: string }[] };
    expect(next.data.map((r) => r.id)).toEqual(["pay_2026_10_15", "pay_2026_10_30"]);
  });
  it("GET /v1/payrolls/:id returns the draft with 48 paychecks and 4/44", async () => {
    const run = PayrollRun.parse(await (await get("/v1/payrolls/pay_2026_10_30")).json());
    expect(run).toMatchObject({ status: "draft", paycheckCount: 48, anomalySummary: { needsReview: 4, ready: 44, blocked: 1, excluded: 0 } });
    expect(run.totals!.cashRequirement.amount).toBe(run.totals!.totalCost.amount);
    expect((await get("/v1/payrolls/pay_nope")).status).toBe(404);
  });
  it("GET /v1/payrolls/:id/paychecks filters by group, state and worker", async () => {
    const review = (await (await get("/v1/payrolls/pay_2026_10_30/paychecks?group=needs_review")).json()) as { data: unknown[] };
    expect(review.data.map((p) => Paycheck.parse(p).workerId).sort()).toEqual([ids.nyRaise, ids.txSpike, ids.caOct19, ids.nyOffboard].sort());
    const tx = (await (await get("/v1/payrolls/pay_2026_10_30/paychecks?state=TX&limit=100")).json()) as { count: number };
    expect(tx.count).toBe(12);
    const one = (await (await get(`/v1/payrolls/pay_2026_10_30/paychecks?workerId=${ids.caOct19}`)).json()) as { data: Paycheck[] };
    expect(one.data[0]!.flags.map((f) => f.rule).sort()).toEqual(["MISSING_BANK_ACCOUNT", "NEW_IN_RUN", "PRORATED"]);
  });
  it("GET /v1/paychecks/:id includes the tax trace", async () => {
    const list = (await (await get(`/v1/payrolls/pay_2026_10_30/paychecks?workerId=${ids.nyRaise}`)).json()) as { data: Paycheck[] };
    const p = Paycheck.parse(await (await get(`/v1/paychecks/${list.data[0]!.id}`)).json());
    expect(p.trace!.some((l) => l.startsWith("FIT"))).toBe(true);
    expect(p.trace!.some((l) => l.startsWith("NY SUI"))).toBe(true);
    expect(p.net.amount).toBe(list.data[0]!.net.amount);
  });
  it("requires a session", async () => {
    expect((await weft.app.request("/v1/payrolls")).status).toBe(401);
  });
});

describe("payroll mutations", () => {
  it("POST /v1/payrolls/drafts creates Nov 1 to 15 while pay_2026_10_30 is a draft", async () => {
    const res = await post("/v1/payrolls/drafts", { payScheduleId: PS, periodEnd: "2026-11-15" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "done", data: { run_id: "pay_2026_11_13", previous_run_id: "pay_2026_10_15" } });
    const again = await post("/v1/payrolls/drafts", { payScheduleId: PS, periodEnd: "2026-11-15" });
    expect(again.status).toBe(422);
    expect(await again.json()).toMatchObject({ _tag: "Refused", code: "DOMAIN_DRAFT_EXISTS" });
    expect((await post("/v1/payrolls/drafts", { periodEnd: "2026-11-15" })).status).toBe(400);
  });
  it("POST /v1/payrolls/:id/preview refreshes the draft", async () => {
    const res = await post("/v1/payrolls/pay_2026_10_30/preview", {});
    expect(await res.json()).toMatchObject({ ok: true, data: { run_id: "pay_2026_10_30", changed: 0 } });
  });
  it("POST /v1/payrolls/:id/submit refuses BLOCKED_LINES with the exclude_blocked hint, then submits", async () => {
    const res = await post("/v1/payrolls/pay_2026_10_30/submit", {});
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; example: unknown; hint: string };
    expect(body.code).toBe("BLOCKED_LINES");
    expect(body.example).toEqual({ run_id: "pay_2026_10_30", exclude_blocked: true });
    const ok = await post("/v1/payrolls/pay_2026_10_30/submit", { excludeBlocked: true });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, data: { status: "processing", included: 47, excluded_worker_ids: [ids.caOct19] } });
    const run = PayrollRun.parse(await (await get("/v1/payrolls/pay_2026_10_30")).json());
    expect(run).toMatchObject({ status: "processing", excludedWorkerIds: [ids.caOct19], settleAt: "2026-10-30T13:00:00.000Z" });
  });
});
