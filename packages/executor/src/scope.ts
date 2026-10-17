// ExecContext is derived from executor rows on every call (harness 6.1). Caller-supplied values do not exist.
import { createHash, timingSafeEqual } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { AgentActionOverrideMode, AgentKind, ExecContext, HumanSession, RunHandle, Surface } from "@weft/contracts";
import { agentActionOverrides, execRuns, type DbTx } from "@weft/db";
import type { BatchState, Engine } from "./engine";
import type { Caller } from "./policy";
import { agentPrincipalId, capAgent, intersect, loadAgentGrants, loadPrincipal, noGrants, type Grants } from "./store";
import { readTaint } from "./taint";
import { nonceFromToken, randomNonce } from "./untrusted";

export type ExecRunRow = typeof execRuns.$inferSelect;
export type ActorKind = "human" | "agent" | "routine" | "system";

export interface CallScope {
  caller: Caller;
  ctx: ExecContext;
  grants: Grants;
  taintedBy: string | null;
  nonce: string | null;
  actor: { kind: ActorKind; id: string };
  stamp: { attended: boolean; requestedBy: string | null };
  run: ExecRunRow | null;
  batch: BatchState | null;
  callId: string | null;
  systemAllowed: boolean;
  /** Wave 4 (w4-parity-admin): per-action narrowing of an agent run below its domain grant. Absent outside agent runs. */
  overrides?: ActionOverrides;
}

// ------------------------------------------------------------------------------------------------ per-action overrides (G1)
//
// A person (or an admin for the agent itself) narrows the agent per command below the domain grant: `deny` takes the
// command away and `propose_only` makes every call to it a proposal. The agent's own row binds every run; a person's
// row binds the runs that act for them. Overrides are rows in agent_action_overrides, written only by an approved
// settings.set_agent_action_override proposal. They only ever narrow: nothing here widens a grant or an allowlist.

export interface ActionOverrides { deny: ReadonlySet<string>; proposeOnly: ReadonlySet<string> }
export const NO_OVERRIDES: ActionOverrides = Object.freeze({ deny: new Set<string>(), proposeOnly: new Set<string>() });

/** The overrides binding a run of `agentId` acting for `onBehalfOf`; deny wins when the two rows disagree. */
export async function loadActionOverrides(tx: DbTx, companyId: string, principalIds: readonly (string | null | undefined)[]): Promise<ActionOverrides> {
  const ids = [...new Set(principalIds.filter((x): x is string => !!x))];
  if (!ids.length) return NO_OVERRIDES;
  const rows = await tx.select({ command: agentActionOverrides.command, mode: agentActionOverrides.mode }).from(agentActionOverrides)
    .where(and(eq(agentActionOverrides.companyId, companyId), inArray(agentActionOverrides.principalId, ids)));
  if (!rows.length) return NO_OVERRIDES;
  const deny = new Set(rows.filter((r) => r.mode === "deny").map((r) => r.command));
  const proposeOnly = new Set(rows.filter((r) => r.mode === "propose_only" && !deny.has(r.command)).map((r) => r.command));
  return { deny, proposeOnly };
}

/** An allowlist without the denied commands: the tool list the model is shown for this run (harness 5.3 stays a subset). */
export function narrowAllowlist(allowlist: readonly string[], o: ActionOverrides): string[] {
  return o.deny.size ? allowlist.filter((n) => !o.deny.has(n)) : [...allowlist];
}

/** The override for one command in a call scope (the pipeline reads it after the domain grant check). */
export function actionOverrideOf(scope: Pick<CallScope, "caller" | "overrides">, command: string): AgentActionOverrideMode | null {
  if (scope.caller !== "agent" || !scope.overrides) return null;
  if (scope.overrides.deny.has(command)) return "deny";
  return scope.overrides.proposeOnly.has(command) ? "propose_only" : null;
}

/** propose_only turns an execute into a propose for any non-read; a refusal or an existing proposal stays as it is. */
export function narrowDecision<D extends { decision: "execute" | "propose" | "refuse"; reason: string }>(decision: D, mode: AgentActionOverrideMode | null, isRead: boolean): D {
  if (mode !== "propose_only" || isRead || decision.decision !== "execute") return decision;
  return { ...decision, decision: "propose", reason: "a per-action override makes this command always a proposal for the agent" };
}

/**
 * The run row an agent call sees, with denied commands taken off its frozen allowlist, so the pipeline's allowlist
 * check refuses them as UNAVAILABLE. A run opened without an allowlist (test handles) gets every registered command
 * but the denied ones, which is the same set it could call before, minus the denials.
 */
