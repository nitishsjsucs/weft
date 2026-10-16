// Wave 3 routines, prechecks and checklist predicates (docs/wave3.md). Owner: w3-parity-routines. Planned: rt_new_hire_ready, rt_monthly_exec_report, rt_exec_briefing, rt_milestones, rt_thirty_day_checkin, rt_contractor_forms.
// prebuilt.ts, prechecks.ts and checks.ts spread these in; add entries here only. New routines ship disabled unless their
// golden path needs them enabled, keep their tools at 8 or fewer, and use new ids (rt_ prefix).
import type { Precheck, RoutineDef } from "@weft/contracts";
import type { Predicate } from "../checks";

export const routines: RoutineDef[] = [];
export const prechecks: Record<string, Precheck> = {};
export const predicates: Record<string, Predicate> = {};
