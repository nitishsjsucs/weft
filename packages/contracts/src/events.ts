import { z } from "zod";
import { Wave2EventBody } from "./wave2";
import { Wave3EventBody } from "./wave3";
// Domain events (SPEC 6.5, 15 item 4): a discriminated union on `type` with id-only payloads, never free text.
// The executor stamps `attended` and `requestedBy` (SPEC 9.0 amendment 3); stored in the events table.
const ref = (p: string) => z.string().startsWith(p);
const ev = <T extends string, P extends z.ZodRawShape>(type: T, payload: P) => z.object({ type: z.literal(type), payload: z.object(payload).strict() });

export const EventBody = z.discriminatedUnion("type", [
  ev("offer.accepted", { offer_id: ref("offr_"), worker_id: ref("wrk_") }),
  ev("worker.created", { worker_id: ref("wrk_") }),
  ev("worker.onboarding_completed", { worker_id: ref("wrk_") }),
  ev("worker.offboarding_started", { worker_id: ref("wrk_") }),
  ev("pay_rate.created", { worker_id: ref("wrk_"), pay_rate_id: ref("prt_") }),
  ev("notice.received", { notice_id: ref("ntc_") }),
  ev("notice.resolved", { notice_id: ref("ntc_") }),
  ev("payroll.draft_created", { payroll_run_id: ref("pay_") }),
  ev("payroll.submitted", { payroll_run_id: ref("pay_") }),
  ev("payroll.processed", { payroll_run_id: ref("pay_") }),
  ev("tax_account.registration_submitted", { tax_account_id: ref("txa_"), application_id: ref("sima_") }),
  ev("tax_account.activated", { tax_account_id: ref("txa_"), worker_ids: z.string() }),   // comma-joined wrk_ ids
  ev("proposal.created", { proposal_id: ref("prp_") }),
  ev("proposal.decided", { proposal_id: ref("prp_"), status: z.string() }),
  ev("routine.drafted", { routine_id: ref("rt_") }),
  ev("routine.enabled", { routine_id: ref("rt_") }),
  ev("routine.disabled", { routine_id: ref("rt_") }),
  ev("routine_run.finished", { routine_run_id: ref("rtr_"), routine_id: ref("rt_"), status: z.string() }),
  ev("run.finished", { run_id: ref("run_"), status: z.string() }),
  ev("clock.advanced", { from: z.string(), to: z.string() }),
  ev("sim.registration_completed", { application_id: ref("sima_") }),
  ev("sim.registration_needs_info", { application_id: ref("sima_") }),
  ev("sim.bank_batch_settled", { batch_id: z.string(), payroll_run_id: ref("pay_") }),
  ev("sim.bank_batch_returned", { batch_id: z.string(), payroll_run_id: ref("pay_"), worker_id: ref("wrk_") }),
  ev("sim.device_delivered", { order_ref: z.string(), worker_id: ref("wrk_") }),
]);
export type EventBody = z.infer<typeof EventBody>;
export type EventType = EventBody["type"];
export type EventPayload<T extends EventType> = Extract<EventBody, { type: T }>["payload"];
export const EVENT_TYPES = EventBody.options.map((o) => o.shape.type.value) as EventType[];

/** A stored event row as the API returns it. */
export const EventRow = z.object({ id: ref("evt_"), type: z.string(), ts: z.string(), subjectRef: z.string(), payload: z.record(z.string(), z.string()), attended: z.boolean(), requestedBy: z.string().nullable() });
export type EventRow = z.infer<typeof EventRow>;

/** Validates an event body; payload values must be strings (ids), which keeps payloads free of untrusted text. */
/** Wave 2 event bodies (wave2.ts Wave2EventBody) are accepted too; the frozen EventBody union is unchanged. */
export function parseEventBody(body: unknown): EventBody {
  const t = (body as { type?: unknown } | null)?.type;
  if (typeof t === "string" && !EVENT_TYPES.includes(t as EventType) && Wave2EventBody.options.some((o) => o.shape.type.value === t)) return Wave2EventBody.parse(body) as unknown as EventBody;
  if (typeof t === "string" && !EVENT_TYPES.includes(t as EventType) && Wave3EventBody.options.some((o) => o.shape.type.value === t)) return Wave3EventBody.parse(body) as unknown as EventBody;   // wave 3
  return EventBody.parse(body);
}
