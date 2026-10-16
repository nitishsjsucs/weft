// Vendor polling on the scheduler tick (wave 3, docs/wave3.md). Owner: w3-integrations-hr. A local Weft cannot receive
// webhooks, so polling is the baseline: Greenhouse every 15 minutes of sim time through integrations.sync_now
// (svc_scheduler), only when there is something to read (an unlinked or newer hire in the simulator, or a real
// connection). The simulator's due webhook deliveries are delivered in-process to the same receiver the public route
// uses, with the retry schedule on the sim clock. Then the screening and e-signature poll owned by
// w3-integrations-screening-esign.
import { sql } from "drizzle-orm";
import { W3_POLL_MINUTES, type ExecutorBundle, type SimClock, type W3GreenhouseSimControls } from "@weft/contracts";
import { withWriteLock, type Db } from "@weft/db";
import { createSimulators } from "@weft/sim";
import { integrationMode } from "@weft/integrations";
import { pollScreeningEsign } from "./poll-screening";

export interface PollDeps { db: Db; clock: SimClock; executor: ExecutorBundle; now: string }

/** The receiver behind POST /v1/integrations/:vendor/webhook, registered per world by integrationsRoutes(). */
export type WebhookReceiver = (vendor: string, raw: Uint8Array, headers: Record<string, string>) => Promise<{ status: number; duplicate?: boolean; deliveryId?: string | null }>;
export const webhookReceivers = new WeakMap<Db, WebhookReceiver>();

const isControls = (x: unknown): x is W3GreenhouseSimControls => !!x && typeof x === "object" && "dueDeliveries" in x && "recordAttempt" in x;

/** Delivers every due simulated Greenhouse webhook. The greenhouse.webhook fault makes a delivery fail and retry. */
export async function deliverSimWebhooks(d: Pick<PollDeps, "db" | "clock">): Promise<{ id: string; status: number; outcome: string }[]> {
  const receive = webhookReceivers.get(d.db);
  if (!receive) return [];
  const pending = await d.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM sim_webhook_outbox WHERE vendor = 'greenhouse' AND status = 'pending' AND next_at <= ${d.clock.now()}`);
  if (!pending[0]?.n) return [];
  const sim = createSimulators({ db: d.db, clock: d.clock }).vendors.greenhouse;
  if (!isControls(sim)) return [];
  const out: { id: string; status: number; outcome: string }[] = [];
  for (const row of await sim.dueDeliveries(d.clock.now())) {
    const failed = await withWriteLock(() => d.db.transaction(async (tx) => (await createSimulators({ db: tx, clock: d.clock }).faults.check("greenhouse.webhook")).fire));
    let status = 503;
    if (!failed) { try { status = (await receive("greenhouse", new TextEncoder().encode(row.raw), row.headers)).status; } catch { status = 500; } }
    const r = await withWriteLock(() => d.db.transaction(async (tx) => {
      const s = createSimulators({ db: tx, clock: d.clock }).vendors.greenhouse as unknown as W3GreenhouseSimControls;
      return s.recordAttempt(row.id, status === 200, d.clock.now());
    }));
    out.push({ id: row.id, status, outcome: r.status });
  }
  return out;
}

async function greenhouseDue(d: PollDeps): Promise<boolean> {
  const [c] = await d.db.all<{ last: string | null }>(sql`SELECT last_sync_at AS last FROM integration_connections WHERE vendor = 'greenhouse' LIMIT 1`);
  if (c?.last && Date.parse(d.now) - Date.parse(c.last) < W3_POLL_MINUTES * 60_000) return false;
  let real = false;
  try { real = integrationMode("greenhouse", process.env) === "real"; } catch { real = false; }
  if (real) return true;
  // A verified delivery still waiting for its re-read covers the same hire; the handler applies it this tick.
  const [w] = await d.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM integration_deliveries WHERE vendor = 'greenhouse' AND applied_at IS NULL AND error IS NULL`);
  if (w?.n) return false;
  // Simulated: poll only when the simulator holds a hire Weft has not linked, or a newer offer version than the link.
  const [n] = await d.db.all<{ n: number }>(sql`
    SELECT COUNT(*) AS n FROM sim_vendor_records a
    WHERE a.vendor = 'greenhouse' AND a.kind = 'application' AND json_extract(a.body_json, '$.status') = 'hired'
      AND (NOT EXISTS (SELECT 1 FROM ext_links l WHERE l.vendor = 'greenhouse' AND l.ext_type = 'application' AND l.ext_id = a.ext_id)
        OR EXISTS (SELECT 1 FROM sim_vendor_records o JOIN ext_links l ON l.vendor = 'greenhouse' AND l.ext_type = 'application' AND l.ext_id = a.ext_id
          WHERE o.vendor = 'greenhouse' AND o.kind = 'offer' AND CAST(json_extract(o.body_json, '$.application_id') AS TEXT) = a.ext_id
            AND json_extract(o.body_json, '$.status') != 'Deprecated' AND json_extract(o.body_json, '$.version') > COALESCE(l.ext_version, 0)))`);
  return !!n?.n;
}

export async function pollIntegrations(d: PollDeps): Promise<void> {
  await deliverSimWebhooks(d);
  if (await greenhouseDue(d)) {
    await d.executor.system.exec("svc_scheduler", "integrations.sync_now", { vendor: "greenhouse" }, { eventId: null, attended: false, requestedBy: null });
  }
  await pollScreeningEsign(d);
}
