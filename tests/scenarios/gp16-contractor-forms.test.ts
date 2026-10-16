// Scenario GP16 (docs/wave3.md), contractor tax forms (wave 3 rank 15). Owner: w3-parity-routines. Scripted provider
// (scenarios/rt_contractor_forms.json). A W-9 never lapses; a W-8 lapses on December 31 of the third year after
// signing. The Monday routine emails every contractor whose form is missing, expired or lapses within 60 days, marks
// the lapsing form as renewal requested, and leaves current forms alone.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { AgentRunRow, RoutineRun } from "@weft/contracts";
import { contractorTaxForms, simEmailMessages, workers } from "@weft/db";
import { PREBUILT } from "../../packages/routines/src/prebuilt";
import { listTaxForms, taxFormExpiresOn } from "../../packages/core/src/parity/contractor-forms";
import { seedWorkerId } from "../../packages/seed/src/people";
import { createTestWeft, type TestWeft } from "./helpers";

let weft: TestWeft;
beforeAll(async () => { weft = await createTestWeft(); });
afterAll(async () => {
  for (let i = 0; i < 10; i++) {
    const open = await weft.db.all<{ id: string }>(sql`SELECT id FROM routine_runs WHERE status IN ('queued', 'running')`);
    if (!open.length) break;
    for (const r of open) await (weft.routines as unknown as { settled(id: string): Promise<unknown> }).settled(r.id);
  }
  await weft?.close();
});

