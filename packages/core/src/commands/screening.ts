// screening.* (and the documents.* envelope commands) commands (wave 3, docs/wave3.md). Owner: w3-integrations-screening-esign. Append WeftCommand definitions to this array; commands/index.ts
// concatenates it. Names, risk classes and access are fixed by W3_PLANNED_COMMANDS in packages/contracts/src/wave3.ts.
//
// Rules (research/wave3/integrations-screening-esign.md 5.4 and 6.8): screening.order is R4 with approval always, refused
// before the offer is accepted, priced from screening_packages and capped by agent.screening_cents. Agent reads return
// status, result, ETA and timestamps only. Reviewing records and every adverse step are human_only, so no model surface
// ever lists them. The background_check task completes only from vendor events (screening.apply_vendor_event, system
// only) or a human engage.
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { formatCents, type ScreeningStatus } from "@weft/contracts";
import { screeningOrders, screeningPackages } from "@weft/db";
import { W3EsignApplyInput, W3ScreeningApplyInput } from "../../../contracts/src/ext/w3-integrations-screening-esign";
import { esignEnvelopes } from "@weft/db";
import { applyEnvelope, envelopeOfOffer } from "../esign/envelopes";
import { acceptFromEnvelope } from "../portal/forms";
import { canonicalJson } from "../shared/canonical-json";
import { sha256Hex } from "../shared/hash";
import type { CommandDeps, WeftCommand } from "../shared/deps";
import { DomainRefusal, ptDateOf, readCommand, riskOf, writeCommand } from "../demo/define";
import { displayName, nameRef } from "../people/names";
import {
  acceptedOffer, connectorOf, defaultPackage, ensureBackgroundTask, finalNotAllowedBefore, linkAdverse, loadOrder, openAdverse, openOrders, orderByVendorRef,
  orderViews, packageRow, screeningVendor, syncBackgroundTask, workLocationOf, type OrderRow,
} from "../screening/orders";
import type { ExecContext } from "@weft/contracts";

const CONSENT_LINE = "The screening company presents the disclosure and the summary of rights and collects the candidate's consent.";
const statusEvent = (r: OrderRow, status: string) => ({ type: "screening.status_changed", subjectRef: r.id, payload: { order_id: r.id, status } });

// ---- reads (R0, every surface): status, result, ETA and timestamps only --------------------------------------
export const listPackages = readCommand({
  name: "screening.list_packages", summary: "List background check packages and prices.",
  description: "List the background check packages for the configured screening company: slug, name, price (cents and display), the screenings included and the phase (full, or NYC non_criminal then criminal). Prices come from the package catalog in the database.",
  input: z.object({}), domain: "people",
  async run(_i, _ctx, deps) {
    const vendor = screeningVendor();
    const rows = (await deps.tx.select().from(screeningPackages).where(eq(screeningPackages.vendor, vendor))).sort((a, b) => (a.slug < b.slug ? -1 : 1));
    return { data: { vendor, packages: rows.map((p) => ({ slug: p.slug, name: p.name, price_cents: p.priceCents, price_display: formatCents(p.priceCents), screenings: JSON.parse(p.screeningsJson) as string[], phase: p.phase })) }, summary: `${rows.length} ${vendor} package(s)` };
  },
});

const StatusInput = z.object({ offer_id: z.string().optional(), worker_id: z.string().optional(), order_id: z.string().optional() });
export const getStatus = readCommand({
  name: "screening.get_status", summary: "Background check status for an offer or worker.",
  description: "Background check orders for offer_id, worker_id or order_id: status, result (clear or consider), adjudication stage, ETA date and timestamps. Never includes record details; a consider result reads review_required and only a person can open the report.",
  input: StatusInput, domain: "people",
  async run(i, ctx, deps) {
    const rows = (await deps.tx.select().from(screeningOrders).where(eq(screeningOrders.companyId, ctx.companyId)))
      .filter((r) => (!i.offer_id || r.offerId === i.offer_id) && (!i.worker_id || r.workerId === i.worker_id) && (!i.order_id || r.id === i.order_id))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const views = await orderViews(deps.tx, rows);
    const orders = views.map((v) => ({ order_id: v.id, offer_id: v.offerId, worker_id: v.workerId, vendor: v.vendor, mode: v.mode, package: v.packageName, price_cents: v.priceCents, phase: v.phase, status: v.status, result: v.result, adjudication: v.adjudication, review_required: v.reviewRequired, eta_on: v.etaOn, created_at: v.createdAt, completed_at: v.completedAt }));
    return { data: { orders }, summary: orders.length ? orders.map((o) => `${o.order_id} ${o.status}${o.eta_on ? ` (ETA ${o.eta_on})` : ""}`).join("; ") : "No background check orders" };
  },
});

