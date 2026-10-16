// Scenario GP9 (docs/wave2.md). Owner: w2-offboarding. Termination with access revocation, end to end over HTTP on
// the scripted provider: Dana terminates an active employee, the case opens with the eight ordered steps, the four
// proposal steps are pending proposals with previews, approving each runs its simulator call, the direct steps run
// after final pay, every step has its own action row and offboarding.step_done event, and the case completes.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { OFFBOARDING_STEP_ORDER, OffboardingCase, type Proposal, type ToolOutcome } from "@weft/contracts";
import { createTestWeft, type TestWeft } from "./helpers";

const WORKER = "wrk_0004";   // Imani Ferreira (demo), Engineering: google_ws, chat, github, a laptop, benefits

describe("GP9 termination with access revocation", () => {
  let weft: TestWeft;
  beforeAll(async () => { weft = await createTestWeft(); });
  afterAll(async () => { await weft.close(); });

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await weft.app.request(path, { method, headers: { ...weft.uiHeaders("usr_dana"), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as unknown };
  };
  const getCase = async (id: string) => OffboardingCase.parse((await call("GET", `/v1/offboarding/${id}`)).json);

  it("terminates, revokes access through the simulators and completes the case", async () => {
    // An SSO account so the SSO step has something to deactivate (the seed gives every employee google_ws and chat).
    const sso = await call("POST", "/v1/tools/it.create_account", { worker_id: WORKER, system: "sso" });
    expect(sso.status).toBe(200);
    const actionsBefore = (await weft.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM actions`))[0]!.n;

    const t = await call("POST", `/v1/workers/${WORKER}/terminate`, { kind: "voluntary", lastDay: "2026-10-30", reasonNote: "Moving abroad", payUnusedPto: true });
    if (t.status !== 200) console.log(JSON.stringify(t.json));
    expect(t.status).toBe(200);
    const out = t.json as ToolOutcome & { data: { case_id: string } };
    expect(out).toMatchObject({ ok: true, status: "done" });
    const caseId = out.data.case_id;

    const worker = (await weft.db.all<{ status: string; end_date: string | null }>(sql`SELECT status, end_date FROM workers WHERE id = ${WORKER}`))[0]!;
    expect(worker).toEqual({ status: "offboarding", end_date: "2026-10-30" });
    const evt = await weft.db.all<{ payload_json: string }>(sql`SELECT payload_json FROM events WHERE type = 'worker.terminated'`);
    expect(evt.map((e) => JSON.parse(e.payload_json))).toEqual([{ worker_id: WORKER, case_id: caseId }]);

    let c = await getCase(caseId);
    expect(c.steps.map((s) => s.kind)).toEqual([...OFFBOARDING_STEP_ORDER]);
    expect(Object.fromEntries(c.steps.map((s) => [s.kind, s.status]))).toEqual({
      final_pay: "proposed", directory_suspend: "proposed", sso_deactivate: "proposed", group_removal: "pending",
      app_removal: "pending", device_lock: "proposed", cobra_notice: "pending", benefits_terminate: "pending",
    });

    // Each proposal step has a pending proposal with a preview.
    const proposalOf = async (kind: string) => {
      const id = c.steps.find((s) => s.kind === kind)!.proposalId!;
      return (await call("GET", `/v1/proposals/${id}`)).json as Proposal;
    };
    const fp = await proposalOf("final_pay");
    expect(fp).toMatchObject({ status: "pending", command: "offboarding.final_pay", risk: "R4", taintedBy: null, onBehalfOf: "usr_dana" });
    expect(fp.headline).toMatch(/^Final pay for Imani Ferreira \(demo\) \(wrk_0004\): dismissal run, net \$[\d,]+\.\d\d/);
    expect(fp.diff.map((d) => d.label)).toEqual(expect.arrayContaining(["Gross pay", "Net pay to bank"]));
    expect(fp.diff.some((d) => d.label.startsWith("Salary (") )).toBe(true);
    expect(fp.diff.some((d) => d.label.startsWith("Unused PTO payout (90.00 h"))).toBe(true);
    const ds = await proposalOf("directory_suspend");
    expect(ds.diff).toEqual([{ label: "google_ws imani.ferreira", before: "active", after: "suspended" }]);

    // Direct steps refuse before final pay is approved.
    const early = await call("POST", "/v1/tools/offboarding.run_step", { case_id: caseId, step: "group_removal" });
    expect(early.status).toBe(422);
    expect((early.json as { code: string }).code).toBe("DOMAIN_FINAL_PAY_PENDING");

    for (const kind of ["final_pay", "directory_suspend", "sso_deactivate", "device_lock"]) {
      const p = await proposalOf(kind);
      const res = await call("POST", `/v1/proposals/${p.id}/approve`, {});
      expect(res.status, kind).toBe(200);
      expect((res.json as { proposal: Proposal }).proposal.status, kind).toBe("executed");
    }
    c = await getCase(caseId);
    expect(c.steps.filter((s) => s.status === "done").map((s) => s.kind)).toEqual(["final_pay", "directory_suspend", "sso_deactivate", "device_lock"]);

    // Final pay is a dismissal run submitted to the bank simulator.
    const run = (await weft.db.all<{ id: string; subtype: string; status: string; bank_batch_id: string | null }>(sql`SELECT id, subtype, status, bank_batch_id FROM payroll_runs WHERE subtype = 'dismissal'`));
    expect(run).toHaveLength(1);
    expect(run[0]).toMatchObject({ subtype: "dismissal", status: "processing" });
    const batch = await weft.db.all<{ status: string }>(sql`SELECT status FROM sim_bank_batches WHERE id = ${run[0]!.bank_batch_id}`);
    expect(batch).toHaveLength(1);
    const pyc = (await weft.db.all<{ earnings_json: string; worker_id: string }>(sql`SELECT earnings_json, worker_id FROM paychecks WHERE payroll_run_id = ${run[0]!.id}`));
    expect(pyc.map((p) => p.worker_id)).toEqual([WORKER]);
    expect((JSON.parse(pyc[0]!.earnings_json) as { type: string }[]).map((e) => e.type)).toEqual(["salary", "pto_payout"]);

    // Final pay covers the period, so the open regular draft for Oct 16 to 31 no longer pays Imani.
    const regular = await weft.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM paychecks WHERE payroll_run_id = 'pay_2026_10_30' AND worker_id = ${WORKER}`);
    expect(regular[0]!.n).toBe(0);

    // The IdP simulator suspended the directory and SSO accounts.
    const idp = await weft.db.all<{ system: string; status: string }>(sql`SELECT system, status FROM sim_idp_accounts WHERE worker_id = ${WORKER} ORDER BY system`);
    expect(Object.fromEntries(idp.map((a) => [a.system, a.status]))).toMatchObject({ google_ws: "suspended", sso: "suspended" });

    // The direct steps run after final pay.
    for (const step of ["group_removal", "app_removal", "cobra_notice", "benefits_terminate"]) {
      const res = await call("POST", "/v1/tools/offboarding.run_step", { case_id: caseId, step });
      expect(res.status, step).toBe(200);
    }
    c = await getCase(caseId);
    expect(c.status).toBe("complete");
    expect(c.steps.every((s) => s.status === "done")).toBe(true);
    const after = (await weft.db.all<{ status: string; end_date: string | null }>(sql`SELECT status, end_date FROM workers WHERE id = ${WORKER}`))[0]!;
    expect(after).toEqual({ status: "inactive", end_date: "2026-10-30" });

    const accounts = await weft.db.all<{ system: string; status: string; groups_json: string }>(sql`SELECT system, status, groups_json FROM it_accounts WHERE worker_id = ${WORKER} ORDER BY system`);
    expect(accounts.every((a) => a.status === "suspended" && a.groups_json === "[]")).toBe(true);
    const enrolls = await weft.db.all<{ status: string; effective_to: string | null }>(sql`SELECT status, effective_to FROM benefit_enrollments WHERE worker_id = ${WORKER}`);
    expect(enrolls.length).toBeGreaterThan(0);
    expect(enrolls.every((e) => e.status === "terminated" && e.effective_to === "2026-10-31")).toBe(true);
    const mail = await weft.sims.email.list();
    const cobra = mail.filter((m) => m.kind === "cobra_notice");
    expect(cobra).toHaveLength(1);
    expect(cobra[0]).toMatchObject({ relatedRef: caseId, from: "benefits@larkspur.example" });
    expect(cobra[0]!.body).toContain("Your group health coverage ends on 2026-10-31.");

    // Every step: its own action row and its own offboarding.step_done event.
    const seqs = c.steps.map((s) => s.actionSeq);
    expect(new Set(seqs).size).toBe(8);
    const acts = await weft.db.all<{ seq: number; command: string }>(sql`SELECT seq, command FROM actions WHERE seq > ${actionsBefore} ORDER BY seq`);
    for (const s of c.steps) expect(acts.find((a) => a.seq === s.actionSeq)?.command, s.kind).toMatch(/^offboarding\./);
    const done = await weft.db.all<{ payload_json: string }>(sql`SELECT payload_json FROM events WHERE type = 'offboarding.step_done'`);
    expect(new Set(done.map((e) => (JSON.parse(e.payload_json) as { step_id: string }).step_id))).toEqual(new Set(c.steps.map((s) => s.id)));
  });

  it("October reconciliation after the case expects coverage through the end of the month, so the leaver is not a finding", async () => {
    // GP9 ended Imani's enrollments effective 2026-10-31 (the COBRA notice says the same); the carrier bills October in
    // full, which is right. Only the three planted errors remain.
    const res = await call("POST", "/v1/benefits/reconciliation/run", { month: "2026-10" });
    expect(res.status).toBe(200);
    const findings = (await call("GET", "/v1/benefits/reconciliation?month=2026-10")).json as { kind: string; workerId: string | null }[];
    expect(findings.filter((f) => f.workerId === WORKER)).toEqual([]);
    expect(findings.map((f) => f.kind).sort()).toEqual(["missing_dependent", "terminated_but_billed", "wrong_tier"]);
  });

  it("the leaver drops out of the 2027 open enrollment list, so the chase routine never reminds them", async () => {
    const rows = (await call("GET", "/v1/benefits/open-enrollment")).json as { workerId: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.workerId === WORKER)).toBe(false);
  });

  it("refuses a second termination and a contractor", async () => {
    const again = await call("POST", `/v1/workers/${WORKER}/terminate`, { kind: "voluntary", lastDay: "2026-10-30" });
    expect(again.status).toBe(422);
    expect((again.json as { code: string }).code).toBe("DOMAIN_NOT_ACTIVE");
    const contractor = (await weft.db.all<{ id: string }>(sql`SELECT id FROM workers WHERE type = 'contractor' ORDER BY id LIMIT 1`))[0]!.id;
    const c = await call("POST", `/v1/workers/${contractor}/terminate`, { kind: "end_of_contract", lastDay: "2026-10-30" });
    expect(c.status).toBe(422);
    expect((c.json as { code: string }).code).toBe("DOMAIN_NOT_EMPLOYEE");
  });
});
