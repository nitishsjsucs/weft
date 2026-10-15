// Deterministic event handlers for payroll. Owner: t1-payroll. handlers/index.ts concatenates this array.
// The bank simulator settles a batch on the first tick at or after settle_at; these handlers record it as svc_events.
import type { EventHandler, WeftEvent } from "@weft/contracts";

const source = (evt: WeftEvent) => ({ eventId: evt.id, attended: evt.attended, requestedBy: evt.requestedBy });

export const bankBatchSettledHandler: EventHandler = {
  event: "sim.bank_batch_settled", principal: "svc_events",
  async handle(evt, sys) {
    await sys.exec("svc_events", "payroll.mark_processed", { run_id: evt.payload.payroll_run_id, batch_id: evt.payload.batch_id }, source(evt));
  },
};

export const bankBatchReturnedHandler: EventHandler = {
  event: "sim.bank_batch_returned", principal: "svc_events",
  async handle(evt, sys) {
    await sys.exec("svc_events", "payroll.mark_failed", { run_id: evt.payload.payroll_run_id, batch_id: evt.payload.batch_id, worker_id: evt.payload.worker_id }, source(evt));
  },
};

export const payrollHandlers: EventHandler[] = [bankBatchSettledHandler, bankBatchReturnedHandler];
