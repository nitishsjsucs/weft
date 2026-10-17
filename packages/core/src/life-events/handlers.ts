// Wave 4 event handlers (docs/wave4.md). Owner: w4-parity-people. Planned: life_event.reported, enrollment_window.*, carrier.submission_confirmed, worker.first_day.
// handlers/index.ts concatenates this array; handlers run as svc_ principals and read payload ids only.
import type { EventHandler } from "@weft/contracts";

export const lifeEventsHandlers: EventHandler[] = [];
