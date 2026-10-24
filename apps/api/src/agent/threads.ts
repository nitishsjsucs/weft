// Conversation threads for the Agent page (packages/contracts/src/ext/agent-page.ts; harness 6.2 for the taint rule).
// apps/api reads every table it needs: who a run acted for (exec_runs for a live run, agent_runs for the seeded
// history), its taint (run_taint, the executor's truth, and the agent_runs mirror), its question (the chat pack's
// <request> block in its context step) and its final answer (agent_runs.summary). The brain only bounds and renders
// what earlierTurns returns (packages/agent/src/threads.ts).
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { agentRuns, execRuns, runSteps, runTaint, type Db } from "@weft/db";
import { answerForThread, questionOfPack, type EarlierTurn } from "@weft/agent";
import { THREAD_PRIOR_TURNS, type AskedFrom } from "../../../../packages/contracts/src/ext/agent-page";

/** Ids of the runs that acted for `principalId`: a live run records its person on the executor's run row, a seeded
 * history run on the agent run row. */
export async function runsActingFor(db: Db, companyId: string, principalId: string): Promise<Set<string>> {
  const live = await db.select({ id: execRuns.id }).from(execRuns).where(and(eq(execRuns.companyId, companyId), eq(execRuns.onBehalfOf, principalId)));
  const seeded = await db.select({ id: agentRuns.id }).from(agentRuns).where(and(eq(agentRuns.companyId, companyId), eq(agentRuns.onBehalfOf, principalId)));
  return new Set([...live, ...seeded].map((x) => x.id));
}

/** The person each run acted for (exec_runs first, then the agent run row), by run id. */
async function peopleOf(db: Db, rows: { id: string; onBehalfOf: string | null }[]): Promise<Map<string, string | null>> {
  const out = new Map(rows.map((r) => [r.id, r.onBehalfOf] as [string, string | null]));
  if (rows.length === 0) return out;
  for (const e of await db.select({ id: execRuns.id, onBehalfOf: execRuns.onBehalfOf }).from(execRuns).where(inArray(execRuns.id, rows.map((r) => r.id)))) {
    if (e.onBehalfOf) out.set(e.id, e.onBehalfOf);
  }
  return out;
}

/** Whether a run in this thread acted for someone other than `principalId` (a thread is one person's conversation). */
export async function threadBelongsToSomeoneElse(db: Db, companyId: string, threadId: string, principalId: string): Promise<boolean> {
  const rows = await db.select({ id: agentRuns.id, onBehalfOf: agentRuns.onBehalfOf }).from(agentRuns).where(and(eq(agentRuns.companyId, companyId), eq(agentRuns.threadId, threadId)));
  const people = await peopleOf(db, rows);
  return [...people.values()].some((p) => p !== principalId);
}

const PAGE_MARKERS: [string, AskedFrom][] = [["\npage: employee portal", "portal"], ["\npage: Tagged in a company chat thread", "mention"]];

/**
 * The question and where it was asked for each chat run, from its context step: SQLite cuts the <request> block out
 * of the stored pack, so a list of runs reads a few hundred characters each instead of whole packs. A run with no
 * stored pack gets a null question.
 */
