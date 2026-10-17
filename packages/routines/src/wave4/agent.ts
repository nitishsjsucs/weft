// Wave 4 routines, prechecks and checklist predicates (docs/wave4.md). Owner: w4-parity-agent. Planned: rt_laptop_hand_delivery (the R14 example with a wait step), rt_portal_question_followup.
// prebuilt.ts, prechecks.ts and checks.ts spread these in; add entries here only. New routines ship disabled unless their
// golden path needs them enabled, keep their tools at 8 or fewer, and use new ids (rt_ prefix).
import type { Precheck, RoutineDef } from "@weft/contracts";
import type { Predicate } from "../checks";

export const routines: RoutineDef[] = [];
export const prechecks: Record<string, Precheck> = {};
export const predicates: Record<string, Predicate> = {};
