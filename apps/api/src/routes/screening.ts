// /v1 screening routes (wave 3, docs/wave3.md). Owner: w3-integrations-screening-esign. Paths come from packages/contracts/src/api.ts.
// Every route answers 501 until the owner registers real handlers before stubRoutes and lists them in `except`.
// Reads return status, result, ETA and timestamps only; record detail is a human-only command (screening.review),
// and every adjudication step runs a human_only command through the HumanExecutor, which writes the action row.
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { NotFound, Unauthorized, ValidationError, formatCents } from "@weft/contracts";
import { esignEnvelopes, screeningOrders, screeningPackages } from "@weft/db";
import { loadPersona } from "../../../../packages/core/src/portal/persona";
import { W3_SCREENING_STEP_COMMAND, W3ScreeningAdjudicateStep, w3EsignSimControls, w3ScreeningSimControls, type W3EsignEnvelopeView, type W3ScreeningPortalView } from "../../../../packages/contracts/src/ext/w3-integrations-screening-esign";
import { orderViews } from "../../../../packages/core/src/screening/orders";
import { withWriteLock } from "@weft/db";
import { offers } from "@weft/db";
import { deliverSimWebhooks } from "../integrations/poll-screening";
import type { Weft, WeftEnv } from "../http/context";
import { stubRoutes } from "../http/stub";
import { outcomeJson } from "./offers";

const companyOf = (s: { companyId: string } | null) => s?.companyId ?? "cmp_larkspur";
const VENDOR_LABEL = { checkr: "Checkr", hireright: "HireRight" } as const;

