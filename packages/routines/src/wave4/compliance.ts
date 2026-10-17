// Wave 4 routines, prechecks and checklist predicates (docs/wave4.md). Owner: w4-parity-compliance. Planned: rt_compliance_calendar (deadline reminders), rt_quarterly_filings, rt_training_due; rt_agency_notice gains the other notice kinds through its own precheck file.
// prebuilt.ts, prechecks.ts and checks.ts spread these in; add entries here only. New routines ship disabled unless their
// golden path needs them enabled, keep their tools at 8 or fewer, and use new ids (rt_ prefix).
import type { Precheck, RoutineDef } from "@weft/contracts";
import type { Predicate } from "../checks";

export const routines: RoutineDef[] = [];
export const prechecks: Record<string, Precheck> = {};
export const predicates: Record<string, Predicate> = {};
