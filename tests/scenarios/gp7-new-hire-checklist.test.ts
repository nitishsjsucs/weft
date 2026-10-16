// Scenario GP7 (docs/wave2.md): the new-hire checklist unblocks payroll. Owner: w2-onboarding. Scripted provider.
// After GP6's signatures the new hire files the W-4, the CO DR 0004, direct deposit (an ABA failure is refused, a
// valid number is verified by the bank simulator, only last 4 digits are stored), the I-9 with an ID image under the
// data dir (masked in every response) and a benefits election. 7 of 7 turns the worker active, and the next payroll
// draft pays them with the W-4 extra withholding, the elected pre-tax deductions and no MISSING_BANK_ACCOUNT flag.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { payroll } from "@weft/core";
import { createTestWeft, type TestWeft } from "./helpers";

const CANDIDATE = { candidateFirst: "Rowan", candidateLast: "Ellery", candidateEmail: "rowan.ellery@candidate.example", title: "Firmware Test Engineer", departmentId: "dpt_hardware", workState: "CO", baseCents: 13_200_000, payKind: "salary", startDate: "2026-11-02" };
const NAME = "Rowan Ellery";
const ACCOUNT = "4417390056";
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");

describe("GP7 new-hire checklist unblocks payroll", () => {
  let weft: TestWeft;
  beforeAll(async () => { weft = await createTestWeft(); });
  afterAll(async () => { await weft.close(); });
  const call = async (who: string, method: string, path: string, body?: unknown) => {
    const res = await weft.app.request(path, { method, headers: { ...weft.uiHeaders(who), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as any };
  };
  const me = async () => (await call(persona, "GET", "/v1/portal/me")).json;

  let persona = "", workerId = "";
  it("reaches 2 of 7 after the GP6 signatures", async () => {
    const offerId = (await call("usr_dana", "POST", "/v1/offers", CANDIDATE)).json.data.offer_id;
    const sent = (await call("usr_dana", "POST", `/v1/offers/${offerId}/send`)).json.data;
    persona = sent.persona_principal_id; workerId = sent.reserved_worker_id;
    await call(persona, "POST", "/v1/portal/offer/view");
    for (const d of (await me()).documents) expect((await call(persona, "POST", `/v1/portal/documents/${d.id}/sign`, { typedName: NAME, documentSha256: d.sha256 })).status).toBe(200);
    const v = await me();
    expect([v.done, v.total, v.payrollReady]).toEqual([2, 7, false]);
  });

  it("the W-4 writes tax_profiles from the portal and the DR 0004 writes the state fields", async () => {
    const w4 = await call(persona, "POST", "/v1/portal/w4", { filingStatus: "single", step2Checkbox: false, step3Cents: 0, step4aCents: 0, step4bCents: 0, step4cCents: 5_000, exempt: false, typedName: NAME });
    expect(w4.status).toBe(200);
    expect((await call(persona, "POST", "/v1/portal/state-withholding", { state: "TX", filingStatus: "single", allowances: 0, extraCents: 0, exempt: false, typedName: NAME })).json.code).toBe("DOMAIN_WRONG_STATE");
    expect((await call(persona, "POST", "/v1/portal/state-withholding", { state: "CO", filingStatus: "single", allowances: 0, extraCents: 0, exempt: false, typedName: NAME })).status).toBe(200);
    const [tp] = await weft.db.all<Record<string, unknown>>(sql`SELECT w4_version, filing_status, step4c_cents, source, state_filing_status FROM tax_profiles WHERE worker_id = ${workerId}`);
    expect(tp).toEqual({ w4_version: "2020", filing_status: "single", step4c_cents: 5_000, source: "portal", state_filing_status: "single" });
  });

  it("direct deposit refuses a failed ABA checksum inline, verifies a valid one and stores only last 4 digits", async () => {
    const bad = await call(persona, "POST", "/v1/portal/direct-deposit", { bankName: "Sim Federal Credit Union", routing: "021000022", account: ACCOUNT, accountType: "checking", typedName: NAME });
    expect([bad.status, bad.json.code, bad.json.field]).toEqual([422, "INVALID_INPUT", "routing"]);
    expect(bad.json.message).toContain("ABA checksum");
    const ok = await call(persona, "POST", "/v1/portal/direct-deposit", { bankName: "Sim Federal Credit Union", routing: "021000021", account: ACCOUNT, accountType: "checking", typedName: NAME });
    expect(ok.status).toBe(200);
    expect(ok.json.data).toMatchObject({ routing_last4: "0021", account_last4: "0056", verification: "verified" });
    const banks = await weft.db.all<Record<string, unknown>>(sql`SELECT account_last4, routing_last4, credential_ref, status, source FROM bank_accounts WHERE worker_id = ${workerId}`);
    expect(banks).toEqual([{ account_last4: "0056", routing_last4: "0021", credential_ref: `vault:bank-${workerId.replace("_", "-")}`, status: "active", source: "portal" }]);
    const ver = await weft.db.all<{ status: string }>(sql`SELECT status FROM sim_bank_verifications WHERE worker_id = ${workerId}`);
    expect(ver.map((r) => r.status)).toEqual(["verified"]);
    // The full account number is in no table: actions, submissions, documents, bank rows, events, sim rows.
    for (const table of ["actions", "onboarding_submissions", "documents", "bank_accounts", "events", "sim_bank_verifications", "signatures"]) {
      const rows = await weft.db.all<Record<string, unknown>>(sql.raw(`SELECT * FROM ${table}`));
      expect(JSON.stringify(rows), table).not.toContain(ACCOUNT);
    }
  });

  it("the I-9 image is stored under the data dir and every response shows it masked", async () => {
    const form = new FormData();
    form.set("citizenship", "citizen"); form.set("documentKind", "us_passport"); form.set("documentNumberLast4", "A7Q2"); form.set("expiresOn", "2031-04-30"); form.set("typedName", NAME);
    form.set("idImage", new Blob([PNG], { type: "image/png" }), "rowan-passport.png");
    const res = await weft.app.request("/v1/portal/i9", { method: "POST", headers: weft.uiHeaders(persona), body: form });
    const out = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(out.data.upload).toMatchObject({ masked: true, fileName: "ro***.png", bytes: PNG.length });
    expect(JSON.stringify(out)).not.toContain("rowan-passport");
    const [row] = await weft.db.all<{ storage_path: string; sha256: string }>(sql`SELECT storage_path, sha256 FROM uploads WHERE worker_id = ${workerId}`);
    expect(row!.storage_path).toMatch(/^uploads\/[0-9a-f]{64}\.bin$/);
    expect(readFileSync(join(weft.dataDir, row!.storage_path)).equals(PNG)).toBe(true);
    const view = await me();
    expect(view.upload).toMatchObject({ masked: true, fileName: "ro***.png" });
    expect(JSON.stringify(view)).not.toContain(row!.sha256);
    expect(existsSync(join(weft.dataDir, "uploads"))).toBe(true);
  });

  it("the benefits election writes enrollments; 7 of 7 turns the worker active", async () => {
    const plans = (await me()).plans as { id: string; type: string; name: string }[];
    const ppo = plans.find((p) => p.name.includes("PPO"))!, dental = plans.find((p) => p.type === "dental")!, k401 = plans.find((p) => p.type === "401k")!;
    const out = await call(persona, "POST", "/v1/portal/benefits", { elections: [{ planId: ppo.id, tier: "ee", deferralBps: null }, { planId: dental.id, tier: "ee", deferralBps: null }, { planId: k401.id, tier: null, deferralBps: 500 }], waived: ["vision"], typedName: NAME });
    expect(out.status, JSON.stringify(out.json)).toBe(200);
    const ens = await weft.db.all<Record<string, unknown>>(sql`SELECT plan_id, tier, employee_cents, deferral_bps, effective_from FROM benefit_enrollments WHERE worker_id = ${workerId} ORDER BY id`);
    expect(ens).toEqual([
      { plan_id: ppo.id, tier: "ee", employee_cents: 9_500, deferral_bps: null, effective_from: "2026-11-02" },
      { plan_id: dental.id, tier: "ee", employee_cents: 800, deferral_bps: null, effective_from: "2026-11-02" },
      { plan_id: k401.id, tier: null, employee_cents: null, deferral_bps: 500, effective_from: "2026-11-02" },
    ]);
    const v = await me();
    expect([v.done, v.total, v.payrollReady, v.workerStatus]).toEqual([7, 7, true, "active"]);
    const evts = await weft.db.all<{ type: string; payload_json: string }>(sql`SELECT type, payload_json FROM events WHERE type IN ('onboarding.task_completed', 'worker.onboarding_completed') ORDER BY id`);
    expect(evts.filter((e) => e.type === "onboarding.task_completed").map((e) => JSON.parse(e.payload_json).kind)).toEqual(["sign_offer", "sign_confidentiality", "federal_w4", "state_withholding", "direct_deposit", "i9_sim", "benefits_selection"]);
    expect(evts.at(-1)).toEqual({ type: "worker.onboarding_completed", payload_json: JSON.stringify({ worker_id: workerId }) });
    const lib = (await call("usr_dana", "GET", `/v1/workers/${workerId}/documents?status=signed`)).json as { kind: string }[];
    expect(lib.map((d) => d.kind)).toEqual(["offer_letter", "confidentiality_agreement", "w4", "state_withholding", "direct_deposit_auth", "i9", "benefits_election"]);
  });

  it("the next payroll draft pays the hire: W-4 withholding, pre-tax deductions, no MISSING_BANK_ACCOUNT", async () => {
    const draft = await call("usr_dana", "POST", "/v1/payrolls/drafts", { payScheduleId: "ps_us_semimonthly", periodEnd: "2026-11-15" });
    expect(draft.status).toBe(200);
    const runId = draft.json.data.run_id as string;
    const [pc] = await weft.db.all<{ gross_cents: number; deductions_json: string; taxes_json: string; flags_json: string }>(sql`SELECT gross_cents, deductions_json, taxes_json, flags_json FROM paychecks WHERE payroll_run_id = ${runId} AND worker_id = ${workerId}`);
    expect(pc).toBeDefined();
    expect(pc!.gross_cents).toBeGreaterThan(0);
    const flags = (JSON.parse(pc!.flags_json) as { rule: string }[]).map((f) => f.rule);
    expect(flags).not.toContain("MISSING_BANK_ACCOUNT");
    expect(flags).not.toContain("MISSING_W4");
    const deductions = JSON.parse(pc!.deductions_json) as { code: string; pretax: boolean; amountCents: number }[];
    expect(deductions).toEqual(expect.arrayContaining([
      { code: "section125_medical", pretax: true, amountCents: 9_500 }, { code: "section125_medical", pretax: true, amountCents: 800 },
      { code: "401k_traditional", pretax: true, amountCents: Math.round(pc!.gross_cents * 0.05) },
    ]));
    // Federal withholding carries the W-4 step 4(c) extra $50.00: recompute the same period with step 4(c) at 0.
    const taxes = JSON.parse(pc!.taxes_json) as { code: string; amount_cents: number }[];
    const fit = taxes.find((t) => t.code === "fit")!;
    const [run] = await weft.db.all<{ period_start: string; period_end: string; payday: string }>(sql`SELECT period_start, period_end, payday FROM payroll_runs WHERE id = ${runId}`);
    await weft.db.run(sql`UPDATE tax_profiles SET step4c_cents = 0 WHERE worker_id = ${workerId}`);
    const without = (await payroll.computePeriod(weft.db, { companyId: "cmp_larkspur", payScheduleId: "ps_us_semimonthly", periodStart: run!.period_start, periodEnd: run!.period_end, payday: run!.payday })).find((c) => c.workerId === workerId)!;
    await weft.db.run(sql`UPDATE tax_profiles SET step4c_cents = 5000 WHERE worker_id = ${workerId}`);
    const fitWithout = (without.calc.taxes as { code: string; amount_cents: number }[]).find((t) => t.code === "fit")!;
    expect(fit.amount_cents - fitWithout.amount_cents).toBe(5_000);
  });
});
