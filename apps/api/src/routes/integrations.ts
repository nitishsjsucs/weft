// /v1 integrations routes (wave 3, docs/wave3.md, research/wave3/integrations-hr.md 3.5). Owner: w3-integrations-hr.
// Cards for the five vendors (mode, secret names present or missing, never a value), the connection test, sync now,
// the simulator demo controls, sync items and the generic public webhook receiver: raw body, 1 MB cap, signature
// checked by the vendor connector in constant time over the raw bytes, dedupe on the delivery id in
// integration_deliveries (ids and a body hash only), 200 once the row is stored. The record is then re-read and
// applied by the vendor's system command (Greenhouse through integration.ats_hire_detected).
import { createHash } from "node:crypto";
import { Hono, type Context } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  Conflict, IntegrationVendor, NotFound, Unauthorized, ValidationError, VENDOR_APPLY_COMMAND, VENDOR_CATEGORY, W3_INTEGRATIONS_HR_SIMULATE, W3_WEBHOOK_MAX_BYTES,
  type IntegrationCard, type ToolOutcome, type W3GreenhouseSimControls, type W3WorkdaySimControls,
} from "@weft/contracts";
import { extLinks, integrationConnections, integrationDeliveries, offers, syncItems, withWriteLock } from "@weft/db";
import { createSimulators } from "@weft/sim";
import { secretsReport, VENDOR_COPY } from "@weft/integrations";
import type { Weft, WeftEnv } from "../http/context";
import { stubRoutes } from "../http/stub";
import { applyWorkdayDetected, deliverSimWebhooks, webhookReceivers, type WebhookReceiver } from "../integrations/poll";

const DEFAULT_OWNERSHIP = { people: "weft", compensation: "weft", time_off: "weft" } as const;
const vendorOf = (c: Context<WeftEnv>) => {
  const v = IntegrationVendor.safeParse(c.req.param("vendor"));
  if (!v.success) throw new NotFound(`No integration ${c.req.param("vendor")}`);
  return v.data;
};
const outcomeJson = (c: Context<WeftEnv>, out: ToolOutcome) => (out.ok ? c.json(out) : c.json({ ...out, _tag: "Refused", code: out.refusal.code, message: out.refusal.message, hint: out.refusal.hint }, 422));
const isGhControls = (x: unknown): x is W3GreenhouseSimControls => !!x && typeof x === "object" && "simulate" in x && "dueDeliveries" in x;
const isWdControls = (x: unknown): x is W3WorkdaySimControls => !!x && typeof x === "object" && "simulate" in x && "rest" in x;

export async function integrationCard(weft: Weft, vendor: IntegrationVendor): Promise<IntegrationCard> {
  const s = await weft.sims.vendors[vendor].status();
  const [conn] = await weft.db.select().from(integrationConnections).where(eq(integrationConnections.vendor, vendor)).limit(1);
  const copy = VENDOR_COPY[vendor];
  const ownership = vendor === "workday" ? ((conn?.ownershipJson ? JSON.parse(conn.ownershipJson) : DEFAULT_OWNERSHIP) as Record<string, "weft" | "vendor">) : null;
  return {
    status: { ...s, category: VENDOR_CATEGORY[vendor], lastSyncAt: conn?.lastSyncAt ?? s.lastSyncAt, cursor: conn?.cursor ?? s.cursor, health: (conn?.health as typeof s.health | undefined) ?? s.health, detail: conn?.detail ?? s.detail },
    title: copy.title, body: copy.body, freePath: copy.freePath, secrets: secretsReport(vendor, process.env), ownership,
  };
}

