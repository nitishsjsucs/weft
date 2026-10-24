// Contract tests for /v1/notices and the notices.* read commands (owner: t2-world).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Notice, Page } from "@weft/contracts";
import { sql } from "drizzle-orm";
import { directCtx, directDeps, directExecutors, ensureTestPrincipals, findCommand, nonEmptyUntrusted, runDirect } from "@weft/core";
import { createSimulators } from "@weft/sim";
import { createTestWeft, type TestWeft } from "../src/testing";

let weft: TestWeft;
beforeAll(async () => { weft = await createTestWeft(); await ensureTestPrincipals(weft.db); });
afterAll(async () => { await weft.close(); });
const deps = () => directDeps(weft.db, weft.clock, createSimulators({ db: weft.db, clock: weft.clock }));
const get = (p: string) => weft.app.request(p, { headers: weft.uiHeaders("usr_dana") });

describe("GET /v1/notices", () => {
  it("the inbox has the resolved NY DOL notice, without the body", async () => {
    const page = Page(Notice).parse(await (await get("/v1/notices")).json());
    expect(page.count).toBe(1);
    expect(page.data[0]).toMatchObject({ id: "ntc_0001", agency: "ny_dol", kind: "rate_change", status: "resolved", receivedAt: "2026-02-14T17:00:00.000Z" });
    expect(page.data[0]!.bodyText).toBeUndefined();
    expect(Page(Notice).parse(await (await get("/v1/notices?status=new")).json()).count).toBe(0);
  });
  it("the detail returns the body and the extract", async () => {
    const n = Notice.parse(await (await get("/v1/notices/ntc_0001")).json());
    expect(n.bodyText).toContain("NEW YORK STATE DEPARTMENT OF LABOR");
    expect(n.bodyText).not.toMatch(/SIMULATED|\(demo\)/);
    expect(n.extracted?.rates).toEqual([{ code: "sui", oldRate: "0.038", newRate: "0.041" }]);
    expect((await get("/v1/notices/ntc_9999")).status).toBe(404);
  });
});

describe("notices read commands", () => {
  it("concise notices.get and notices.list return no untrusted text", async () => {
    const g = await runDirect("notices.get", { notice_id: "ntc_0001" }, directCtx(weft.clock), deps());
    expect(nonEmptyUntrusted(findCommand("notices.get"), g.data)).toEqual([]);
    expect(g.data.notice.extracted.accountNumber).toBe("00-48172 6");
    const l = await runDirect("notices.list", {}, directCtx(weft.clock), deps());
    expect(nonEmptyUntrusted(findCommand("notices.list"), l.data)).toEqual([]);
  });
  it("detailed notices.get returns a body that taints the run", async () => {
    const g = await runDirect("notices.get", { notice_id: "ntc_0001", response_format: "detailed" }, directCtx(weft.clock), deps());
    expect(g.data.notice.body).toContain("Unemployment Insurance (UI): 4.1%");
    expect(nonEmptyUntrusted(findCommand("notices.get"), g.data)).toEqual(["notice.title", "notice.body"]);
    const l = await runDirect("notices.list", { response_format: "detailed" }, directCtx(weft.clock), deps());
    expect(nonEmptyUntrusted(findCommand("notices.list"), l.data)).toEqual(["notices.*.title"]);
  });
});

