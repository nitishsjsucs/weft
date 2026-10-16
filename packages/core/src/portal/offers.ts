// Offer lifecycle commands (w2-onboarding): draft, send (offer letter, confidentiality agreement, persona, invite
// email), view, void and expire. Every transition is checked against OFFER_TRANSITIONS and writes an action row.
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { OFFER_TRANSITIONS, type ExecContext, type OfferLifecycle } from "@weft/contracts";
import { companies, departments, documents, offers, principals, workers, type DbTx } from "@weft/db";
import { canonicalJson } from "../shared/canonical-json";
import { sha256Hex } from "../shared/hash";
import type { CommandDeps } from "../shared/deps";
import { DomainRefusal, notFound, ptDateOf, riskOf, writeCommand } from "../demo/define";
import { displayName, nameRef } from "../people/names";
import { confidentialityText, docSha, offerLetterText } from "../documents/templates";
import { PERSONA_GRANTS, PERSONA_ROLE, REVOKED_GRANTS, personaOfOffer, requirePersona, type OfferRow } from "./persona";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const EXAMPLE_EMAIL = /^[^@\s]+@([a-z0-9-]+\.)*example$/i;
export const OFFER_STATES = ["CA", "NY", "TX", "CO"] as const;
export const INVITE_FROM = "people@larkspur.example";
/** The portal link in the invite. The web app reads ?as= and signs in as that persona (dev auth, simulated). */
export const portalLink = (principalId: string) => `/portal?as=${principalId}`;

export function assertTransition(o: OfferRow, to: OfferLifecycle): void {
  const from = o.status as OfferLifecycle;
  if (!(OFFER_TRANSITIONS[from] ?? []).includes(to)) {
    throw new DomainRefusal("DOMAIN_ILLEGAL_TRANSITION", `Offer ${o.id} is ${from}; ${from} to ${to} is not allowed`, `Allowed from ${from}: ${(OFFER_TRANSITIONS[from] ?? []).join(", ") || "none (final)"}`, null);
  }
}

export async function loadOffer(tx: DbTx, companyId: string, id: string): Promise<OfferRow> {
  const [o] = await tx.select().from(offers).where(and(eq(offers.companyId, companyId), eq(offers.id, id))).limit(1);
  if (!o) throw notFound("offer", id);
  return o;
}

/** True when the sim date (PT) is past the offer's expires_on. */
export const isPastExpiry = (o: OfferRow, now: string) => !!o.expiresOn && ptDateOf(now) > o.expiresOn;

const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);

