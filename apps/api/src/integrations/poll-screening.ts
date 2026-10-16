// Screening and e-signature polling (wave 3, docs/wave3.md). Owner: w3-integrations-screening-esign. Checkr reports every
// 30 minutes while in progress; a DocuSign envelope at most once per 20 minutes (esign_envelopes.last_polled_at).
//
// Each tick: (1) the simulators run their own timers on the sim clock (the vendor's side); (2) their signed webhook
// deliveries go through the same path as a real inbound webhook: HMAC verified over the raw bytes, deduplicated in
// integration_deliveries (ids and the body's sha256 only, never the body), then applied by the vendor's system command
// after a re-read; (3) the poll fallback re-reads any open order not heard from in 30 minutes.
import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { formatId, VENDOR_APPLY_COMMAND, type IntegrationVendor, type ScreeningConnector, type ESignConnector } from "@weft/contracts";
import { integrationDeliveries, screeningOrders, withWriteLock, type Db, type DbTx } from "@weft/db";
import { createSimulators } from "@weft/sim";
import { W3_SCREENING_POLL_MINUTES, w3EsignSimControls, w3ScreeningSimControls } from "../../../../packages/contracts/src/ext/w3-integrations-screening-esign";
import type { PollDeps } from "./poll";

type Connector = ScreeningConnector | ESignConnector;
export type DeliveryResult = { status: "applied" | "duplicate" | "rejected" | "ignored" | "failed"; deliveryId: string | null; dedupeKey: string | null; detail: string | null };

async function nextId(tx: DbTx, prefix: "dlv_"): Promise<string> {
  const rows = await tx.all<{ next: number }>(sql`INSERT INTO id_counters (prefix, next) VALUES (${prefix}, 1) ON CONFLICT(prefix) DO UPDATE SET next = next + 1 RETURNING next`);
  return formatId(prefix, rows[0]!.next);
}

/**
 * One inbound vendor webhook (the screening and e-signature vendors): verify, store ids only, dedupe, apply through
 * VENDOR_APPLY_COMMAND as svc_events. Used for the simulators' deliveries; the generic route of w3-integrations-hr
 * follows the same steps for real ones.
 */
export async function ingestVendorDelivery(d: Pick<PollDeps, "db" | "executor" | "now">, vendor: "checkr" | "hireright" | "docusign", conn: Connector, raw: Uint8Array, headers: Record<string, string>): Promise<DeliveryResult> {
  const verdict = conn.verifyWebhook(raw, headers);
  if (!verdict.ok) return { status: "rejected", deliveryId: null, dedupeKey: null, detail: "signature did not verify" };
  const parsed = conn.parseWebhook(raw)[0] as { dedupeKey: string; vendorOrderId?: string; envelopeId?: string; kind?: string; event?: string } | undefined;
  const dedupeKey = verdict.dedupeKey ?? parsed?.dedupeKey ?? null;
  if (!parsed || !dedupeKey) return { status: "ignored", deliveryId: null, dedupeKey, detail: "no event id" };
  const rawSha = createHash("sha256").update(raw).digest("hex");
  const action = (parsed.kind ?? parsed.event ?? null)?.slice(0, 80) ?? null;
  const deliveryId = await withWriteLock(() => d.db.transaction(async (tx) => {
    const id = await nextId(tx, "dlv_");
    const ins = await tx.insert(integrationDeliveries).values({ id, vendor, dedupeKey, action, receivedAt: d.now, verified: true, rawSha256: rawSha, appliedAt: null, error: null }).onConflictDoNothing().returning({ id: integrationDeliveries.id });
    return ins[0]?.id ?? null;
  }));
  if (!deliveryId) return { status: "duplicate", deliveryId: null, dedupeKey, detail: null };
  const command = VENDOR_APPLY_COMMAND[vendor as IntegrationVendor];
  const args = vendor === "docusign" ? { envelope_id: parsed.envelopeId, event: action ?? undefined, dedupe_key: dedupeKey } : { vendor, vendor_order_id: parsed.vendorOrderId, kind: action ?? undefined, dedupe_key: dedupeKey };
  const out = await d.executor.system.exec("svc_events", command, args, { eventId: null, attended: false, requestedBy: null });
  const error = out.ok ? null : `${out.refusal.code}`.slice(0, 120);
  await withWriteLock(() => d.db.update(integrationDeliveries).set(error ? { error } : { appliedAt: d.now }).where(eq(integrationDeliveries.id, deliveryId)));
  return { status: out.ok ? "applied" : "failed", deliveryId, dedupeKey, detail: error };
}

