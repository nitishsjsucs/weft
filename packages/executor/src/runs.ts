// RunAuthority (harness 6.1): runs are minted by the executor. The handle is opaque: { runId, token, nonce };
// only the sha256 of the token is stored. Principal, on-behalf-of, kind, surface, company and attended come from
// executor rows on every call.
import { randomBytes } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { AgentKind, HumanSession, RunAuthority, RunHandle } from "@weft/contracts";
import { newId } from "@weft/core";
import { agentRuns, execRuns, routines, runTaint, type Db } from "@weft/db";
import type { Engine } from "./engine";
import { hashToken, resolveRun } from "./scope";
import { agentPrincipalId, loadPrincipal } from "./store";
import { initTaint, readTaint } from "./taint";
import { nonceFromToken } from "./untrusted";
import { writeLocked } from "./write";

export interface WeftRunHandle extends RunHandle { readonly nonce: string }

function handleOf(runId: string, token: string): WeftRunHandle {
  return Object.freeze({ runId, token, nonce: nonceFromToken(token) });
}

interface OpenInput {
  companyId: string; onBehalfOf: string | null; agentKind: AgentKind; surface: "agent" | "mcp"; routineId: string | null;
  routineRunId: string | null; parentRunId: string | null; attended: boolean; taintedBy: string | null; allowlist: readonly string[] | null;
}

async function open(e: Engine, i: OpenInput): Promise<WeftRunHandle> {
  return writeLocked(() => e.db.transaction(async (tx) => {
    const id = await newId(tx, "run_");
    // POST /v1/sim/reset restarts run ids and step numbers in this process, so a new run must not inherit the batch
    // state (keyed by run id and step:<n>) that an earlier run with the same id left behind.
    e.batches.delete(id);
    e.lastBatch.delete(id);
    const token = randomBytes(24).toString("hex");
    const principalId = await agentPrincipalId(tx, i.companyId);
    await tx.insert(execRuns).values({
      id, tokenHash: hashToken(token), companyId: i.companyId, principalId, onBehalfOf: i.onBehalfOf, agentKind: i.agentKind, surface: i.surface,
      routineId: i.routineId, routineRunId: i.routineRunId, parentRunId: i.parentRunId, attended: i.attended, createdAt: e.clock.now(),
      allowlistJson: i.allowlist ? JSON.stringify([...new Set(i.allowlist)].sort()) : null,
    });
    await initTaint(tx, id, i.taintedBy);
    return handleOf(id, token);
  }));
}

/** The routine row's tools, from the database (never from the brain). */
function routineTools(toolsJson: unknown): string[] {
  try {
    const v = typeof toolsJson === "string" ? JSON.parse(toolsJson) : toolsJson;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** The run's frozen allowlist, or null for a test handle opened without one. */
export function runAllowlist(row: { allowlistJson: string | null }): string[] | null {
  if (row.allowlistJson === null || row.allowlistJson === undefined) return null;
  try {
    const v = JSON.parse(row.allowlistJson);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The taint a follow-up inherits from its conversation thread (the Agent page; harness 6.2 provenance): when any earlier
 * run in the thread is tainted (run_taint, or its agent_runs mirror), the new run starts tainted as `thread:<id>`. A
 * thread is a person's own conversation; runs join one only through POST /v1/agent/runs, which records the id on
 * agent_runs.thread_id at creation (never from the model) and refuses a thread that acted for someone else. Any run in
 * the company with the id counts, so a collision can only add taint, never remove it.
 */
export async function threadTaint(db: Db, companyId: string, threadId: string | null | undefined): Promise<string | null> {
  if (!threadId) return null;
  const runs = await db.select({ id: agentRuns.id, tainted: agentRuns.tainted }).from(agentRuns).where(and(eq(agentRuns.companyId, companyId), eq(agentRuns.threadId, threadId)));
  if (runs.length === 0) return null;
  if (runs.some((r) => r.tainted)) return `thread:${threadId}`;
  const [hit] = await db.select({ runId: runTaint.runId }).from(runTaint).where(and(inArray(runTaint.runId, runs.map((r) => r.id)), eq(runTaint.tainted, true))).limit(1);
  return hit ? `thread:${threadId}` : null;
}

export function createRunAuthority(e: Engine): RunAuthority {
  return {
    async openChatRun(session: HumanSession, input) {
      const p = await loadPrincipal(e.db, session.principalId);
      if (!p || p.kind !== "human" || p.companyId !== session.companyId) throw new Error("openChatRun: the session principal is not a human of this company");
      const mcp = input.surface === "mcp" || session.keyScope === "mcp";
      const fromThread = await threadTaint(e.db, p.companyId, input.threadId);
      const taintedBy = [mcp ? "mcp" : null, fromThread].filter((x): x is string => x !== null).join(",") || null;
      return open(e, { companyId: p.companyId, onBehalfOf: p.id, agentKind: "main", surface: mcp ? "mcp" : "agent", routineId: null, routineRunId: null,
        parentRunId: null, attended: true, taintedBy, allowlist: input.allowlist ?? null });
    },
    async openRoutineRun(input) {
      const [r] = await e.db.select().from(routines).where(eq(routines.id, input.routineId)).limit(1);
      if (!r) throw new Error(`openRoutineRun: unknown routine ${input.routineId}`);
      return open(e, { companyId: r.companyId, onBehalfOf: r.ownerPrincipalId, agentKind: "main", surface: "agent", routineId: r.id,
        routineRunId: input.routineRunId, parentRunId: null, attended: input.attended, taintedBy: r.taintedBy ? `routine:${r.id}` : null,
        allowlist: routineTools(r.toolsJson) });
    },
    async openChildRun(parent, kind) {
      const row = await resolveRun(e.db, parent);
      if (!row) throw new Error("openChildRun: unknown parent run handle");
      const taint = await readTaint(e.db, row.id);
      return open(e, { companyId: row.companyId, onBehalfOf: row.onBehalfOf, agentKind: kind, surface: row.surface as "agent" | "mcp", routineId: row.routineId,
        routineRunId: row.routineRunId, parentRunId: row.id, attended: row.attended, taintedBy: taint.tainted ? (taint.taintedBy ?? `run:${row.id}`) : null,
        allowlist: runAllowlist(row) });
    },
  };
}