// onboarding.create_offer ------------------------------------------------------------------------------------
const CreateInput = z.object({
  candidate_first: z.string().min(1).max(60), candidate_last: z.string().min(1).max(60),
  candidate_email: z.string().max(120).regex(EXAMPLE_EMAIL, "use a *.example address (demo data)"),
  title: z.string().min(2).max(80), department_id: z.string(), workplace_id: z.string().optional(), work_state: z.enum(OFFER_STATES),
  manager_id: z.string().optional(), base_cents: z.number().int().positive(), pay_kind: z.enum(["salary", "hourly"]).optional(),
  start_date: isoDate, expires_on: isoDate.optional(),
});
export const createOffer = writeCommand({
  name: "onboarding.create_offer", summary: "Save a draft offer for a candidate (nothing is sent).",
  description: "Create a draft offer: candidate name and *.example email, title, department_id, work_state (CA, NY, TX, CO), optional manager_id, base_cents (annual salary or hourly rate in cents), start_date and optional expires_on. A draft is not sent; onboarding.send_offer sends it. R1: no approval.",
  input: CreateInput, domain: "people", needs: "edit", effect: "write", risk: riskOf("R1"), approval: "never", reversible: false, preview: null,
  async run(i, ctx, deps) {
    const tx = deps.tx;
    const [dept] = await tx.select().from(departments).where(and(eq(departments.companyId, ctx.companyId), eq(departments.id, i.department_id))).limit(1);
    if (!dept) throw notFound("department", i.department_id);
    if (i.manager_id) {
      const [m] = await tx.select().from(workers).where(and(eq(workers.companyId, ctx.companyId), eq(workers.id, i.manager_id))).limit(1);
      if (!m) throw notFound("manager", i.manager_id);
    }
    const today = ptDateOf(ctx.now);
    if (i.start_date <= today) throw new DomainRefusal("DOMAIN_BAD_START_DATE", `start_date ${i.start_date} is not after today (${today})`, "Pick a start date in the future", null);
    const expiresOn = i.expires_on ?? addDays(today, 14);
    if (expiresOn < today) throw new DomainRefusal("DOMAIN_BAD_EXPIRY", `expires_on ${expiresOn} is before today (${today})`, "Pick an expiry on or after today", null);
    const id = await deps.newId("offr_");
    await tx.insert(offers).values({
      id, companyId: ctx.companyId, candidateFirst: i.candidate_first.trim(), candidateLast: i.candidate_last.trim(), candidateEmail: i.candidate_email.toLowerCase(),
      title: i.title.trim(), departmentId: dept.id, workplaceId: i.workplace_id ?? "wkp_remote", workState: i.work_state, managerId: i.manager_id ?? dept.leadWorkerId ?? null,
      baseCents: i.base_cents, payKind: i.pay_kind ?? "salary", startDate: i.start_date, status: "draft", acceptedAt: null, workerId: null,
      createdAt: ctx.now, sentAt: null, viewedAt: null, voidedAt: null, expiresOn, documentId: null,
    });
    return { data: { offer_id: id, status: "draft", expires_on: expiresOn }, summary: `Drafted offer ${id} for ${displayName(i.candidate_first, i.candidate_last)} as ${i.title}` };
  },
});

// onboarding.send_offer --------------------------------------------------------------------------------------
const OfferIdInput = z.object({ offer_id: z.string() });
async function companyName(tx: DbTx, companyId: string) {
  const [c] = await tx.select().from(companies).where(eq(companies.id, companyId)).limit(1);
  return c?.legalName ?? "Larkspur Robotics, Inc. (demo)";
}
async function managerName(tx: DbTx, id: string | null) {
  if (!id) return null;
  const [m] = await tx.select().from(workers).where(eq(workers.id, id)).limit(1);
  return m ? displayName(m.firstName, m.lastName) : null;
}
export async function offerLetterFor(tx: DbTx, o: OfferRow): Promise<string> {
  const [dept] = await tx.select().from(departments).where(eq(departments.id, o.departmentId)).limit(1);
  return offerLetterText({
    companyName: await companyName(tx, o.companyId), candidateFirst: o.candidateFirst, candidateLast: o.candidateLast, title: o.title,
    departmentName: dept?.name ?? o.departmentId, managerName: await managerName(tx, o.managerId), workState: o.workState, baseCents: o.baseCents,
    payKind: o.payKind, startDate: o.startDate, expiresOn: o.expiresOn, offerId: o.id,
  });
}
const subjectHash = (o: OfferRow) => sha256Hex(canonicalJson({ offer: o.id, status: o.status, base: o.baseCents, start: o.startDate }));

