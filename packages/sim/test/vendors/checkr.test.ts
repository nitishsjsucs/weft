// Checkr simulator (w3-integrations-screening-esign): signature vectors on raw bytes, the invitation to report state
// machine on the sim clock, the faults, and the human-only adverse path. Record text lives only in listAdverseItems.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFaults } from "../../src/faults";
import { CHECKR_SIM_WEBHOOK_KEY, createCheckrSim, SIM_RECORD_MARKER } from "../../src/vendors/checkr";
import { w3ScreeningSimControls } from "../../../contracts/src/ext/w3-integrations-screening-esign";
import { simWorld, type SimTestWorld } from "../helpers";

const VECTOR_BODY = '{"id":"sim_evt_000001","object":"event","type":"report.completed","created_at":"2026-10-27T15:30:00.000Z","data":{"object":{"id":"sim_rpt_000003","object":"report","status":"complete","result":"clear"}}}';
const VECTOR_HEX = "3babe9f9d6561e6b2b48194a200ba640412304881fd0aa66764d3db3b6b8b8fb";   // printf body | openssl dgst -sha256 -hmac key
const enc = (s: string) => new TextEncoder().encode(s);
const ORDER = { orderId: "scr_0001", candidate: { first: "Rowan", last: "Ellery", email: "rowan.ellery@candidate.example" }, packageSlug: "weft_standard_sim", workLocation: { country: "US", state: "CO", city: "Denver" } };

let w: SimTestWorld;
beforeEach(async () => { w = await simWorld(); });
afterEach(async () => { await w.close(); });
const sim = () => createCheckrSim(w.db, w.clock, createFaults(w.db));

describe("Checkr simulator signatures", () => {
  it("verifies the fixed hex vector over the raw bytes, case-insensitive header, and rejects a re-serialized body", () => {
    const s = sim();
    expect(CHECKR_SIM_WEBHOOK_KEY).toBe("weft-sim-checkr-webhook-key-not-a-secret");
    expect(s.verifyWebhook(enc(VECTOR_BODY), { "X-Checkr-Signature": VECTOR_HEX })).toEqual({ ok: true, dedupeKey: "sim_evt_000001" });
    const reserialized = JSON.stringify(JSON.parse(VECTOR_BODY), null, 1);
    expect(s.verifyWebhook(enc(reserialized), { "x-checkr-signature": VECTOR_HEX }).ok).toBe(false);
    expect(s.verifyWebhook(enc(VECTOR_BODY + " "), { "x-checkr-signature": VECTOR_HEX }).ok).toBe(false);
    expect(s.verifyWebhook(enc(VECTOR_BODY), { "x-checkr-signature": VECTOR_HEX.replace(/^3/, "4") }).ok).toBe(false);
    expect(s.verifyWebhook(enc(VECTOR_BODY), {}).ok).toBe(false);
    expect(s.parseWebhook(enc(VECTOR_BODY))).toEqual([{ dedupeKey: "sim_evt_000001", vendorOrderId: "sim_rpt_000003", kind: "report.completed" }]);
  });
});

