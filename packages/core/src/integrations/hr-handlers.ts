// Owner: w3-integrations-hr (docs/wave3.md). integration.ats_hire_detected (from a verified webhook delivery or a poll)
// re-reads the hire and applies it through integrations.record_ats_hire as svc_events. The event carries ids only.
import type { EventHandler } from "@weft/contracts";

export const hrHandlers: EventHandler[] = [{
  event: "integration.ats_hire_detected", principal: "svc_events",
  async handle(evt, sys) {
    const ref = evt.payload.application_ref;
    if (evt.payload.vendor !== "greenhouse" || !ref) return;
    const deliveryId = evt.subjectRef.startsWith("dlv_") ? evt.subjectRef : undefined;
    await sys.exec("svc_events", "integrations.record_ats_hire", { vendor: "greenhouse", application_ref: ref, ...(deliveryId ? { delivery_id: deliveryId } : {}) }, { eventId: evt.id, attended: evt.attended, requestedBy: evt.requestedBy });
  },
}];
