// Screening orders (w3-integrations-screening-esign, docs/wave3.md 3.2, research/wave3/integrations-screening-esign.md 5.4).
// Shared helpers for the screening commands: vendor choice, the conditional-offer gate, packages priced from the DB,
// work location, the agent-safe view (status, result, ETA, timestamps; never record text) and the background_check task.
import { and, eq, inArray, or } from "drizzle-orm";
import type { ScreeningConnector, ScreeningStatus, Simulators } from "@weft/contracts";
import { events as eventRows, extLinks, offers, onboardingTasks, screeningOrders, screeningPackages, workplaces, type DbTx } from "@weft/db";
import type { W3ScreeningAdjudicateStep, W3ScreeningOrderView } from "../../../contracts/src/ext/w3-integrations-screening-esign";
import { W3_SCREENING_WAITING_DAYS } from "../../../contracts/src/ext/w3-integrations-screening-esign";
import { DomainRefusal, notFound } from "../demo/define";

export type OrderRow = typeof screeningOrders.$inferSelect;
export type PackageRow = typeof screeningPackages.$inferSelect;
export type ScreeningVendor = "checkr" | "hireright";
type Event = { type: string; subjectRef: string; payload: Record<string, string> };

/** WEFT_SCREENING=hireright picks the HireRight connector; everything else (sim, checkr, unset) is Checkr. */
export function screeningVendor(env: Record<string, string | undefined> = process.env): ScreeningVendor {
  return env.WEFT_SCREENING === "hireright" ? "hireright" : "checkr";
}
export const connectorOf = (sims: Simulators, vendor: ScreeningVendor): ScreeningConnector => sims.vendors[vendor];

/** Final for a new order: a canceled or expired order may be replaced. */
export const REPLACEABLE: ScreeningStatus[] = ["canceled", "expired"];
const NYC_CITIES = new Set(["new york", "brooklyn", "queens", "bronx", "the bronx", "staten island", "manhattan"]);

export async function acceptedOffer(tx: DbTx, companyId: string, offerId: string) {
  const [o] = await tx.select().from(offers).where(and(eq(offers.companyId, companyId), eq(offers.id, offerId))).limit(1);
  if (!o) throw notFound("offer", offerId);
  // The accepted (signed) offer is the conditional offer: the strictest rule across CA, NYC, Austin and CO, applied everywhere.
  if (o.status !== "accepted" || !o.workerId) {
    throw new DomainRefusal("DOMAIN_SCREENING_BEFORE_OFFER", `Offer ${o.id} is ${o.status}; a background check may run only after the offer is accepted`, "Wait for offer.accepted, then propose screening.order", null);
  }
  return { ...o, workerId: o.workerId };
}

export async function workLocationOf(tx: DbTx, o: { workplaceId: string; workState: string }) {
  const [wp] = await tx.select().from(workplaces).where(eq(workplaces.id, o.workplaceId)).limit(1);
  const state = wp?.state ?? o.workState;
  if (!state) throw new DomainRefusal("DOMAIN_SCREENING_NO_LOCATION", "The offer has no work state", "Set the work state on the offer", null);
  const city = wp?.city ?? null;
  return { country: "US", state, city, nyc: state === "NY" && city !== null && NYC_CITIES.has(city.toLowerCase()) };
}

export async function packageRow(tx: DbTx, vendor: ScreeningVendor, slug: string): Promise<PackageRow> {
  const [p] = await tx.select().from(screeningPackages).where(and(eq(screeningPackages.vendor, vendor), eq(screeningPackages.slug, slug))).limit(1);
  if (!p) throw new DomainRefusal("DOMAIN_SCREENING_UNKNOWN_PACKAGE", `No ${vendor} package ${slug}`, "Use a slug from screening.list_packages", null);
  return p;
}
export async function defaultPackage(tx: DbTx, vendor: ScreeningVendor, phase: "full" | "non_criminal" | "criminal"): Promise<PackageRow> {
  const rows = (await tx.select().from(screeningPackages).where(and(eq(screeningPackages.vendor, vendor), eq(screeningPackages.phase, phase)))).sort((a, b) => a.priceCents - b.priceCents || (a.slug < b.slug ? -1 : 1));
  if (!rows[0]) throw new DomainRefusal("DOMAIN_SCREENING_UNKNOWN_PACKAGE", `No ${vendor} package for the ${phase} phase`, null, null);
  return rows[0];
}

