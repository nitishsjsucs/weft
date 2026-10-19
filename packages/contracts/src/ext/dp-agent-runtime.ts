// Demo polish round 1, agent-runtime (additive only).

/**
 * Routines whose row stays for the record but which no list a person reads should show: folded into another routine,
 * disabled and never run (rt_compliance_notices went into rt_agency_notice in wave 4 round 1). The engine and the
 * routines API keep the row; the gallery and the Routines page leave it out.
 */
export const RETIRED_ROUTINE_IDS: readonly string[] = ["rt_compliance_notices"];
export const isRetiredRoutine = (id: string): boolean => RETIRED_ROUTINE_IDS.includes(id);