// ---- screening.order (R4, approval always, money ceiling) ---------------------------------------------------
const OrderInput = z.object({ offer_id: z.string(), package_slug: z.string().optional() });
type OrderInput = z.infer<typeof OrderInput>;
async function orderPlan(i: OrderInput, ctx: ExecContext, deps: CommandDeps) {
  const o = await acceptedOffer(deps.tx, ctx.companyId, i.offer_id);
  const open = await openOrders(deps.tx, o.id);
  if (open.length) throw new DomainRefusal("DOMAIN_SCREENING_EXISTS", `Offer ${o.id} already has background check ${open.map((r) => `${r.id} ${r.status}`).join(", ")}`, "Read screening.get_status; only a canceled or expired order can be replaced", null);
  const vendor = screeningVendor();
  const loc = await workLocationOf(deps.tx, o);
  // New York City: non-criminal first, then a person decides to proceed to the criminal check (Fair Chance Act).
  const phase = loc.nyc ? "non_criminal" : "full";
  const pkg = i.package_slug ? await packageRow(deps.tx, vendor, i.package_slug) : await defaultPackage(deps.tx, vendor, phase);
  if (pkg.phase !== phase) {
    throw new DomainRefusal("DOMAIN_SCREENING_STEP", `${pkg.slug} is a ${pkg.phase} package; this hire needs a ${phase} package${loc.nyc ? " (New York City runs the non-criminal check first)" : ""}`, "Pick a package from screening.list_packages with the right phase", { offer_id: o.id, package_slug: (await defaultPackage(deps.tx, vendor, phase)).slug });
  }
  return { o, pkg, vendor, loc, phase };
}

