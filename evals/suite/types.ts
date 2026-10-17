// The eval suite's internal shapes (research/wave4/evals.md sections 4 and 6). Owner: w4-eval-suite.
// Graders are pure functions of TrialEvidence, so they are unit-tested on scripted runs and hand-built fixtures
// without a database; the runner collects the evidence from a trial world (evidence.ts).
import type { EvalExpectation, EvalTask, EvalTrialResult, GraderVerdict } from "../../packages/contracts/src/evals";
import type { EvalVariant } from "../../packages/contracts/src/telemetry";
import type { RiskClass } from "../../packages/contracts/src/commands";

export type { EvalExpectation, EvalTask, EvalTrialResult, EvalVariant, GraderVerdict };

/** What G1 needs from the registry for one command (CommandDef's risk, approval, autoAllow, effect and access). */
export interface CommandFacts {
  name: string;
  effect: "read" | "draft" | "write" | "external";
  approval: "never" | "always" | { overCents: number };
  autoAllow: "never" | "untainted";
  access: "all" | "human_only" | "system_only";
  risk(args: unknown): RiskClass;
}
export type RegistryLookup = (command: string) => CommandFacts | null;

export interface EvRun {
  id: string; kind: string; parentRunId: string | null; routineRunId: string | null; status: string; terminalReason: string | null;
  tainted: boolean; taintedBy: string | null; stepsUsed: number; costUsd: number; summary: string | null;
  /** The run's model ("template" for the deterministic routine templates a live unattended run uses). */
  model?: string | null;
}
export interface EvStep {
  runId: string; n: number; parentN: number | null; stage: string; kind: string; toolName: string | null; toolArgs: unknown;
  outcome: string | null; result: unknown; native: unknown; costUsdMicros: number;
  usage: { input?: number; cached?: number; output?: number; reasoning?: number } | null;
  timings: { modelMs?: number; timeToLlmMs?: number } | null;
}
export interface EvAction {
  seq: number; command: string; args: unknown; actorKind: string; actorId: string; agentRunId: string | null; routineRunId: string | null;
  proposalId: string | null; summary: string;
}
export interface EvProposal {
  id: string; kind: string; command: string | null; args: unknown; status: string; risk: string | null; decidedBy: string | null;
  proposerRunId: string | null; routineRunId: string | null; headline: string; agentNote: string | null;
}
export interface EvMessage { id: string; surface: "chat" | "email"; channel: string | null; to: string | null; from: string | null; text: string; inbound: boolean }
export interface EvMemory {
  headBefore: string | null; headAfter: string | null;
  commits: { sha: string; subject: string; author: string }[];
  changed: string[];
  /** Text of every file at HEAD after the trial plus every commit message, for the canary scan. */
  texts: { path: string; text: string }[];
}

/** Everything a grader may look at for one trial. Collected after the trial settles. */
export interface TrialEvidence {
  /** The run the trial started (chat run, or the routine run's agent run); null when none started. */
  mainRunId: string | null;
  runs: EvRun[];
  steps: EvStep[];
  /** Action rows written during the trial (seq after setup). */
  actions: EvAction[];
  /** Proposal rows created during the trial. */
  proposals: EvProposal[];
  /** Proposal rows that existed before the trial, for G1's approval lookups. */
  priorProposals: EvProposal[];
  messages: EvMessage[];
  memory: EvMemory;
  /** Exported OTLP payloads (protobuf or JSON bodies as latin1 text) captured so far. */
  otlp: string[];
  /** Canary values planted before the trial (vault and fixture); never legitimately in any output. */
  canaries: string[];
  registry: RegistryLookup;
  endState: { sql: string; equals: unknown; actual: unknown }[];
  wallMs: number;
  /** A driver or harness error that stopped the trial. */
  error: string | null;
}

/** The runner's trial record: the contract's EvalTrialResult plus the counts the report aggregates. */
export interface TrialDetail {
  proposals: { matched: number; actual: number; expected: number; exactArgs: number } | null;
  invalidInput: number; unknownReference: number; unknownCommand: number;
  groundingFallback: boolean;
  unsafe: { g1: number; taintMiss: number; canaryHits: number };
  triggering: { missedClarify: boolean; unneededClarify: boolean; falseRefusal: boolean; missedRefusal: boolean };
  timeToFirstModelMs: number | null; modelMs: number;
  /** World digest the trial ran on. */
  digest: string | null;
  /** chat_can_propose setting read back from the trial world (proves variant isolation). */
  chatCanPropose: boolean;
  finalText: string | null;
  /** Actions written during the trial (command, actor, run): the first place to look when an end-state check fails. */
  actions: { seq: number; command: string; actor: string; run: string | null; summary: string }[];
  /** Commands and outcomes of every tool call, in order. */
  calls: { run: string; tool: string | null; outcome: string | null }[];
}
export type SuiteTrial = EvalTrialResult & { detail: TrialDetail };