describe("notices.draft_response and send_response", () => {
  it("drafts from the template plus a note, sends on approval, stores the confirmation and resolves; not reversible", async () => {
    const d = directExecutors(weft.db, weft.clock, weft.sims).human("usr_dana");
    const delivered = await d.exec("sim.deliver_notice", { scenario: "ca_de2088_rate_change" });
    const id = (delivered as { data: { notice_id: string } }).data.notice_id;
    const early = await d.exec("notices.send_response", { notice_id: id });
    expect(early).toMatchObject({ ok: false, refusal: { code: "DOMAIN_NO_DRAFT", example: { notice_id: id, note: "" } } });
    await expect(runDirect("notices.draft_response", { notice_id: id, note: "x".repeat(401) }, directCtx(weft.clock), deps())).rejects.toThrow();
    const draft = await runDirect("notices.draft_response", { notice_id: id, note: "Thank you for the review." }, directCtx(weft.clock), deps());
    expect(draft.data.body).toContain("UI 1.5% replacing 3.4%");
    expect(draft.data.body).toMatch(/\n\nThank you for the review\.$/);
    expect(draft.data.body).not.toContain("Note:");
    // Filed text names the notice by form and day and writes dates as a letter does, never a row id or ISO date.
    expect(draft.data.body).toContain("Re: DE 2088 notice received ");
    expect(draft.data.body).toContain("effective January 1, 2026");
    expect(draft.data.body).not.toContain(id);
    expect(draft.data.body).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(draft.data.body).not.toContain("Ignore prior");

    const def = findCommand("notices.send_response");
    expect([def.risk({ notice_id: id }), def.approval, def.reversible]).toEqual(["R3", "always", false]);
    const pv = await def.preview!({ notice_id: id }, directCtx(weft.clock), deps());
    expect(pv.title).toBe(`File response 1 to DE 2088 notice ${id} with CA EDD`);
    expect(pv.content).toEqual([{ label: "Content to be sent", text: draft.data.body }]);

    const sent = await d.exec("notices.send_response", { notice_id: id });
    expect(sent).toMatchObject({ ok: true, status: "done", data: { status: "resolved", confirmation: expect.stringMatching(/^CA-EDD-R-\d{6}$/), not_reversible_reason: "Not reversible: filed with the agency" } });
    expect(nonEmptyUntrusted(def, (sent as { data: unknown }).data)).toEqual(["confirmation"]);
    const n = await (await get(`/v1/notices/${id}`)).json();
    expect(n).toMatchObject({ status: "resolved", responseConfirmation: (sent as { data: { confirmation: string } }).data.confirmation, resolution: { outcome: "response_filed", not_reversible_reason: "Not reversible: filed with the agency" } });
    const evts = await weft.db.all<{ type: string }>(sql`SELECT type FROM events WHERE subject_ref = ${id} ORDER BY id`);
    expect(evts.map((e) => e.type)).toEqual(["notice.received", "notice.resolved"]);
  });
});

describe("the other notice scenarios (cut line: draft and send only)", () => {
  it("ny_missing_filing and irs_deposit_schedule_change deliver, refuse a rate change, draft from the kind template and resolve on send", async () => {
    const d = directExecutors(weft.db, weft.clock, weft.sims).human("usr_dana");
    const want = {
      ny_missing_filing: { account: "txa_0003", kind: "missing_filing", body: "We are reviewing the 2026-Q3 filing named in this notice" },
      irs_deposit_schedule_change: { account: "txa_0001", kind: "deposit_schedule_change", body: "We acknowledge this notice and will respond by" },
    } as const;
    for (const [scenario, w] of Object.entries(want)) {
      const delivered = await d.exec("sim.deliver_notice", { scenario });
      if (!delivered.ok || delivered.status !== "done") throw new Error(JSON.stringify(delivered));
      const id = (delivered.data as { notice_id: string }).notice_id;
      const got = await d.exec("notices.get", { notice_id: id });
      expect(got, scenario).toMatchObject({ ok: true, data: { notice: { tax_account_id: w.account, kind: w.kind, extracted: { rates: [] } } } });
      const rate = await d.exec("tax.update_rate", { tax_account_id: w.account, code: "sui", rate: "0.01", effective_from: "2027-01-01", source_notice_id: id });
      expect(rate, scenario).toMatchObject({ ok: false, refusal: { code: "DOMAIN_NOTICE_MISMATCH", message: expect.stringContaining(`Notice ${id} carries no rate change for sui`) } });
      const draft = await d.exec("notices.draft_response", { notice_id: id });
      expect(draft.ok && draft.status === "done" && (draft.data as { body: string }).body, scenario).toContain(w.body);
      const sent = await d.exec("notices.send_response", { notice_id: id });
      expect(sent, scenario).toMatchObject({ ok: true, status: "done", data: { status: "resolved", confirmation: expect.stringMatching(/^[A-Z]+(-[A-Z]+)*-R-\d{6}$/) } });
    }
  });
});
