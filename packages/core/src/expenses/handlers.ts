// Wave 3 event handlers (docs/wave3.md). Owner: w3-expenses. Deterministic, run by the scheduler as svc_events:
// payroll.processed marks the run's scheduled reimbursements paid; payroll.draft_created attaches approved items that
// were waiting for a draft.
import type { EventHandler, WeftEvent } from "@weft/contracts";

const source = (evt: WeftEvent) => ({ eventId: evt.id, attended: evt.attended, requestedBy: evt.requestedBy });

export const expensesPaidHandler: EventHandler = {
  event: "payroll.processed", principal: "svc_events",
  async handle(evt, sys) {
    await sys.exec("svc_events", "expenses.mark_paid", { payroll_run_id: evt.payload.payroll_run_id }, source(evt));
  },
};

export const expensesScheduleHandler: EventHandler = {
  event: "payroll.draft_created", principal: "svc_events",
  async handle(evt, sys) {
    await sys.exec("svc_events", "expenses.schedule", { payroll_run_id: evt.payload.payroll_run_id }, source(evt));
  },
};

export const expensesHandlers: EventHandler[] = [expensesPaidHandler, expensesScheduleHandler];