export const sendOffer = writeCommand({
  name: "onboarding.send_offer", summary: "Send a draft offer: offer letter, confidentiality agreement and a portal invite email.",
  description: "Send draft offer_id to the candidate: writes the offer letter and confidentiality agreement documents, creates the new hire portal sign-in, emails an offer_invite with the portal link through the email simulator and marks the offer sent. R2: always needs a human approval.",
  input: OfferIdInput, domain: "people", needs: "edit", effect: "write", risk: riskOf("R2"), approval: "always", reversible: false,
  lease: (i) => `offer:${i.offer_id}`,
  async preview(i, ctx, deps) {
    const o = await loadOffer(deps.tx, ctx.companyId, i.offer_id);
    assertTransition(o, "sent");
    return { title: `Send offer ${o.id} to ${displayName(o.candidateFirst, o.candidateLast)} (${o.candidateEmail})`, diff: [{ label: "Offer status", before: o.status, after: "sent" }], content: [], moneyCents: null, subjectRef: o.id, subjectHash: subjectHash(o), evidence: [{ label: "Offer", ref: o.id }] };
  },
  async run(i, ctx, deps) {
    const tx = deps.tx;
    const o = await loadOffer(tx, ctx.companyId, i.offer_id);
    assertTransition(o, "sent");
    if (isPastExpiry(o, ctx.now)) throw new DomainRefusal("DOMAIN_OFFER_EXPIRED", `Offer ${o.id} expired on ${o.expiresOn}`, "Create a new offer with a later expiry", null);
    const reservedWorker = await deps.newId("wrk_");
    const sent = { ...o, status: "sent", sentAt: ctx.now };
    const letter = await offerLetterFor(tx, sent);
    const nda = confidentialityText({ companyName: await companyName(tx, o.companyId), candidateFirst: o.candidateFirst, candidateLast: o.candidateLast, offerId: o.id });
    const letterId = await deps.newId("doc_");
    const ndaId = await deps.newId("doc_");
    const base = { companyId: ctx.companyId, workerId: reservedWorker, offerId: o.id, createdAt: ctx.now, sentAt: ctx.now, signedAt: null, status: "sent" };
    await tx.insert(documents).values({ ...base, id: letterId, kind: "offer_letter", title: `Offer letter: ${o.title}`, bodyText: letter, sha256: docSha(letter) });
    await tx.insert(documents).values({ ...base, id: ndaId, kind: "confidentiality_agreement", title: "Confidentiality and invention assignment agreement", bodyText: nda, sha256: docSha(nda) });
    const principalId = await deps.newId("usr_");
    await tx.insert(principals).values({ id: principalId, companyId: ctx.companyId, kind: "human", workerId: reservedWorker, display: displayName(o.candidateFirst, o.candidateLast), email: o.candidateEmail, role: PERSONA_ROLE, grantsJson: PERSONA_GRANTS });
    await tx.update(offers).set({ status: "sent", sentAt: ctx.now, documentId: letterId }).where(eq(offers.id, o.id));
    const link = portalLink(principalId);
    const email = await deps.sims.email.send({
      to: o.candidateEmail, from: INVITE_FROM, kind: "offer_invite", relatedRef: o.id,
      subject: `Your offer from Larkspur Robotics (demo): ${o.title}`,
      body: `Hi ${o.candidateFirst} (demo),\n\nYour offer for ${o.title} is ready. Open your new-hire portal to read and sign it, then finish your onboarding checklist:\n${link}\n\nThe offer stays open until ${o.expiresOn ?? o.startDate}.\n\nThis is a simulated email from a fictional company.`,
    });
    return {
      data: { offer_id: o.id, status: "sent", document_ids: [letterId, ndaId], persona_principal_id: principalId, reserved_worker_id: reservedWorker, email_id: email.id, portal_link: link },
      summary: `Sent offer ${o.id} to ${displayName(o.candidateFirst, o.candidateLast)}: invite ${email.id}, documents ${letterId} and ${ndaId}`,
      events: [{ type: "offer.sent", subjectRef: o.id, payload: { offer_id: o.id } }],
    };
  },
});

// onboarding.void_offer --------------------------------------------------------------------------------------
async function closeOffer(tx: DbTx, o: OfferRow, status: "voided" | "expired", ctx: ExecContext) {
  await tx.update(offers).set(status === "voided" ? { status, voidedAt: ctx.now } : { status }).where(eq(offers.id, o.id));
  const docs = await tx.select().from(documents).where(eq(documents.offerId, o.id));
  const open = docs.filter((d) => d.status !== "signed").map((d) => d.id);
  if (open.length) await tx.update(documents).set({ status: "voided" }).where(inArray(documents.id, open));
  const persona = await personaOfOffer(tx, o);
  if (persona) await tx.update(principals).set({ grantsJson: REVOKED_GRANTS }).where(eq(principals.id, persona.id));
  return { voidedDocuments: open, persona: persona?.id ?? null };
}

