// Contract tests for /v1/notices and the notices.* read commands (owner: t2-world).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Notice, Page } from "@weft/contracts";
import { directCtx, directDeps, ensureTestPrincipals, findCommand, nonEmptyUntrusted, runDirect } from "@weft/core";
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
    expect(n.bodyText).toContain("SIMULATED AGENCY NOTICE");
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
