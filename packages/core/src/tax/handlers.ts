// Deterministic event handlers for tax. Owner: t2-world. handlers/index.ts concatenates this array.
// sim.registration_completed and sim.registration_needs_info run the system command tax.record_registration as svc_events.
import type { EventHandler } from "@weft/contracts";

const record = (event: string): EventHandler => ({
  event, principal: "svc_events",
  async handle(evt, sys) {
    const applicationId = evt.payload.application_id;
    if (!applicationId) return;
    await sys.exec("svc_events", "tax.record_registration", { application_id: applicationId }, { eventId: evt.id, attended: evt.attended, requestedBy: evt.requestedBy });
  },
});

export const taxHandlers: EventHandler[] = [record("sim.registration_completed"), record("sim.registration_needs_info")];