export async function openOrders(tx: DbTx, offerId: string): Promise<OrderRow[]> {
  return (await tx.select().from(screeningOrders).where(eq(screeningOrders.offerId, offerId))).filter((r) => !REPLACEABLE.includes(r.status as ScreeningStatus));
}

export async function loadOrder(tx: DbTx, companyId: string, id: string): Promise<OrderRow> {
  const [r] = await tx.select().from(screeningOrders).where(and(eq(screeningOrders.companyId, companyId), eq(screeningOrders.id, id))).limit(1);
  if (!r) throw notFound("screening order", id);
  return r;
}
export async function orderByVendorRef(tx: DbTx, vendor: ScreeningVendor, ref: string): Promise<OrderRow | null> {
  const [r] = await tx.select().from(screeningOrders).where(and(eq(screeningOrders.vendor, vendor), or(eq(screeningOrders.vendorOrderId, ref), eq(screeningOrders.vendorReportId, ref)))).limit(1);
  return r ?? null;
}

/** The human steps open on an order right now (shown in the hiring view; each is a human_only command). */
export function nextSteps(r: OrderRow): W3ScreeningAdjudicateStep[] {
  const out: W3ScreeningAdjudicateStep[] = [];
  if (r.phase === "non_criminal" && r.status === "complete_clear") out.push("proceed_to_criminal");
  if (r.status === "complete_review" && r.adjudication === "none") out.push("engage", "pre_adverse");
  if ((r.status === "complete_review" || r.status === "disputed") && r.adjudication === "pre_adverse") out.push("final_adverse", "cancel_adverse");
  return out;
}

/** The only shape any reader gets: no vendor ids, no apply link, no record text. */
export function orderView(r: OrderRow, packageName: string): W3ScreeningOrderView {
  return {
    id: r.id, offerId: r.offerId, workerId: r.workerId, vendor: r.vendor as ScreeningVendor, mode: r.mode as "simulated" | "real", packageSlug: r.packageSlug, packageName,
    priceCents: r.priceCents, phase: r.phase as W3ScreeningOrderView["phase"], status: r.status as ScreeningStatus, result: (r.result as "clear" | "consider" | null) ?? null,
    adjudication: r.adjudication as W3ScreeningOrderView["adjudication"], timerPaused: r.timerPaused, etaOn: r.etaOn, createdAt: r.createdAt, completedAt: r.completedAt,
    reviewRequired: r.status === "complete_review" && r.adjudication !== "engaged", nextSteps: nextSteps(r),
  };
}
export async function orderViews(tx: DbTx, rows: OrderRow[]): Promise<W3ScreeningOrderView[]> {
  const names = new Map((await tx.select().from(screeningPackages)).map((p) => [`${p.vendor}:${p.slug}`, p.name]));
  return rows.map((r) => orderView(r, names.get(`${r.vendor}:${r.packageSlug}`) ?? r.packageSlug));
}

// ---- the background_check onboarding task ----------------------------------------------------------------
export async function ensureBackgroundTask(tx: DbTx, newId: (p: "obt_") => Promise<string>, workerId: string, dueOn: string | null) {
  const [t] = await tx.select().from(onboardingTasks).where(and(eq(onboardingTasks.workerId, workerId), eq(onboardingTasks.kind, "background_check"))).limit(1);
  if (t) { if (t.status !== "done") await tx.update(onboardingTasks).set({ status: "pending", blockedReason: null }).where(eq(onboardingTasks.id, t.id)); return; }
  // Owner agent: it never gates activation (completePortalTask counts employee tasks) or the first payroll.
  await tx.insert(onboardingTasks).values({ id: await newId("obt_"), workerId, kind: "background_check", status: "pending", owner: "agent", dueOn, doneAt: null, blockedReason: null });
}