export const orderScreening = writeCommand({
  name: "screening.order", summary: "Order a background check after the offer is accepted.",
  description: "Propose ordering a background check for accepted offer_id (optional package_slug; default by work location). R4: always needs approval; the price comes from the package catalog and counts against the agent screening ceilings. Refused before the offer is accepted. The screening company collects consent.",
  input: OrderInput, domain: "people", needs: "edit", effect: "external", risk: () => "R4", approval: "always", reversible: false,
  amountCents: async (i, ctx, deps) => (await orderPlan(i, ctx, deps)).pkg.priceCents,
  ceilingKey: "agent.screening_cents", lease: (i) => `screening:${i.offer_id}`,
  async preview(i, ctx, deps) {
    const { o, pkg, vendor, loc } = await orderPlan(i, ctx, deps);
    const mode = (await connectorOf(deps.sims, vendor).status()).mode;
    return {
      title: `Order ${pkg.name} for ${nameRef(o.candidateFirst, o.candidateLast, o.workerId)} at ${formatCents(pkg.priceCents)}`,
      diff: [{ label: "Background check", before: "none", after: `${pkg.name}, ${formatCents(pkg.priceCents)}, ${vendor} (${mode === "simulated" ? "Simulated" : "live"}), work location ${[loc.city, loc.state].filter(Boolean).join(", ")}` }],
      content: [{ label: "Consent", text: CONSENT_LINE }], moneyCents: pkg.priceCents, subjectRef: `${o.id}:screening`,
      subjectHash: sha256Hex(canonicalJson({ offer: o.id, status: o.status, pkg: pkg.slug, price: pkg.priceCents })), evidence: [{ label: "Offer", ref: o.id }, { label: "Worker", ref: o.workerId }],
    };
  },
  async run(i, ctx, deps) {
    const { o, pkg, vendor, loc, phase } = await orderPlan(i, ctx, deps);
    const conn = connectorOf(deps.sims, vendor);
    const mode = (await conn.status()).mode;
    const id = await deps.newId("scr_");
    const res = await conn.createOrder({ orderId: id, candidate: { first: o.candidateFirst, last: o.candidateLast, email: o.candidateEmail }, packageSlug: pkg.slug, workLocation: { country: loc.country, state: loc.state, city: loc.city } });
    await deps.tx.insert(screeningOrders).values({
      id, companyId: ctx.companyId, offerId: o.id, workerId: o.workerId, vendor, mode, packageSlug: pkg.slug, priceCents: pkg.priceCents, phase, status: res.status, result: null, adjudication: "none",
      timerPaused: false, vendorCandidateId: res.vendorCandidateId, vendorOrderId: res.vendorOrderId, vendorReportId: null, applyUrl: res.applyUrl, etaOn: null, lastPolledAt: ctx.now,
      createdAt: ctx.now, completedAt: null, proposalId: ctx.approvedProposalId ?? null, actionSeq: null,
    });
    await ensureBackgroundTask(deps.tx, (p) => deps.newId(p), o.workerId, o.startDate);
    return {
      data: { order_id: id, offer_id: o.id, worker_id: o.workerId, vendor, mode, package: pkg.name, phase, status: res.status, price_cents: pkg.priceCents, price_display: formatCents(pkg.priceCents) },
      summary: `Ordered ${pkg.name} for ${nameRef(o.candidateFirst, o.candidateLast, o.workerId)} at ${formatCents(pkg.priceCents)} (${id}, ${vendor} ${mode})`,
      moneyCents: pkg.priceCents,
      events: [statusEvent({ id } as OrderRow, res.status)],
    };
  },
});

// ---- screening.cancel (R3, approval always) -------------------------------------------------------------------
const OrderIdInput = z.object({ order_id: z.string() });
const CANCELABLE: ScreeningStatus[] = ["invited", "consented", "in_progress", "suspended"];
export const cancelScreening = writeCommand({
  name: "screening.cancel", summary: "Cancel a background check that has not finished.",
  description: "Propose canceling background check order_id while it is invited, consented, in progress or suspended. R3: always needs approval. A finished report cannot be canceled.",
  input: OrderIdInput, domain: "people", needs: "edit", effect: "external", risk: riskOf("R3"), approval: "always", reversible: false, lease: (i) => `screening-order:${i.order_id}`,
  async preview(i, ctx, deps) {
    const r = await loadOrder(deps.tx, ctx.companyId, i.order_id);
    if (!CANCELABLE.includes(r.status as ScreeningStatus)) throw new DomainRefusal("DOMAIN_SCREENING_NOT_OPEN", `${r.id} is ${r.status}`, null, null);
    return { title: `Cancel background check ${r.id}`, diff: [{ label: "Status", before: r.status, after: "canceled" }], content: [], moneyCents: null, subjectRef: r.id, subjectHash: sha256Hex(canonicalJson({ id: r.id, status: r.status })), evidence: [{ label: "Offer", ref: r.offerId }] };
  },
  async run(i, ctx, deps) {
    const r = await loadOrder(deps.tx, ctx.companyId, i.order_id);
    if (!CANCELABLE.includes(r.status as ScreeningStatus)) throw new DomainRefusal("DOMAIN_SCREENING_NOT_OPEN", `${r.id} is ${r.status}`, null, null);
    await connectorOf(deps.sims, r.vendor as "checkr").cancelOrder(r.vendorOrderId!);
    const next = { ...r, status: "canceled" };
    await deps.tx.update(screeningOrders).set({ status: "canceled" }).where(eq(screeningOrders.id, r.id));
    const events = [statusEvent(r, "canceled"), ...(await syncBackgroundTask(deps.tx, next, ctx.now))];
    return { data: { order_id: r.id, status: "canceled", previous_status: r.status }, summary: `Canceled background check ${r.id}`, events };
  },
});