describe("Checkr simulator state machine", () => {
  it("invited, consented, in progress for one business day, then clear through signed webhooks", async () => {
    const s = sim(), c = w3ScreeningSimControls(s)!;
    expect(c).not.toBeNull();
    expect((await s.listPackages()).map((p) => [p.slug, p.priceCents, p.phase])).toContainEqual(["weft_standard_sim", 3_500, "full"]);
    const o = await s.createOrder(ORDER);
    expect(o).toMatchObject({ status: "invited", applyUrl: "/portal#screening-apply", vendorOrderId: expect.stringMatching(/^sim_inv_\d{6}$/) });
    expect(await s.getOrder(o.vendorOrderId)).toMatchObject({ status: "invited", result: null, adjudication: "none" });
    await c.consent(o.vendorOrderId, "Rowan Ellery");
    const consented = await s.getOrder(o.vendorOrderId);
    expect(consented).toMatchObject({ status: "in_progress", etaOn: "2026-10-27", vendorReportId: expect.stringMatching(/^sim_rpt_/) });
    expect(await c.advance("2026-10-27T15:29:00.000Z")).toBe(0);
    expect(await c.advance("2026-10-27T15:30:00.000Z")).toBe(1);
    expect(await s.getOrder(o.vendorOrderId)).toMatchObject({ status: "complete_clear", result: "clear", completedAt: "2026-10-27T15:30:00.000Z" });
    expect(await s.getOrder(consented.vendorReportId!)).toMatchObject({ status: "complete_clear" });
    const out = await c.outbox("2026-10-27T15:30:00.000Z");
    expect(out.map((d) => (JSON.parse(d.raw) as { type: string }).type)).toEqual(["invitation.created", "invitation.completed", "report.created", "report.completed"]);
    for (const d of out) expect(s.verifyWebhook(enc(d.raw), d.headers)).toEqual({ ok: true, dedupeKey: d.dedupeKey });
    await c.ack(out[0]!.id, true, w.clock.now());
    await c.ack(out[1]!.id, false, "2026-10-27T15:30:00.000Z");
    expect((await c.outbox("2026-10-27T15:30:00.000Z")).map((d) => d.id)).toEqual([out[2]!.id, out[3]!.id]);
    expect((await c.outbox("2026-10-27T15:31:00.000Z")).map((d) => d.id)).toContain(out[1]!.id);
  });

  it("consider plants a synthetic item reachable only through listAdverseItems; pre-adverse then completes after the notice date", async () => {
    const faults = createFaults(w.db);
    await faults.arm({ target: "checkr.consider", kind: "error", mode: "once" });
    const s = createCheckrSim(w.db, w.clock, faults), c = w3ScreeningSimControls(s)!;
    const o = await s.createOrder(ORDER);
    await c.consent(o.vendorOrderId, "Rowan Ellery");
    await c.advance("2026-10-27T15:30:00.000Z");
    const snap = await s.getOrder(o.vendorOrderId);
    expect(snap).toMatchObject({ status: "complete_review", result: "consider" });
    expect(JSON.stringify(snap)).not.toContain(SIM_RECORD_MARKER);
    for (const d of await c.outbox("2026-10-27T15:30:00.000Z")) expect(d.raw).not.toContain(SIM_RECORD_MARKER);
    const items = await s.listAdverseItems(snap.vendorReportId!);
    expect(items).toHaveLength(1);
    expect(items[0]!.text).toContain(SIM_RECORD_MARKER);
    const { vendorAdverseId } = await s.startPreAdverse(snap.vendorReportId!, items.map((i) => i.id), "2026-11-03T15:30:00.000Z");
    expect(await s.getOrder(o.vendorOrderId)).toMatchObject({ adjudication: "pre_adverse" });
    expect(await c.advance("2026-11-02T15:30:00.000Z")).toBe(0);
    expect(await c.advance("2026-11-03T15:30:00.000Z")).toBe(1);
    expect(await s.getOrder(o.vendorOrderId)).toMatchObject({ adjudication: "post_adverse" });
    await expect(s.cancelAdverse(vendorAdverseId)).rejects.toThrow(/not open/);
  });

  it("expire, suspended and dispute faults; cancel before consent; a missing state is refused", async () => {
    const faults = createFaults(w.db);
    const s = createCheckrSim(w.db, w.clock, faults), c = w3ScreeningSimControls(s)!;
    await expect(s.createOrder({ ...ORDER, workLocation: { country: "US", state: "", city: null } })).rejects.toThrow(/state is required/);
    await faults.arm({ target: "checkr.expire", kind: "error", mode: "once" });
    const ex = await s.createOrder(ORDER);
    await c.advance(w.clock.now());
    expect((await s.getOrder(ex.vendorOrderId)).status).toBe("expired");
    const plain = await s.createOrder(ORDER);
    expect(await c.advance("2026-11-03T06:59:58.000Z")).toBe(0);
    expect(await c.advance("2026-11-03T07:00:00.000Z")).toBe(1);   // 7 days, at 11:59:59 pm PDT
    expect((await s.getOrder(plain.vendorOrderId)).status).toBe("expired");
    const cx = await s.createOrder(ORDER);
    await s.cancelOrder(cx.vendorOrderId);
    expect((await s.getOrder(cx.vendorOrderId)).status).toBe("canceled");
    await faults.arm({ target: "checkr.suspended", kind: "needs_info", mode: "once" });
    const su = await s.createOrder(ORDER);
    await c.consent(su.vendorOrderId, "Rowan Ellery");
    await c.advance("2026-10-27T15:30:00.000Z");
    expect((await s.getOrder(su.vendorOrderId)).status).toBe("suspended");
    await faults.arm({ target: "checkr.consider", kind: "error", mode: "once" });
    const di = await s.createOrder(ORDER);
    await c.consent(di.vendorOrderId, "Rowan Ellery");
    await c.advance("2026-10-27T15:30:00.000Z");
    const rid = (await s.getOrder(di.vendorOrderId)).vendorReportId!;
    // dispute arms after the consider result exists: the candidate disputes once the pre-adverse notice arrives
    const rows = await w.db.all<{ body_json: string }>(`SELECT body_json FROM sim_vendor_records WHERE ext_id = '${rid}'` as never);
    const body = JSON.parse(rows[0]!.body_json); body._sim.fault = "dispute";
    await w.db.run(`UPDATE sim_vendor_records SET body_json = '${JSON.stringify(body)}' WHERE ext_id = '${rid}'` as never);
    await s.startPreAdverse(rid, (await s.listAdverseItems(rid)).map((i) => i.id), "2026-11-03T15:30:00.000Z");
    expect((await s.getOrder(di.vendorOrderId)).status).toBe("disputed");
    await c.advance("2026-11-03T15:30:00.000Z");   // 5 business days later the dispute completes and the notice moves out
    expect(await s.getOrder(di.vendorOrderId)).toMatchObject({ status: "complete_review", adjudication: "pre_adverse" });
  });
});