/** Sets the task from the order; returns the events (task completed, and onboarding completed once, as complete_task does). */
export async function syncBackgroundTask(tx: DbTx, r: OrderRow, now: string): Promise<Event[]> {
  if (!r.workerId) return [];
  const [t] = await tx.select().from(onboardingTasks).where(and(eq(onboardingTasks.workerId, r.workerId), eq(onboardingTasks.kind, "background_check"))).limit(1);
  if (!t || t.status === "done") return [];
  const done = (r.status === "complete_clear" && r.phase !== "non_criminal") || r.adjudication === "engaged";
  if (!done) {
    const reason = r.status === "complete_review" ? (r.adjudication === "none" ? "Waiting on a person: review required" : `Waiting on a person: ${r.adjudication.replace("_", "-")} notice`)
      : r.phase === "non_criminal" && r.status === "complete_clear" ? "Waiting on a person: proceed to the criminal check"
      : r.status === "suspended" ? "Waiting on the screening company: more information needed" : r.status === "disputed" ? "Paused: the candidate disputed the report"
      : r.status === "expired" ? "The invitation expired" : r.status === "canceled" ? "The order was canceled" : null;
    const status = reason ? "blocked" : "pending";
    if (t.status !== status || t.blockedReason !== reason) await tx.update(onboardingTasks).set({ status, blockedReason: reason }).where(eq(onboardingTasks.id, t.id));
    return [];
  }
  await tx.update(onboardingTasks).set({ status: "done", doneAt: now, blockedReason: null }).where(eq(onboardingTasks.id, t.id));
  const evts: Event[] = [{ type: "onboarding.task_completed", subjectRef: r.workerId, payload: { worker_id: r.workerId, kind: "background_check" } }];
  const all = await tx.select().from(onboardingTasks).where(eq(onboardingTasks.workerId, r.workerId));
  if (all.every((x) => x.id === t.id || x.status === "done")) {
    const already = (await tx.select({ id: eventRows.id }).from(eventRows).where(and(eq(eventRows.type, "worker.onboarding_completed"), eq(eventRows.subjectRef, r.workerId))).limit(1)).length > 0;
    if (!already) evts.push({ type: "worker.onboarding_completed", subjectRef: r.workerId, payload: { worker_id: r.workerId } });
  }
  return evts;
}

// ---- adverse action bookkeeping (ext_links: one Weft order per vendor adverse action) ----------------------
export async function linkAdverse(tx: DbTx, newId: (p: "extl_") => Promise<string>, r: OrderRow, vendorAdverseId: string, now: string) {
  await tx.insert(extLinks).values({ id: await newId("extl_"), companyId: r.companyId, vendor: r.vendor, extType: "adverse_action", extId: vendorAdverseId, weftType: "screening_order", weftId: r.id, extVersion: null, status: "linked", createdAt: now, updatedAt: now });
}
export async function openAdverse(tx: DbTx, r: OrderRow) {
  const rows = await tx.select().from(extLinks).where(and(eq(extLinks.weftType, "screening_order"), eq(extLinks.weftId, r.id), eq(extLinks.extType, "adverse_action"), inArray(extLinks.status, ["linked"])));
  return rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0] ?? null;
}
/** Business days added to the waiting period for each dispute (California's 5 business days, applied everywhere). */
export const DISPUTE_EXTENSION_BUSINESS_DAYS = 5;
const PT_WEEKDAY = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short" });
/** Adds n business days (Monday to Friday by the PT calendar) in whole 24 hour steps. */
export function addBusinessDaysPt(iso: string, n: number): string {
  let t = Date.parse(iso);
  for (let left = n; left > 0;) {
    t += 86_400_000;
    const day = PT_WEEKDAY.format(new Date(t));
    if (day !== "Sat" && day !== "Sun") left -= 1;
  }
  return new Date(t).toISOString();
}
/** The earliest instant the final step may run: the pre-adverse time plus the waiting period, plus 5 business days per dispute. */
export function finalNotAllowedBefore(preAdverseAt: string, disputes = 0): string {
  let t = new Date(Date.parse(preAdverseAt) + W3_SCREENING_WAITING_DAYS * 86_400_000).toISOString();
  for (let k = 0; k < disputes; k++) t = addBusinessDaysPt(t, DISPUTE_EXTENSION_BUSINESS_DAYS);
  return t;
}
/**
 * How many times the order entered the disputed state since `since` (the pre-adverse time), read from the order's
 * screening.status_changed events. Repeated disputed events without a status in between count once.
 */
export async function disputesSince(tx: DbTx, orderId: string, since: string): Promise<number> {
  const rows = await tx.select({ ts: eventRows.ts, payloadJson: eventRows.payloadJson }).from(eventRows)
    .where(and(eq(eventRows.type, "screening.status_changed"), eq(eventRows.subjectRef, orderId)));
  let n = 0;
  let prev: string | null = null;
  for (const r of rows.filter((x) => x.ts >= since).sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))) {
    const status = (JSON.parse(r.payloadJson) as { status?: string }).status ?? null;
    if (status === "disputed" && prev !== "disputed") n += 1;
    prev = status;
  }
  return n;
}
