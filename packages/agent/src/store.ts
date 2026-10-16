// The run store (SPEC 6.5): agent_runs and run_steps only. agent_runs.id equals exec_runs.id (the RunAuthority mints
// the id first and the brain reuses it). Brain writes are single statements under the process write lock.
import { and, asc, eq, inArray } from "drizzle-orm";
import { agentRuns, runSteps, routineRuns, type Db } from "@weft/db";
import { lockedWrite } from "./busy";
import type { AgentRunRow, RunStepRow, RunStatus, TerminalReason, Usage } from "@weft/contracts";

type AgentRunInsert = typeof agentRuns.$inferInsert;
type AgentRunSelect = typeof agentRuns.$inferSelect;
type RunStepSelect = typeof runSteps.$inferSelect;

const parse = <T>(s: string | null | undefined, d: T): T => {
  if (s === null || s === undefined) return d;
  try { return JSON.parse(s) as T; } catch { return d; }
};
const str = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));

function toRow(r: AgentRunSelect): AgentRunRow {
  return {
    id: r.id, companyId: r.companyId, kind: r.kind as AgentRunRow["kind"], parentRunId: r.parentRunId, threadId: r.threadId, routineRunId: r.routineRunId,
    trigger: r.trigger, attended: Boolean(r.attended), provider: r.provider as AgentRunRow["provider"], model: r.model, effort: r.effort as AgentRunRow["effort"],
    cacheKey: r.cacheKey, status: r.status as RunStatus, terminalReason: (r.terminalReason as TerminalReason | null) ?? null,
    tainted: Boolean(r.tainted), taintedBy: r.taintedBy, checklist: parse(r.checklistJson, null), budget: parse(r.budgetJson, { steps: 0, usd: 0, minutes: 0 }),
    stepsUsed: r.stepsUsed, requeues: r.requeues, consecutiveErrors: r.consecutiveErrors, costUsdMicros: r.costUsdMicros,
    tokens: parse<Usage>(r.tokensJson, { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 }), createdAt: r.createdAt, endedAt: r.endedAt, summary: r.summary,
  };
}

function toInsert(r: AgentRunRow, onBehalfOf: string | null): AgentRunInsert {
  return {
    id: r.id, companyId: r.companyId, kind: r.kind, parentRunId: r.parentRunId, threadId: r.threadId, routineRunId: r.routineRunId, onBehalfOf,
    trigger: r.trigger, attended: r.attended, provider: r.provider, model: r.model, effort: r.effort, cacheKey: r.cacheKey, status: r.status,
    terminalReason: r.terminalReason, tainted: r.tainted, taintedBy: r.taintedBy, checklistJson: str(r.checklist), budgetJson: JSON.stringify(r.budget),
    stepsUsed: r.stepsUsed, requeues: r.requeues, consecutiveErrors: r.consecutiveErrors, costUsdMicros: r.costUsdMicros, tokensJson: JSON.stringify(r.tokens),
    summary: r.summary, createdAt: r.createdAt, endedAt: r.endedAt,
  };
}

function toStep(s: RunStepSelect): RunStepRow {
  return {
    runId: s.runId, n: s.n, parentN: s.parentN, stage: s.stage as RunStepRow["stage"], kind: s.kind as RunStepRow["kind"], callId: s.callId,
    toolName: s.toolName, toolArgs: parse(s.toolArgsJson, null), outcome: (s.outcome as RunStepRow["outcome"]) ?? null, result: parse(s.resultJson, null),
    native: parse(s.nativeJson, null), usage: parse(s.usageJson, null), costUsdMicros: s.costUsdMicros, attempt: s.attempt, requestId: s.requestId,
    prefixHash: s.prefixHash, timings: parse(s.timingsJson, null), createdAt: s.createdAt,
  };
}

export type NewStep = Omit<RunStepRow, "n" | "createdAt" | "runId"> & { createdAt?: string };

export interface RunStore {
  createRun(row: AgentRunRow, onBehalfOf?: string | null): Promise<void>;
  getRun(id: string): Promise<AgentRunRow | null>;
  updateRun(id: string, patch: Partial<Omit<AgentRunRow, "id">>): Promise<void>;
  appendStep(runId: string, step: NewStep): Promise<RunStepRow>;
  steps(runId: string): Promise<RunStepRow[]>;
  runsWithStatus(statuses: RunStatus[]): Promise<AgentRunRow[]>;
  listRuns(filter: { companyId?: string; limit?: number }): Promise<AgentRunRow[]>;
  failRoutineRun(routineRunId: string, summary: string, at: string): Promise<void>;
}

