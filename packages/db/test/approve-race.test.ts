// design 4.3 "Approval executes once" on the durable facade: two concurrent approvals of one proposal give one
// execution and one NOT_PENDING, and an approval racing a denial has exactly one winner. rowsAffected comes from
// changes(), so both compare-and-set updates behave as on libsql; the same test runs on libsql for comparison.
// Owner: cf1-db.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestWeft, type TestWeft } from "../../../apps/api/src/testing";
import { emulatorOf } from "../src/client";

for (const mode of ["durable-emu", "libsql"] as const) {
  describe(`concurrent decisions (${mode})`, () => {
    let weft: TestWeft;
    let prev: string | undefined;
    beforeAll(async () => {
      prev = process.env.WEFT_DB;
      if (mode === "durable-emu") process.env.WEFT_DB = "durable-emu"; else delete process.env.WEFT_DB;
      weft = await createTestWeft();
      expect(emulatorOf(weft.db) !== null).toBe(mode === "durable-emu");
    }, 120_000);
    afterAll(async () => {
      await weft?.close();
      if (prev === undefined) delete process.env.WEFT_DB; else process.env.WEFT_DB = prev;
    });

    const post = (path: string, principal: string, body: unknown = { reasonCode: null, note: null }) =>
      weft.app.request(path, { method: "POST", headers: { ...weft.uiHeaders(principal), "content-type": "application/json" }, body: JSON.stringify(body) });
    async function pendingFromNotice(): Promise<{ id: string; command: string }[]> {
      const before = new Set((await weft.db.all<{ id: string }>(sql`SELECT id FROM proposals`)).map((r) => r.id));
      expect((await post("/v1/sim/notices/deliver", "usr_dana", { scenario: "ca_de2088_rate_change" })).status).toBe(200);
      for (let i = 0; i < 10; i++) {
        await weft.scheduler.tick();
        await (weft.agent as unknown as { idle(): Promise<void> }).idle();
        const rows = await weft.db.all<{ id: string; command: string; status: string }>(sql`SELECT id, command, status FROM proposals ORDER BY id`);
        const fresh = rows.filter((r) => !before.has(r.id) && r.status === "pending");
        if (fresh.length >= 2) return fresh;
      }
      throw new Error("the notice run proposed nothing");
    }

    let proposed: { id: string; command: string }[] = [];
    it("two concurrent approvals: one execution, one NOT_PENDING", { timeout: 60_000 }, async () => {
      proposed = await pendingFromNotice();
      const [rate] = proposed.filter((p) => p.command === "tax.update_rate");
      const actionsBefore = Number((await weft.db.all<{ n: number }>(sql`SELECT count(*) AS n FROM actions WHERE command = 'tax.update_rate'`))[0]!.n);
      const [a, b] = await Promise.all([post(`/v1/proposals/${rate!.id}/approve`, "usr_theo"), post(`/v1/proposals/${rate!.id}/approve`, "usr_dana")]);
      const bodies = [await a.json(), await b.json()] as { ok?: boolean; code?: string; proposal?: { status: string } }[];
      expect([a.status, b.status].sort()).toEqual([200, 422]);
      expect(bodies.filter((x) => x.ok && x.proposal?.status === "executed")).toHaveLength(1);
      expect(bodies.filter((x) => x.code === "NOT_PENDING")).toHaveLength(1);
      const actionsAfter = Number((await weft.db.all<{ n: number }>(sql`SELECT count(*) AS n FROM actions WHERE command = 'tax.update_rate'`))[0]!.n);
      expect(actionsAfter - actionsBefore).toBe(1);
      const [row] = await weft.db.all<{ status: string; executed_action_seq: number | null }>(sql`SELECT status, executed_action_seq FROM proposals WHERE id = ${rate!.id}`);
      expect(row!.status).toBe("executed");
      expect(row!.executed_action_seq).not.toBeNull();
    });

    it("an approval racing a denial: exactly one wins", { timeout: 60_000 }, async () => {
      const [reply] = proposed.filter((p) => p.command === "notices.send_response");
      expect(reply).toBeDefined();
      const [a, d] = await Promise.all([post(`/v1/proposals/${reply!.id}/approve`, "usr_theo"), post(`/v1/proposals/${reply!.id}/deny`, "usr_dana", { reasonCode: "wrong_rate" })]);
      const statuses = [a.status, d.status];
      expect(statuses.filter((s) => s === 200)).toHaveLength(1);
      const [row] = await weft.db.all<{ status: string }>(sql`SELECT status FROM proposals WHERE id = ${reply!.id}`);
      expect(a.status === 200 ? ["executed", "approved"] : ["denied"]).toContain(row!.status);
      const verify = await weft.app.request("/v1/actions/verify", { headers: weft.uiHeaders("usr_dana") });
      expect((await verify.json()).ok).toBe(true);
    });
  });
}
