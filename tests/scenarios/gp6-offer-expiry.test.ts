// GP6 follow-up (docs/wave2.md, integrator): an offer that is sent and never signed expires on the sim clock. The
// scheduler tick runs documents.expire_offers as svc_scheduler only when an offer is past its expiry date; the
// offer reads expired, its unsigned documents are voided and the new-hire persona loses its grants.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestWeft, type TestWeft } from "./helpers";

const CANDIDATE = { candidateFirst: "Ines", candidateLast: "Abara", candidateEmail: "ines.abara@candidate.example", title: "Test Technician", departmentId: "dpt_hardware", workState: "TX", baseCents: 7_400_000, payKind: "salary", startDate: "2026-11-09" };

describe("GP6 offer expiry on the sim clock", () => {
  let weft: TestWeft;
  beforeAll(async () => { weft = await createTestWeft(); });
  afterAll(async () => { await weft.close(); });
  const call = async (who: string, method: string, path: string, body?: unknown) => {
    const res = await weft.app.request(path, { method, headers: { ...weft.uiHeaders(who), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as any };
  };
  const sweeps = async () => (await weft.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM actions WHERE command = 'documents.expire_offers'`))[0]!.n;

  it("ticks write nothing until an offer is due, then expire it once as svc_scheduler", async () => {
    const offerId = (await call("usr_dana", "POST", "/v1/offers", CANDIDATE)).json.data.offer_id as string;
    const sent = (await call("usr_dana", "POST", `/v1/offers/${offerId}/send`)).json.data as { persona_principal_id: string };
    const offer = (await call("usr_dana", "GET", `/v1/offers/${offerId}`)).json as { status: string; expiresOn: string };
    expect(offer).toMatchObject({ status: "sent", expiresOn: "2026-11-08" });
    await weft.scheduler.tick();
    expect(await sweeps()).toBe(0);

    await weft.clock.set("2026-11-09T16:00:00.000Z", 0);   // Mon 08:00 PT, the day after the expiry date
    await weft.scheduler.tick();
    await weft.scheduler.tick();
    expect(await sweeps()).toBe(1);
    const [act] = await weft.db.all<{ actor_id: string }>(sql`SELECT actor_id FROM actions WHERE command = 'documents.expire_offers'`);
    expect(act!.actor_id).toBe("svc_scheduler");
    expect(((await call("usr_dana", "GET", `/v1/offers/${offerId}`)).json as { status: string }).status).toBe("expired");
    const docs = await weft.db.all<{ status: string }>(sql`SELECT status FROM documents WHERE offer_id = ${offerId}`);
    expect(docs.length).toBeGreaterThan(0);
    expect(docs.every((d) => d.status === "voided")).toBe(true);
    const [persona] = await weft.db.all<{ grants_json: string }>(sql`SELECT grants_json FROM principals WHERE id = ${sent.persona_principal_id}`);
    expect(JSON.parse(persona!.grants_json)).toMatchObject({ people: "none", benefits: "none" });
    await weft.scheduler.tick();
    expect(await sweeps()).toBe(1);   // nothing is due any more, so the next tick writes nothing
  });
});
