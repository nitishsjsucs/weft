// ReseedWorkflow (design 4.6 and 9.2): a full restore in durable, retried steps. Workflow steps get about 10 ms of
// CPU on Free (2.05 s was killed), so every step only RPCs into the CompanyDO, which does the SQL in its own
// invocation: deleteAll, migrate, about 100 INSERT chunks under 90 KB (CHUNKS_PER_STEP per step, progress committed
// with each chunk so a retried step skips what is done), arm the dirty triggers, verify counts, digests and the
// chain head, take a bookmark, stamp the generation and boot, then tell the Lobby. About 11 steps per restore.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { DO_NAMES, type WorldMode } from "../shared/contracts";
import type { CoreEnv } from "../shared/env";

export interface ReseedParams { slot: string; gen: number; mode: WorldMode; reason?: string }
export interface ReseedOutput { slot: string; gen: number; rowsWritten: number; chunks: number }

export const CHUNKS_PER_STEP = 20;
const RETRY = { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" }, timeout: "5 minutes" } as const;

export function validReseedParams(p: Partial<ReseedParams> | null | undefined): p is ReseedParams {
  return !!p && typeof p.slot === "string" && /^[a-z0-9-]{1,32}$/.test(p.slot) && Number.isInteger(p.gen) && (p.gen ?? 0) >= 1
    && ["showcase", "slot", "smoke", "conformance"].includes(p.mode ?? "");
}

export class ReseedWorkflow extends WorkflowEntrypoint<CoreEnv, ReseedParams> {
  override async run(event: Readonly<WorkflowEvent<ReseedParams>>, step: WorkflowStep): Promise<ReseedOutput> {
    const p = event.payload;
    if (!validReseedParams(p)) throw new NonRetryableError("bad reseed params");
    const { slot, gen, mode } = p;
    const company = () => this.env.COMPANY.get(this.env.COMPANY.idFromName(slot));
    const lobby = () => this.env.LOBBY.get(this.env.LOBBY.idFromName(DO_NAMES.lobby));
    try {
      await step.do("begin", RETRY, async () => { await company().restoreBegin({ slot, gen, mode }); return true; });
      await step.do("migrate", RETRY, async () => (await company().restoreMigrate()).applied);
      const chunks = await step.do("count", RETRY, async () => Number(await company().restoreChunkCount()));
      let rowsWritten = 0;
      for (let from = 0; from < chunks; from += CHUNKS_PER_STEP) {
        const to = Math.min(chunks, from + CHUNKS_PER_STEP);
        rowsWritten = await step.do(`chunks ${from}-${to}`, RETRY, async () => (await company().restoreChunks({ from, to })).rowsWritten);
      }
      await step.do("arm", RETRY, async () => { await company().restoreArm(); return true; });
      const v = await step.do("verify", RETRY, async () => {
        const r = await company().restoreVerify();
        return { ok: r.ok, chainValid: r.chainValid, mismatches: [...r.mismatches], rows: r.rows };
      });
      if (!v.ok || !v.chainValid) throw new NonRetryableError(`restore of ${slot} did not verify: ${v.mismatches.slice(0, 5).join(", ") || "chain invalid"}`);
      const bookmark = await step.do("bookmark", RETRY, async () => (await company().restoreBookmark()) ?? "");
      const done = await step.do("finish", RETRY, async () => {
        const r = await company().restoreFinish({ bookmark: bookmark || null });
        return { slot: r.slot, gen: r.gen, snapshot: r.snapshot, bookmark: r.bookmark ?? "", rowsWritten: r.rowsWritten };
      });
      const total = done.rowsWritten || rowsWritten;
      await step.do("lobby", RETRY, async () => {
        await lobby().restoreDone({ slot, gen, snapshot: done.snapshot, bookmark: done.bookmark || null, rowsWritten: total, ok: true });
        return true;
      });
      return { slot, gen, rowsWritten: total, chunks };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await step.do("lobby failed", RETRY, async () => {
        await lobby().restoreDone({ slot, gen, snapshot: "", bookmark: null, rowsWritten: 0, ok: false, error: message });
        return true;
      });
      throw e;
    }
  }
}
