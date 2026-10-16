// Wave 2 routines, prechecks and checklist predicates for the open enrollment chase and carrier reconciliation routines. Owner: w2-benefits-contractors (docs/wave2.md).
// prebuilt.ts, prechecks.ts and checks.ts spread these maps in; add entries here only. Routine ids must be new (rt_ prefix).
import type { Precheck, RoutineDef } from "@weft/contracts";
import type { Predicate } from "../checks";

export const routines: RoutineDef[] = [];
export const prechecks: Record<string, Precheck> = {};
export const predicates: Record<string, Predicate> = {};
