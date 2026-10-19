// /v1 offers routes. Owner: t2-world (wave 1 list and accept), w2-onboarding (wave 2 lifecycle: create, read, send,
// void). Every write runs an onboarding.* command through the executor, which writes the action row.
import { Hono, type Context } from "hono";
import { and, eq } from "drizzle-orm";
import { OFFER_TRANSITIONS, Unauthorized, NotFound, type OfferLifecycle, type ToolOutcome, type W2OnboardingOfferDetail } from "@weft/contracts";
import { offers } from "@weft/db";
import { hiringManagerInScope, pageById, personaOfOffer, offerPayReason, toOfferDto, type ReadScope } from "@weft/core";
import { viewerScope } from "../http/scope";
import type { Weft, WeftEnv } from "../http/context";
import { stubRoutes } from "../http/stub";
import { parsePage, toPage } from "../http/paging";

type OfferRow = typeof offers.$inferSelect;

export async function offerDetail(weft: Weft, o: OfferRow): Promise<W2OnboardingOfferDetail> {
  const persona = await personaOfOffer(weft.db, o);
  return {
    id: o.id, candidateFirst: o.candidateFirst, candidateLast: o.candidateLast, candidateEmail: o.candidateEmail, title: o.title, departmentId: o.departmentId,
    workplaceId: o.workplaceId, workState: o.workState, managerId: o.managerId, baseCents: o.baseCents, payKind: o.payKind, startDate: o.startDate,
    status: o.status as OfferLifecycle, acceptedAt: o.acceptedAt, workerId: o.workerId, createdAt: o.createdAt, sentAt: o.sentAt, viewedAt: o.viewedAt,
    voidedAt: o.voidedAt, expiresOn: o.expiresOn, documentId: o.documentId, personaPrincipalId: persona?.id ?? null,
    allowed: [...(OFFER_TRANSITIONS[o.status as OfferLifecycle] ?? [])],
  };
}

export function outcomeJson(c: Context<WeftEnv>, out: ToolOutcome) {
  if (!out.ok) return c.json({ ...out, _tag: "Refused", code: out.refusal.code, message: out.refusal.message, hint: out.refusal.hint }, 422);
  return c.json(out);
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/**
 * An offer as a narrowed person (a manager) may read it: in full when she or one of her reports is the hiring manager,
 * else everything but the pay (base and baseCents null), with an access block that says why.
 */
export function narrowOffer<T extends { managerId: string | null; candidateFirst: string; candidateLast: string }>(scope: ReadScope | null, o: T): T {
  if (!scope || hiringManagerInScope(scope, o.managerId)) return o;
  return { ...o, base: null, baseCents: null, access: { scope: "directory", withheld: ["pay"], reason: offerPayReason(scope, `${o.candidateFirst} ${o.candidateLast}`) } };
}

export function offersRoutes(weft: Weft): Hono<WeftEnv> {
  const r = new Hono<WeftEnv>();
  r.get("/v1/offers", async (c) => {
    const page = parsePage(c);
    const companyId = c.var.session?.companyId ?? "cmp_larkspur";
    const rows = await weft.db.select().from(offers).where(eq(offers.companyId, companyId));
    const scope = await viewerScope(weft, c);
    // Wave 1 Offer fields plus the wave 2 lifecycle columns (additive).
    const out = [];
    for (const o of pageById(rows, page)) out.push(narrowOffer(scope, { ...toOfferDto(o), ...(await offerDetail(weft, o)), base: toOfferDto(o).base }));
    return c.json(toPage(out, page.limit));
  });
  // Demo control "Mark accepted": a human mutation through the executor, then a scheduler kick (SPEC 10).
  r.post("/v1/offers/:id/accept", async (c) => {
    const session = c.var.session;
    if (!session) throw new Unauthorized();
    const out = await weft.executor.human.exec(session, "people.accept_offer", { offer_id: c.req.param("id") });
    await weft.scheduler.kick();
    return c.json(out);
  });
  r.post("/v1/offers", async (c) => {
    const session = c.var.session;
    if (!session) throw new Unauthorized();
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const args = {
      candidate_first: b.candidateFirst, candidate_last: b.candidateLast, candidate_email: b.candidateEmail, title: b.title, department_id: b.departmentId,
      workplace_id: str(b.workplaceId), work_state: b.workState, manager_id: str(b.managerId) || undefined, base_cents: b.baseCents, pay_kind: str(b.payKind),
      start_date: b.startDate, expires_on: str(b.expiresOn),
    };
    return outcomeJson(c, await weft.executor.human.exec(session, "documents.create_offer", args));
  });
  r.get("/v1/offers/:id", async (c) => {
    const companyId = c.var.session?.companyId ?? "cmp_larkspur";
    const [o] = await weft.db.select().from(offers).where(and(eq(offers.companyId, companyId), eq(offers.id, c.req.param("id")))).limit(1);
    if (!o) throw new NotFound(`No offer ${c.req.param("id")}`);
    return c.json(narrowOffer(await viewerScope(weft, c), await offerDetail(weft, o)));
  });
  for (const [path, command] of [["/v1/offers/:id/send", "documents.send_offer"], ["/v1/offers/:id/void", "documents.void_offer"]] as const) {
    r.post(path, async (c) => {
      const session = c.var.session;
      if (!session) throw new Unauthorized();
      return outcomeJson(c, await weft.executor.human.exec(session, command, { offer_id: c.req.param("id") }));
    });
  }
  stubRoutes(r, "offers", ["GET /v1/offers", "POST /v1/offers/:id/accept", "POST /v1/offers", "GET /v1/offers/:id", "POST /v1/offers/:id/send", "POST /v1/offers/:id/void"]);
  return r;
}
