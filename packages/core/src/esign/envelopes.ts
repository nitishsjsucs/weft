// E-signature envelopes (w3-integrations-screening-esign, research/wave3/integrations-screening-esign.md 6.4 and 6.5).
// Only with WEFT_ESIGN=docusign: documents.send_offer also sends one envelope carrying both documents with one embedded
// signer (the new-hire persona), documents.void_offer voids it, and documents.apply_esign_event applies the envelope's
// state after a re-read: delivered marks the offer viewed, completed accepts it once, declined ends it in the declined
// state. Without the flag none of this runs and the built-in click to sign is unchanged.
import { and, eq, inArray } from "drizzle-orm";
import { OFFER_TRANSITIONS_W3, type ExecContext, type OfferLifecycleW3 } from "@weft/contracts";
import { documents, esignEnvelopes, offers, principals, signatureEvidence, signatures, type DbTx } from "@weft/db";
import type { CommandDeps } from "../shared/deps";
import { DomainRefusal, nextActionSeq } from "../demo/define";
import { sha256Hex } from "../shared/hash";
import { displayName } from "../people/names";
import { REVOKED_GRANTS, loadPersona, type OfferRow } from "../portal/persona";

export type EnvelopeRow = typeof esignEnvelopes.$inferSelect;
type Event = { type: string; subjectRef: string; payload: Record<string, string> };
export const VOID_REASON = "The hiring team withdrew this offer (demo).";

export const esignEnabled = (env: Record<string, string | undefined> = process.env) => env.WEFT_ESIGN === "docusign";

export async function envelopeOfOffer(tx: DbTx, offerId: string): Promise<EnvelopeRow | null> {
  const rows = (await tx.select().from(esignEnvelopes).where(eq(esignEnvelopes.offerId, offerId))).sort((a, b) => (a.id < b.id ? 1 : -1));
  return rows[0] ?? null;
}

/** documents.send_offer, after the documents and the persona exist. Returns null when the send failed (built-in stays). */
export async function sendOfferEnvelope(deps: CommandDeps, ctx: ExecContext, o: OfferRow, docIds: string[], personaId: string): Promise<EnvelopeRow | null> {
  const docs = await deps.tx.select().from(documents).where(inArray(documents.id, docIds));
  const ordered = docIds.map((id) => docs.find((d) => d.id === id)!).filter(Boolean);
  const conn = deps.sims.vendors.docusign;
  try {
    const mode = (await conn.status()).mode;
    const sent = await conn.send({
      offerId: o.id, documents: ordered.map((d) => ({ weftDocId: d.id, title: d.title, bytes: new TextEncoder().encode(d.bodyText), sha256: d.sha256 })),
      signer: { name: displayName(o.candidateFirst, o.candidateLast), email: o.candidateEmail, clientUserId: personaId }, expiresOn: o.expiresOn,
    });
    const row: EnvelopeRow = { id: await deps.newId("env_"), companyId: ctx.companyId, offerId: o.id, provider: "docusign", mode, envelopeId: sent.envelopeId, status: "sent", sentAt: ctx.now, deliveredAt: null, completedAt: null, voidedAt: null, lastPolledAt: ctx.now, combinedSha256: null, certificateSha256: null };
    await deps.tx.insert(esignEnvelopes).values(row);
    return row;
  } catch {
    return null;   // the built-in click to sign is the fallback whenever the envelope cannot be sent
  }
}

export async function voidOfferEnvelope(deps: CommandDeps, ctx: ExecContext, offerId: string): Promise<string | null> {
  const e = await envelopeOfOffer(deps.tx, offerId);
  if (!e || e.status === "completed" || e.status === "voided" || e.status === "declined") return null;
  await deps.sims.vendors.docusign.void(e.envelopeId, VOID_REASON);
  await deps.tx.update(esignEnvelopes).set({ status: "voided", voidedAt: ctx.now }).where(eq(esignEnvelopes.id, e.id));
  return e.id;
}

/** The built-in signature is refused for an offer that went out as an envelope: acceptance comes from the envelope. */
export async function refuseBuiltinWhenEnveloped(tx: DbTx, offerId: string): Promise<void> {
  const e = await envelopeOfOffer(tx, offerId);
  if (e && e.status !== "voided") throw new DomainRefusal("DOMAIN_ESIGN_ENVELOPE", `Offer ${offerId} is signed through its e-signature envelope ${e.envelopeId}`, "Open the signing link from the portal", null);
}

const allowed = (from: string, to: OfferLifecycleW3) => (OFFER_TRANSITIONS_W3[from as OfferLifecycleW3] ?? []).includes(to);

export interface ApplyHooks {
  /** forms.ts acceptance: creates the worker and the checklist exactly as the built-in signature does. */
  accept(deps: CommandDeps, ctx: ExecContext, offerId: string, personaId: string): Promise<Event[]>;
}

