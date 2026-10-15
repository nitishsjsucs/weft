// Deterministic event handlers for onboarding. Owner: t2-world. handlers/index.ts concatenates this array.
// tax_account.activated completes state_registration for each affected worker once every registration for the
// worker's work state is active (SPEC 9.7).
import type { EventHandler, ToolOutcome } from "@weft/contracts";

export const HANDLER_COMPANY_ID = "cmp_larkspur";
const data = <T>(o: ToolOutcome): T | null => (o.ok && o.status === "done" ? (o.data as T) : null);

export const onboardingHandlers: EventHandler[] = [{
  event: "tax_account.activated", principal: "svc_events",
  async handle(evt, sys, read) {
    const ids = (evt.payload.worker_ids ?? "").split(",").filter((x) => x.startsWith("wrk_"));
    for (const workerId of ids) {
      const checklist = data<{ work_state: string | null; tasks: { kind: string; status: string }[] }>(await read.exec(HANDLER_COMPANY_ID, "onboarding.get_checklist", { worker_id: workerId }));
      const task = checklist?.tasks.find((t) => t.kind === "state_registration");
      if (!checklist?.work_state || !task || task.status === "done") continue;
      const regs = data<{ accounts: { status: string }[] }>(await read.exec(HANDLER_COMPANY_ID, "tax.list_registrations", { jurisdiction: checklist.work_state }));
      if (!regs || regs.accounts.length === 0 || regs.accounts.some((a) => a.status !== "active")) continue;
      await sys.exec("svc_events", "onboarding.complete_task", { worker_id: workerId, kind: "state_registration" }, { eventId: evt.id, attended: evt.attended, requestedBy: evt.requestedBy });
    }
  },
}];