export async function questionsOf(db: Db, runs: { id: string; cacheKey: string }[]): Promise<Map<string, { question: string | null; askedFrom: AskedFrom }>> {
  const out = new Map<string, { question: string | null; askedFrom: AskedFrom }>();
  for (const r of runs) out.set(r.id, { question: null, askedFrom: r.cacheKey.split(":")[2] === "routine_draft" ? "routine_draft" : "agent" });
  if (runs.length === 0) return out;
  const text = sql`json_extract(${runSteps.resultJson}, '$.text')`;
  const rows = await db.select({
    runId: runSteps.runId, n: runSteps.n,
    request: sql<string | null>`CASE WHEN instr(${text}, '<request>') > 0 THEN substr(${text}, instr(${text}, '<request>'), instr(${text}, '</request>') - instr(${text}, '<request>') + 10) END`,
    portal: sql<number>`instr(${text}, ${PAGE_MARKERS[0]![0]})`,
    mention: sql<number>`instr(${text}, ${PAGE_MARKERS[1]![0]})`,
  }).from(runSteps).where(and(inArray(runSteps.runId, runs.map((r) => r.id)), eq(runSteps.kind, "context"))).orderBy(asc(runSteps.runId), asc(runSteps.n));
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.runId) || r.request === null) continue;
    seen.add(r.runId);
    const cur = out.get(r.runId)!;
    const askedFrom: AskedFrom = cur.askedFrom === "routine_draft" ? "routine_draft" : Number(r.portal) > 0 ? "portal" : Number(r.mention) > 0 ? "mention" : "agent";
    out.set(r.runId, { question: questionOfPack(r.request), askedFrom });
  }
  return out;
}

/** A run whose number sorts after another's ("run_10000" after "run_9999"), for runs created at the same instant. */
const byCreation = (a: { createdAt: string; id: string }, b: { createdAt: string; id: string }) =>
  a.createdAt.localeCompare(b.createdAt) || a.id.length - b.id.length || a.id.localeCompare(b.id);

/**
 * ChatContextSource.earlier: the turns of `threadId` before `runId` that a follow-up may read, oldest first. A turn
 * qualifies only when its run acted for the same person, finished with an answer (status done), and is untainted in
 * both run_taint and the mirror. A tainted turn contributes nothing: neither its question nor its answer (its taint
 * reaches the follow-up through the executor instead). Only the question and the final answer are read, never a tool
 * result; the runtime bounds them to THREAD_PRIOR_TURNS turns and THREAD_PRIOR_CHARS characters.
 */
export async function earlierTurns(db: Db, input: { companyId: string; runId: string; threadId: string }): Promise<EarlierTurn[]> {
  const [me] = await db.select({ onBehalfOf: execRuns.onBehalfOf }).from(execRuns).where(eq(execRuns.id, input.runId)).limit(1);
  const [current] = await db.select({ id: agentRuns.id, createdAt: agentRuns.createdAt, onBehalfOf: agentRuns.onBehalfOf }).from(agentRuns).where(eq(agentRuns.id, input.runId)).limit(1);
  const person = me?.onBehalfOf ?? current?.onBehalfOf ?? null;
  if (!person) return [];
  const rows = (await db.select({
    id: agentRuns.id, createdAt: agentRuns.createdAt, status: agentRuns.status, summary: agentRuns.summary, tainted: agentRuns.tainted,
    onBehalfOf: agentRuns.onBehalfOf, trigger: agentRuns.trigger, cacheKey: agentRuns.cacheKey,
  }).from(agentRuns).where(and(eq(agentRuns.companyId, input.companyId), eq(agentRuns.threadId, input.threadId)))).filter((r) => r.id !== input.runId).sort(byCreation);
  const before = current ? rows.filter((r) => byCreation(r, { id: current.id, createdAt: current.createdAt }) < 0) : rows;
  const people = await peopleOf(db, before);
  const taint = before.length
    ? new Set((await db.select({ runId: runTaint.runId }).from(runTaint).where(and(inArray(runTaint.runId, before.map((r) => r.id)), eq(runTaint.tainted, true)))).map((t) => t.runId))
    : new Set<string>();
  const eligible = before.filter((r) => r.trigger === "chat" && r.status === "done" && !r.tainted && !taint.has(r.id) && people.get(r.id) === person && answerForThread(r.summary))
    .slice(-THREAD_PRIOR_TURNS * 2);
  const questions = await questionsOf(db, eligible);
  return eligible.flatMap((r) => {
    const q = questions.get(r.id);
    if (!q?.question || q.askedFrom !== "agent") return [];
    return [{ question: q.question, answer: answerForThread(r.summary) }];
  });
}
