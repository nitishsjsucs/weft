// Wave 4 event handlers (docs/wave4.md). Owner: w4-parity-compliance. Planned: filing.filed, notice.uploaded and training events.
// handlers/index.ts concatenates this array; handlers run as svc_ principals and read payload ids only.
// The compliance calendar refreshes when a run is processed (new wages to report, a new deposit month), when a
// return is filed or a notice resolved (rows turn done), and on the daily tick: a clock move that crosses a PT date.
import type { EventHandler, WeftEvent } from "@weft/contracts";

const source = (evt: WeftEvent) => ({ eventId: evt.id, attended: evt.attended, requestedBy: evt.requestedBy });
const ptDate = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.parse(iso)));

const refresh = (event: string, when: (evt: WeftEvent) => boolean = () => true): EventHandler => ({
  event, principal: "svc_events",
  async handle(evt, sys) {
    if (!when(evt)) return;
    await sys.exec("svc_events", "compliance.refresh_calendar", {}, source(evt));
  },
});

/** A clock move counts as the daily tick when it lands on a later PT date than it started from. */
export function crossesDate(evt: WeftEvent): boolean {
  const p = evt.payload as { from?: unknown; to?: unknown };
  if (typeof p.from !== "string" || typeof p.to !== "string") return false;
  const a = Date.parse(p.from), b = Date.parse(p.to);
  return Number.isFinite(a) && Number.isFinite(b) && ptDate(p.to) > ptDate(p.from);
}

export const complianceHandlers: EventHandler[] = [
  refresh("payroll.processed"), refresh("filing.filed"), refresh("notice.resolved"), refresh("handoff.opened"), refresh("clock.advanced", crossesDate),
];