// ---- screening.apply_vendor_event (system only): re-read the vendor, then update Weft ---------------------------
export async function applyVendorSnapshot(deps: CommandDeps, r: OrderRow, now: string) {
  const snap = await connectorOf(deps.sims, r.vendor as "checkr").getOrder(r.vendorOrderId!);
  // The vendor's post notice never closes an order by itself: the final step is a person's (screening.send_final_adverse).
  const adjudication = snap.adjudication === "post_adverse" && r.adjudication !== "post_adverse" ? r.adjudication === "none" ? "pre_adverse" : r.adjudication : r.adjudication === "post_adverse" || r.adjudication === "engaged" ? r.adjudication : snap.adjudication;
  const next: OrderRow = {
    ...r, status: snap.status, result: snap.result, adjudication, etaOn: snap.etaOn, completedAt: snap.completedAt, vendorReportId: snap.vendorReportId ?? r.vendorReportId,
    timerPaused: snap.status === "disputed", lastPolledAt: now,
  };
  await deps.tx.update(screeningOrders).set({ status: next.status, result: next.result, adjudication: next.adjudication, etaOn: next.etaOn, completedAt: next.completedAt, vendorReportId: next.vendorReportId, timerPaused: next.timerPaused, lastPolledAt: now }).where(eq(screeningOrders.id, r.id));
  const changed = next.status !== r.status || next.result !== r.result || next.adjudication !== r.adjudication;
  const events = [...(changed ? [statusEvent(r, next.status)] : []), ...(await syncBackgroundTask(deps.tx, next, now))];
  return { next, changed, events };
}

export const applyVendorEvent = writeCommand({
  name: "screening.apply_vendor_event", summary: "System: apply a screening company update.",
  description: "System command (svc_events, svc_scheduler): after a verified webhook or a poll, re-reads the order from the screening company by id and updates status, result, ETA and the background_check task. Never reads a webhook body.",
  input: W3ScreeningApplyInput, domain: "people", needs: "edit", effect: "write", risk: riskOf("R1"), approval: "never", access: "system_only", reversible: false, preview: null,
  async run(i, ctx, deps) {
    const r = await orderByVendorRef(deps.tx, i.vendor, i.vendor_order_id);
    if (!r || r.companyId !== ctx.companyId) return { data: { matched: false, vendor: i.vendor }, summary: `No background check matches ${i.vendor} ${i.vendor_order_id}` };
    const { next, changed, events } = await applyVendorSnapshot(deps, r, ctx.now);
    return { data: { matched: true, order_id: r.id, status: next.status, result: next.result, changed, previous_status: r.status }, summary: changed ? `Background check ${r.id}: ${r.status} to ${next.status}${next.result ? ` (${next.result})` : ""}` : `Background check ${r.id} unchanged (${r.status})`, events };
  },
});

// ---- human only: review, engage, adverse steps, NYC proceed --------------------------------------------------
const humanOnly = { domain: "people" as const, needs: "edit" as const, approval: "never" as const, access: "human_only" as const, reversible: false as const, preview: null };

export const reviewScreening = writeCommand({
  name: "screening.review", summary: "Open a background check report (people only).",
  description: "Human only: opens the report items behind a consider result for order_id. Each opening is written to the audit log. The text comes from the screening company and is untrusted; it never reaches the agent.",
  input: OrderIdInput, ...humanOnly, effect: "write", risk: riskOf("R3"), untrustedFields: ["items[].text"],
  async run(i, ctx, deps) {
    const r = await loadOrder(deps.tx, ctx.companyId, i.order_id);
    if (r.status !== "complete_review" && r.status !== "disputed") throw new DomainRefusal("DOMAIN_SCREENING_STEP", `${r.id} is ${r.status}; there is nothing to review`, null, null);
    const items = await connectorOf(deps.sims, r.vendor as "checkr").listAdverseItems(r.vendorReportId!);
    return { data: { order_id: r.id, items: items.map((x) => ({ id: x.id, text: x.text })) }, summary: `Opened ${items.length} report item(s) for ${r.id}` };
  },
});

