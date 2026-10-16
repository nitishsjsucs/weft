// The one policy function (harness 5.4). The only place that combines risk class, approval, autoAllow, taint,
// the batch rules and ceilings. Pure: the pipeline gathers the facts, policy() decides.
import { sql } from "drizzle-orm";
import { W3_SETTINGS, type AgentKind, type PolicyDecision, type RefusalCode, type RiskClass } from "@weft/contracts";
import type { WeftCommand } from "@weft/core";
import type { DbTx } from "@weft/db";
import { loadLimits, readSetting } from "./store";

export const RISK_RANK: Record<RiskClass, number> = { R0: 0, R1: 1, R2: 2, R3: 3, R4: 4 };
export const MAX_OPEN_R4_PER_RUN = 3;
/** Laundering channels into later untainted runs (harness 6.2): refused in tainted runs. */
export const TAINTED_WRITE_COMMANDS: ReadonlySet<string> = new Set(["memory.write_note", "routines.draft", "vault.request"]);

export type Caller = "agent" | "mcp" | "human" | "system" | "readonly" | "approved";

/**
 * Wave 3 (docs/wave3.md, research/wave3/agent-parity.md 5.6): the autonomy of the routine a call runs in. Null for
 * chat, MCP, humans and anything that is not a routine run, which keeps today's (approve) behavior.
 * - recommend: every R2 to R4 write becomes an Inbox suggestion (never a proposal, never executed); reads and R1
 *   drafts and notes still run.
 * - approve: today.
 * - auto, only while allowAuto (setting agent.allow_auto_autonomy, default off) and only in an untainted run: an R2
 *   command that declares autoEligible executes when its amount is known and at or under autoLimitCents (the limits
 *   row named by autoEligible); R3 keeps autoAllow; R4 never executes. A tainted run, the setting off, a missing
 *   limit or an amount over it fall back to approve.
 */
export interface AutonomyFacts { level: "recommend" | "approve" | "auto"; allowAuto: boolean; autoLimitCents: number | null }
/** policy() marks a recommend-level write with suggest: the pipeline files it as a suggestion, not a proposal. */
export type AutonomyDecision = PolicyDecision & { suggest?: true };

/**
 * The fact gatherer for AutonomyFacts (the one read in this file; policy() itself stays pure). The pipeline calls it
 * for agent calls inside a routine run: the routine row's autonomy, the company setting, and the autoEligible limit.
 */
export async function loadAutonomyFacts(tx: DbTx, companyId: string, routineRunId: string, autoEligible: string | null): Promise<AutonomyFacts | null> {
  const [r] = await tx.all<{ autonomy: string }>(sql`SELECT r.autonomy AS autonomy FROM routine_runs rr JOIN routines r ON r.id = rr.routine_id WHERE rr.id = ${routineRunId} LIMIT 1`);
  if (!r || (r.autonomy !== "recommend" && r.autonomy !== "auto")) return null;
  const allowAuto = r.autonomy === "auto" && (await readSetting(tx, W3_SETTINGS.allowAutoAutonomy, false)) === true;
  const autoLimitCents = allowAuto && autoEligible ? ((await loadLimits(tx, companyId)).get(autoEligible) ?? null) : null;
  return { level: r.autonomy, allowAuto, autoLimitCents };
}

export interface PolicyFacts {
  caller: Caller;
  agentKind: AgentKind | null;
  tainted: boolean;
  taintedBy: string | null;
  /** An earlier non-read call in this batch was refused or errored (batch rule a). */
  blockedInBatch: boolean;
  /** An earlier call in this batch returned pending_approval (batch rule b). */
  pendingInBatch: boolean;
  amountCents: number | null;
  ceiling: { key: string; perCall: number | null; day: number | null; daySpent: number } | null;
  /** Open R4 proposals of this run, not counting one this call would supersede. */
  openR4: number;
  /** System principals: whether the command is on the principal's exact allowlist. */
  systemAllowed: boolean;
  /** Wave 3: the routine run's autonomy; absent or null means approve. */
  autonomy?: AutonomyFacts | null;
}

export function riskOf(def: WeftCommand, input: unknown): RiskClass {
  return def.access === "system_only" ? "R1" : def.risk(input);
}

const refuse = (risk: RiskClass, code: RefusalCode, reason: string): PolicyDecision => ({ risk, decision: "refuse", code, reason });
const propose = (risk: RiskClass, reason: string): PolicyDecision => ({ risk, decision: "propose", code: null, reason });
const execute = (risk: RiskClass, reason: string): PolicyDecision => ({ risk, decision: "execute", code: null, reason });

