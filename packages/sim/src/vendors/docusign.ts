// Simulated DocuSign (esign) for wave 3 (docs/wave3.md, research/wave3/integrations-screening-esign.md 4 and 6.4).
// Owner: w3-integrations-screening-esign. A minimal envelope store in the eSignature REST v2.1 shape (envelopeId, status,
// recipients.signers with clientUserId, customFields) and Connect JSON SIM messages signed like DocuSign's (base64
// HMAC-SHA256 over the raw body, header X-DocuSign-Signature-1). Only used when WEFT_ESIGN=docusign; the built-in
// click to sign stays the default. Writes only sim_vendor_records and sim_webhook_outbox, reads the sim clock and
// checks the fault injector.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { and, asc, eq, lte } from "drizzle-orm";
import type { ConnectorStatus, ESignConnector, EnvelopeStatus, FaultInjector, SimClock, WebhookVerdict } from "@weft/contracts";
import { simVendorRecords, simWebhookOutbox, type DbTx } from "@weft/db";
import type { W3EsignSimControls, W3VendorSimDelivery } from "../../../contracts/src/ext/w3-integrations-screening-esign";
import { SimFaultError } from "../faults";
import { mintId, seqOf } from "../ids";

export const DOCUSIGN_SIM_HMAC_KEY = "weft-sim-docusign-connect-key-not-a-secret";
export const DOCUSIGN_SIM_ACCOUNT = "sim-account-0001";
const HEADER = "x-docusign-signature-1";

type Env = { envelopeId: string; status: EnvelopeStatus; [k: string]: unknown; _sim: { reads: string[]; offerId: string; docs: string[] } };
const sign = (raw: string | Uint8Array, key = DOCUSIGN_SIM_HMAC_KEY) => createHmac("sha256", key).update(raw).digest("base64");
const lower = (h: Record<string, string>) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

/** JSON SIM carries no event id: the dedupe key is sha256(envelopeId + event + generatedDateTime) (research 6.7). */
export function docusignDedupeKey(envelopeId: string, event: string, generatedDateTime: string): string {
  return createHash("sha256").update(`${envelopeId}${event}${generatedDateTime}`).digest("hex");
}
/** Parses a Connect JSON SIM message: ids only. */
export function parseDocusignConnect(raw: Uint8Array): { dedupeKey: string; envelopeId: string; event: string }[] {
  try {
    const b = JSON.parse(Buffer.from(raw).toString("utf8")) as { event?: unknown; generatedDateTime?: unknown; data?: { envelopeId?: unknown } };
    if (typeof b.event !== "string" || typeof b.generatedDateTime !== "string" || typeof b.data?.envelopeId !== "string") return [];
    return [{ dedupeKey: docusignDedupeKey(b.data.envelopeId, b.event, b.generatedDateTime), envelopeId: b.data.envelopeId, event: b.event }];
  } catch { return []; }
}

