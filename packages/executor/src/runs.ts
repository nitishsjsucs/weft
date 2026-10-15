// RunAuthority (harness 6.1): runs are minted by the executor. The handle is opaque: { runId, token, nonce };
// only the sha256 of the token is stored. Principal, on-behalf-of, kind, surface, company and attended come from
// executor rows on every call.
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { AgentKind, HumanSession, RunAuthority, RunHandle } from "@weft/contracts";
import { newId } from "@weft/core";
import { execRuns, routines, withWriteLock } from "@weft/db";
import type { Engine } from "./engine";
import { hashToken, resolveRun } from "./scope";
import { agentPrincipalId, loadPrincipal } from "./store";
import { initTaint, readTaint } from "./taint";
import { nonceFromToken } from "./untrusted";

export interface WeftRunHandle extends RunHandle { readonly nonce: string }

function handleOf(runId: string, token: string): WeftRunHandle {
  return Object.freeze({ runId, token, nonce: nonceFromToken(token) });
}

interface OpenInput {
  companyId: string; onBehalfOf: string | null; agentKind: AgentKind; surface: "agent" | "mcp"; routineId: string | null;
  routineRunId: string | null; parentRunId: string | null; attended: boolean; taintedBy: string | null;
}

async function open(e: Engine, i: OpenInput): Promise<WeftRunHandle> {
  return withWriteLock(() => e.db.transaction(async (tx) => {
    const id = await newId(tx, "run_");
    const token = randomBytes(24).toString("hex");
    const principalId = await agentPrincipalId(tx, i.companyId);
    await tx.insert(execRuns).values({
      id, tokenHash: hashToken(token), companyId: i.companyId, principalId, onBehalfOf: i.onBehalfOf, agentKind: i.agentKind, surface: i.surface,
      routineId: i.routineId, routineRunId: i.routineRunId, parentRunId: i.parentRunId, attended: i.attended, createdAt: e.clock.now(),
    });
    await initTaint(tx, id, i.taintedBy);
    return handleOf(id, token);
  }));
}

export function createRunAuthority(e: Engine): RunAuthority {
  return {
    async openChatRun(session: HumanSession, input) {
      const p = await loadPrincipal(e.db, session.principalId);
      if (!p || p.kind !== "human" || p.companyId !== session.companyId) throw new Error("openChatRun: the session principal is not a human of this company");
      const mcp = input.surface === "mcp" || session.keyScope === "mcp";
      return open(e, { companyId: p.companyId, onBehalfOf: p.id, agentKind: "main", surface: mcp ? "mcp" : "agent", routineId: null, routineRunId: null,
        parentRunId: null, attended: true, taintedBy: mcp ? "mcp" : null });
    },
    async openRoutineRun(input) {
      const [r] = await e.db.select().from(routines).where(eq(routines.id, input.routineId)).limit(1);
      if (!r) throw new Error(`openRoutineRun: unknown routine ${input.routineId}`);
      return open(e, { companyId: r.companyId, onBehalfOf: r.ownerPrincipalId, agentKind: "main", surface: "agent", routineId: r.id,
        routineRunId: input.routineRunId, parentRunId: null, attended: input.attended, taintedBy: r.taintedBy ? `routine:${r.id}` : null });
    },
    async openChildRun(parent, kind) {
      const row = await resolveRun(e.db, parent);
      if (!row) throw new Error("openChildRun: unknown parent run handle");
      const taint = await readTaint(e.db, row.id);
      return open(e, { companyId: row.companyId, onBehalfOf: row.onBehalfOf, agentKind: kind, surface: row.surface as "agent" | "mcp", routineId: row.routineId,
        routineRunId: row.routineRunId, parentRunId: row.id, attended: row.attended, taintedBy: taint.tainted ? (taint.taintedBy ?? `run:${row.id}`) : null });
    },
  };
}