async function needReview(deps: CommandDeps, ctx: ExecContext, id: string, adjudication: string[]) {
  const r = await loadOrder(deps.tx, ctx.companyId, id);
  if ((r.status !== "complete_review" && r.status !== "disputed") || !adjudication.includes(r.adjudication)) {
    throw new DomainRefusal("DOMAIN_SCREENING_STEP", `${r.id} is ${r.status} with adjudication ${r.adjudication}`, "Read the order's next steps on the hiring screen", null);
  }
  return r;
}

export const engageScreening = writeCommand({
  name: "screening.engage", summary: "Proceed with the hire after reviewing a report (people only).",
  description: "Human only: after reviewing a consider result for order_id, proceed with the hire. The background_check task completes.",
  input: OrderIdInput, ...humanOnly, effect: "write", risk: riskOf("R3"),
  async run(i, ctx, deps) {
    const r = await needReview(deps, ctx, i.order_id, ["none"]);
    const next = { ...r, adjudication: "engaged" };
    await deps.tx.update(screeningOrders).set({ adjudication: "engaged" }).where(eq(screeningOrders.id, r.id));
    return { data: { order_id: r.id, adjudication: "engaged" }, summary: `Engaged: proceeding with the hire after review of ${r.id}`, events: [statusEvent(r, r.status), ...(await syncBackgroundTask(deps.tx, next, ctx.now))] };
  },
});

export const startPreAdverse = writeCommand({
  name: "screening.start_pre_adverse", summary: "Send the pre-adverse notice (people only).",
  description: "Human only: starts the pre-adverse step for order_id. The screening company sends the report copy and the summary of rights; the final step may follow only after the waiting period. The offer stays open.",
  input: OrderIdInput, ...humanOnly, effect: "external", risk: riskOf("R3"),
  async run(i, ctx, deps) {
    const r = await needReview(deps, ctx, i.order_id, ["none"]);
    const conn = connectorOf(deps.sims, r.vendor as "checkr");
    const items = await conn.listAdverseItems(r.vendorReportId!);
    const postNoticeAt = finalNotAllowedBefore(ctx.now);
    const { vendorAdverseId } = await conn.startPreAdverse(r.vendorReportId!, items.map((x) => x.id), postNoticeAt);
    await linkAdverse(deps.tx, (p) => deps.newId(p), r, vendorAdverseId, ctx.now);
    await deps.tx.update(screeningOrders).set({ adjudication: "pre_adverse" }).where(eq(screeningOrders.id, r.id));
    const next = { ...r, adjudication: "pre_adverse" };
    const synced = await applyVendorSnapshot(deps, next, ctx.now);
    return { data: { order_id: r.id, adjudication: "pre_adverse", final_not_before: postNoticeAt, item_count: items.length }, summary: `Pre-adverse notice started for ${r.id}; final step not before ${ptDateOf(postNoticeAt)}`, events: [statusEvent(r, synced.next.status), ...synced.events] };
  },
});

