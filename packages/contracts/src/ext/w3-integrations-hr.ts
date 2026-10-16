// Additive contracts for w3-integrations-hr (docs/wave3.md, docs/tracks/w3-integrations-hr.md). Exported through
// w3/testids-integrations.ts. Nothing here changes a frozen wave 3 type.

/** Demo controls on the Integrations screen: POST /v1/integrations/:vendor/simulate { kind }. */
export const W3_INTEGRATIONS_HR_SIMULATE = {
  greenhouse: ["hire", "start_date_change", "redeliver"],
  workday: ["worker_change", "time_off"],
} as const;
export type W3IntegrationsHrSimulateKind = (typeof W3_INTEGRATIONS_HR_SIMULATE)[keyof typeof W3_INTEGRATIONS_HR_SIMULATE][number];

/** One pending simulated webhook delivery (sim_webhook_outbox), with the exact bytes the simulator signed. */
export interface W3IntegrationsHrOutboxDelivery { id: string; vendor: string; dedupeKey: string; raw: string; headers: Record<string, string>; attempt: number }

/** Response shape of a Harvest-like simulated HTTP call (bare arrays, Link cursor, rate-limit headers). */
export interface W3IntegrationsHrHttpResponse { status: number; headers: Record<string, string>; body: unknown }

/**
 * Extra methods the Greenhouse simulator carries beyond AtsConnector. The API checks for them at runtime
 * (`"simulate" in connector`), so a real adapter, which has none, refuses the demo controls.
 */
export interface W3GreenhouseSimControls {
  /** Seeds the fictional Larkspur account (jobs and in-process candidates, no hires); a no-op when present. */
  seedLarkspur(): Promise<void>;
  simulate(kind: "hire" | "start_date_change" | "redeliver", opts?: { applicationId?: string }): Promise<{ applicationId: string; offerId: string; offerVersion: number; deliveryKey: string }>;
  dueDeliveries(now: string): Promise<W3IntegrationsHrOutboxDelivery[]>;
  recordAttempt(id: string, ok: boolean, now: string): Promise<{ status: "delivered" | "pending" | "failed"; attempt: number; nextAt: string | null }>;
  harvest(path: string, query?: Record<string, string>): Promise<W3IntegrationsHrHttpResponse>;
}

/** Workday simulator controls (worker change and approved time off for the Workday scenario). */
export interface W3WorkdaySimControls {
  seedLarkspur(): Promise<void>;
  simulate(kind: "worker_change" | "time_off", opts?: { employeeId?: string }): Promise<{ workerRef: string; entryRefs: string[] }>;
  rest(path: string, query?: Record<string, string>): Promise<W3IntegrationsHrHttpResponse>;
}

/** Retry schedule for simulated Greenhouse deliveries: cumulative minutes after the first attempt (7 attempts). */
export const W3_GREENHOUSE_RETRY_MINUTES = [0, 1, 16, 76, 196, 436, 916] as const;

/** Webhook body cap for POST /v1/integrations/:vendor/webhook. */
export const W3_WEBHOOK_MAX_BYTES = 1_048_576;

/** Polling interval for Greenhouse and Workday on the scheduler tick, in sim minutes. */
export const W3_POLL_MINUTES = 15;

/**
 * Args the generic webhook route passes to VENDOR_APPLY_COMMAND for vendors other than Greenhouse and Workday
 * (agreement with w3-integrations-screening-esign): ids only, never the body.
 */
export interface W3VendorApplyArgs { vendor: string; delivery_id: string; items: Record<string, string>[] }
