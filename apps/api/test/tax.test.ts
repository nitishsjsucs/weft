// Contract tests for /v1/tax and the tax.* read commands (owner: t2-world).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EmployerRate, TaxAccount } from "@weft/contracts";
import { directCtx, directDeps, ensureTestPrincipals, findCommand, nonEmptyUntrusted, runDirect } from "@weft/core";
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