export const voidOffer = writeCommand({
  name: "onboarding.void_offer", summary: "Void an offer that is not accepted yet.",
  description: "Void offer_id (draft, sent or viewed): the offer reads Void, its unsigned documents are voided and the new hire portal sign-in loses its access. An accepted, expired or void offer is refused. R2: always needs a human approval.",
  input: OfferIdInput, domain: "people", needs: "edit", effect: "write", risk: riskOf("R2"), approval: "always", reversible: false,
  lease: (i) => `offer:${i.offer_id}`,
  async preview(i, ctx, deps) {
    const o = await loadOffer(deps.tx, ctx.companyId, i.offer_id);
    assertTransition(o, "voided");
    return { title: `Void offer ${o.id} for ${displayName(o.candidateFirst, o.candidateLast)}`, diff: [{ label: "Offer status", before: o.status, after: "voided" }], content: [], moneyCents: null, subjectRef: o.id, subjectHash: subjectHash(o), evidence: [{ label: "Offer", ref: o.id }] };
  },
  async run(i, ctx, deps) {
    const o = await loadOffer(deps.tx, ctx.companyId, i.offer_id);
    assertTransition(o, "voided");
    const r = await closeOffer(deps.tx, o, "voided", ctx);
    return { data: { offer_id: o.id, status: "voided", previous_status: o.status, voided_document_ids: r.voidedDocuments, persona_revoked: r.persona }, summary: `Voided offer ${o.id} (was ${o.status})` };
  },
});

// onboarding.expire_offers -----------------------------------------------------------------------------------
export const expireOffers = writeCommand({
  name: "onboarding.expire_offers", summary: "Expire sent or viewed offers whose expiry date has passed.",
  description: "Mark every sent or viewed offer whose expires_on is before today's sim date (America/Los_Angeles) expired: its unsigned documents are voided and the portal sign-in loses access. Returns the expired offer ids. R1: no approval.",
  input: z.object({}), domain: "people", needs: "edit", effect: "write", risk: riskOf("R1"), approval: "never", reversible: false, preview: null,
  async run(_i, ctx, deps) {
    const rows = await deps.tx.select().from(offers).where(and(eq(offers.companyId, ctx.companyId), inArray(offers.status, ["sent", "viewed"])));
    const due = rows.filter((o) => isPastExpiry(o, ctx.now)).sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const o of due) { assertTransition(o, "expired"); await closeOffer(deps.tx, o, "expired", ctx); }
    return { data: { expired_offer_ids: due.map((o) => o.id), as_of: ptDateOf(ctx.now) }, summary: due.length ? `Expired ${due.length} offer(s): ${due.map((o) => o.id).join(", ")}` : "No offers past their expiry" };
  },
});

// onboarding.view_offer (the new hire persona opens the portal) ----------------------------------------------
export const viewOffer = writeCommand({
  name: "onboarding.view_offer", summary: "The new hire opened their offer (portal only).",
  description: "Human only, new hire persona: marks the caller's sent offer viewed. An offer past its expiry date is marked expired instead. Already viewed or accepted offers are left as they are.",
  input: z.object({}), domain: "people", needs: "view", effect: "write", risk: riskOf("R1"), approval: "never", access: "human_only", reversible: false, preview: null,
  async run(_i, ctx, deps) {
    const { offer: o } = await requirePersona(deps.tx, ctx);
    if (o.status === "sent" || o.status === "viewed") {
      if (isPastExpiry(o, ctx.now)) {
        await closeOffer(deps.tx, o, "expired", ctx);
        return { data: { offer_id: o.id, status: "expired", changed: true }, summary: `Offer ${o.id} expired on ${o.expiresOn}` };
      }
    }
    if (o.status !== "sent") return { data: { offer_id: o.id, status: o.status, changed: false }, summary: `Offer ${o.id} is ${o.status}` };
    assertTransition(o, "viewed");
    await deps.tx.update(offers).set({ status: "viewed", viewedAt: ctx.now }).where(eq(offers.id, o.id));
    return { data: { offer_id: o.id, status: "viewed", changed: true }, summary: `${nameRef(o.candidateFirst, o.candidateLast, o.id)} viewed offer ${o.id}`, events: [{ type: "offer.viewed", subjectRef: o.id, payload: { offer_id: o.id } }] };
  },
});

export type { CommandDeps };