/** Delivers every due simulator webhook for the screening and e-signature vendors. Returns what happened to each. */
export async function deliverSimWebhooks(d: PollDeps): Promise<DeliveryResult[]> {
  const results: DeliveryResult[] = [];
  for (const vendor of ["checkr", "hireright", "docusign"] as const) {
    const due = await d.db.transaction(async (tx) => {
      const conn = createSimulators({ db: tx, clock: d.clock }).vendors[vendor];
      const ctl = vendor === "docusign" ? w3EsignSimControls(conn) : w3ScreeningSimControls(conn);
      return ctl ? await ctl.outbox(d.now) : [];
    });
    for (const item of due) {
      const conn = createSimulators({ db: d.db, clock: d.clock }).vendors[vendor];
      const r = await ingestVendorDelivery(d, vendor, conn, new TextEncoder().encode(item.raw), item.headers);
      results.push(r);
      await withWriteLock(() => d.db.transaction(async (tx) => {
        const c = createSimulators({ db: tx, clock: d.clock }).vendors[vendor];
        const ctl = vendor === "docusign" ? w3EsignSimControls(c) : w3ScreeningSimControls(c);
        await ctl?.ack(item.id, r.status !== "failed", d.now);
      }));
    }
  }
  return results;
}

/** The simulators' own timers (invitation expiry, report turnaround, dispute, the scheduled post notice). */
export async function advanceScreeningSims(d: Pick<PollDeps, "db" | "clock" | "now">): Promise<number> {
  return withWriteLock(() => d.db.transaction(async (tx) => {
    let n = 0;
    for (const vendor of ["checkr", "hireright"] as const) n += (await w3ScreeningSimControls(createSimulators({ db: tx, clock: d.clock }).vendors[vendor])?.advance(d.now)) ?? 0;
    return n;
  }));
}

const POLLED = ["invited", "consented", "in_progress", "suspended", "disputed", "complete_review"];
/** Poll fallback: re-read every open order not heard from in 30 minutes of sim time. */
export async function pollOpenOrders(d: PollDeps): Promise<string[]> {
  const cutoff = new Date(Date.parse(d.now) - W3_SCREENING_POLL_MINUTES * 60_000).toISOString();
  const rows = (await d.db.select().from(screeningOrders).where(inArray(screeningOrders.status, POLLED)))
    .filter((r) => r.vendorOrderId && (r.status !== "complete_review" || r.adjudication === "pre_adverse") && (!r.lastPolledAt || r.lastPolledAt <= cutoff));
  for (const r of rows) await d.executor.system.exec("svc_scheduler", "screening.apply_vendor_event", { vendor: r.vendor, vendor_order_id: r.vendorOrderId }, { eventId: null, attended: false, requestedBy: null });
  return rows.map((r) => r.id);
}

export async function pollScreeningEsign(d: PollDeps): Promise<void> {
  const any = await d.db.select({ id: screeningOrders.id }).from(screeningOrders).where(and(sql`1 = 1`)).limit(1);
  const pending = await d.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM sim_webhook_outbox WHERE status = 'pending' AND vendor IN ('checkr', 'hireright', 'docusign')`);
  if (!any.length && !pending[0]?.n) return;
  await advanceScreeningSims(d);
  await deliverSimWebhooks(d);
  await pollOpenOrders(d);
}

export type { Db };
