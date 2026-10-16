// Scenario GP16 (docs/wave3.md), notice escalation to a tax specialist (wave 3 rank 10). Owner: w3-parity-routines.
// A missing-filing notice the agency notice routine does not handle is escalated: the notice turns escalated, the
// case carries the reason and an evidence pack (notice, tax account, filings, parser extract), and the simulated
// specialist gets it by email. Closed notices cannot be escalated, and an agent may escalate without approval (R1).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { notices, simEmailMessages } from "@weft/db";
import { parityCommands } from "../../packages/core/src/commands/parity";
import { SPECIALIST } from "../../packages/core/src/parity/escalation";
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

describe("GP16 notice escalation", () => {
  let noticeId = "";

  it("notices.escalate is R1, never needs approval, and agents may use it", () => {
    const c = parityCommands.find((x) => x.name === "notices.escalate")!;
    expect(c).toMatchObject({ approval: "never", tiers: { main: "executable" } });
    expect(c.risk({} as never)).toBe("R1");
  });

  it("escalating a missing-filing notice hands the specialist an evidence pack", async () => {
    const d = await call("POST", "/v1/sim/notices/deliver", { scenario: "ny_missing_filing" });
    expect(d.json.ok, JSON.stringify(d.json)).toBe(true);
    const [n] = (await weft.db.select().from(notices).where(eq(notices.kind, "missing_filing")));
    expect(n).toBeDefined();
    noticeId = n!.id;
    expect(["new", "in_review"]).toContain(n!.status);

    const before = (await weft.db.select().from(simEmailMessages)).length;
    const r = await call("POST", "/v1/tools/notices.escalate", { notice_id: noticeId, reason_code: "missing_filing" });
    expect(r.json.ok, JSON.stringify(r.json)).toBe(true);
    expect(r.json.data).toMatchObject({ notice_id: noticeId, status: "escalated", specialist: SPECIALIST.name });

    const got = (await call("GET", `/v1/notices/${noticeId}`)).json;
    expect(got.status).toBe("escalated");
    expect(got.resolution).toMatchObject({ outcome: "escalated", reason_code: "missing_filing", specialist_principal: SPECIALIST.principal, escalated_by: "usr_dana", previous_status: n!.status });
    const refs = (got.resolution.evidence as { label: string; ref: string }[]).map((e) => e.ref);
    expect(refs[0]).toBe(noticeId);
    if (n!.taxAccountId) expect(refs).toContain(n!.taxAccountId);
    expect(refs).toContain(`${noticeId}#extract`);

    const mail = (await weft.db.select().from(simEmailMessages)).slice(before);
    expect(mail.map((m) => [m.toAddr, m.relatedRef])).toEqual([[SPECIALIST.email, noticeId]]);
    expect(mail[0]!.subject).toBe(`Escalated notice ${noticeId}: NYS-45`);
    expect(mail[0]!.body).toContain("the agency says a filing is missing and none is on record");
    expect(mail[0]!.body).not.toMatch(/—/);
  });

  it("an escalated or resolved notice cannot be escalated again", async () => {
    const again = await call("POST", "/v1/tools/notices.escalate", { notice_id: noticeId, reason_code: "agency_call_needed" });
    expect(again.json.ok).toBe(false);
    expect(JSON.stringify(again.json)).toContain("DOMAIN_NOTICE_CLOSED");
    const [resolved] = (await weft.db.select().from(notices).where(eq(notices.status, "resolved")));
    const r = await call("POST", "/v1/tools/notices.escalate", { notice_id: resolved!.id, reason_code: "penalty_dispute" });
    expect(r.json.ok).toBe(false);
    expect(JSON.stringify(r.json)).toContain("DOMAIN_NOTICE_CLOSED");
    const bad = await call("POST", "/v1/tools/notices.escalate", { notice_id: "ntc_9999", reason_code: "penalty_dispute" });
    expect(bad.json.ok).toBe(false);
  });
});
