// Routines engine (SPEC 9.7, harness 4.3 and 8). Owner: t4-agent.
import { NotImplemented, type AgentRuntime, type ReadOnlyExecutor, type RoutineRunAuthority, type RoutinesEngine, type SimClock } from "@weft/contracts";
import type { Db } from "@weft/db";

export interface CreateRoutinesOptions { db: Db; clock: SimClock; agent: AgentRuntime; runs: RoutineRunAuthority; readOnly: ReadOnlyExecutor }
export function createRoutines(_opts: CreateRoutinesOptions): RoutinesEngine {
  throw new NotImplemented("createRoutines (t4-agent)");
}