function narrowedRun(e: Engine, row: ExecRunRow, o: ActionOverrides): ExecRunRow {
  if (!o.deny.size) return row;
  let allow: string[];
  try {
    const parsed = row.allowlistJson === null || row.allowlistJson === undefined ? null : JSON.parse(row.allowlistJson);
    allow = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : parsed === null ? e.registry.all().map((d) => d.name) : [];
  } catch { allow = []; }
  return { ...row, allowlistJson: JSON.stringify(narrowAllowlist(allow, o).sort()) };
}

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function resolveRun(tx: DbTx, handle: RunHandle): Promise<ExecRunRow | null> {
  if (!handle || typeof handle.runId !== "string" || typeof handle.token !== "string") return null;
  const [row] = await tx.select().from(execRuns).where(eq(execRuns.id, handle.runId)).limit(1);
  if (!row || !sameHash(row.tokenHash, hashToken(handle.token))) return null;
  return row;
}

/** Effective grants of an agent run: the agent's grants intersected with the on-behalf-of principal's, approve capped at edit. */
export async function runGrants(tx: DbTx, row: Pick<ExecRunRow, "companyId" | "onBehalfOf">): Promise<Grants> {
  const agent = await loadAgentGrants(tx, row.companyId);
  if (!row.onBehalfOf) return agent;
  const p = await loadPrincipal(tx, row.onBehalfOf);
  return capAgent(intersect(agent, p?.grants ?? noGrants()));
}

export async function agentScope(e: Engine, tx: DbTx, row: ExecRunRow, token: string, callId: string | null, batchKey: string | null): Promise<CallScope> {
  const taint = await readTaint(tx, row.id);
  const principal = await loadPrincipal(tx, row.principalId);
  const [c] = await tx.all<{ n: number }>(sql`SELECT count(*) AS n FROM exec_calls WHERE run_id = ${row.id}`);
  const key = batchKey ?? "run";
  if (e.lastBatch.get(row.id) !== key) { e.lastBatch.set(row.id, key); e.batches.delete(row.id); }
  let batch = e.batches.get(row.id);
  if (!batch) { batch = { blocked: false, pending: false }; e.batches.set(row.id, batch); }
  const overrides = await loadActionOverrides(tx, row.companyId, [row.principalId, row.onBehalfOf]);
  return {
    caller: "agent",
    ctx: {
      companyId: row.companyId,
      principal: { id: row.principalId, kind: "agent", role: principal?.role ?? null },
      onBehalfOf: row.onBehalfOf,
      surface: row.surface as Surface,
      agentKind: row.agentKind as AgentKind,
      run: { id: row.id, stepN: (c?.n ?? 0) + 1, parentStepN: null, attended: row.attended },
      tainted: taint.tainted,
      routineRunId: row.routineRunId,
      approvedProposalId: null,
      now: e.clock.now(),
    },
    grants: await runGrants(tx, row),
    taintedBy: taint.taintedBy,
    nonce: nonceFromToken(token),
    actor: { kind: row.routineRunId ? "routine" : "agent", id: row.principalId },
    stamp: { attended: row.attended, requestedBy: row.onBehalfOf },
    run: narrowedRun(e, row, overrides),
    batch,
    callId,
    systemAllowed: false,
    overrides,
  };
}

export function surfaceOfSession(s: HumanSession): Surface {
  if (s.via === "ui") return "human_ui";
  return s.keyScope === "mcp" ? "mcp" : "api";
}

export async function humanScope(e: Engine, tx: DbTx, s: HumanSession): Promise<CallScope | null> {
  const p = await loadPrincipal(tx, s.principalId);
  if (!p || p.kind !== "human" || p.companyId !== s.companyId) return null;
  const surface = surfaceOfSession(s);
  return {
    caller: surface === "mcp" ? "mcp" : "human",
    ctx: {
      companyId: p.companyId, principal: { id: p.id, kind: "human", role: p.role }, onBehalfOf: null, surface, agentKind: null,
      run: null, tainted: surface === "mcp", routineRunId: null, approvedProposalId: null, now: e.clock.now(),
    },
    grants: p.grants,
    taintedBy: surface === "mcp" ? "mcp" : null,
    nonce: surface === "mcp" ? randomNonce() : null,
    actor: { kind: "human", id: p.id },
    stamp: { attended: true, requestedBy: p.id },
    run: null, batch: null, callId: null, systemAllowed: false,
  };
}

export async function readonlyScope(e: Engine, tx: DbTx, companyId: string): Promise<CallScope> {
  const id = await agentPrincipalId(tx, companyId);
  return {
    caller: "readonly",
    ctx: {
      companyId, principal: { id, kind: "agent", role: null }, onBehalfOf: null, surface: "system", agentKind: null, run: null,
      tainted: false, routineRunId: null, approvedProposalId: null, now: e.clock.now(),
    },
    grants: await loadAgentGrants(tx, companyId),
    taintedBy: null, nonce: null, actor: { kind: "system", id }, stamp: { attended: false, requestedBy: null },
    run: null, batch: null, callId: null, systemAllowed: false,
  };
}