export const sendFinalAdverse = writeCommand({
  name: "screening.send_final_adverse", summary: "Record the final adverse decision (people only).",
  description: "Human only: records the final adverse decision for order_id after the waiting period. Refused while the timer is paused by a dispute. The offer and onboarding are not ended automatically.",
  input: OrderIdInput, ...humanOnly, effect: "write", risk: riskOf("R3"),
  async run(i, ctx, deps) {
    let r = await needReview(deps, ctx, i.order_id, ["pre_adverse"]);
    r = (await applyVendorSnapshot(deps, r, ctx.now)).next;
    if (r.timerPaused || r.status === "disputed") throw new DomainRefusal("DOMAIN_SCREENING_TIMER_PAUSED", `${r.id} is disputed; the waiting period is paused`, "Wait for the dispute to finish", null);
    const link = await openAdverse(deps.tx, r);
    const notBefore = link ? finalNotAllowedBefore(link.createdAt) : ctx.now;
    if (ctx.now < notBefore) throw new DomainRefusal("DOMAIN_SCREENING_WAITING_PERIOD", `The waiting period for ${r.id} ends ${notBefore}`, `Wait until ${ptDateOf(notBefore)}`, null);
    await deps.tx.update(screeningOrders).set({ adjudication: "post_adverse" }).where(eq(screeningOrders.id, r.id));
    const next = { ...r, adjudication: "post_adverse" };
    return { data: { order_id: r.id, adjudication: "post_adverse" }, summary: `Final adverse decision recorded for ${r.id}; void the offer or start offboarding separately`, events: [statusEvent(r, r.status), ...(await syncBackgroundTask(deps.tx, next, ctx.now))] };
  },
});

export const cancelAdverse = writeCommand({
  name: "screening.cancel_adverse", summary: "Withdraw a pre-adverse notice and proceed (people only).",
  description: "Human only: cancels the open adverse action for order_id (for example after the candidate's response) and proceeds with the hire. The background_check task completes.",
  input: OrderIdInput, ...humanOnly, effect: "external", risk: riskOf("R3"),
  async run(i, ctx, deps) {
    const r = await needReview(deps, ctx, i.order_id, ["pre_adverse"]);
    const link = await openAdverse(deps.tx, r);
    if (!link) throw new DomainRefusal("DOMAIN_SCREENING_STEP", `${r.id} has no open adverse action`, null, null);
    await connectorOf(deps.sims, r.vendor as "checkr").cancelAdverse(link.extId);
    const { extLinks } = await import("@weft/db");
    await deps.tx.update(extLinks).set({ status: "canceled", updatedAt: ctx.now }).where(eq(extLinks.id, link.id));
    await deps.tx.update(screeningOrders).set({ adjudication: "engaged" }).where(eq(screeningOrders.id, r.id));
    const next = { ...r, adjudication: "engaged" };
    return { data: { order_id: r.id, adjudication: "engaged" }, summary: `Adverse action withdrawn for ${r.id}; proceeding with the hire`, events: [statusEvent(r, r.status), ...(await syncBackgroundTask(deps.tx, next, ctx.now))] };
  },
});

export const proceedToCriminal = writeCommand({
  name: "screening.proceed_to_criminal", summary: "NYC: start the criminal check after the non-criminal results (people only).",
  description: "Human only, New York City hires: after a person has evaluated the clear non-criminal results of order_id, orders the criminal phase package (price from the catalog).",
  input: OrderIdInput, ...humanOnly, effect: "external", risk: riskOf("R3"),
  async run(i, ctx, deps) {
    const r = await loadOrder(deps.tx, ctx.companyId, i.order_id);
    if (r.phase !== "non_criminal" || r.status !== "complete_clear") throw new DomainRefusal("DOMAIN_SCREENING_STEP", `${r.id} is a ${r.phase} order and ${r.status}`, "Proceed only from a clear non-criminal order", null);
    const existing = (await deps.tx.select().from(screeningOrders).where(and(eq(screeningOrders.offerId, r.offerId), eq(screeningOrders.phase, "criminal")))).filter((x) => x.status !== "canceled" && x.status !== "expired");
    if (existing.length) throw new DomainRefusal("DOMAIN_SCREENING_EXISTS", `Criminal phase ${existing[0]!.id} already exists`, null, null);
    const o = await acceptedOffer(deps.tx, ctx.companyId, r.offerId);
    const loc = await workLocationOf(deps.tx, o);
    const pkg = await defaultPackage(deps.tx, r.vendor as "checkr", "criminal");
    const conn = connectorOf(deps.sims, r.vendor as "checkr");
    const id = await deps.newId("scr_");
    const res = await conn.createOrder({ orderId: id, candidate: { first: o.candidateFirst, last: o.candidateLast, email: o.candidateEmail }, packageSlug: pkg.slug, workLocation: { country: loc.country, state: loc.state, city: loc.city } });
    await deps.tx.insert(screeningOrders).values({
      id, companyId: ctx.companyId, offerId: o.id, workerId: o.workerId, vendor: r.vendor, mode: r.mode, packageSlug: pkg.slug, priceCents: pkg.priceCents, phase: "criminal", status: res.status, result: null, adjudication: "none",
      timerPaused: false, vendorCandidateId: res.vendorCandidateId, vendorOrderId: res.vendorOrderId, vendorReportId: null, applyUrl: res.applyUrl, etaOn: null, lastPolledAt: ctx.now, createdAt: ctx.now, completedAt: null, proposalId: null, actionSeq: null,
    });
    await ensureBackgroundTask(deps.tx, (p) => deps.newId(p), o.workerId, o.startDate);
    return { data: { order_id: id, previous_order_id: r.id, phase: "criminal", status: res.status, price_cents: pkg.priceCents }, summary: `Criminal phase ${id} ordered for ${displayName(o.candidateFirst, o.candidateLast)} at ${formatCents(pkg.priceCents)}`, moneyCents: pkg.priceCents, events: [statusEvent({ id } as OrderRow, res.status)] };
  },
});

