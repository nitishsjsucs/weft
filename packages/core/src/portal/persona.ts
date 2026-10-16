// The new hire persona (w2-onboarding): a human principal with role "employee", created when an offer is sent.
// Its worker_id is reserved at send time and becomes the worker row's id when the offer letter is signed.
// Grants are people:view and benefits:view (to name the seeded plans) only; every portal command also checks that the subject is the persona's own record,
// and the API restricts the persona to /v1/portal/* (apps/api/src/http/auth.ts).
import { and, eq } from "drizzle-orm";
import type { ExecContext } from "@weft/contracts";
import { documents, offers, principals, type DbTx } from "@weft/db";
import { DomainRefusal } from "../demo/define";

export const PERSONA_ROLE = "employee";
export const PERSONA_GRANTS = JSON.stringify({ people: "view", payroll: "none", tax: "none", benefits: "view", it: "none", comms: "none", company: "none" });
export const REVOKED_GRANTS = JSON.stringify({ people: "none", payroll: "none", tax: "none", benefits: "none", it: "none", comms: "none", company: "none" });

export type PrincipalRow = typeof principals.$inferSelect;
export type OfferRow = typeof offers.$inferSelect;

export interface Persona { principal: PrincipalRow; workerId: string; offer: OfferRow }

/** The persona of an offer (by its offer letter document), or null when the offer was never sent. */
export async function personaOfOffer(tx: DbTx, offer: OfferRow): Promise<PrincipalRow | null> {
  if (!offer.documentId) return null;
  const [doc] = await tx.select().from(documents).where(eq(documents.id, offer.documentId)).limit(1);
  if (!doc?.workerId) return null;
  const [p] = await tx.select().from(principals).where(and(eq(principals.companyId, offer.companyId), eq(principals.workerId, doc.workerId), eq(principals.role, PERSONA_ROLE))).limit(1);
  return p ?? null;
}

/** Loads the persona for a principal id: its reserved worker id and the offer whose letter names that worker. */
export async function loadPersona(tx: DbTx, companyId: string, principalId: string): Promise<Persona | null> {
  const [p] = await tx.select().from(principals).where(and(eq(principals.companyId, companyId), eq(principals.id, principalId))).limit(1);
  if (!p || p.kind !== "human" || p.role !== PERSONA_ROLE || !p.workerId) return null;
  const [doc] = await tx.select().from(documents).where(and(eq(documents.companyId, companyId), eq(documents.workerId, p.workerId), eq(documents.kind, "offer_letter"))).limit(1);
  if (!doc?.offerId) return null;
  const [offer] = await tx.select().from(offers).where(eq(offers.id, doc.offerId)).limit(1);
  if (!offer) return null;
  return { principal: p, workerId: p.workerId, offer };
}

/** The calling persona, or a refusal: portal commands act only on the caller's own record. */
export async function requirePersona(tx: DbTx, ctx: ExecContext): Promise<Persona> {
  const persona = ctx.principal.role === PERSONA_ROLE ? await loadPersona(tx, ctx.companyId, ctx.principal.id) : null;
  if (!persona) throw new DomainRefusal("DOMAIN_NOT_NEW_HIRE", "Only the new hire persona can use the portal", "Sign in through the portal link in the offer email", null);
  return persona;
}

export const legalName = (o: { candidateFirst: string; candidateLast: string }) => `${o.candidateFirst} ${o.candidateLast}`;
export const normName = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