const call = async (method: string, path: string, body?: unknown, who = "usr_dana") => {
  const res = await weft.app.request(path, { method, headers: { ...weft.uiHeaders(who), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as any };
};
const trigger = async (routineId: string): Promise<RoutineRun> => {
  const { json } = await call("POST", `/v1/routines/${routineId}/trigger`, {});
  const engine = weft.routines as unknown as { settled(id: string): Promise<RoutineRun> };
  const run = await engine.settled(json.routineRunId);
  if (run.agentRunId) await (weft.agent as unknown as { settled(id: string): Promise<AgentRunRow> }).settled(run.agentRunId);
  await (weft.routines as unknown as { drain(ms?: number): Promise<boolean> }).drain(5_000);
  return (await (weft.routines as unknown as { getRun(id: string): Promise<RoutineRun> }).getRun(run.id));
};

const INES = seedWorkerId("ines"), ARJUN = seedWorkerId("arjun"), CLAIRE = seedWorkerId("claire");

async function contractor(id: string, first: string, country: string, form: { form: string; signedOn: string } | null) {
  const now = "2026-10-20T16:00:00.000Z";
  await weft.db.insert(workers).values({
    id, companyId: "cmp_larkspur", employeeNumber: null, type: "contractor", workerType: country === "US" ? "us_contractor" : "global_contractor", status: "active",
    firstName: first, lastName: "Tester", workEmail: `${first.toLowerCase()}.tester@larkspur.example`, personalEmail: `${first.toLowerCase()}@contractor.example`,
    title: "Contractor", departmentId: "dpt_engineering", managerId: null, workplaceId: null, workState: null, country, currency: country === "US" ? "USD" : "EUR",
    timezone: "America/Los_Angeles", startDate: "2022-01-10", payScheduleId: "ps_global_monthly", createdAt: now, updatedAt: now,
  });
  if (form) await weft.db.insert(contractorTaxForms).values({ id: `ctf_t${id.slice(4)}`, workerId: id, form: form.form, signedOn: form.signedOn, expiresOn: null, documentId: null, status: "active", createdAt: now });
}

describe("GP16 contractor tax forms", () => {
  it("a W-8 lapses on December 31 of the third year after signing; a W-9 does not lapse", () => {
    expect(taxFormExpiresOn("w8ben", "2023-03-01")).toBe("2026-12-31");
    expect(taxFormExpiresOn("w8bene", "2025-12-31")).toBe("2028-12-31");
    expect(taxFormExpiresOn("w9", "2019-06-01")).toBeNull();
  });

  it("rt_contractor_forms ships disabled with at most 8 tools", () => {
    const r = PREBUILT.find((x) => x.id === "rt_contractor_forms");
    expect(r).toMatchObject({ enabled: false, trigger: { type: "cron", cron: "0 9 * * 1" } });
    expect(r!.tools.length).toBeLessThanOrEqual(8);
  });

  it("the seeded forms: Ines and Arjun current, Claire missing because her W-8BEN was superseded", async () => {
    const r = await listTaxForms(weft.db, "cmp_larkspur", "2026-10-20");
    expect(r.contractors.map((c) => [c.worker_id, c.state, c.form, c.expires_on])).toEqual([
      [INES, "valid", "w8ben", "2028-12-31"], [ARJUN, "valid", "w8ben", "2028-12-31"], [CLAIRE, "missing", null, null],
    ]);
    expect(r.needs_request).toEqual([CLAIRE]);
  });

  it("the Monday run emails the missing, expired and lapsing forms only, and marks the lapsing one requested", async () => {
    await contractor("wrk_0951", "Sam", "US", { form: "w9", signedOn: "2019-06-01" });        // a W-9 never lapses
    await contractor("wrk_0952", "Mara", "DE", { form: "w8ben", signedOn: "2023-03-01" });    // lapses 2026-12-31, 59 days out
    await contractor("wrk_0953", "Lio", "FR", { form: "w8bene", signedOn: "2022-04-11" });   // lapsed 2025-12-31
    await contractor("wrk_0954", "Tove", "SE", { form: "w9", signedOn: "2023-01-05" });      // abroad, only a W-9 on file: missing
    await weft.clock.set("2026-11-02T17:00:00.000Z", 0);   // Mon Nov 2, 09:00 PT

    const r = await listTaxForms(weft.db, "cmp_larkspur", "2026-11-02");
    const state = Object.fromEntries(r.contractors.map((c) => [c.worker_id, [c.state, c.days_left]]));
    expect(state).toMatchObject({ wrk_0951: ["valid", null], wrk_0952: ["expiring", 59], wrk_0953: ["expired", -306], wrk_0954: ["missing", null] });

    const before = (await weft.db.select().from(simEmailMessages)).length;
    const run = await trigger("rt_contractor_forms");
    expect(run.status, JSON.stringify(run)).toBe("done");
    const pre = run.precheck as { derivedArgs: Record<string, unknown> };
    expect(pre.derivedArgs["contractors.request_tax_forms"]).toEqual({ worker_ids: [CLAIRE, "wrk_0952", "wrk_0953", "wrk_0954"], as_of: "2026-11-02" });

    const mail = (await weft.db.select().from(simEmailMessages)).slice(before);
    expect(mail.map((m) => [m.relatedRef, m.subject]).sort()).toEqual([
      [CLAIRE, "Please send your W-8BEN (individual) or W-8BEN-E (entity)"],
      ["wrk_0952", "Please renew your W-8BEN"],
      ["wrk_0953", "Please renew your W-8BEN-E"],
      ["wrk_0954", "Please send your W-8BEN (individual) or W-8BEN-E (entity)"],
    ].sort());
    expect(mail.find((m) => m.relatedRef === "wrk_0952")).toMatchObject({ toAddr: "mara@contractor.example" });
    expect(mail.find((m) => m.relatedRef === "wrk_0952")!.body).toContain("stays in effect through 2026-12-31");
    expect(mail.find((m) => m.relatedRef === "wrk_0953")!.body).toContain("lapsed on 2025-12-31");
    for (const m of mail) expect(m.body).not.toMatch(/—/);
    const [mara] = await weft.db.select().from(contractorTaxForms).where(eq(contractorTaxForms.workerId, "wrk_0952"));
    expect(mara!.status).toBe("renewal_requested");

    // A week later the lapsing form is already requested, so only the missing and expired forms are asked for again.
    await weft.clock.set("2026-11-09T17:00:00.000Z", 0);
    const next = await trigger("rt_contractor_forms");
    expect(next.status, JSON.stringify(next)).toBe("done");
    expect((next.precheck as { derivedArgs: Record<string, unknown> }).derivedArgs["contractors.request_tax_forms"]).toEqual({ worker_ids: [CLAIRE, "wrk_0953", "wrk_0954"], as_of: "2026-11-09" });
  });

  it("refuses an id that is not an active contractor and skips current forms", async () => {
    const bad = await call("POST", "/v1/tools/contractors.request_tax_forms", { worker_ids: ["wrk_0001"] });
    expect(JSON.stringify(bad.json)).toContain("Not an active contractor");
    const ok = await call("POST", "/v1/tools/contractors.list_tax_forms", { as_of: "2026-11-09" });
    expect(ok.json.ok, JSON.stringify(ok.json)).toBe(true);
    expect(ok.json.data.needs_request).toEqual([CLAIRE, "wrk_0953", "wrk_0954"]);
  });
});
