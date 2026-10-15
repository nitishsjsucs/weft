// Copied verbatim from research/harness.md section 13 (routines.ts).
import type { ReadOnlyExecutor } from "./commands";
export type RoutineTrigger = { type: "event"; event: string } | { type: "cron"; cron: string; tz: string } | { type: "manual" };
export type PrecheckResult =
  | { action: "skip"; reason: string }
  | { action: "run"; findings: unknown; derivedArgs: Record<string, unknown> | null; severity: "interrupt" | "digest"; subjectRefs: string[] };

export interface ChecklistItem { id: string; label: string; check: string }   // check: "<predicate>:<template over trigger fields>"

export interface RoutineDef {
  id: string; name: string; description: string;
  ownerPrincipalId: string; enabled: boolean;
  autonomy: "recommend" | "approve";               // P0 enforces approve
  trigger: RoutineTrigger; filter: Record<string, unknown> | null;
  instructions: string;
  tools: string[];                                 // registry names, <= 8, enum of main-tier names
  precheck: string | null;
  checklist: ChecklistItem[];                      // isDone = every item passes
  budget: { steps: number; usd: number; minutes: number };
  surface: { worthSurfacing: boolean; channel: string | null };
  source: "prebuilt" | "custom";
  taintedBy: string | null;                        // set when drafted in a tainted run; every run starts tainted
}

export type RoutineRunStatus = "queued" | "running" | "waiting_approval" | "waiting_event" | "done" | "failed" | "cancelled" | "skipped";
export interface RoutineRun {
  id: string; routineId: string; runKey: string; triggerRef: string; status: RoutineRunStatus;
  agentRunId: string | null; precheck: PrecheckResult | null; summary: string | null;
  leftForHuman: string[]; surfaceHash: string | null; overdue: boolean; attended: boolean;
  startedAt: string | null; endedAt: string | null; costUsdMicros: number;
}

export type Precheck = (ctx: { companyId: string; now: string; triggerRef: string; payload: unknown }, exec: ReadOnlyExecutor) => Promise<PrecheckResult>;
export type CheckPredicate = (arg: string, ctx: { companyId: string; agentRunId: string }, exec: ReadOnlyExecutor) => Promise<boolean>;
