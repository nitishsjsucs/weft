// Wave 3 routines, prechecks and checklist predicates (docs/wave3.md). Owner: w3-expenses. Planned: rt_expense_review.
// prebuilt.ts, prechecks.ts and checks.ts spread these in; add entries here only. New routines ship disabled unless their
// golden path needs them enabled, keep their tools at 8 or fewer, and use new ids (rt_ prefix).
import type { Precheck, RoutineDef } from "@weft/contracts";
import type { Predicate } from "../checks";

export const routines: RoutineDef[] = [];
export const prechecks: Record<string, Precheck> = {};
export const predicates: Record<string, Predicate> = {};
