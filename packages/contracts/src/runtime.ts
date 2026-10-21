// SPEC 9.0: factory and runtime interfaces (frozen after the scaffold commit).
import type { AgentExecutor, HumanExecutor, ReadOnlyExecutor, RegistryView, RunAuthority, RunHandle, ToolOutcome } from "./commands";
import type { MemoryStore } from "./memory";
import type { NoticeKind } from "./provider";
import type { PrecheckResult, RoutineDef, RoutineRun } from "./routines";
import type { RunStepRow, RunTrace } from "./trace";
import type { ProposalDecided } from "./approvals";

export interface SimClock { now(): string; rate(): number; advance(to: string): Promise<void>; set(to: string, rate?: number): Promise<void> }
// svc_jobs (Weft on Cloudflare, docs/cloudflare/design.md 5.4): the queue write-backs; it has an allowlist only where the
// durable platform registers them (extraCommands), so on Node it can run nothing.
export type SystemPrincipal = "svc_scheduler" | "svc_events" | "svc_sim" | "svc_digest" | "svc_jobs";
export interface SystemExecutor { exec(principal: SystemPrincipal, command: string, args: unknown, source: { eventId: string | null; attended: boolean; requestedBy: string | null }): Promise<ToolOutcome> }
export interface VaultAdmin { put(input: { name: string; kind: string; value: string; description: string; by: string }): Promise<void>; list(): Promise<{ name: string; kind: string; fingerprint: string }[]> }
export interface ChainStatus { ok: boolean; head: { seq: number; hash: string } | null; gaps: number[]; badSeq: number | null; gitLag: number; /** Wave 2 review: signed documents whose text, hash or action row disagree. */ signatureProblems?: string[] }
export interface ExecutorBundle {
  agent: AgentExecutor; readOnly: ReadOnlyExecutor; runs: RunAuthority; human: HumanExecutor; system: SystemExecutor;
  vault: VaultAdmin; memory: MemoryStore; registry: RegistryView;
  expireProposals(now: string): Promise<number>; verifyChain(): Promise<ChainStatus>; redact(text: string): string; close(): Promise<void>;
}
export interface WeftEvent { id: string; type: string; ts: string; subjectRef: string; payload: Record<string, string>; attended: boolean; requestedBy: string | null }
export interface EventHandler { event: string; principal: SystemPrincipal; handle(evt: WeftEvent, sys: SystemExecutor, read: ReadOnlyExecutor): Promise<void> }
export interface AgentRuntime {
  boot(): Promise<void>;                                            // boot rule PROCESS_RESTART
  /** `allowlist` (wave 3, additive): the chat tools the API chose for this run (CHAT_TOOLS_W3 or CHAT_ACT_TOOLS); omitted means CHAT_TOOLS. */
  startChat(run: RunHandle, input: { text: string; recipe: "chat" | "routine_draft"; pageContext: string | null; allowlist?: readonly string[] }): Promise<void>;
  startRoutineRun(run: RunHandle, input: { routine: RoutineDef; routineRun: RoutineRun; trigger: WeftEvent | null; precheck: PrecheckResult }): Promise<void>;
  requeue(runId: string, notice: { kind: NoticeKind; attrs: Record<string, string>; text: string }): Promise<void>;
  cancel(runId: string): Promise<void>;
  subscribe(runId: string, cb: (step: RunStepRow) => void): () => void;
  trace(runId: string): Promise<RunTrace>;
}
export interface RoutinesEngine {
  tick(now: string): Promise<void>;                                 // cron slots since cursor, then unconsumed events
  trigger(routineId: string, input: { attended: boolean; requestedBy: string | null }): Promise<{ routineRunId: string }>;
  onProposalDecided(p: ProposalDecided): Promise<void>;            // checklist first: zero-token wake
}
export interface Scheduler { tick(): Promise<void>; kick(): Promise<void>; start(): void; stop(): Promise<void> }
