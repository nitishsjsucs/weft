// Scenario GP17 (docs/wave3.md 5): Greenhouse hire to a Weft offer. Owner: w3-integrations-hr. Scripted provider.
// "Simulate a hire" makes the Greenhouse simulator queue a signed hire_candidate delivery; Weft verifies it over the
// raw bytes, stores the delivery id (never the body), re-reads the hire and creates exactly one draft offer linked
// in ext_links. rt_ats_hire reads the unmapped Boulder office as a sync item and proposes sending the offer; Vic
// approves and GP6 runs unchanged from there. A second delivery with the same id is a no-op, and a later offer
// version with a new start date becomes a human-only sync conflict.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { AgentRunRow, RoutineRun } from "@weft/contracts";
import { createTestWeft, type TestWeft } from "./helpers";

describe("GP17 Greenhouse hire to Weft offer", () => {
  let weft: TestWeft;
  beforeAll(async () => { weft = await createTestWeft(); });
  afterAll(async () => {
    for (let i = 0; i < 10; i++) {
      const open = await weft.db.all<{ id: string }>(sql`SELECT id FROM routine_runs WHERE status IN ('queued', 'running')`);
      const runs = await weft.db.all<{ id: string }>(sql`SELECT id FROM agent_runs WHERE status IN ('queued', 'running')`);
      if (!open.length && !runs.length) break;
      for (const r of runs) await (weft.agent as unknown as { settled(id: string): Promise<unknown> }).settled(r.id);
      for (const r of open) await (weft.routines as unknown as { settled(id: string): Promise<unknown> }).settled(r.id);
    }
    await weft.close();
  });
  const call = async (who: string, method: string, path: string, body?: unknown) => {
    const res = await weft.app.request(path, { method, headers: { ...weft.uiHeaders(who), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as any };
  };
  const settleRoutine = async () => {
    for (let i = 0; i < 5; i++) {
      const [rr] = await weft.db.all<{ id: string; agent_run_id: string | null; status: string }>(sql`SELECT id, agent_run_id, status FROM routine_runs WHERE routine_id = 'rt_ats_hire' ORDER BY id DESC LIMIT 1`);
      if (!rr) { await weft.scheduler.tick(); continue; }
      const run = await (weft.routines as unknown as { settled(id: string): Promise<RoutineRun> }).settled(rr.id);
      if (run.agentRunId) await (weft.agent as unknown as { settled(id: string): Promise<AgentRunRow> }).settled(run.agentRunId);
      return (weft.routines as unknown as { settled(id: string): Promise<RoutineRun> }).settled(rr.id);
    }
    throw new Error("rt_ats_hire never ran");
  };

  let offerId = "", applicationId = "";
  it("five integration cards, all simulated, secret names without values", async () => {
    const cards = (await call("usr_dana", "GET", "/v1/integrations")).json as { status: { vendor: string; mode: string }; secrets: { name: string; present: boolean }[] }[];
    expect(cards.map((c) => c.status.vendor)).toEqual(["greenhouse", "workday", "checkr", "hireright", "docusign"]);
    expect(cards.every((c) => c.status.mode === "simulated")).toBe(true);
    expect(cards[0]!.secrets.map((s) => s.name)).toContain("WEFT_GREENHOUSE_CLIENT_ID");
  });

  it("a simulated hire becomes exactly one draft offer linked in ext_links, and rt_ats_hire proposes sending it", async () => {
    const sim = await call("usr_dana", "POST", "/v1/integrations/greenhouse/simulate", { kind: "hire" });
    expect(sim.status).toBe(200);
    applicationId = sim.json.data.applicationId;
    expect(sim.json.data.deliveries).toEqual([expect.objectContaining({ status: 200, outcome: "delivered" })]);
    offerId = sim.json.data.weft_offer_id;
    expect(offerId).toMatch(/^offr_/);
    const offer = (await call("usr_dana", "GET", `/v1/offers/${offerId}`)).json;
    expect(offer).toMatchObject({ status: "draft", candidateFirst: "Marisol", candidateLast: "Quint", candidateEmail: "marisol.quint@candidate.example", title: "Firmware Test Engineer", departmentId: "dpt_hardware", workplaceId: "wkp_remote", workState: "CO", baseCents: 13_200_000, startDate: "2026-11-16" });
    const links = await weft.db.all<{ ext_id: string; weft_id: string; ext_version: number }>(sql`SELECT ext_id, weft_id, ext_version FROM ext_links WHERE vendor = 'greenhouse'`);
    expect(links).toEqual([{ ext_id: applicationId, weft_id: offerId, ext_version: 1 }]);
    const deliveries = await weft.db.all<Record<string, unknown>>(sql`SELECT * FROM integration_deliveries`);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ vendor: "greenhouse", action: "hire_candidate", verified: 1, error: null });
    expect(deliveries[0]!.applied_at).toBeTruthy();
    expect(JSON.stringify(deliveries)).not.toContain("Marisol");   // ids and a hash only, never the body
    const evts = await weft.db.all<{ type: string; payload_json: string }>(sql`SELECT type, payload_json FROM events WHERE type IN ('integration.ats_hire_detected', 'offer.imported', 'integration.sync_item_opened') ORDER BY rowid`);
    expect(evts.map((e) => e.type)).toEqual(["integration.ats_hire_detected", "offer.imported", "integration.sync_item_opened"]);
    expect(evts.map((e) => e.payload_json).join(" ")).not.toMatch(/Marisol|candidate\.example/);
    const items = (await call("usr_dana", "GET", "/v1/sync-items")).json as { kind: string; subjectRef: string; detail: Record<string, string> }[];
    expect(items).toEqual([expect.objectContaining({ kind: "unmapped_value", subjectRef: offerId, detail: expect.objectContaining({ field: "office", ext_name: "Boulder Field Office", fallback: "wkp_remote" }) })]);

    const run = await settleRoutine();
    expect(run.status).toBe("waiting_approval");   // the send proposal waits in the Inbox
    const props = (await call("usr_dana", "GET", "/v1/proposals?limit=100")).json.data as { id: string; command: string; status: string; args: Record<string, unknown> }[];
    const send = props.filter((p) => p.command === "documents.send_offer" && p.status === "pending");
    expect(send).toHaveLength(1);
    expect(send[0]!.args).toMatchObject({ offer_id: offerId });

    // Vic approves; from here GP6 runs unchanged: the invite, the portal and signing.
    const ok = await call("usr_dana", "POST", `/v1/proposals/${send[0]!.id}/approve`, {});
    expect(ok.status).toBe(200);
    const sent = (await call("usr_dana", "GET", `/v1/offers/${offerId}`)).json;
    expect(sent.status).toBe("sent");
    const persona = sent.personaPrincipalId as string;
    const mail = (await call("usr_dana", "GET", "/v1/sim/email?to=marisol.quint@candidate.example")).json as { kind: string; relatedRef: string }[];
    expect(mail).toEqual([expect.objectContaining({ kind: "offer_invite", relatedRef: offerId })]);
    const me = (await call(persona, "GET", "/v1/portal/me")).json;
    expect(me).toMatchObject({ offerId, worker: { workState: "CO", displayName: "Marisol Quint" } });
    const letter = me.documents.find((d: { kind: string }) => d.kind === "offer_letter");
    const signed = await call(persona, "POST", `/v1/portal/documents/${letter.id}/sign`, { typedName: "Marisol Quint", documentSha256: letter.sha256 });
    expect(signed.json.data).toMatchObject({ offer_status: "accepted" });
  });

  it("the same delivery id again is a no-op, and a re-serialized body fails verification", async () => {
    const before = await weft.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM offers`);
    const again = await call("usr_dana", "POST", "/v1/integrations/greenhouse/simulate", { kind: "redeliver" });
    expect(again.json.data.deliveries).toEqual([expect.objectContaining({ status: 200, outcome: "delivered" })]);
    await weft.scheduler.tick();
    expect(await weft.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM offers`)).toEqual(before);
    expect((await weft.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM integration_deliveries`))[0]!.n).toBe(1);

    const [row] = await weft.db.all<{ body_json: string; signature: string; dedupe_key: string }>(sql`SELECT body_json, signature, dedupe_key FROM sim_webhook_outbox ORDER BY id DESC LIMIT 1`);
    const reserialized = JSON.stringify(JSON.parse(row!.body_json));
    expect(reserialized).not.toBe(row!.body_json);
    const bad = await weft.app.request("/v1/integrations/greenhouse/webhook", { method: "POST", headers: { "content-type": "application/json", signature: row!.signature, "greenhouse-event-id": "11111111-2222-4333-a444-555555555555" }, body: reserialized });
    expect(bad.status).toBe(401);
    const good = await weft.app.request("/v1/integrations/greenhouse/webhook", { method: "POST", headers: { "content-type": "application/json", signature: row!.signature, "greenhouse-event-id": row!.dedupe_key }, body: row!.body_json });
    expect([good.status, await good.json()]).toEqual([200, { ok: true, duplicate: true }]);
  });

  it("a later offer version with a new start date becomes a human-only sync conflict", async () => {
    // A second hire, still a draft, so taking the vendor value is allowed.
    const second = await call("usr_dana", "POST", "/v1/integrations/greenhouse/simulate", { kind: "hire" });
    const draftId = second.json.data.weft_offer_id as string;
    const changed = await call("usr_dana", "POST", "/v1/integrations/greenhouse/simulate", { kind: "start_date_change", applicationId: second.json.data.applicationId });
    expect(changed.json.data.offerVersion).toBe(2);
    await weft.scheduler.tick();
    const items = (await call("usr_dana", "GET", "/v1/sync-items")).json as { id: string; kind: string; subjectRef: string; detail: Record<string, string> }[];
    const conflict = items.find((i) => i.kind === "sync_conflict" && i.subjectRef === draftId)!;
    expect(conflict.detail).toMatchObject({ field: "start_date", weft_value: "2026-11-16", vendor_value: "2026-11-30", offer_version: "2" });
    expect((await call("usr_dana", "GET", `/v1/offers/${draftId}`)).json.startDate).toBe("2026-11-16");   // never overwritten silently
    const def = (await import("@weft/core")).commands.find((c) => c.name === "integrations.resolve_sync_item")!;
    expect([def.access, def.mcp, def.tiers]).toEqual(["human_only", "hidden", { main: "unavailable", task: "unavailable" }]);
    const res = await call("usr_dana", "POST", `/v1/sync-items/${conflict.id}/resolve`, { take: "vendor" });
    expect(res.status).toBe(200);
    expect((await call("usr_dana", "GET", `/v1/offers/${draftId}`)).json.startDate).toBe("2026-11-30");
    expect((await call("usr_dana", "POST", `/v1/sync-items/${conflict.id}/resolve`, { take: "vendor" })).json.code).toBe("DOMAIN_SYNC_ITEM_CLOSED");
  });
});
