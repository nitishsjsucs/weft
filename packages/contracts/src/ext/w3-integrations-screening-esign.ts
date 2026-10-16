// Additive contracts for w3-integrations-screening-esign (docs/wave3.md rule 2). Export names carry the W3Screening or
// W3Esign prefix. Not re-exported by the frozen index yet (contract request in docs/tracks/w3-integrations-screening-esign.md):
// owners import this file by relative path until the integrator folds it into the w3 testids barrel.
import { z } from "zod";
import { Adjudication, ConnectorMode, EnvelopeStatus, ScreeningStatus } from "../wave3";

/** Human-only adjudication steps on POST /v1/screening/orders/:id/adjudicate (one command each, none on a model surface). */
export const W3ScreeningAdjudicateStep = z.enum(["engage", "pre_adverse", "final_adverse", "cancel_adverse", "proceed_to_criminal"]);
export type W3ScreeningAdjudicateStep = z.infer<typeof W3ScreeningAdjudicateStep>;
export const W3_SCREENING_STEP_COMMAND: Record<W3ScreeningAdjudicateStep, string> = {
  engage: "screening.engage", pre_adverse: "screening.start_pre_adverse", final_adverse: "screening.send_final_adverse",
  cancel_adverse: "screening.cancel_adverse", proceed_to_criminal: "screening.proceed_to_criminal",
};

/** Input of screening.apply_vendor_event (svc_events, svc_scheduler): ids only, never a webhook body. */
export const W3ScreeningApplyInput = z.object({
  vendor: z.enum(["checkr", "hireright"]), vendor_order_id: z.string().min(1).max(80),
  kind: z.string().max(80).optional(), dedupe_key: z.string().max(200).optional(),
});
export type W3ScreeningApplyInput = z.infer<typeof W3ScreeningApplyInput>;
/** Input of documents.apply_esign_event (svc_events, svc_scheduler): the envelope id, re-read before any change. */
export const W3EsignApplyInput = z.object({ envelope_id: z.string().min(1).max(80), event: z.string().max(80).optional(), dedupe_key: z.string().max(200).optional() });
export type W3EsignApplyInput = z.infer<typeof W3EsignApplyInput>;

/** A screening order as every reader sees it: status, result, ETA and timestamps. Never record text. */
export const W3ScreeningOrderView = z.object({
  id: z.string(), offerId: z.string(), workerId: z.string().nullable(), vendor: z.enum(["checkr", "hireright"]), mode: ConnectorMode,
  packageSlug: z.string(), packageName: z.string(), priceCents: z.number().int(), phase: z.enum(["full", "non_criminal", "criminal"]),
  status: ScreeningStatus, result: z.enum(["clear", "consider"]).nullable(), adjudication: Adjudication, timerPaused: z.boolean(),
  etaOn: z.string().nullable(), createdAt: z.string(), completedAt: z.string().nullable(),
  reviewRequired: z.boolean(), nextSteps: z.array(W3ScreeningAdjudicateStep),
});
export type W3ScreeningOrderView = z.infer<typeof W3ScreeningOrderView>;
/** What the new-hire portal shows: the order status and the simulated apply page link. */
export const W3ScreeningPortalView = z.object({
  orderId: z.string(), vendor: z.enum(["checkr", "hireright"]), mode: ConnectorMode, status: ScreeningStatus, consentNeeded: z.boolean(),
  vendorLabel: z.string(), packageName: z.string(),
});
export type W3ScreeningPortalView = z.infer<typeof W3ScreeningPortalView>;
export const W3EsignEnvelopeView = z.object({
  id: z.string(), offerId: z.string(), provider: z.enum(["builtin", "docusign"]), mode: ConnectorMode, envelopeId: z.string(), status: EnvelopeStatus,
  sentAt: z.string(), deliveredAt: z.string().nullable(), completedAt: z.string().nullable(), voidedAt: z.string().nullable(), lastPolledAt: z.string().nullable(),
});
export type W3EsignEnvelopeView = z.infer<typeof W3EsignEnvelopeView>;

/** Domain refusal codes this track adds. */
export const W3_SCREENING_REFUSALS = [
  "DOMAIN_SCREENING_BEFORE_OFFER", "DOMAIN_SCREENING_EXISTS", "DOMAIN_SCREENING_NO_LOCATION", "DOMAIN_SCREENING_UNKNOWN_PACKAGE",
  "DOMAIN_SYSTEM_TASK", "DOMAIN_SCREENING_STEP", "DOMAIN_SCREENING_WAITING_PERIOD", "DOMAIN_SCREENING_TIMER_PAUSED", "DOMAIN_SCREENING_NOT_OPEN",
] as const;

/** Poll spacing on the scheduler tick: a Checkr report every 30 minutes while open, a DocuSign envelope never under 20 minutes. */
export const W3_SCREENING_POLL_MINUTES = 30;
export const W3_ESIGN_POLL_MINUTES = 20;
/** Calendar days between pre-adverse and the final step (Checkr's default; at least the 5 business days CA and NYC require). */
export const W3_SCREENING_WAITING_DAYS = 7;
/** Fault targets the screening simulators read (any FaultKind fires them). */
export const W3_SCREENING_FAULTS = ["checkr.consider", "checkr.suspended", "checkr.dispute", "checkr.expire", "hireright.consider", "esign.send"] as const;

/**
 * Simulator-only controls on the simulated screening and e-signature connectors: the vendor-side actions a real vendor
 * performs on its own servers (the candidate's consent on the hosted apply page, timers, webhook delivery). Real adapters
 * do not have them; callers check with w3ScreeningSimControls().
 */
export interface W3VendorSimDelivery { id: string; vendor: string; raw: string; headers: Record<string, string>; dedupeKey: string }
export interface W3ScreeningSimControls {
  readonly simulated: true;
  /** The candidate completes the simulated apply page (disclosure, summary of rights, authorization). */
  consent(vendorOrderId: string, typedName: string): Promise<void>;
  /** Runs every timer due by `now` on the sim clock and queues the signed webhooks. Returns the number of transitions. */
  advance(now: string): Promise<number>;
  /** Signed webhook deliveries due by `now`, oldest first. */
  outbox(now: string): Promise<W3VendorSimDelivery[]>;
  ack(id: string, delivered: boolean, now: string): Promise<void>;
}
export interface W3EsignSimControls {
  readonly simulated: true;
  /** The signer finishes (signed) or declines the envelope on the simulated signing page. */
  finish(envelopeId: string, outcome: "signed" | "declined"): Promise<void>;
  outbox(now: string): Promise<W3VendorSimDelivery[]>;
  ack(id: string, delivered: boolean, now: string): Promise<void>;
  /** How many status reads each envelope has had, with their sim times (poll-spacing tests). */
  reads(envelopeId: string): Promise<string[]>;
}
export function w3ScreeningSimControls(c: unknown): W3ScreeningSimControls | null {
  return c && typeof c === "object" && (c as { simulated?: unknown }).simulated === true && typeof (c as { consent?: unknown }).consent === "function" ? (c as W3ScreeningSimControls) : null;
}
export function w3EsignSimControls(c: unknown): W3EsignSimControls | null {
  return c && typeof c === "object" && (c as { simulated?: unknown }).simulated === true && typeof (c as { finish?: unknown }).finish === "function" ? (c as W3EsignSimControls) : null;
}
