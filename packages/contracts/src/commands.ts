// Copied verbatim from research/harness.md section 13 (commands.ts), with the SPEC 9.0 amendments (CommandDef D parameter and deps, access).
import type { ZodType } from "zod";
import type { AgentKind, ToolSpec } from "./provider";
import type { DecisionInput, DecisionResult, ProposalDecided } from "./approvals";

export type Namespace = "people" | "payroll" | "tax" | "notices" | "benefits" | "it" | "comms" | "onboarding"
  | "memory" | "vault" | "actions" | "routines" | "agent" | "code"
  | "documents" | "offboarding" | "contractors";   // wave 2
export type Domain = "people" | "payroll" | "tax" | "benefits" | "it" | "comms" | "company";
export type Grant = "none" | "view" | "edit" | "approve";
export type Effect = "read" | "draft" | "write" | "external";
export type RiskClass = "R0" | "R1" | "R2" | "R3" | "R4";
export type Tier = "executable" | "delegated" | "unavailable";
export type Surface = "agent" | "sandbox" | "mcp" | "api" | "human_ui" | "system";

/** Built by the executor from its own rows. Never constructed by the brain, routines or route handlers. */
export interface ExecContext {
  companyId: string;
  principal: { id: string; kind: "human" | "agent" | "service"; role: string | null };
  onBehalfOf: string | null;
  surface: Surface;
  agentKind: AgentKind | null;
  run: { id: string; stepN: number; parentStepN: number | null; attended: boolean } | null;
  tainted: boolean;                    // read fresh from run_taint for every call
  routineRunId: string | null;
  approvedProposalId: string | null;   // set only by decide() after the CAS in section 5.5
  now: string;                         // sim clock ISO
}

export interface Preview {
  title: string;                       // template over ids, enums, cents, dates, DB-resolved names only
  diff: { label: string; before: string; after: string }[];
  content: { label: string; text: string }[];   // free-text args, escaped, shown in full
  moneyCents: number | null;
  subjectRef: string;
  subjectHash: string;
  evidence: { label: string; ref: string }[];
}

export interface CommandOutput<O> {
  data: O;
  summary: string;
  reverseArgs?: unknown;
  events?: { type: string; subjectRef: string; payload: unknown }[];
  moneyCents?: number;                 // must equal the proposal's money_cents when executing a proposal
  verify?: { ok: boolean; checked: string[] };
}

export type RefusalCode =
  | "UNKNOWN_COMMAND" | "UNAVAILABLE" | "DELEGATED_ONLY" | "INVALID_INPUT" | "UNKNOWN_REFERENCE"
  | "NOT_PERMITTED" | "OVER_CEILING" | "LEASE_HELD" | "PLAN_REQUIRED" | "OUT_OF_PHASE" | "NOT_DONE"
  | "SKIPPED_AFTER_BLOCK" | "SKIPPED_AFTER_PENDING" | "TAINTED_WRITE" | "BLOCKED_LINES" | "UNGROUNDED"
  | "SANDBOX_NOT_ALLOWED" | "SANDBOX_TIMEOUT" | "SANDBOX_OOM" | "CALL_BUDGET"
  | "BUDGET_EXCEEDED" | "PII_IN_MEMORY" | "SECRET_IN_MEMORY" | "MISSING_SOURCE" | "STALE_SUBJECT" | "INTERNAL"
  | `DOMAIN_${string}`;                // track-owned domain refusals

export interface CommandDef<I = unknown, O = unknown, D = unknown> {
  name: `${Namespace}.${string}`;
  namespace: Namespace;
  summary: string;
  description: string;                 // <= 400 chars
  compactDescription: string;          // <= 200 chars (P1 local models)
  input: ZodType<I>;                   // optional fields .optional(); the executor maps null to undefined first
  domain: Domain;
  needs: Exclude<Grant, "none">;
  effect: Effect;
  risk: (i: I) => RiskClass;
  approval: "never" | "always" | { overCents: number };
  autoAllow: "never" | "untainted";    // R3 only; never for task agents
  amountCents: ((i: I, ctx: ExecContext, deps: D) => Promise<number | null>) | null;   // from DB rows, never args
  ceilingKey: string | null;           // per call; `${ceilingKey}_day` for the daily aggregate
  reversible: false | { reverse: string };
  lease: ((i: I) => string) | null;
  tiers: { main: Tier; task: Tier };
  mcp: "hidden" | "read" | "propose";
  sandbox: "hidden" | "read";
  /** SPEC 9.0 amendment 2: human_only and system_only commands have tiers "unavailable" and mcp "hidden". */
  access: "all" | "human_only" | "system_only";
  untrustedFields: string[];           // dotted paths; non-empty in the result => wrap and taint
  afterPending: "run" | "skip" | "propose";   // batch rule (b), section 4.6
  errorHints: Partial<Record<RefusalCode, { hint: string; example: unknown }>>;
  preview: ((i: I, ctx: ExecContext, deps: D) => Promise<Preview>) | null;   // required when approval != "never"
  run(i: I, ctx: ExecContext, deps: D): Promise<CommandOutput<O>>;
}

