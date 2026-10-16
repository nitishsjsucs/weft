// Simulated Checkr (screening) for wave 3 (docs/wave3.md, research/wave3/integrations-screening-esign.md 2 and 6.3).
// Owner: w3-integrations-screening-esign. Follows the published shapes for the subset Weft uses (candidates, invitations,
// reports, adverse actions, webhook events) with Checkr's enums; field names only, no copied prose. Writes only
// sim_vendor_records and sim_webhook_outbox, reads the sim clock and checks the fault injector. Webhook bodies are signed
// like Checkr's (hex HMAC-SHA256 over the compact body, header X-Checkr-Signature) with a sim key, so every delivery goes
// through the same verification code as a real one. The shared engine below also backs the HireRight simulator.
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, asc, eq, lte } from "drizzle-orm";
import type { ConnectorStatus, FaultInjector, ScreeningConnector, ScreeningPackage, ScreeningSnapshot, ScreeningStatus, SimClock, WebhookVerdict } from "@weft/contracts";
import { simVendorRecords, simWebhookOutbox, type DbTx } from "@weft/db";
import type { W3ScreeningSimControls, W3VendorSimDelivery } from "../../../contracts/src/ext/w3-integrations-screening-esign";
import { mintId, seqOf } from "../ids";
import { addBusinessDays, addDays, ptDate } from "../time";

/** The sim's webhook signing key. Not a secret: it exists only so the verification path runs on every delivery. */
export const CHECKR_SIM_WEBHOOK_KEY = "weft-sim-checkr-webhook-key-not-a-secret";
export const CHECKR_SIGNATURE_HEADER = "x-checkr-signature";
/** Planted on every synthetic adverse item so tests can prove no agent read ever carries record text. */
export const SIM_RECORD_MARKER = "SIMULATED RECORD (fictional)";

/** Synthetic catalog in Checkr's package shape (slug, name, price in cents, screenings). Prices are invented. */
export const CHECKR_SIM_PACKAGES: ScreeningPackage[] = [
  { slug: "weft_standard_sim", name: "Standard (sim)", priceCents: 3_500, screenings: ["ssn_trace", "sex_offender_search", "national_criminal_search", "county_criminal_search"], phase: "full" },
  { slug: "weft_standard_mvr_sim", name: "Standard plus MVR (sim)", priceCents: 5_500, screenings: ["ssn_trace", "sex_offender_search", "national_criminal_search", "county_criminal_search", "motor_vehicle_report"], phase: "full" },
  { slug: "weft_nyc_noncriminal_sim", name: "NYC non-criminal (sim)", priceCents: 2_000, screenings: ["ssn_trace", "employment_verification", "education_verification"], phase: "non_criminal" },
  { slug: "weft_nyc_criminal_sim", name: "NYC criminal (sim)", priceCents: 2_500, screenings: ["national_criminal_search", "county_criminal_search"], phase: "criminal" },
];

type Rec = Record<string, unknown> & { id: string; _sim?: SimState };
interface SimState { fault?: string | null; dueAt?: string | null; disputeUntil?: string | null; invitationId?: string; reportId?: string | null }
const INVITE_DAYS = 7;

export interface ScreeningSimFlavor {
  vendor: "checkr" | "hireright";
  key: string; header: string; packages: ScreeningPackage[];
  /** Webhook body in the vendor's shape (Checkr) or Weft's normalized shape (HireRight, whose API is not published). */
  eventBody(e: { id: string; type: string; createdAt: string; object: Record<string, unknown> }): Record<string, unknown>;
  parse(body: Record<string, unknown>): { dedupeKey: string; vendorOrderId: string; kind: string } | null;
  detail: string | null;
}

