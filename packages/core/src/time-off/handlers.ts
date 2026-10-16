// Wave 3 event handlers (docs/wave3.md). Owner: w3-timeoff. Deterministic, run by the scheduler as svc_events: payroll.processed posts accruals; time_off.request.decided refreshes open drafts.
// A processed regular run posts one accrual per assignment (time_off.post_accruals, idempotent on run_key); a
// processed dismissal run records the vacation payout so the paid-out balance is zero (time_off.record_payout).
// The decide command itself refreshes open drafts in its transaction, so no handler is needed for that.
import type { EventHandler, WeftEvent } from "@weft/contracts";

const source = (evt: WeftEvent) => ({ eventId: evt.id, attended: evt.attended, requestedBy: evt.requestedBy });

export const timeOffAccrualHandler: EventHandler = {
  event: "payroll.processed", principal: "svc_events",
  async handle(evt, sys) {
    const runId = String((evt.payload as { payroll_run_id?: unknown }).payroll_run_id ?? "");
    if (!runId.startsWith("pay_")) return;
    await sys.exec("svc_events", "time_off.post_accruals", { run_id: runId }, source(evt));
    await sys.exec("svc_events", "time_off.record_payout", { run_id: runId }, source(evt));
  },
};

export const timeOffHandlers: EventHandler[] = [timeOffAccrualHandler];