export function createRunStore(db: Db, opts: { wallNow?: () => string; onStep?: (s: RunStepRow) => void } = {}): RunStore {
  const nowIso = opts.wallNow ?? (() => new Date().toISOString());
  const nextN = new Map<string, number>();

  async function counter(runId: string): Promise<number> {
    const cached = nextN.get(runId);
    if (cached !== undefined) return cached;
    const rows = await db.select({ n: runSteps.n }).from(runSteps).where(eq(runSteps.runId, runId));
    const max = rows.reduce((m, r) => Math.max(m, r.n), 0);
    nextN.set(runId, max + 1);
    return max + 1;
  }

  return {
    async createRun(row, onBehalfOf = null) {
      await lockedWrite(() => db.insert(agentRuns).values(toInsert(row, onBehalfOf)));
      // A new run has no steps. POST /v1/sim/reset rebuilds the world in this process and run ids restart at run_0001,
      // so a counter cached for the old run with this id would number the fresh run's steps from where that one stopped.
      nextN.delete(row.id);
    },
    async getRun(id) {
      const rows = await db.select().from(agentRuns).where(eq(agentRuns.id, id)).limit(1);
      return rows[0] ? toRow(rows[0]) : null;
    },
    async updateRun(id, p) {
      const set: Partial<AgentRunInsert> = {};
      if (p.status !== undefined) set.status = p.status;
      if (p.provider !== undefined) set.provider = p.provider;
      if (p.model !== undefined) set.model = p.model;
      if (p.terminalReason !== undefined) set.terminalReason = p.terminalReason;
      if (p.tainted !== undefined) set.tainted = p.tainted;
      if (p.taintedBy !== undefined) set.taintedBy = p.taintedBy;
      if (p.checklist !== undefined) set.checklistJson = str(p.checklist);
      if (p.stepsUsed !== undefined) set.stepsUsed = p.stepsUsed;
      if (p.requeues !== undefined) set.requeues = p.requeues;
      if (p.consecutiveErrors !== undefined) set.consecutiveErrors = p.consecutiveErrors;
      if (p.costUsdMicros !== undefined) set.costUsdMicros = p.costUsdMicros;
      if (p.tokens !== undefined) set.tokensJson = JSON.stringify(p.tokens);
      if (p.summary !== undefined) set.summary = p.summary;
      if (p.endedAt !== undefined) set.endedAt = p.endedAt;
      if (Object.keys(set).length === 0) return;
      await lockedWrite(() => db.update(agentRuns).set(set).where(eq(agentRuns.id, id)));
    },
    async appendStep(runId, s) {
      const n = await counter(runId);
      nextN.set(runId, n + 1);
      const row: RunStepRow = { ...s, runId, n, createdAt: s.createdAt ?? nowIso() };
      await lockedWrite(() => db.insert(runSteps).values({
        runId, n, parentN: row.parentN, stage: row.stage, kind: row.kind, callId: row.callId, attempt: row.attempt, toolName: row.toolName,
        toolArgsJson: str(row.toolArgs), outcome: row.outcome, resultJson: str(row.result), nativeJson: str(row.native), usageJson: str(row.usage),
        costUsdMicros: row.costUsdMicros, requestId: row.requestId, prefixHash: row.prefixHash, timingsJson: str(row.timings), createdAt: row.createdAt,
      }));
      opts.onStep?.(row);
      return row;
    },
    async steps(runId) {
      const rows = await db.select().from(runSteps).where(eq(runSteps.runId, runId)).orderBy(asc(runSteps.n));
      return rows.map(toStep);
    },
    async runsWithStatus(statuses) {
      const rows = await db.select().from(agentRuns).where(inArray(agentRuns.status, statuses));
      return rows.map(toRow);
    },
    async listRuns(filter) {
      const q = db.select().from(agentRuns);
      const rows = filter.companyId ? await q.where(eq(agentRuns.companyId, filter.companyId)) : await q;
      return rows.map(toRow).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, filter.limit ?? 50);
    },
    async failRoutineRun(routineRunId, summary, at) {
      await lockedWrite(() => db.update(routineRuns).set({ status: "failed", summary, endedAt: at })
        .where(and(eq(routineRuns.id, routineRunId), inArray(routineRuns.status, ["queued", "running", "waiting_approval", "waiting_event"]))));
    },
  };
}
