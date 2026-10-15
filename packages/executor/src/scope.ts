// ExecContext is derived from executor rows on every call (harness 6.1). Caller-supplied values do not exist.
import { createHash, timingSafeEqual } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { AgentKind, ExecContext, HumanSession, RunHandle, Surface } from "@weft/contracts";
import { execRuns, type DbTx } from "@weft/db";
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
    run: row,
    batch,
    callId,
    systemAllowed: false,
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