// ---- e-signature envelopes (WEFT_ESIGN=docusign only; the built-in click to sign has no envelope) ----------------
export const getEnvelope = readCommand({
  name: "documents.get_envelope", summary: "E-signature envelope status for an offer.",
  description: "The e-signature envelope for offer_id when the offer went out through the e-signature connector: provider, status (sent, delivered, completed, declined, voided) and timestamps. Offers signed in the portal's built-in flow have none.",
  input: z.object({ offer_id: z.string() }), domain: "people",
  async run(i, ctx, deps) {
    const e = await envelopeOfOffer(deps.tx, i.offer_id);
    if (!e || e.companyId !== ctx.companyId) return { data: { offer_id: i.offer_id, envelope: null as Record<string, string | null> | null }, summary: `Offer ${i.offer_id} uses built-in signing` };
    return { data: { offer_id: i.offer_id, envelope: { id: e.id, provider: e.provider, mode: e.mode, status: e.status, sent_at: e.sentAt, delivered_at: e.deliveredAt, completed_at: e.completedAt, voided_at: e.voidedAt } }, summary: `Envelope ${e.id} is ${e.status}` };
  },
});

export const applyEsignEvent = writeCommand({
  name: "documents.apply_esign_event", summary: "System: apply an e-signature envelope update.",
  description: "System command (svc_events, svc_scheduler): re-reads envelope_id from the e-signature connector and applies it: delivered marks the offer viewed, completed accepts it once with provider evidence, declined ends it declined. Never reads a webhook body.",
  input: W3EsignApplyInput, domain: "people", needs: "edit", effect: "write", risk: riskOf("R1"), approval: "never", access: "system_only", reversible: false, preview: null,
  lease: (i) => `envelope:${i.envelope_id}`,
  async run(i, ctx, deps) {
    const [e] = await deps.tx.select().from(esignEnvelopes).where(and(eq(esignEnvelopes.provider, "docusign"), eq(esignEnvelopes.envelopeId, i.envelope_id))).limit(1);
    if (!e || e.companyId !== ctx.companyId) return { data: { matched: false }, summary: `No envelope ${i.envelope_id}` };
    const r = await applyEnvelope(deps, ctx, e, { accept: acceptFromEnvelope });
    return { data: { matched: true, envelope_id: e.id, status: r.status, previous_status: r.previous, offer_status: r.offerStatus }, summary: `Envelope ${e.id}: ${r.previous} to ${r.status} (offer ${r.offerStatus})`, events: r.events };
  },
});

export const screeningCommands: WeftCommand[] = [
  getEnvelope, applyEsignEvent,
  listPackages, getStatus, orderScreening, cancelScreening, applyVendorEvent,
  reviewScreening, engageScreening, startPreAdverse, sendFinalAdverse, cancelAdverse, proceedToCriminal,
];