export function policy(def: WeftCommand, input: unknown, run: PolicyFacts): AutonomyDecision {
  const risk = riskOf(def, input);
  const rank = RISK_RANK[risk];
  const read = def.effect === "read";

  if (run.caller === "system") {
    if (!run.systemAllowed) return refuse(risk, "NOT_PERMITTED", `${def.name} is not on this system principal's allowlist`);
    if (rank >= 2) return refuse(risk, "NOT_PERMITTED", "system principals never run R2 or above");
    return execute(risk, "system record");
  }
  if (run.caller === "readonly") {
    return read ? execute(risk, "read") : refuse(risk, "NOT_PERMITTED", "prechecks and checklist predicates may only read");
  }
  if (run.tainted && TAINTED_WRITE_COMMANDS.has(def.name)) {
    return refuse(risk, "TAINTED_WRITE", `This run read untrusted content (${run.taintedBy ?? "external"}), so ${def.name} is refused`);
  }
  if (run.caller === "human") return execute(risk, "human session");

  // Ceilings: per call and the _day aggregate (pending plus executed today plus this call). Over a ceiling the
  // call is refused and cannot be proposed.
  if (run.amountCents !== null && run.ceiling) {
    const c = run.ceiling;
    if (c.perCall !== null && run.amountCents > c.perCall) {
      return refuse(risk, "OVER_CEILING", `${run.amountCents} cents exceeds the per-call ceiling ${c.key} (${c.perCall} cents)`);
    }
    if (c.day !== null && c.daySpent + run.amountCents > c.day) {
      return refuse(risk, "OVER_CEILING", `${c.daySpent + run.amountCents} cents today exceeds the daily ceiling ${c.key}_day (${c.day} cents)`);
    }
  }
  if (run.caller === "approved") return execute(risk, "approved proposal");

  if (run.caller === "mcp") {
    if (def.mcp === "hidden") return refuse(risk, "UNAVAILABLE", `${def.name} is not exposed over MCP`);
    if (def.mcp === "propose") return propose(risk, "MCP write tools always create a proposal");
    return read ? execute(risk, "read") : propose(risk, "MCP calls that change state need approval");
  }

  // Agent calls.
  if (!read && run.blockedInBatch) return refuse(risk, "SKIPPED_AFTER_BLOCK", "an earlier call in this batch was refused or failed");
  if (run.pendingInBatch && def.afterPending === "skip") {
    return refuse(risk, "SKIPPED_AFTER_PENDING", "an earlier call in this batch is waiting for approval, so nothing is computed on that assumption");
  }
  const taintNote = run.tainted ? `This run read untrusted content: ${run.taintedBy ?? "external"}` : null;
  const overApproval = typeof def.approval === "object" && run.amountCents !== null && run.amountCents > def.approval.overCents;
  const needsApproval = def.approval === "always" || overApproval || rank >= 2;

  let decision: PolicyDecision;
  if (rank === 4) {
    decision = propose(risk, taintNote ?? "R4 money movement or admin access always needs approval");
  } else if (rank === 3) {
    const auto = def.autoAllow === "untainted" && run.agentKind === "main" && !run.tainted && !run.pendingInBatch;
    decision = auto ? execute(risk, "auto-allowed: main agent, untainted run")
      : propose(risk, taintNote ?? (run.pendingInBatch ? "an earlier call in this batch is waiting for approval" : "R3 external effects need approval"));
  } else if (rank === 2) {
    decision = propose(risk, taintNote ?? "R2 writes to pay, tax, benefit or employment data always need approval");
  } else {
    decision = needsApproval ? propose(risk, taintNote ?? "this command needs approval") : execute(risk, read ? "read" : "draft or internal note");
  }
  if (decision.decision === "execute" && !read && run.pendingInBatch && def.afterPending === "propose") {
    decision = propose(risk, "an earlier call in this batch is waiting for approval");
  }
  if (decision.decision === "propose" && rank === 4 && run.openR4 >= MAX_OPEN_R4_PER_RUN) {
    return refuse(risk, "NOT_PERMITTED", `at most ${MAX_OPEN_R4_PER_RUN} open R4 proposals per run`);
  }
  return withAutonomy(def, risk, read, decision, run);
}

/** The autonomy layer over the approve-level decision (agent calls only; refusals never reach it). */
function withAutonomy(def: WeftCommand, risk: RiskClass, read: boolean, decision: PolicyDecision, run: PolicyFacts): AutonomyDecision {
  const a = run.autonomy ?? null;
  if (!a || a.level === "approve" || read) return decision;
  const rank = RISK_RANK[risk];
  if (a.level === "recommend") {
    if (rank < 2) return decision;
    return { risk, decision: "propose", code: null, reason: "recommend autonomy: this routine only suggests changes; a person decides whether to make it", suggest: true };
  }
  // auto
  if (rank !== 2 || decision.decision !== "propose") return decision;   // R4 never; R3 keeps autoAllow; R0 and R1 as is
  if (!a.allowAuto) return { ...decision, reason: `${decision.reason} (auto autonomy is off for this company, so this routine runs at approve)` };
  if (run.tainted) return { ...decision, reason: `${decision.reason} (auto falls back to approve in a tainted run)` };
  if (!def.autoEligible) return decision;
  if (run.pendingInBatch) return decision;
  if (run.amountCents === null || a.autoLimitCents === null) return { ...decision, reason: `${decision.reason} (no amount or no ${def.autoEligible} limit, so auto does not apply)` };
  if (run.amountCents > a.autoLimitCents) return { ...decision, reason: `${run.amountCents} cents is over the auto limit ${def.autoEligible} (${a.autoLimitCents} cents), so it needs approval` };
  return { risk, decision: "execute", code: null, reason: `auto autonomy: ${run.amountCents} cents is at or under ${def.autoEligible} (${a.autoLimitCents} cents) in an untainted routine run` };
}
