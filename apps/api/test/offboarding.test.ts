// Contract tests for the wave 2 offboarding routes (owner: w2-offboarding): terminate, the case reads and off-cycle.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { OffboardingCase, OFFBOARDING_STEP_ORDER } from "@weft/contracts";
import { createTestWeft, type TestWeft } from "../src/testing";

let weft: TestWeft;
beforeAll(async () => { weft = await createTestWeft(); });
afterAll(async () => { await weft.close(); });
const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = weft.uiHeaders("usr_dana")) =>
  weft.app.request(path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

describe("offboarding routes", () => {
  it("lists no cases on the seed and answers 404 for an unknown case", async () => {
    const list = await call("GET", "/v1/offboarding");
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([]);
    expect((await call("GET", "/v1/offboarding/ofb_9999")).status).toBe(404);
  });

  it("validates TerminationInput and refuses mcp-scoped keys", async () => {
    expect((await call("POST", "/v1/workers/wrk_0005/terminate", { kind: "retired", lastDay: "2026-10-30" })).status).toBe(400);
    expect((await call("POST", "/v1/workers/wrk_0005/terminate", { kind: "layoff", lastDay: "Oct 30" })).status).toBe(400);
    const mcpKey = readFileSync(join(weft.dataDir, "demo-mcp-key.txt"), "utf8").trim();
    expect((await call("POST", "/v1/workers/wrk_0005/terminate", { kind: "layoff", lastDay: "2026-10-30" }, { "x-api-key": mcpKey })).status).toBe(403);
  });

  it("terminate opens a case with the eight ordered steps; skipped steps carry their reason", async () => {
    const res = await call("POST", "/v1/workers/wrk_0005/terminate", { kind: "layoff", lastDay: "2026-10-30", payUnusedPto: false });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { ok: boolean; data: { case_id: string } };
    const c = OffboardingCase.parse(await (await call("GET", `/v1/offboarding/${out.data.case_id}`)).json());
    expect(c).toMatchObject({ workerId: "wrk_0005", kind: "layoff", lastDay: "2026-10-30", status: "open" });
    expect(c.steps.map((s) => s.kind)).toEqual([...OFFBOARDING_STEP_ORDER]);
    const sso = c.steps.find((s) => s.kind === "sso_deactivate")!;
    expect(sso).toMatchObject({ status: "skipped", detail: "No SSO account on file", proposalId: null });
    expect(c.steps.find((s) => s.kind === "final_pay")).toMatchObject({ status: "proposed", detail: "Dismissal run through the last day, no PTO payout" });
    const list = OffboardingCase.array().parse(await (await call("GET", "/v1/offboarding")).json());
    expect(list.map((x) => x.id)).toEqual([c.id]);
    // The proposals are the person's own: untainted, on Dana's behalf.
    const rows = await weft.db.all<{ tainted_by: string | null; on_behalf_of: string | null; command: string }>(sql`SELECT tainted_by, on_behalf_of, command FROM proposals WHERE status = 'pending' AND command LIKE 'offboarding.%' ORDER BY id`);
    expect(rows.map((r) => r.command)).toEqual(["offboarding.final_pay", "offboarding.suspend_directory", "offboarding.lock_device"]);
    expect(rows.every((r) => r.tainted_by === null && r.on_behalf_of === "usr_dana")).toBe(true);
  });

  it("final pay skips wages a submitted regular run already paid, and still pays unused PTO", async () => {
    const submit = await call("POST", "/v1/tools/payroll.submit_run", { run_id: "pay_2026_10_30", exclude_blocked: true });
    expect(submit.status).toBe(200);
    const res = await call("POST", "/v1/workers/wrk_0004/terminate", { kind: "voluntary", lastDay: "2026-10-30" });
    expect(res.status).toBe(200);
    const caseId = ((await res.json()) as { data: { case_id: string } }).data.case_id;
    const c = OffboardingCase.parse(await (await call("GET", `/v1/offboarding/${caseId}`)).json());
    const p = (await (await call("GET", `/v1/proposals/${c.steps[0]!.proposalId}`)).json()) as { diff: { label: string; after: string }[] };
    expect(p.diff.some((d) => d.label.startsWith("Salary"))).toBe(false);
    expect(p.diff.find((d) => d.label.startsWith("Unused PTO payout"))?.after).toBe("$10,038.46");
  });

  it("off-cycle validates OffCycleRequest and answers a pending proposal", async () => {
    expect((await call("POST", "/v1/payrolls/off-cycle", { workerIds: [], periodStart: "2026-10-01", periodEnd: "2026-10-15", payday: "2026-10-27", reason: "bonus" })).status).toBe(400);
    const res = await call("POST", "/v1/payrolls/off-cycle", { workerIds: ["wrk_0006"], periodStart: "2026-10-01", periodEnd: "2026-10-15", payday: "2026-10-27", reason: "bonus", bonusCents: { wrk_0006: 120_000 } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "pending_approval" });
  });
});