export function createDocuSignSim(db: DbTx, clock: SimClock, faults: FaultInjector): ESignConnector & W3EsignSimControls {
  const get = async (id: string): Promise<Env | null> => {
    const [r] = await db.select().from(simVendorRecords).where(and(eq(simVendorRecords.vendor, "docusign"), eq(simVendorRecords.kind, "envelope"), eq(simVendorRecords.extId, id))).limit(1);
    return r ? (JSON.parse(r.bodyJson) as Env) : null;
  };
  const put = async (e: Env, fresh = false) => {
    const now = clock.now();
    if (fresh) await db.insert(simVendorRecords).values({ id: await mintId(db, "simx_"), vendor: "docusign", kind: "envelope", extId: e.envelopeId, version: 1, bodyJson: JSON.stringify(e), createdAt: now, updatedAt: now });
    else await db.update(simVendorRecords).set({ bodyJson: JSON.stringify(e), updatedAt: now }).where(and(eq(simVendorRecords.vendor, "docusign"), eq(simVendorRecords.kind, "envelope"), eq(simVendorRecords.extId, e.envelopeId)));
  };
  const emit = async (event: string, e: Env) => {
    const at = clock.now();
    const raw = JSON.stringify({ event, apiVersion: "v2.1", uri: `/restapi/v2.1/accounts/${DOCUSIGN_SIM_ACCOUNT}/envelopes/${e.envelopeId}`, retryCount: 0, configurationId: 0, generatedDateTime: at, data: { accountId: DOCUSIGN_SIM_ACCOUNT, userId: "sim-user-0001", envelopeId: e.envelopeId } });
    const key = docusignDedupeKey(e.envelopeId, event, at);
    await db.insert(simWebhookOutbox).values({ id: await mintId(db, "simo_"), vendor: "docusign", dedupeKey: key, bodyJson: raw, signature: sign(raw), attempt: 0, nextAt: at, status: "pending", deliveredAt: null }).onConflictDoNothing();
  };
  const need = async (id: string) => { const e = await get(id); if (!e) throw new Error(`docusign simulator: no envelope ${id}`); return e; };
  const signers = (e: Env) => ((e.recipients as { signers: { clientUserId: string; status: string; name: string; email: string }[] }).signers);

  return {
    simulated: true,
    async status(): Promise<ConnectorStatus> { return { vendor: "docusign", category: "esign", mode: "simulated", configured: false, lastSyncAt: null, cursor: null, health: "ok", detail: null }; },
    async send(i) {
      if ((await faults.check("esign.send")).fire) throw new SimFaultError("esign.send");
      if (i.documents.length === 0) throw new Error("docusign simulator: an envelope needs at least one document");
      const now = clock.now();
      const envelopeId = `sim-env-${String(seqOf(await mintId(db, "simx_"))).padStart(6, "0")}`;
      const e: Env = {
        envelopeId, status: "sent", emailSubject: "Your offer documents", sentDateTime: now, deliveredDateTime: null, completedDateTime: null, voidedDateTime: null, voidedReason: null,
        documents: i.documents.map((d, n) => ({ documentId: String(n + 1), name: d.title, sha256: d.sha256, weftDocId: d.weftDocId })),
        recipients: { signers: [{ recipientId: "1", clientUserId: i.signer.clientUserId, name: i.signer.name, email: i.signer.email, status: "sent" }] },
        notification: { expirations: { expireEnabled: !!i.expiresOn, expireAfter: null, expiresOn: i.expiresOn } },
        customFields: { textCustomFields: [{ name: "weft_offer_id", value: i.offerId }] },
        _sim: { reads: [], offerId: i.offerId, docs: i.documents.map((d) => Buffer.from(d.bytes).toString("utf8")) },
      };
      await put(e, true);
      await emit("envelope-sent", e);
      return { envelopeId, status: "sent" as const };
    },
    async signingUrl(envelopeId, signer, returnUrl) {
      const e = await need(envelopeId);
      if (!signers(e).some((s) => s.clientUserId === signer.clientUserId)) throw new Error("docusign simulator: unknown embedded recipient");
      if (e.status !== "sent" && e.status !== "delivered") throw new Error(`docusign simulator: envelope ${envelopeId} is ${e.status}`);
      if (e.status === "sent") { e.status = "delivered"; e.deliveredDateTime = clock.now(); signers(e)[0]!.status = "delivered"; await put(e); await emit("envelope-delivered", e); }
      if (returnUrl.length > 470) throw new Error("docusign simulator: returnUrl over 470 characters");
      // One-time, five-minute link in DocuSign; the simulated signing page lives in the new-hire portal.
      return { url: `/portal?esign=${encodeURIComponent(envelopeId)}&return=${encodeURIComponent(returnUrl)}`, expiresAt: new Date(Date.parse(clock.now()) + 300_000).toISOString() };
    },
    async envelope(envelopeId) {
      const e = await need(envelopeId);
      e._sim.reads.push(clock.now());
      await put(e);
      return { status: e.status, recipients: signers(e).map((s) => ({ clientUserId: s.clientUserId, status: s.status })) };
    },
    async void(envelopeId, reason) {
      const e = await need(envelopeId);
      if (e.status === "completed" || e.status === "voided" || e.status === "declined") throw new Error(`docusign simulator: envelope ${envelopeId} is ${e.status}`);
      e.status = "voided"; e.voidedDateTime = clock.now(); e.voidedReason = reason.slice(0, 200);
      await put(e); await emit("envelope-voided", e);
    },
    async download(envelopeId, which) {
      const e = await need(envelopeId);
      if (e.status !== "completed") throw new Error(`docusign simulator: envelope ${envelopeId} is not completed`);
      const text = which === "combined" ? e._sim.docs.join("\n\n---- next document ----\n\n") : `Certificate of completion\nEnvelope ${envelopeId}\nCompleted ${String(e.completedDateTime)}\nSigner ${signers(e)[0]!.name}`;
      return new TextEncoder().encode(text);
    },
    verifyWebhook(raw: Uint8Array, headers: Record<string, string>): WebhookVerdict {
      const h = lower(headers), want = sign(raw);
      const ok = Object.entries(h).some(([k, v]) => /^x-docusign-signature-\d+$/.test(k) && same(want, v.trim()));
      return ok ? { ok: true, dedupeKey: parseDocusignConnect(raw)[0]?.dedupeKey ?? null } : { ok: false, dedupeKey: null };
    },
    parseWebhook: parseDocusignConnect,
    async finish(envelopeId, outcome) {
      const e = await need(envelopeId);
      if (e.status !== "sent" && e.status !== "delivered") throw new Error(`docusign simulator: envelope ${envelopeId} is ${e.status}`);
      const s = signers(e)[0]!;
      if (outcome === "signed") { s.status = "completed"; e.status = "completed"; e.completedDateTime = clock.now(); }
      else { s.status = "declined"; e.status = "declined"; }
      await put(e);
      await emit(outcome === "signed" ? "envelope-completed" : "envelope-declined", e);
    },
    async outbox(now) {
      const rows = await db.select().from(simWebhookOutbox).where(and(eq(simWebhookOutbox.vendor, "docusign"), eq(simWebhookOutbox.status, "pending"), lte(simWebhookOutbox.nextAt, now))).orderBy(asc(simWebhookOutbox.id));
      return rows.map((r): W3VendorSimDelivery => ({ id: r.id, vendor: "docusign", raw: r.bodyJson, headers: { [HEADER]: r.signature }, dedupeKey: r.dedupeKey }));
    },
    async ack(id, delivered, now) {
      const [r] = await db.select().from(simWebhookOutbox).where(eq(simWebhookOutbox.id, id)).limit(1);
      if (!r) return;
      const attempt = r.attempt + 1;
      // DocuSign's retry ladder: 5, 10, 20, 40 minutes, 1 hour, 2 hours, 1 day.
      const ladder = [5, 10, 20, 40, 60, 120, 1440];
      if (delivered) await db.update(simWebhookOutbox).set({ status: "delivered", deliveredAt: now, attempt }).where(eq(simWebhookOutbox.id, id));
      else await db.update(simWebhookOutbox).set({ attempt, status: attempt > ladder.length ? "failed" : "pending", nextAt: new Date(Date.parse(now) + (ladder[attempt - 1] ?? 1440) * 60_000).toISOString() }).where(eq(simWebhookOutbox.id, id));
    },
    async reads(envelopeId) { return (await need(envelopeId))._sim.reads; },
  };
}