const checkrFlavor: ScreeningSimFlavor = {
  vendor: "checkr", key: CHECKR_SIM_WEBHOOK_KEY, header: CHECKR_SIGNATURE_HEADER, packages: CHECKR_SIM_PACKAGES, detail: null,
  eventBody: (e) => ({ id: e.id, object: "event", type: e.type, created_at: e.createdAt, webhook_url: "http://127.0.0.1/v1/integrations/checkr/webhook", data: { object: e.object } }),
  parse: (b) => {
    const obj = ((b.data as { object?: Record<string, unknown> } | undefined)?.object ?? {}) as Record<string, unknown>;
    if (typeof b.id !== "string" || typeof b.type !== "string") return null;
    const ref = obj.object === "adverse_action" ? obj.report_id : obj.id;
    return typeof ref === "string" ? { dedupeKey: b.id, vendorOrderId: ref, kind: b.type } : null;
  },
};

const sign = (key: string, raw: string | Uint8Array) => createHmac("sha256", key).update(raw).digest("hex");
const eqHex = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const lower = (h: Record<string, string>) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));

/** Checkr's report status, result and adjudication folded into Weft's normalized status (research 6.2 mapping). */
export function normalizeCheckr(inv: Rec | null, rpt: Rec | null): ScreeningStatus {
  if (rpt) {
    const s = rpt.status;
    if (s === "suspended") return "suspended";
    if (s === "dispute") return "disputed";
    if (s === "canceled") return "canceled";
    if (s === "complete") return rpt.result === "consider" ? "complete_review" : "complete_clear";
    return "in_progress";
  }
  if (inv?.status === "expired") return "expired";
  if (inv?.status === "deleted") return "canceled";
  if (inv?.status === "completed") return "consented";
  return "invited";
}
const ADJ: Record<string, ScreeningSnapshot["adjudication"]> = { engaged: "engaged", pre_adverse_action: "pre_adverse", post_adverse_action: "post_adverse" };