export function screeningRoutes(weft: Weft): Hono<WeftEnv> {
  const r = new Hono<WeftEnv>();
  r.get("/v1/screening/packages", async (c) => {
    const rows = (await weft.db.select().from(screeningPackages)).sort((a, b) => (a.vendor + a.slug < b.vendor + b.slug ? -1 : 1));
    return c.json(rows.map((p) => ({ vendor: p.vendor, slug: p.slug, name: p.name, priceCents: p.priceCents, priceDisplay: formatCents(p.priceCents), screenings: JSON.parse(p.screeningsJson) as string[], phase: p.phase })));
  });
  r.get("/v1/screening/orders", async (c) => {
    const offerId = c.req.query("offerId"), status = c.req.query("status");
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 25) || 25, 1), 100), afterId = c.req.query("afterId");
    const rows = (await weft.db.select().from(screeningOrders).where(eq(screeningOrders.companyId, companyOf(c.var.session))))
      .filter((x) => (!offerId || x.offerId === offerId) && (!status || x.status === status) && (!afterId || x.id > afterId)).sort((a, b) => (a.id < b.id ? -1 : 1));
    const data = await orderViews(weft.db, rows.slice(0, limit));
    return c.json({ hasMore: rows.length > limit, count: data.length, data });
  });
  r.get("/v1/screening/orders/:id", async (c) => {
    const [row] = await weft.db.select().from(screeningOrders).where(and(eq(screeningOrders.companyId, companyOf(c.var.session)), eq(screeningOrders.id, c.req.param("id")))).limit(1);
    if (!row) throw new NotFound(`No screening order ${c.req.param("id")}`);
    const [view] = await orderViews(weft.db, [row]);
    // ?detail=items is the human-only record view: it runs screening.review through the HumanExecutor (audited).
    if (c.req.query("detail") === "items") {
      const session = c.var.session;
      if (!session || session.via !== "ui") throw new Unauthorized("Opening a report needs a signed-in person");
      const out = await weft.executor.human.exec(session, "screening.review", { order_id: row.id });
      return out.ok ? c.json({ ...view, items: out.status === "done" ? (out.data as { items: unknown[] }).items : [] }) : outcomeJson(c, out);
    }
    return c.json(view);
  });
  r.post("/v1/offers/:id/screening", async (c) => {
    const session = c.var.session;
    if (!session) throw new Unauthorized();
    const b = (await c.req.json().catch(() => ({}))) as { packageSlug?: unknown };
    const out = await weft.executor.human.exec(session, "screening.order", { offer_id: c.req.param("id"), package_slug: typeof b.packageSlug === "string" && b.packageSlug ? b.packageSlug : undefined });
    await weft.scheduler.kick();
    return outcomeJson(c, out);
  });
  r.post("/v1/screening/orders/:id/adjudicate", async (c) => {
    const session = c.var.session;
    if (!session) throw new Unauthorized();
    const b = (await c.req.json().catch(() => ({}))) as { step?: unknown };
    const step = W3ScreeningAdjudicateStep.safeParse(b.step);
    if (!step.success) throw new ValidationError(`step must be one of ${W3ScreeningAdjudicateStep.options.join(", ")}`);
    const out = await weft.executor.human.exec(session, W3_SCREENING_STEP_COMMAND[step.data], { order_id: c.req.param("id") });
    await weft.scheduler.kick();
    return outcomeJson(c, out);
  });
  r.get("/v1/offers/:id/envelope", async (c) => {
    const [e] = await weft.db.select().from(esignEnvelopes).where(and(eq(esignEnvelopes.companyId, companyOf(c.var.session)), eq(esignEnvelopes.offerId, c.req.param("id")))).limit(1);
    if (!e) throw new NotFound(`Offer ${c.req.param("id")} has no envelope (built-in signing)`);
    const view: W3EsignEnvelopeView = { id: e.id, offerId: e.offerId, provider: e.provider as "docusign", mode: e.mode as "simulated", envelopeId: e.envelopeId, status: e.status as W3EsignEnvelopeView["status"], sentAt: e.sentAt, deliveredAt: e.deliveredAt, completedAt: e.completedAt, voidedAt: e.voidedAt, lastPolledAt: e.lastPolledAt };
    return c.json(view);
  });
  // The new-hire portal: the candidate's own order and the simulated apply page (the screening company's side).
  r.get("/v1/portal/screening", async (c) => {
    const session = c.var.session;
    if (!session) throw new Unauthorized();
    const p = await loadPersona(weft.db, session.companyId, session.principalId);
    if (!p) return c.json([]);
    const rows = (await weft.db.select().from(screeningOrders).where(eq(screeningOrders.offerId, p.offer.id))).sort((a, b) => (a.id < b.id ? -1 : 1));
    const views = await orderViews(weft.db, rows);
    return c.json(views.map((v): W3ScreeningPortalView => ({ orderId: v.id, vendor: v.vendor, mode: v.mode, status: v.status, consentNeeded: v.status === "invited" && v.mode === "simulated", vendorLabel: VENDOR_LABEL[v.vendor], packageName: v.packageName })));
  });
  r.post("/v1/portal/screening/consent", async (c) => {
    const session = c.var.session;
    if (!session) throw new Unauthorized();
    const b = (await c.req.json().catch(() => ({}))) as { orderId?: unknown; typedName?: unknown };
    if (typeof b.orderId !== "string" || typeof b.typedName !== "string") throw new ValidationError("orderId and typedName are required");
    const p = await loadPersona(weft.db, session.companyId, session.principalId);
    const [row] = p ? await weft.db.select().from(screeningOrders).where(and(eq(screeningOrders.offerId, p.offer.id), eq(screeningOrders.id, b.orderId))).limit(1) : [];
    if (!row || !row.vendorOrderId) throw new NotFound(`No screening order ${b.orderId} for you`);
    // The screening company's hosted page, simulated: it writes only the simulator's tables. A real vendor collects
    // consent on its own site, so there is nothing to do here in real mode.
    const done = await withWriteLock(() => weft.db.transaction(async (tx) => {
      const { createSimulators } = await import("@weft/sim");
      const ctl = w3ScreeningSimControls(createSimulators({ db: tx, clock: weft.clock }).vendors[row.vendor as "checkr"]);
      if (!ctl || row.mode !== "simulated") return false;
      await ctl.consent(row.vendorOrderId!, b.typedName as string);
      return true;
    })).catch((e: unknown) => { throw new ValidationError(String((e as Error).message ?? e).replace(/^.*simulator: /, "")); });
    if (!done) return c.json({ ok: false, code: "INTEGRATION_NOT_AVAILABLE", message: "Consent is collected on the screening company's own page" }, 422);
    await weft.scheduler.kick();
    return c.json({ ok: true, orderId: row.id });
  });
  // Embedded signing: a fresh one-time link per click (DocuSign's expire after five minutes); the portal redirects the full page.
  r.post("/v1/portal/esign/url", async (c) => {
    const session = c.var.session;
    if (!session) throw new Unauthorized();
    const p = await loadPersona(weft.db, session.companyId, session.principalId);
    if (!p) throw new NotFound("No offer for this sign-in");
    const [e] = (await weft.db.select().from(esignEnvelopes).where(eq(esignEnvelopes.offerId, p.offer.id))).sort((a, b) => (a.id < b.id ? 1 : -1));
    if (!e || (e.status !== "sent" && e.status !== "delivered")) throw new NotFound("This offer has no open e-signature envelope (built-in signing)");
    const returnUrl = `/portal?as=${encodeURIComponent(session.principalId)}&esign_return=1`;
    const signer = { name: `${p.offer.candidateFirst} ${p.offer.candidateLast} (demo)`, email: p.offer.candidateEmail, clientUserId: session.principalId };
    const link = await withWriteLock(() => weft.sims.vendors.docusign.signingUrl(e.envelopeId, signer, returnUrl));
    await weft.scheduler.kick();
    return c.json(link);
  });
  // The simulated signing page (DocuSign's embedded signing, played by the portal): the signer signs or declines. The
  // simulator records it and queues its signed Connect message, which goes through verification and dedupe right
  // away, so the redirect back to the portal finds the offer already accepted or declined. Real mode never gets here.
  r.post("/v1/portal/esign/finish", async (c) => {
    const session = c.var.session;
    if (!session) throw new Unauthorized();
    const b = (await c.req.json().catch(() => ({}))) as { envelopeId?: unknown; outcome?: unknown };
    if (typeof b.envelopeId !== "string" || (b.outcome !== "signed" && b.outcome !== "declined")) throw new ValidationError("envelopeId and outcome ('signed' or 'declined') are required");
    const p = await loadPersona(weft.db, session.companyId, session.principalId);
    const [e] = p ? await weft.db.select().from(esignEnvelopes).where(and(eq(esignEnvelopes.offerId, p.offer.id), eq(esignEnvelopes.envelopeId, b.envelopeId))).limit(1) : [];
    if (!e) throw new NotFound(`No envelope ${b.envelopeId} for you`);
    if (e.mode !== "simulated") return c.json({ ok: false, code: "INTEGRATION_NOT_AVAILABLE", message: "Signing happens on the e-signature provider's own page" }, 422);
    const outcome = b.outcome;
    await withWriteLock(() => weft.db.transaction(async (tx) => {
      const { createSimulators } = await import("@weft/sim");
      await w3EsignSimControls(createSimulators({ db: tx, clock: weft.clock }).vendors.docusign)!.finish(e.envelopeId, outcome);
    })).catch((err: unknown) => { throw new ValidationError(String((err as Error).message ?? err).replace(/^.*simulator: /, "")); });
    await deliverSimWebhooks({ db: weft.db, clock: weft.clock, executor: weft.executor, now: weft.clock.now() });
    await weft.scheduler.kick();
    const [o] = await weft.db.select({ status: offers.status }).from(offers).where(eq(offers.id, e.offerId)).limit(1);
    return c.json({ ok: true, envelopeId: e.envelopeId, outcome, offerStatus: o?.status ?? null });
  });
  return stubRoutes(r, "screening", [
    "GET /v1/screening/packages", "GET /v1/screening/orders", "GET /v1/screening/orders/:id", "POST /v1/offers/:id/screening", "POST /v1/screening/orders/:id/adjudicate",
    "GET /v1/offers/:id/envelope", "GET /v1/portal/screening", "POST /v1/portal/screening/consent", "POST /v1/portal/esign/url",
    "POST /v1/portal/esign/finish",
  ]);
}