/** The webhook receiver shared by the public route and the simulator's in-process deliveries. */
export function createWebhookReceiver(weft: Weft): WebhookReceiver {
  return async (vendorName, raw, headers) => {
    const parsed = IntegrationVendor.safeParse(vendorName);
    if (!parsed.success) return { status: 404 };
    const vendor = parsed.data;
    if (raw.byteLength > W3_WEBHOOK_MAX_BYTES) return { status: 413 };
    const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    const connector = weft.sims.vendors[vendor] as unknown as { verifyWebhook(raw: Uint8Array, h: Record<string, string>): { ok: boolean; dedupeKey: string | null }; parseWebhook(raw: Uint8Array): unknown };
    const verdict = connector.verifyWebhook(raw, h);
    if (!verdict.ok || !verdict.dedupeKey) return { status: 401 };
    const [dup] = await weft.db.select().from(integrationDeliveries).where(and(eq(integrationDeliveries.vendor, vendor), eq(integrationDeliveries.dedupeKey, verdict.dedupeKey))).limit(1);
    if (dup) return { status: 200, duplicate: true, deliveryId: dup.id };
    const parsedBody = connector.parseWebhook(raw);
    const gh = vendor === "greenhouse" ? (parsedBody as { action: string; applicationId: string | null } | null) : null;
    const sha = createHash("sha256").update(raw).digest("hex");
    const out = await weft.executor.system.exec("svc_events", "integrations.record_delivery", { vendor, dedupe_key: verdict.dedupeKey, action: gh?.action ?? (vendor === "greenhouse" ? null : "event"), raw_sha256: sha, application_ref: gh?.applicationId ?? null }, { eventId: null, attended: false, requestedBy: null });
    if (!out.ok || out.status !== "done") return { status: 500 };
    const data = out.data as { delivery_id: string; duplicate: boolean };
    if (data.duplicate) return { status: 200, duplicate: true, deliveryId: data.delivery_id };
    if (vendor !== "greenhouse" && vendor !== "workday") {
      // Screening and e-signature vendors: ids-only items to their own apply command (W3VendorApplyArgs).
      const items = Array.isArray(parsedBody) ? (parsedBody as Record<string, unknown>[]).map((x) => Object.fromEntries(Object.entries(x).filter(([, v]) => typeof v === "string"))) : [];
      await weft.executor.system.exec("svc_events", VENDOR_APPLY_COMMAND[vendor], { vendor, delivery_id: data.delivery_id, items }, { eventId: null, attended: false, requestedBy: null });
    }
    if (!weft.testMode) void weft.scheduler.kick();
    return { status: 200, duplicate: false, deliveryId: data.delivery_id };
  };
}

const SimulateBody = z.object({ kind: z.string(), applicationId: z.string().optional(), employeeId: z.string().regex(/^\d{1,10}$/).optional() });

