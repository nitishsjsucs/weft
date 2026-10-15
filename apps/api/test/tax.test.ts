// Contract tests for /v1/tax and the tax.* read commands (owner: t2-world).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EmployerRate, TaxAccount } from "@weft/contracts";
import { directCtx, directDeps, directExecutors, ensureTestPrincipals, findCommand, nonEmptyUntrusted, runDirect } from "@weft/core";
import { createSimulators } from "@weft/sim";
import { createTestWeft, type TestWeft } from "../src/testing";

let weft: TestWeft;
beforeAll(async () => { weft = await createTestWeft(); await ensureTestPrincipals(weft.db); });
afterAll(async () => { await weft.close(); });
const deps = () => directDeps(weft.db, weft.clock, createSimulators({ db: weft.db, clock: weft.clock }));
const get = (p: string) => weft.app.request(p, { headers: weft.uiHeaders("usr_theo") });

describe("GET /v1/tax/accounts and /v1/tax/rates", () => {
  it("lists 7 agency accounts with CO not registered", async () => {
    const accts = (await (await get("/v1/tax/accounts")).json()).map((a: unknown) => TaxAccount.parse(a));
    expect(accts.map((a: TaxAccount) => [a.agency, a.accountNumber, a.status])).toEqual([
      ["irs", "00-4817265", "active"], ["ca_edd", "000-4817-2", "active"], ["ny_dtf", "004817265-01-3", "active"], ["ny_dol", "00-48172 6", "active"],
      ["tx_twc", "00-481726-5", "active"], ["co_dor", null, "not_registered"], ["co_cdle", null, "not_registered"],
    ]);
  });
  it("lists employer rates effective 2026-01-01 and filters by jurisdiction", async () => {
    const rates = (await (await get("/v1/tax/rates")).json()).map((r: unknown) => EmployerRate.parse(r));
    expect(rates.map((r: EmployerRate) => `${r.jurisdiction}:${r.code}:${r.rate}:${r.wageBase.amount}`)).toEqual(["CA:ett:0.001:700000", "CA:sui:0.034:700000", "NY:sui:0.041:1760000", "TX:sui:0.027:900000"]);
    const ca = await (await get("/v1/tax/rates?jurisdiction=CA")).json();
    expect(ca).toHaveLength(2);
    expect((await get("/v1/tax/rates?jurisdiction=ZZ")).status).toBe(400);
  });
});

describe("tax read commands", () => {
  it("tax.list_registrations reports CO incomplete", async () => {
    const out = await runDirect("tax.list_registrations", {}, directCtx(weft.clock), deps());
    expect(out.data.by_state).toEqual({ US: "active", CA: "active", NY: "active", TX: "active", CO: "incomplete" });
    expect(nonEmptyUntrusted(findCommand("tax.list_registrations"), out.data)).toEqual([]);
  });
  it("tax.get_rates shows rate displays; detailed adds the FUTA facts with the CA credit reduction labeled", async () => {
    const out = await runDirect("tax.get_rates", { jurisdiction: "CA" }, directCtx(weft.clock), deps());
    expect(out.data.rates.map((r: { code: string; rate_display: string; wage_base_display: string }) => [r.code, r.rate_display, r.wage_base_display])).toEqual([["ett", "0.1%", "$7,000.00"], ["sui", "3.4%", "$7,000.00"]]);
    const d = await runDirect("tax.get_rates", { response_format: "detailed" }, directCtx(weft.clock), deps());
    expect(d.data.federal.credit_reduction).toEqual([
      { state: "CA", year: 2025, rate: "0.012", rate_display: "1.2%", status: "final" },
      expect.objectContaining({ state: "CA", year: 2026, rate: "0.015", status: "projection" }),
    ]);
  });
});

