// AgentExecutor: the only executor surface packages/agent may import (harness 6.1). exec(handle, call) is deduped
// on (run_id, call_id). The optional `batch` field on a call names the model turn it came from (batch rules).
import { and, eq, sql } from "drizzle-orm";
import type { AgentCall, AgentExecutor, RunHandle, ToolOutcome } from "@weft/contracts";
import { proposals, withWriteLock } from "@weft/db";
import type { Engine } from "./engine";
import { refusal } from "./outcome";
import { priorCall, recordCall, runInTx } from "./pipeline";
import { agentScope, resolveRun } from "./scope";
import { readTaint } from "./taint";
import { readArtifactInTx } from "./workspace";

export type BatchedAgentCall = AgentCall & { batch?: string | number | null };

/** Without an explicit batch key, the batch is the run's latest model_call step (run_steps, written by the loop). */
async function latestModelStep(tx: Parameters<typeof priorCall>[0], runId: string): Promise<string | null> {
  const [r] = await tx.all<{ n: number | null }>(sql`SELECT max(n) AS n FROM run_steps WHERE run_id = ${runId} AND kind = 'model_call'`);
  return r?.n === null || r?.n === undefined ? null : `step:${r.n}`;
}

const UNKNOWN_HANDLE = (): ToolOutcome => refusal("NOT_PERMITTED", "Unknown or invalid run handle", false);

export function createAgentExecutor(e: Engine): AgentExecutor {
  return {
    registry: e.registry,
    async exec(handle: RunHandle, call: AgentCall) {
      const c = call as BatchedAgentCall;
      if (!c || typeof c.callId !== "string" || !c.callId || typeof c.command !== "string") return refusal("INVALID_INPUT", "A call needs a callId and a command", false);
      return withWriteLock(() => e.db.transaction(async (tx) => {
        const row = await resolveRun(tx, handle);
        if (!row) return UNKNOWN_HANDLE();
        const prior = await priorCall(tx, row.id, c.callId);
        if (prior) return prior;
        const batchKey = c.batch === undefined || c.batch === null ? await latestModelStep(tx, row.id) : String(c.batch);
        const scope = await agentScope(e, tx, row, handle.token, c.callId, batchKey);
        const { outcome, def } = await runInTx(e, tx, scope, c.command, c.args);
        if (scope.batch) {
          if (outcome.ok === false && def && def.effect !== "read" && !outcome.refusal.code.startsWith("SKIPPED_")) scope.batch.blocked = true;
          if (outcome.ok === true && outcome.status === "pending_approval") scope.batch.pending = true;
        }
        await recordCall(tx, row.id, c.callId, c.command, outcome, e.clock.now());
        return outcome;
      }));
    },
    async readArtifact(handle, ref, offset, limit) {
      return withWriteLock(() => e.db.transaction(async (tx) => {
        const row = await resolveRun(tx, handle);
        if (!row) return UNKNOWN_HANDLE();
        const scope = await agentScope(e, tx, row, handle.token, null, null);
        return readArtifactInTx(e, tx, scope, ref, offset, limit);
      }));
    },
    async runState(handle) {
      const row = await resolveRun(e.db, handle);
      if (!row) return { tainted: false, taintedBy: null, pendingProposalIds: [] };
      const t = await readTaint(e.db, row.id);
      const pending = await e.db.select({ id: proposals.id }).from(proposals).where(and(eq(proposals.proposerRunId, row.id), eq(proposals.status, "pending")));
      return { tainted: t.tainted, taintedBy: t.taintedBy, pendingProposalIds: pending.map((p) => p.id) };
    },
  };
}