/** Re-reads the envelope and applies it. Idempotent: a second completion or decline changes nothing. */
export async function applyEnvelope(deps: CommandDeps, ctx: ExecContext, e: EnvelopeRow, hooks: ApplyHooks) {
  const conn = deps.sims.vendors.docusign;
  const live = await conn.envelope(e.envelopeId);
  const tx = deps.tx, now = ctx.now, events: Event[] = [];
  const [o] = await tx.select().from(offers).where(eq(offers.id, e.offerId)).limit(1);
  if (!o) throw new DomainRefusal("DOMAIN_NOT_FOUND", `No offer ${e.offerId}`, null, null);
  const set: Partial<EnvelopeRow> = { status: live.status, lastPolledAt: now };
  if (live.status === "delivered" && !e.deliveredAt) set.deliveredAt = now;
  if ((live.status === "delivered" || live.status === "completed") && o.status === "sent") {
    await tx.update(offers).set({ status: "viewed", viewedAt: now }).where(eq(offers.id, o.id));
    events.push({ type: "offer.viewed", subjectRef: o.id, payload: { offer_id: o.id } });
    o.status = "viewed";
  }
  const signerId = live.recipients[0]?.clientUserId ?? "";
  if (live.status === "completed" && o.status !== "accepted" && allowed(o.status, "accepted")) {
    const persona = await loadPersona(tx, o.companyId, signerId);
    if (!persona || persona.offer.id !== o.id) throw new DomainRefusal("DOMAIN_ESIGN_SIGNER", `Envelope ${e.envelopeId} was signed by an unknown recipient`, null, null);
    events.push(...await hooks.accept(deps, ctx, o.id, persona.principal.id));
    set.completedAt = now;
    try {
      set.combinedSha256 = sha256Hex(Buffer.from(await conn.download(e.envelopeId, "combined")).toString("utf8"));
      set.certificateSha256 = sha256Hex(Buffer.from(await conn.download(e.envelopeId, "certificate")).toString("utf8"));
    } catch { /* the hashes are evidence, not a gate */ }
  }
  if (live.status === "declined" && allowed(o.status, "declined")) {
    await tx.update(offers).set({ status: "declined" }).where(eq(offers.id, o.id));
    const docs = await tx.select().from(documents).where(eq(documents.offerId, o.id));
    const open = docs.filter((d) => d.status !== "signed").map((d) => d.id);
    if (open.length) await tx.update(documents).set({ status: "voided" }).where(inArray(documents.id, open));
    const persona = signerId ? await loadPersona(tx, o.companyId, signerId) : null;
    if (persona) await tx.update(principals).set({ grantsJson: REVOKED_GRANTS }).where(eq(principals.id, persona.principal.id));
    events.push({ type: "offer.declined", subjectRef: o.id, payload: { offer_id: o.id } });
  }
  if (live.status === "voided" && !e.voidedAt) set.voidedAt = now;
  await tx.update(esignEnvelopes).set(set).where(eq(esignEnvelopes.id, e.id));
  if (live.status !== e.status) events.push({ type: "esign.envelope_changed", subjectRef: e.id, payload: { envelope_id: e.id, status: live.status } });
  return { status: live.status, previous: e.status, offerStatus: (await tx.select({ s: offers.status }).from(offers).where(eq(offers.id, o.id)))[0]?.s ?? o.status, events };
}

/** Signature rows for an envelope completion: one per document, with provider evidence in signature_evidence. */
export async function envelopeSignatures(deps: CommandDeps, ctx: ExecContext, offerId: string, personaId: string, typedName: string): Promise<string[]> {
  const tx = deps.tx;
  const env = await envelopeOfOffer(tx, offerId);
  const [p] = await tx.select().from(principals).where(eq(principals.id, personaId)).limit(1);
  const docs = (await tx.select().from(documents).where(and(eq(documents.offerId, offerId), inArray(documents.kind, ["offer_letter", "confidentiality_agreement"])))).sort((a, b) => (a.kind === "offer_letter" ? -1 : b.kind === "offer_letter" ? 1 : 0));
  const out: string[] = [];
  for (const d of docs) {
    if (d.status === "signed") continue;
    const sig = await deps.newId("sig_");
    await tx.insert(signatures).values({ id: sig, documentId: d.id, signerPrincipalId: personaId, signerName: p?.display ?? typedName, typedName, signedAt: ctx.now, documentSha256: d.sha256, actionSeq: await nextActionSeq(tx) });
    await tx.insert(signatureEvidence).values({ signatureId: sig, provider: "docusign", envelopeId: env?.envelopeId ?? null, ip: null, userAgent: null });
    await tx.update(documents).set({ status: "signed", signedAt: ctx.now }).where(eq(documents.id, d.id));
    out.push(sig);
  }
  return out;
}