export type ToolOutcome<O = unknown> =
  | { ok: true; status: "done"; resultId: string; data: O; summary: string; actionSeq: number | null; artifactRef: string | null; tainted: boolean; label: "synthetic" }
  | { ok: true; status: "pending_approval"; proposalId: string; title: string; expiresAt: string; tainted: boolean }
  | { ok: false; refusal: { code: RefusalCode; message: string; hint: string | null; example: unknown }; tainted: boolean };

export interface PolicyDecision { risk: RiskClass; decision: "execute" | "propose" | "refuse"; code: RefusalCode | null; reason: string }

export interface RegistryView {
  get(nameOrWire: string): Readonly<Pick<CommandDef, "name" | "description" | "effect" | "tiers" | "mcp">> | undefined;
  toolSpecs(input: { agentKind: AgentKind; allowlist: string[] }): ToolSpec[];   // sorted, frozen for the run; throws over 16
  wireName(name: string): string;
}

/** Opaque. The executor resolves it to its exec_runs row on every call. */
export interface RunHandle { readonly runId: string; readonly token: string }

export interface AgentCall { callId: string; command: string; args: unknown }   // command: registry or wire name

/** The only executor surface packages/agent may import. */
export interface AgentExecutor {
  registry: RegistryView;
  exec(run: RunHandle, call: AgentCall): Promise<ToolOutcome>;   // deduped on (runId, callId)
  readArtifact(run: RunHandle, ref: string, offset: number, limit: number): Promise<ToolOutcome>;
  runState(run: RunHandle): Promise<{ tainted: boolean; taintedBy: string | null; pendingProposalIds: string[] }>;
}

/** Prechecks and checklist predicates. exec refuses anything but effect "read". */
export interface ReadOnlyExecutor { exec(companyId: string, command: string, args: unknown): Promise<ToolOutcome> }

/** apps/api routes (authenticated session) and the routine engine (routine id only). */
export interface RunAuthority {
  /** `allowlist` is frozen on the run; the executor refuses any other command from it (harness 5.3). Every route passes one. */
  openChatRun(session: HumanSession, input: { threadId: string | null; surface: "human_ui" | "mcp"; allowlist?: readonly string[] }): Promise<RunHandle>;
  openRoutineRun(input: { routineId: string; routineRunId: string; triggerRef: string; attended: boolean }): Promise<RunHandle>;
  openChildRun(parent: RunHandle, kind: AgentKind): Promise<RunHandle>;   // P1; inherits taint
}
export type RoutineRunAuthority = Pick<RunAuthority, "openRoutineRun">;

/** Harness 5.3: chat and MCP agent.ask, read-only in P0, exactly 14 tools. */
export const CHAT_TOOLS = [
  "people.search", "people.get", "payroll.list_runs", "payroll.get_run", "tax.get_rates", "tax.list_registrations", "notices.list", "notices.get",
  "actions.list", "actions.get_run", "memory.search", "memory.read", "agent.read_artifact", "comms.post_update",
] as const;
/** The routine_draft recipe's run allowlist. */
export const DRAFT_TOOLS = ["routines.draft", "routines.list"] as const;

/** Imported only by apps/api routes. Banned in packages/agent and packages/routines by the import scan. */
export interface HumanExecutor {
  exec(session: HumanSession, command: string, args: unknown): Promise<ToolOutcome>;
  decide(input: DecisionInput): Promise<DecisionResult>;
  rollback(session: HumanSession, input: { seq: number; reason: string }): Promise<ToolOutcome>;
  onProposalDecided(cb: (p: ProposalDecided) => Promise<void>): void;
}

/** Produced by apps/api auth middleware from the UI session or an API key row; never from a request body. */
export interface HumanSession { principalId: string; companyId: string; via: "ui" | "api_key"; keyScope: "mcp" | "cli" | "admin" | null }
