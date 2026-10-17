// Wave 4 routines, prechecks and checklist predicates (docs/wave4.md). Owner: w4-parity-people. Planned: rt_life_event_window, rt_benefits_window_reminders, rt_first_day_message, rt_open_enrollment lifecycle.
// prebuilt.ts, prechecks.ts and checks.ts spread these in; add entries here only. New routines ship disabled unless their
// golden path needs them enabled, keep their tools at 8 or fewer, and use new ids (rt_ prefix).
import type { Precheck, RoutineDef } from "@weft/contracts";
import type { Predicate } from "../checks";

export const routines: RoutineDef[] = [];
export const prechecks: Record<string, Precheck> = {};
export const predicates: Record<string, Predicate> = {};
