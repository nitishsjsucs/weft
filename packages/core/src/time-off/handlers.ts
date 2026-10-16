// Wave 3 event handlers (docs/wave3.md). Owner: w3-timeoff. Deterministic, run by the scheduler as svc_events: payroll.processed posts accruals; time_off.request.decided refreshes open drafts.
import type { EventHandler } from "@weft/contracts";

export const timeOffHandlers: EventHandler[] = [];
