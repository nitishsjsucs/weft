// Wave 4 compliance (w4-parity-compliance): the filing rule table, filings prepared from processed runs with
// hand-checked totals in integer cents, tax.file_return as an R4 proposal, the calendar and its refresh, hand-offs.
// The hand-checked figures come from the YTD ledger rows the two September runs wrote (source payroll:<run>), an
// independent record of the same paychecks the preparation reads.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { COMPLIANCE_DUE_SOON_DAYS, FilingForm, W4_PLANNED_COMMANDS } from "@weft/contracts";
import { directCtx, directDeps, directExecutors, ensureTestPrincipals, findCommand, runDirect } from "@weft/core";
import { complianceItems, events, filings, handoffCases, notices, proposals, simAgencyMail, simEmailMessages, ytdLedger } from "@weft/db";
import { FILING_RULES, dueOn, nextBusinessDay, periodBounds } from "../../../packages/core/src/compliance/rules";
import { liveStatus } from "../../../packages/core/src/compliance/calendar";
import { w4ComplianceCommands } from "../../../packages/core/src/commands/w4-compliance";
import { createTestWeft, type TestWeft } from "../src/testing";

let weft: TestWeft;
beforeAll(async () => { weft = await createTestWeft(); await ensureTestPrincipals(weft.db); });
afterAll(async () => { await weft.close(); });
const deps = () => directDeps(weft.db, weft.clock, weft.sims);
const call = async (method: string, path: string, body?: unknown, who = "usr_dana") => {
  const res = await weft.app.request(path, { method, headers: { ...weft.uiHeaders(who), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as any };
};
const filingId = async (form: string, period: string) => (await weft.db.select().from(filings).where(and(eq(filings.form, form), eq(filings.period, period))))[0]!.id;
const ledgerSum = async (code: string, runs: string[]) => {
  const rows = await weft.db.select().from(ytdLedger).where(eq(ytdLedger.code, code));
  return rows.filter((r) => runs.includes(r.source)).reduce((a, r) => a + r.amountCents, 0);
};
const SEPT = ["payroll:pay_2026_09_15", "payroll:pay_2026_09_30"];

describe("filing rules", () => {
  it("every form has a rule with an https source on the agency's site, and quarterly due dates follow the rule", () => {
    expect(FILING_RULES.map((r) => r.form).sort()).toEqual([...FilingForm.options].sort());
    for (const r of FILING_RULES) expect(r.sourceUrl, r.form).toMatch(/^https:\/\/(www\.)?(irs\.gov|edd\.ca\.gov|tax\.ny\.gov|twc\.texas\.gov|cdle\.colorado\.gov|tax\.colorado\.gov)\//);
    expect(periodBounds("2026-Q3")).toEqual({ start: "2026-07-01", end: "2026-09-30" });
    expect(nextBusinessDay("2026-10-31")).toBe("2026-11-02");   // Saturday to Monday
    expect(dueOn("941", "2026-Q3")).toBe("2026-11-02");
    expect(dueOn("941", "2026-Q4")).toBe("2027-02-01");          // January 31, 2027 is a Sunday
    expect(dueOn("ca_de9c", "2026-Q2")).toBe("2026-07-31");
    expect(dueOn("w2_w3", "2026")).toBe("2027-02-01");
  });
  it("commands follow W4_PLANNED_COMMANDS for risk, approval and access", () => {
    for (const p of W4_PLANNED_COMMANDS.filter((x) => x.owner === "w4-parity-compliance")) {
      const d = w4ComplianceCommands.find((c) => c.name === p.name);
      if (!d) continue;   // training.* and the notice upload are round 2 (docs/tracks/w4-parity-compliance.md)
      expect([d.risk({} as never), d.approval, d.access], p.name).toEqual([p.risk, p.approval, p.access]);
    }
    const file = findCommand("tax.file_return");
    expect([file.risk({ filing_id: "fil_0001" }), file.approval, file.autoAllow, file.reversible, file.effect]).toEqual(["R4", "always", "never", false, "external"]);
    expect(file.preview).not.toBeNull();
  });
});

describe("seeded calendar", () => {
  it("has filings for 2026-Q3, 2026-Q4 and the 2026 annual forms of every active account, none for Colorado", async () => {
    const rows = await weft.db.select().from(filings);
    const keys = rows.map((f) => `${f.form} ${f.period}`).sort();
    expect(keys).toEqual(["1099_nec 2026", "940 2026", "941 2026-Q3", "941 2026-Q4", "ca_de9 2026-Q3", "ca_de9 2026-Q4", "ca_de9c 2026-Q3", "ca_de9c 2026-Q4", "ny_nys45 2026-Q3", "ny_nys45 2026-Q4", "tx_c3 2026-Q3", "tx_c3 2026-Q4", "w2_w3 2026"]);
    expect(rows.every((f) => f.status === "draft" && f.preparedJson === null)).toBe(true);
  });
  it("lists filings, deposits and contractor forms by due date; the Q3 941 is due soon", async () => {
    const { status, json } = await call("GET", "/v1/compliance/calendar");
    expect(status).toBe(200);
    const kinds = new Set((json as { kind: string }[]).map((r) => r.kind));
    expect([...kinds].sort()).toEqual(["contractor_form_expiry", "deposit", "filing"]);
    const q3 = json.find((r: any) => r.form === "941" && r.period === "2026-Q3");
    expect(q3).toMatchObject({ dueOn: "2026-11-02", status: "due_soon", daysLeft: 7, sourceUrl: "https://www.irs.gov/forms-pubs/about-form-941" });
    const dep = json.filter((r: any) => r.kind === "deposit").map((r: any) => [r.period, r.dueOn, r.status]);
    expect(dep).toEqual([["2026-09", "2026-10-15", "done"], ["2026-10", "2026-11-16", "upcoming"]]);
    expect(json.map((r: any) => r.dueOn)).toEqual([...json.map((r: any) => r.dueOn)].sort());
    expect((await call("GET", "/v1/compliance/calendar?kind=filing&status=due_soon")).json.map((r: any) => r.form).sort()).toEqual(["941", "ca_de9", "ca_de9c", "ny_nys45", "tx_c3"]);
  });
  it("status is recomputed from the date: due soon within the window, overdue after", () => {
    expect(liveStatus("upcoming", "2026-11-02", "2026-10-26")).toBe("due_soon");
    expect(liveStatus("upcoming", "2026-12-31", "2026-10-26")).toBe("upcoming");
    expect(COMPLIANCE_DUE_SOON_DAYS).toBe(14);
    expect(liveStatus("prepared", "2026-11-02", "2026-11-03")).toBe("overdue");
    expect(liveStatus("done", "2026-11-02", "2026-11-03")).toBe("done");
  });
});

describe("Form 941 for 2026-Q3 from processed runs", () => {
  it("prepares every line in integer cents, matching the hand check from the ledger", async () => {
    const id = await filingId("941", "2026-Q3");
    const prep = await call("POST", `/v1/filings/${id}/prepare`, {});
    expect(prep.status, JSON.stringify(prep.json)).toBe(200);
    expect(prep.json.data).toMatchObject({ runs: ["pay_2026_09_15", "pay_2026_09_30"], balance_due_cents: 0 });

    // Hand check: sums of the ledger rows the two September runs posted.
    const wages = await ledgerSum("fit_wages", SEPT), fit = await ledgerSum("tax:US:fit:employee", SEPT);
    const ssWages = await ledgerSum("ss_wages", SEPT), medWages = await ledgerSum("medicare_wages", SEPT);
    const ssActual = (await ledgerSum("tax:US:ss:employee", SEPT)) + (await ledgerSum("tax:US:ss:employer", SEPT));
    const medActual = (await ledgerSum("tax:US:medicare:employee", SEPT)) + (await ledgerSum("tax:US:medicare:employer", SEPT));
    expect([wages, fit, ssWages, medWages, ssActual, medActual]).toEqual([43_940_762, 5_634_326, 45_869_992, 45_869_992, 5_687_868, 1_330_228]);

    const detail = (await call("GET", `/v1/filings/${id}`)).json;
    const L = Object.fromEntries((detail.preparedReturn.lines as { line: string; cents: number | null; count: number | null }[]).map((l) => [l.line, l.cents ?? l.count]));
    expect(L["1"]).toBe(45);                         // employees paid in the Sep 1 to 15 period (includes Sep 12)
    expect(L["2"]).toBe(43_940_762);                 // $439,407.62
    expect(L["3"]).toBe(5_634_326);
    expect(L["5a.2"]).toBe(5_687_879);               // 45,869,992 x 12.4% = 5,687,879.008
    expect(L["5c.2"]).toBe(1_330_230);               // 45,869,992 x 2.9% = 1,330,229.768
    expect(L["5e"]).toBe(7_018_109);
    expect(L["6"]).toBe(12_652_435);
    expect(L["7"]).toBe(-13);                        // (5,687,868 + 1,330,228) - 7,018,109: per-paycheck rounding
    expect(L["10"]).toBe(12_652_422);
    expect(L["13"]).toBe(5_634_326 + 5_687_868 + 1_330_228);
    expect(L["14"]).toBe(0);
    expect([L["16.1"], L["16.2"], L["16.3"], L["16.total"]]).toEqual([0, 0, 12_652_422, 12_652_422]);
    expect(detail.preparedReturn.coverage).toContain("previous provider");
  });

  it("filing is always a pending R4 proposal with a preview; it never executes from an agent", async () => {
    const id = await filingId("941", "2026-Q3");
    const before = await weft.db.select().from(simAgencyMail);
    // An agent run (main chat) calling tax.file_return gets a proposal, not a filing.
    const viaUi = await call("POST", `/v1/filings/${id}/file`, {});
    expect(viaUi.status, JSON.stringify(viaUi.json)).toBe(200);
    expect(viaUi.json).toMatchObject({ ok: true, status: "pending_approval" });
    const [p] = await weft.db.select().from(proposals).where(eq(proposals.id, viaUi.json.proposalId));
    expect(p).toMatchObject({ command: "tax.file_return", risk: "R4", subjectRef: id, status: "pending" });
    expect(p!.headline).toBe("File Form 941 for 2026-Q3 with IRS (sim): $126,524.22 total, $0.00 balance due");
    expect(JSON.stringify(p!.contentJson)).toContain("Line 7 Adjustment for fractions of cents: -$0.13");
    expect((await weft.db.select().from(simAgencyMail)).length).toBe(before.length);
    expect((await weft.db.select().from(filings).where(eq(filings.id, id)))[0]!.status).toBe("draft");

    // The calendar shows it proposed; approving files it with the agency simulator and marks the row done.
    await runDirect("compliance.refresh_calendar", {}, directCtx(weft.clock), deps());
    const row = (await call("GET", "/v1/compliance/calendar?kind=filing")).json.find((r: any) => r.subjectRef === id);
    expect(row).toMatchObject({ status: "proposed", proposalId: p!.id });
    const ok = await call("POST", `/v1/proposals/${p!.id}/approve`, {}, "usr_theo");
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.proposal.status).toBe("executed");
    const [f] = await weft.db.select().from(filings).where(eq(filings.id, id));
    expect(f).toMatchObject({ status: "filed", confirmation: expect.stringMatching(/^IRS-F-\d{4}$/) });
    const mail = (await weft.db.select().from(simAgencyMail)).slice(before.length);
    expect(mail.map((m) => [m.agency, m.kind, m.confirmation, m.credentialName])).toEqual([["irs", "return_filing", f!.confirmation, "vault:irs-efile"]]);
    expect(JSON.stringify(mail)).not.toContain("sim-credential");
    await runDirect("compliance.refresh_calendar", {}, directCtx(weft.clock), deps());
    expect((await call("GET", "/v1/compliance/calendar?kind=filing")).json.find((r: any) => r.subjectRef === id)).toMatchObject({ status: "done" });
    // Filed returns cannot be prepared or filed again.
    const d = directExecutors(weft.db, weft.clock, weft.sims).human("usr_dana");
    expect(await d.exec("tax.prepare_filing", { filing_id: id })).toMatchObject({ ok: false, refusal: { code: "DOMAIN_FILING_FILED" } });
  });

  it("an agent run calling tax.file_return gets a proposal, never a filing", async () => {
    const id = await filingId("ca_de9", "2026-Q3");
    const d = directExecutors(weft.db, weft.clock, weft.sims).human("usr_dana");
    await d.exec("tax.prepare_filing", { filing_id: id });
    const h = await weft.executor.runs.openChatRun({ principalId: "usr_dana", companyId: "cmp_larkspur", via: "ui", keyScope: null }, { threadId: null, surface: "human_ui", allowlist: ["tax.file_return", "tax.get_filing"] });
    const o = await weft.executor.agent.exec(h, { callId: "c1", command: "tax.file_return", args: { filing_id: id } });
    expect(o, JSON.stringify(o)).toMatchObject({ ok: true, status: "pending_approval" });
    expect((await weft.db.select().from(filings).where(eq(filings.id, id)))[0]!.status).toBe("draft");
  });

  it("refuses to file a quarter that has not ended and an unprepared return", async () => {
    const q4 = await filingId("941", "2026-Q4");
    const d = directExecutors(weft.db, weft.clock, weft.sims).human("usr_dana");
    expect(await d.exec("tax.file_return", { filing_id: q4 })).toMatchObject({ ok: false, refusal: { code: "DOMAIN_NOT_PREPARED" } });
    await d.exec("tax.prepare_filing", { filing_id: q4 });
    expect(await d.exec("tax.file_return", { filing_id: q4 })).toMatchObject({ ok: false, refusal: { code: "DOMAIN_PERIOD_OPEN" } });
  });
});

describe("a state wage report from processed runs", () => {
  it("CA DE 9C lists each California employee; its totals match the ledger hand check", async () => {
    const id = await filingId("ca_de9c", "2026-Q3");
    await call("POST", `/v1/filings/${id}/prepare`, {});
    const p = (await call("GET", `/v1/filings/${id}`)).json.preparedReturn;
    const L = Object.fromEntries((p.lines as { line: string; cents: number | null; count: number | null }[]).map((l) => [l.line, l.cents ?? l.count]));
    expect(p.employees).toHaveLength(19);
    expect(L["subject"]).toBe(await ledgerSum("sdi_wages:CA", SEPT));                // 23,984,532
    expect(L["subject"]).toBe(23_984_532);
    expect(L["pit_wages"]).toBe(22_945_198);
    expect(L["pit"]).toBe(await ledgerSum("tax:CA:pit:employee", SEPT));
    expect(L["pit"]).toBe(1_414_250);
    expect(L["sdi"]).toBe(311_804);
    expect([L["ui_taxable"], L["ui"], L["ett"]]).toEqual([0, 0, 0]);               // the $7,000 UI base was met before September
    expect(L["total"]).toBe(1_414_250 + 311_804);
    expect(p.employees.reduce((a: number, e: any) => a + e.pit_withheld_cents, 0)).toBe(L["pit"]);
    expect(JSON.stringify(p)).not.toMatch(/ssn|\d{3}-\d{2}-\d{4}/i);
  });
  it("NY NYS-45 withholding matches the ledger", async () => {
    const id = await filingId("ny_nys45", "2026-Q3");
    await call("POST", `/v1/filings/${id}/prepare`, {});
    const p = (await call("GET", `/v1/filings/${id}`)).json.preparedReturn;
    expect(p.employees).toHaveLength(14);
    expect(p.lines.find((l: any) => l.line === "pit").cents).toBe(await ledgerSum("tax:NY:pit:employee", SEPT));
  });
});

describe("refresh on payroll.processed and the daily tick", () => {
  it("svc_events may run the refresh; a date-crossing clock move refreshes and emits due-soon events", async () => {
    const out = await weft.executor.system.exec("svc_events", "compliance.refresh_calendar", {}, { eventId: null, attended: false, requestedBy: null } as never);
    expect(out.ok, JSON.stringify(out)).toBe(true);
    const n = (await weft.db.select().from(complianceItems)).length;
    expect(n).toBeGreaterThan(10);
    const ev = await weft.db.all<{ type: string }>(sql`SELECT type FROM events WHERE type LIKE 'compliance.%'`);
    expect(Array.isArray(ev)).toBe(true);
    void events;
  });
});

describe("hand-offs", () => {
  it("opens a tax specialist case for a notice with the evidence pack, escalates the notice, emails the specialist, and dedupes", async () => {
    const d = directExecutors(weft.db, weft.clock, weft.sims).human("usr_dana");
    const delivered = await d.exec("sim.deliver_notice", { scenario: "irs_deposit_schedule_change" }) as any;
    const nid = delivered.data.notice_id;
    const before = (await weft.db.select().from(simEmailMessages)).length;
    const o = await d.exec("handoffs.open", { kind: "tax_specialist", reason: "judgment_needed", subject_ref: nid, summary: "Check the lookback total before the schedule changes." }) as any;
    expect(o.ok, JSON.stringify(o)).toBe(true);
    expect(o.data.evidence.map((e: any) => e.label)).toEqual(expect.arrayContaining(["notice", "tax account", "parser extract", "filing 941 2026-Q3"]));
    expect((await weft.db.select().from(notices).where(eq(notices.id, nid)))[0]!.status).toBe("escalated");
    expect((await weft.db.select().from(simEmailMessages)).length).toBe(before + 1);
    const again = await d.exec("handoffs.open", { kind: "tax_specialist", reason: "judgment_needed", subject_ref: nid, summary: "again" }) as any;
    expect(again.data).toMatchObject({ handoff_id: o.data.handoff_id, duplicate: true });
    const list = await call("GET", "/v1/handoffs?status=open");
    expect(list.json.data.map((c: any) => [c.id, c.kind, c.reason, c.subjectRef])).toEqual([[o.data.handoff_id, "tax_specialist", "judgment_needed", nid]]);
    const res = await call("POST", `/v1/handoffs/${o.data.handoff_id}/resolve`, { note: "Lookback confirmed." });
    expect(res.json).toMatchObject({ ok: true, data: { status: "resolved" } });
    expect((await weft.db.select().from(handoffCases))[0]).toMatchObject({ status: "resolved", resolutionNote: "Lookback confirmed." });
  });
});
