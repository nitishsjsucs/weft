// Binds the memory repo, the executor's taint path and the routines precheck registry to one composed Weft
// (w2-memory). createChatContextSource(db) only receives the Db, so recall finds its binding by that Db; the
// rt_memory_digest precheck finds the digest by the ReadOnlyExecutor the routines engine hands it. memoryRoutes()
// calls bindMemory() while buildApp() runs inside createWeft(), before any run can start.
import type { Db } from "@weft/db";
import type { SimClock } from "@weft/contracts";
import type { TxGuard } from "../../../../packages/contracts/src/ext/cf-db";
import { executorInternals } from "@weft/executor";
import type { Weft } from "../http/context";
import { runMemoryDigest, type MemoryW2 } from "./digest";
import type { SemanticRecallOptions } from "./semantic";

export interface MemoryBinding {
  db: Db; clock: SimClock; memory: MemoryW2;
  /** The executor's taint path (run_taint plus the agent_runs mirror); never the brain. */
  taintRun(runId: string, by: string): Promise<void>;
  /** The executor's redactor, which lexical recall applies to every excerpt; semantic lines go through it too. */
  redact(text: string): string;
  /** Digest hook used by the precheck and by tests. */
  digest(input: { companyId: string; now: string }): Promise<Awaited<ReturnType<typeof runMemoryDigest>>>;
  /** Tests that must keep wave 1 transcripts byte-identical can switch recall off for one world. */
  recallEnabled: boolean;
  /** Semantic candidates added to the lexical block (cf6-extras, design 5.4); absent everywhere but a hosted world
   * whose platform attached a source, and inert there until its flag is on. */
  semantic?: SemanticRecallOptions | null;
  /** The facade's IO_IN_TX guard on the durable platform, null on Node: a semantic source is binding I/O. */
  guard: TxGuard | null;
}

const bindings = new WeakMap<Db, MemoryBinding>();

interface Registry { hooks: WeakMap<object, (ctx: { companyId: string; now: string; triggerRef: string }) => Promise<{ commit: string | null; key: string; summary: string }>> }
const registry = (): Registry | undefined => (globalThis as unknown as Record<symbol, Registry | undefined>)[Symbol.for("weft.w2-memory.registry")];

export function bindMemory(weft: Weft): MemoryBinding | null {
  const existing = bindings.get(weft.db);
  if (existing) return existing;
  const memory = weft.executor?.memory as unknown as MemoryW2 | undefined;
  const internals = (() => { try { return executorInternals(weft.executor); } catch { return null; } })();
  if (!memory || typeof memory.digest !== "function" || !internals) return null;
  const b: MemoryBinding = {
    db: weft.db, clock: weft.clock, memory, recallEnabled: true, guard: weft.platform?.guard ?? null,
    taintRun: (runId, by) => internals.taintRun(runId, by),
    redact: (text) => weft.executor.redact(text),
    digest: (input) => runMemoryDigest(b, input),
  };
  bindings.set(weft.db, b);
  registry()?.hooks.set(weft.executor.readOnly, async (ctx) => {
    const out = await b.digest({ companyId: ctx.companyId, now: ctx.now });
    return { commit: out.commit, key: out.key, summary: out.summary };
  });
  return b;
}

export function memoryBinding(db: Db): MemoryBinding | null {
  return bindings.get(db) ?? null;
}

/**
 * Attaches a semantic recall source to a composed world (cf6-extras). CompanyDO calls it once after assembleWeft with
 * the Vectorize source, the memoized flag and its MemoryRepo's read; `null` detaches it. Returns false when the world
 * has no memory binding (no memory store), in which case recall stays lexical only.
 */
export function attachSemanticRecall(db: Db, opts: SemanticRecallOptions | null): boolean {
  const b = bindings.get(db);
  if (!b) return false;
  b.semantic = opts;
  return true;
}
