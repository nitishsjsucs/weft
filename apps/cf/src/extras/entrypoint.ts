// HostedExtras (design 3.1): the WorkerEntrypoint in weft-core that the front Worker calls over its CORE service
// binding for Help search, dictation, the Platform and comparison readouts, run catalog writes and export downloads.
// Calls over a service binding are not billed as separate requests. It never evaluates @weft/* (design 3.2): only
// @weft/cf-extras and these thin wrappers load. `extrasQueue` is the queue() body cf4-worker's dispatch calls for
// weft-jobs, weft-render and weft-dlq. Track cf6-extras.
import { WorkerEntrypoint } from "cloudflare:workers";
import type { DictationResult, HelpSearchResult, MessageBatchLike, ModelComparisonRow, PlatformReadout, RunCatalogRow } from "@weft/cf-extras";
import { hostedDepsFromEnv, jobDepsFromEnv, type ExecutionContextLike, type ExtrasEnv } from "./env";
import { createHostedExtras } from "./hosted";
import { extrasFetch } from "./http";
import type { DictateInput, HostedExtrasApi, SlotExport } from "./ports";
import { handleExtrasBatch } from "./queues";

export class HostedExtras extends WorkerEntrypoint<ExtrasEnv> implements HostedExtrasApi {
  #api(): HostedExtrasApi { return createHostedExtras(hostedDepsFromEnv(this.env, this.ctx)); }
  /** The front's forwarded /api/_hosted/* requests (x-weft-ctx verified here); the RPC methods below serve them. */
  override fetch(request: Request): Promise<Response> { return extrasFetch(request, this, this.env); }
  help(query: string): Promise<HelpSearchResult> { return this.#api().help(query); }
  dictate(input: DictateInput): Promise<DictationResult> { return this.#api().dictate(input); }
  platform(): Promise<PlatformReadout> { return this.#api().platform(); }
  models(opts?: { days?: number }): Promise<ModelComparisonRow[]> { return this.#api().models(opts); }
  recordRun(row: RunCatalogRow): Promise<void> { return this.#api().recordRun(row); }
  exportFile(input: { slot: string; gen: number; jobId: string; what: "memory" | "world" }): Promise<SlotExport | null> { return this.#api().exportFile(input); }
}

/** The queue() body for the extras' queues. Logs one redacted JSON line per job (no bodies, no visitor data). */
export async function extrasQueue(batch: MessageBatchLike<unknown>, env: ExtrasEnv, ctx: ExecutionContextLike): Promise<void> {
  await handleExtrasBatch(batch, jobDepsFromEnv(env, ctx));
}