export function createScreeningSimEngine(db: DbTx, clock: SimClock, faults: FaultInjector, flavor: ScreeningSimFlavor): ScreeningConnector & W3ScreeningSimControls {
  const V = flavor.vendor;
  const get = async (kind: string, extId: string): Promise<Rec | null> => {
    const [r] = await db.select().from(simVendorRecords).where(and(eq(simVendorRecords.vendor, V), eq(simVendorRecords.kind, kind), eq(simVendorRecords.extId, extId))).limit(1);
    return r ? (JSON.parse(r.bodyJson) as Rec) : null;
  };
  const all = async (kind: string): Promise<Rec[]> => (await db.select().from(simVendorRecords).where(and(eq(simVendorRecords.vendor, V), eq(simVendorRecords.kind, kind))).orderBy(asc(simVendorRecords.id))).map((r) => JSON.parse(r.bodyJson) as Rec);
  const put = async (kind: string, body: Rec) => {
    const now = clock.now();
    const [r] = await db.select({ id: simVendorRecords.id, version: simVendorRecords.version }).from(simVendorRecords).where(and(eq(simVendorRecords.vendor, V), eq(simVendorRecords.kind, kind), eq(simVendorRecords.extId, body.id))).limit(1);
    if (r) await db.update(simVendorRecords).set({ bodyJson: JSON.stringify(body), version: r.version + 1, updatedAt: now }).where(eq(simVendorRecords.id, r.id));
    else await db.insert(simVendorRecords).values({ id: await mintId(db, "simx_"), vendor: V, kind, extId: body.id, version: 1, bodyJson: JSON.stringify(body), createdAt: now, updatedAt: now });
  };
  const newExt = async (tag: string) => `sim_${tag}_${String(seqOf(await mintId(db, "simx_"))).padStart(6, "0")}`;
  const publicView = (r: Rec) => { const { _sim, ...rest } = r; void _sim; return rest; };
  const emit = async (type: string, object: Rec) => {
    const id = await newExt("evt");
    const raw = JSON.stringify(flavor.eventBody({ id, type, createdAt: clock.now(), object: publicView(object) }));
    await db.insert(simWebhookOutbox).values({ id: await mintId(db, "simo_"), vendor: V, dedupeKey: id, bodyJson: raw, signature: sign(flavor.key, raw), attempt: 0, nextAt: clock.now(), status: "pending", deliveredAt: null });
  };
  const fired = async (target: `${string}.${string}`) => (await faults.check(target)).fire;
  const resolve = async (id: string): Promise<{ inv: Rec | null; rpt: Rec | null }> => {
    let inv = await get("invitation", id), rpt: Rec | null = null;
    if (inv) rpt = inv.report_id ? await get("report", String(inv.report_id)) : null;
    else { rpt = await get("report", id); inv = rpt?._sim?.invitationId ? await get("invitation", rpt._sim.invitationId) : null; }
    return { inv, rpt };
  };
  const completeReport = async (rpt: Rec, now: string) => {
    const consider = rpt._sim?.fault === "consider";
    rpt.status = "complete"; rpt.result = consider ? "consider" : "clear"; rpt.completed_at = now;
    if (consider) {
      const itemId = await newExt("adi");
      await put("adverse_item", { id: itemId, object: "adverse_item", report_id: rpt.id, text: `${SIM_RECORD_MARKER}: county record, Example County, 2015 (demo data, not a real person)`, assessment: null });
      rpt.adverse_item_ids = [itemId];
    }
    await put("report", rpt);
    await emit("report.completed", rpt);
  };

  return {
    simulated: true,
    async status(): Promise<ConnectorStatus> {
      return { vendor: V, category: "screening", mode: "simulated", configured: false, lastSyncAt: null, cursor: null, health: "ok", detail: flavor.detail };
    },
    async listPackages() { return flavor.packages.map((p) => ({ ...p, screenings: [...p.screenings] })); },
    async createOrder(i) {
      const pkg = flavor.packages.find((p) => p.slug === i.packageSlug);
      if (!pkg) throw new Error(`${V} simulator: unknown package ${i.packageSlug}`);
      if (!i.workLocation.state) throw new Error(`${V} simulator: work_locations[].state is required for US candidates`);
      const now = clock.now();
      const fault = (await fired(`${V}.expire`)) ? "expire" : (await fired(`${V}.consider`)) ? "consider" : (await fired(`${V}.suspended`)) ? "suspended" : (await fired(`${V}.dispute`)) ? "dispute" : null;
      const candidateId = await newExt("cand");
      await put("candidate", { id: candidateId, object: "candidate", first_name: i.candidate.first, last_name: i.candidate.last, email: i.candidate.email, created_at: now, work_locations: [{ country: i.workLocation.country, state: i.workLocation.state, city: i.workLocation.city }] });
      const invId = await newExt("inv");
      const inv: Rec = {
        id: invId, object: "invitation", uri: `/v1/invitations/${invId}`, invitation_url: `/portal#screening-apply`, status: "pending",
        created_at: now, expires_at: `${addDays(ptDate(now), INVITE_DAYS + 1)}T06:59:59.000Z`, completed_at: null, deleted_at: null,
        package: pkg.slug, candidate_id: candidateId, report_id: null, work_locations: [{ country: i.workLocation.country, state: i.workLocation.state, city: i.workLocation.city }],
        _sim: { fault, invitationId: invId, reportId: null },
      };
      await put("invitation", inv);
      await emit("invitation.created", inv);
      return { vendorCandidateId: candidateId, vendorOrderId: invId, applyUrl: String(inv.invitation_url), status: "invited" as const };
    },
    async getOrder(id) {
      const { inv, rpt } = await resolve(id);
      if (!inv && !rpt) throw new Error(`${V} simulator: no order ${id}`);
      const eta = rpt && rpt.status === "pending" && typeof rpt.estimated_completion_time === "string" ? ptDate(rpt.estimated_completion_time) : null;
      return {
        status: normalizeCheckr(inv, rpt), result: (rpt?.result as "clear" | "consider" | null | undefined) ?? null,
        adjudication: ADJ[String(rpt?.adjudication ?? "")] ?? "none", etaOn: eta,
        completedAt: (rpt?.completed_at as string | null | undefined) ?? null, vendorReportId: rpt?.id ?? null,
      };
    },
    async cancelOrder(id) {
      const { inv, rpt } = await resolve(id);
      if (rpt && rpt.status === "pending") { rpt.status = "canceled"; await put("report", rpt); await emit("report.canceled", rpt); return; }
      if (inv && inv.status === "pending") { inv.status = "deleted"; inv.deleted_at = clock.now(); await put("invitation", inv); await emit("invitation.deleted", inv); return; }
      throw new Error(`${V} simulator: order ${id} cannot be canceled now`);
    },
    // Human-only path: the only place record text exists.
    async listAdverseItems(reportId) {
      const rpt = await get("report", reportId);
      if (!rpt || rpt.result !== "consider") return [];
      return (await all("adverse_item")).filter((a) => a.report_id === reportId).map((a) => ({ id: a.id, text: String(a.text) }));
    },
    async startPreAdverse(reportId, itemIds, postNoticeAt) {
      const rpt = await get("report", reportId);
      if (!rpt || rpt.status !== "complete" || rpt.result !== "consider") throw new Error(`${V} simulator: report ${reportId} has no adverse items to act on`);
      const now = clock.now();
      const id = await newExt("aa");
      const disputed = rpt._sim?.fault === "dispute";
      const aa: Rec = { id, object: "adverse_action", uri: `/v1/adverse_actions/${id}`, status: disputed ? "dispute" : "pending", report_id: reportId, created_at: now, post_notice_scheduled_at: postNoticeAt, post_notice_ready_at: postNoticeAt, canceled_at: null, adverse_item_ids: [...itemIds], individualized_assessment_engaged: false };
      await put("adverse_action", aa);
      rpt.adjudication = "pre_adverse_action";
      if (disputed) { rpt.status = "dispute"; rpt._sim = { ...rpt._sim, disputeUntil: addBusinessDays(now, 5) }; }
      await put("report", rpt);
      await emit("adverse_action.created", aa);
      if (disputed) await emit("report.disputed", rpt);
      return { vendorAdverseId: id };
    },
    async cancelAdverse(adverseId) {
      const aa = await get("adverse_action", adverseId);
      if (!aa || aa.status === "complete" || aa.status === "canceled") throw new Error(`${V} simulator: adverse action ${adverseId} is not open`);
      aa.status = "canceled"; aa.canceled_at = clock.now();
      await put("adverse_action", aa);
      const rpt = await get("report", String(aa.report_id));
      if (rpt) { rpt.adjudication = "engaged"; await put("report", rpt); }
      await emit("adverse_action.canceled", aa);
    },
    verifyWebhook(raw: Uint8Array, headers: Record<string, string>): WebhookVerdict {
      const got = lower(headers)[flavor.header];
      if (!got || !eqHex(sign(flavor.key, raw), got.trim().toLowerCase())) return { ok: false, dedupeKey: null };
      try { return { ok: true, dedupeKey: flavor.parse(JSON.parse(Buffer.from(raw).toString("utf8")))?.dedupeKey ?? null }; } catch { return { ok: false, dedupeKey: null }; }
    },
    parseWebhook(raw: Uint8Array) {
      try { const p = flavor.parse(JSON.parse(Buffer.from(raw).toString("utf8"))); return p ? [p] : []; } catch { return []; }
    },
    // ---- simulator controls (the vendor's side) ----
    async consent(vendorOrderId, typedName) {
      const inv = await get("invitation", vendorOrderId);
      if (!inv) throw new Error(`${V} simulator: no invitation ${vendorOrderId}`);
      if (inv.status !== "pending") throw new Error(`${V} simulator: invitation ${vendorOrderId} is ${String(inv.status)}`);
      if (typedName.trim().length < 2) throw new Error(`${V} simulator: type your full name to authorize`);
      const now = clock.now();
      const rid = await newExt("rpt");
      const due = addBusinessDays(now, 1);
      const rpt: Rec = { id: rid, object: "report", uri: `/v1/reports/${rid}`, status: "pending", result: null, adjudication: null, assessment: null, package: inv.package, candidate_id: inv.candidate_id, created_at: now, completed_at: null, estimated_completion_time: due, includes_canceled: false, _sim: { fault: inv._sim?.fault ?? null, dueAt: due, invitationId: inv.id } };
      inv.status = "completed"; inv.completed_at = now; inv.report_id = rid;
      await put("invitation", inv);
      await put("report", rpt);
      await emit("invitation.completed", inv);
      await emit("report.created", rpt);
    },
    async advance(now) {
      let n = 0;
      for (const inv of await all("invitation")) {
        if (inv.status !== "pending") continue;
        if (inv._sim?.fault === "expire" || now > String(inv.expires_at)) { inv.status = "expired"; await put("invitation", inv); await emit("invitation.expired", inv); n++; }
      }
      for (const rpt of await all("report")) {
        if (rpt.status === "pending" && rpt._sim?.dueAt && now >= rpt._sim.dueAt) {
          if (rpt._sim.fault === "suspended") { rpt.status = "suspended"; await put("report", rpt); await emit("report.suspended", rpt); }
          else await completeReport(rpt, now);
          n++;
        } else if (rpt.status === "dispute" && rpt._sim?.disputeUntil && now >= rpt._sim.disputeUntil) {
          rpt.status = "complete"; rpt._sim = { ...rpt._sim, disputeUntil: null, fault: null };
          await put("report", rpt); await emit("report.dispute_completed", rpt);
          for (const aa of (await all("adverse_action")).filter((a) => a.report_id === rpt.id && a.status === "dispute")) {
            aa.status = "pending"; aa.post_notice_ready_at = addBusinessDays(String(aa.post_notice_ready_at), 5);
            await put("adverse_action", aa); await emit("adverse_action.resumed", aa);
          }
          n++;
        }
      }
      for (const aa of await all("adverse_action")) {
        if (aa.status === "pending" && now >= String(aa.post_notice_ready_at)) {
          aa.status = "complete"; await put("adverse_action", aa);
          const rpt = await get("report", String(aa.report_id));
          if (rpt) { rpt.adjudication = "post_adverse_action"; await put("report", rpt); }
          await emit("adverse_action.completed", aa); n++;
        }
      }
      return n;
    },
    async outbox(now) {
      const rows = await db.select().from(simWebhookOutbox).where(and(eq(simWebhookOutbox.vendor, V), eq(simWebhookOutbox.status, "pending"), lte(simWebhookOutbox.nextAt, now))).orderBy(asc(simWebhookOutbox.id));
      return rows.map((r): W3VendorSimDelivery => ({ id: r.id, vendor: V, raw: r.bodyJson, headers: { [flavor.header]: r.signature, "user-agent": `${V === "checkr" ? "Checkr-Webhook" : "Weft-Sim-HireRight"}/1.0 (simulated)` }, dedupeKey: r.dedupeKey }));
    },
    async ack(id, delivered, now) {
      const [r] = await db.select().from(simWebhookOutbox).where(eq(simWebhookOutbox.id, id)).limit(1);
      if (!r) return;
      // Retry like Checkr: every minute for 10 minutes, then hourly for 24 hours.
      const attempt = r.attempt + 1;
      if (delivered) await db.update(simWebhookOutbox).set({ status: "delivered", deliveredAt: now, attempt }).where(eq(simWebhookOutbox.id, id));
      else await db.update(simWebhookOutbox).set({ attempt, status: attempt >= 34 ? "failed" : "pending", nextAt: new Date(Date.parse(now) + (attempt <= 10 ? 60_000 : 3_600_000)).toISOString() }).where(eq(simWebhookOutbox.id, id));
    },
  };
}

export function createCheckrSim(db: DbTx, clock: SimClock, faults: FaultInjector): ScreeningConnector {
  return createScreeningSimEngine(db, clock, faults, checkrFlavor);
}