describe("hero rate change (GP1 domain)", () => {
  let noticeId = "";
  const dana = () => directExecutors(weft.db, weft.clock, weft.sims).human("usr_dana");
  beforeAll(async () => {
    const out = await dana().exec("sim.deliver_notice", { scenario: "ca_de2088_rate_change" });
    noticeId = (out as { data: { notice_id: string } }).data.notice_id;
  });

  it("tax.rate_change_impact returns rate_delta, counts and per-worker cents", async () => {
    const out = await runDirect("tax.rate_change_impact", { jurisdiction: "CA", code: "sui", new_rate: "0.015", effective_from: "2026-01-01" }, directCtx(weft.clock), deps());
    expect(out.data).toMatchObject({ old_rate: "0.034", new_rate: "0.015", rate_delta: "0.019", rate_delta_display: "1.9%", employees_in_state: 22 });
    expect(out.data.affected_count + out.data.unaffected_count).toBe(22);
    expect(out.data.workers).toHaveLength(22);
    expect(out.data.workers[0]).toEqual(expect.objectContaining({ worker_id: "wrk_0001", credit_cents: expect.any(Number), credit_display: expect.stringMatching(/^\$/) }));
    expect(JSON.stringify(out.data).length).toBeLessThan(8000);
  });

  it("a mismatched rate or account is refused with a DOMAIN_ code whose hint shows the derived values", async () => {
    const def = findCommand("tax.update_rate");
    const good = { tax_account_id: "txa_0002", code: "sui", rate: "0.015", effective_from: "2026-01-01", source_notice_id: noticeId };
    for (const bad of [{ ...good, rate: "0.02" }, { ...good, tax_account_id: "txa_0005" }, { ...good, effective_from: "2026-07-01" }]) {
      const p = def.preview!(def.input.parse(bad), directCtx(weft.clock), deps());
      await expect(p).rejects.toMatchObject({ code: "DOMAIN_NOTICE_MISMATCH", hint: `The notice ${noticeId} says: account 000-4817-2 (txa_0002), sui 0.015 (1.5%) effective 2026-01-01`, example: good });
    }
    const out = await dana().exec("tax.update_rate", { ...good, rate: "0.02" });
    expect(out).toMatchObject({ ok: false, refusal: { code: "DOMAIN_NOTICE_MISMATCH", example: good } });
    // The message carries the derived values too, for executors that read hints only from the static errorHints.
    expect(!out.ok && out.refusal.message).toContain(`The notice ${noticeId} says: account 000-4817-2 (txa_0002), sui 0.015 (1.5%) effective 2026-01-01`);
  });

  it("matching args preview a headline built only from structured fields; executing keeps the old row; revert restores 3.4%", async () => {
    const def = findCommand("tax.update_rate");
    const args = { tax_account_id: "txa_0002", code: "sui", rate: "0.015", effective_from: "2026-01-01", source_notice_id: noticeId };
    const pv = await def.preview!(def.input.parse(args), directCtx(weft.clock), deps());
    expect(pv.title).toBe("Update CA SUI rate 3.4% to 1.5% effective 2026-01-01 on account 000-4817-2 for 22 CA employees");
    expect(pv.content).toEqual([]);
    expect(pv.diff[0]).toEqual({ label: "CA SUI rate", before: "3.4%", after: "1.5%" });
    expect(pv.evidence[0]).toEqual({ label: "Notice", ref: noticeId });
    expect(def.risk(args as never)).toBe("R2");
    expect(def.approval).toBe("always");

    const done = await dana().exec("tax.update_rate", args);
    expect(done.ok).toBe(true);
    const rateId = (done as { data: { rate_id: string } }).data.rate_id;
    const rates = await (await get("/v1/tax/rates?jurisdiction=CA")).json();
    expect(rates.map((r: EmployerRate) => [r.code, r.rate, r.source, r.supersededActionSeq !== null])).toEqual([["ett", "0.001", "seed", false], ["sui", "0.034", "seed", true], ["sui", "0.015", `notice:${noticeId}`, false]]);
    const cur = await runDirect("tax.get_rates", { jurisdiction: "CA" }, directCtx(weft.clock), deps());
    expect(cur.data.rates.map((r: { rate: string }) => r.rate)).toEqual(["0.001", "0.015"]);

    const rev = await dana().exec("tax.revert_rate", { rate_id: rateId });
    expect(rev.ok).toBe(true);
    const back = await runDirect("tax.get_rates", { jurisdiction: "CA" }, directCtx(weft.clock), deps());
    expect(back.data.rates.map((r: { rate: string; source: string }) => [r.rate, r.source])).toEqual([["0.001", "seed"], ["0.034", `revert:${rateId}`]]);
    expect((await (await get("/v1/tax/rates?jurisdiction=CA")).json())).toHaveLength(4);
  });
});