export function integrationsRoutes(weft: Weft): Hono<WeftEnv> {
  const r = new Hono<WeftEnv>();
  const receive = createWebhookReceiver(weft);
  webhookReceivers.set(weft.db, receive);

  r.get("/v1/integrations", async (c) => c.json(await Promise.all(IntegrationVendor.options.map((v) => integrationCard(weft, v)))));
  r.get("/v1/integrations/:vendor", async (c) => c.json(await integrationCard(weft, vendorOf(c))));
  r.post("/v1/integrations/:vendor/test", async (c) => {
    if (!c.var.session) throw new Unauthorized();
    const vendor = vendorOf(c);
    const conn = weft.sims.vendors[vendor] as unknown as { testConnection?: () => Promise<unknown>; status(): Promise<unknown> };
    const s = (vendor === "greenhouse" || vendor === "workday") && conn.testConnection ? await conn.testConnection() : await conn.status();
    return c.json(s);
  });
  r.post("/v1/integrations/:vendor/sync", async (c) => {
    const session = c.var.session;
    if (!session) throw new Unauthorized();
    const vendor = vendorOf(c);
    if (vendor !== "greenhouse" && vendor !== "workday") throw new ValidationError(`${vendor} syncs through its own screening or signing flow`);
    const out = await weft.executor.human.exec(session, "integrations.sync_now", { vendor });
    const applied = vendor === "workday" ? await applyWorkdayDetected(weft.executor, out) : null;
    await weft.scheduler.kick();
    if (applied && out.ok && out.status === "done") return c.json({ ...out, data: { ...(out.data as object), applied: applied.ok && applied.status === "done" ? applied.data : null } });
    return outcomeJson(c, out);
  });
  r.post("/v1/integrations/:vendor/simulate", async (c) => {
    const session = c.var.session;
    if (!session) throw new Unauthorized();
    const vendor = vendorOf(c);
    const body = SimulateBody.parse(await c.req.json().catch(() => ({})));
    if (vendor === "workday") {
      const kinds: readonly string[] = W3_INTEGRATIONS_HR_SIMULATE.workday;
      if (!kinds.includes(body.kind)) throw new ValidationError(`kind must be one of ${kinds.join(", ")}`);
      if (!isWdControls(weft.sims.vendors.workday)) throw new Conflict("Workday is connected for real; the simulate controls run only in simulated mode");
      const result = await withWriteLock(() => weft.db.transaction(async (tx) => {
        const sim = createSimulators({ db: tx, clock: weft.clock }).vendors.workday as unknown as W3WorkdaySimControls;
        return sim.simulate(body.kind as "worker_change" | "time_off", body.employeeId ? { employeeId: body.employeeId } : {});
      }));
      const out: ToolOutcome = { ok: true, status: "done", data: result, summary: `Simulated Workday ${body.kind.replace("_", " ")}; press Sync now to apply it` } as ToolOutcome;
      return c.json(out);
    }
    if (vendor !== "greenhouse") throw new ValidationError(`No simulate controls for ${vendor}`);
    const kinds: readonly string[] = W3_INTEGRATIONS_HR_SIMULATE.greenhouse;
    if (!kinds.includes(body.kind)) throw new ValidationError(`kind must be one of ${kinds.join(", ")}`);
    if (!isGhControls(weft.sims.vendors.greenhouse)) throw new Conflict("Greenhouse is connected for real; the simulate controls run only in simulated mode");
    const result = await withWriteLock(() => weft.db.transaction(async (tx) => {
      const sim = createSimulators({ db: tx, clock: weft.clock }).vendors.greenhouse as unknown as W3GreenhouseSimControls;
      return sim.simulate(body.kind as "hire" | "start_date_change" | "redeliver", body.applicationId ? { applicationId: body.applicationId } : {});
    }));
    const deliveries = await deliverSimWebhooks({ db: weft.db, clock: weft.clock });
    await weft.scheduler.kick();
    const [link] = await weft.db.select().from(extLinks).where(and(eq(extLinks.vendor, "greenhouse"), eq(extLinks.extType, "application"), eq(extLinks.extId, result.applicationId))).limit(1);
    const out: ToolOutcome = { ok: true, status: "done", data: { ...result, deliveries, weft_offer_id: link?.weftId ?? null }, summary: `Simulated Greenhouse ${body.kind} for application ${result.applicationId}` } as ToolOutcome;
    return c.json(out);
  });
  r.post("/v1/integrations/:vendor/webhook", async (c) => {
    const len = Number(c.req.header("content-length") ?? "0");
    const tooLarge = () => c.json({ _tag: "ValidationError", message: `Webhook body over ${W3_WEBHOOK_MAX_BYTES} bytes`, ok: false }, 413);
    if (len > W3_WEBHOOK_MAX_BYTES) return tooLarge();
    const raw = new Uint8Array(await c.req.arrayBuffer());
    if (raw.byteLength > W3_WEBHOOK_MAX_BYTES) return tooLarge();
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((v, k) => { headers[k] = v; });
    const res = await receive(c.req.param("vendor"), raw, headers);
    if (res.status === 200) return c.json({ ok: true, duplicate: !!res.duplicate });
    if (res.status === 404) throw new NotFound(`No integration ${c.req.param("vendor")}`);
    if (res.status === 401) throw new Unauthorized("Webhook signature did not verify");
    return c.json({ _tag: "Internal", message: "The delivery could not be stored; the sender should retry", ok: false }, 500);
  });
  r.get("/v1/sync-items", async (c) => {
    const status = c.req.query("status") ?? "open", vendor = c.req.query("vendor");
    const companyId = c.var.session?.companyId ?? "cmp_larkspur";
    const rows = await weft.db.select().from(syncItems).where(eq(syncItems.companyId, companyId)).orderBy(desc(syncItems.id));
    return c.json(rows.filter((x) => (status === "all" || x.status === status) && (!vendor || x.vendor === vendor)).map((x) => ({
      id: x.id, vendor: x.vendor, kind: x.kind, subjectRef: x.subjectRef, status: x.status, detail: JSON.parse(x.detailJson), createdAt: x.createdAt, resolvedAt: x.resolvedAt,
    })));
  });
  r.post("/v1/sync-items/:id/resolve", async (c) => {
    const session = c.var.session;
    if (!session) throw new Unauthorized();
    const b = z.object({ take: z.enum(["weft", "vendor"]) }).parse(await c.req.json().catch(() => ({})));
    return outcomeJson(c, await weft.executor.human.exec(session, "integrations.resolve_sync_item", { sync_item_id: c.req.param("id"), take: b.take }));
  });
  r.get("/v1/ats/jobs", async (c) => {
    const source = c.req.query("source") === "harvest" ? "harvest" : "board";
    const page = await weft.sims.vendors.greenhouse.listJobs({ cursor: null, source });
    return c.json(page.items);
  });
  // Imported offers with their Greenhouse link, for the Integrations screen (read-only, not in the route table).
  r.get("/v1/integrations/greenhouse/imported", async (c) => {
    if (!c.var.session) throw new Unauthorized();
    const links = await weft.db.select().from(extLinks).where(and(eq(extLinks.vendor, "greenhouse"), eq(extLinks.weftType, "offer"))).orderBy(desc(extLinks.id));
    const out = [];
    for (const l of links) {
      const [o] = await weft.db.select().from(offers).where(eq(offers.id, l.weftId)).limit(1);
      out.push({ applicationRef: l.extId, offerVersion: l.extVersion, offerId: l.weftId, status: o?.status ?? null, candidate: o ? `${o.candidateFirst} ${o.candidateLast} (demo)` : null, title: o?.title ?? null, startDate: o?.startDate ?? null, workState: o?.workState ?? null });
    }
    return c.json(out);
  });
  return stubRoutes(r, "integrations", [
    "GET /v1/integrations", "GET /v1/integrations/:vendor", "POST /v1/integrations/:vendor/test", "POST /v1/integrations/:vendor/sync",
    "POST /v1/integrations/:vendor/simulate", "POST /v1/integrations/:vendor/webhook", "GET /v1/sync-items", "POST /v1/sync-items/:id/resolve", "GET /v1/ats/jobs",
  ]);
}
