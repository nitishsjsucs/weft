// weft-core (design 3.1 and 9.4): workers_dev false and preview_urls false, so it has no public route. It exports
// the Durable Objects (CompanyDO, LobbyDO, SpendDO), ReseedWorkflow, the HostedExtras entrypoint the front reaches
// over its CORE service binding (cf6-extras), and the cron and queue handlers. CompanyDO loads the real Weft engine
// lazily: the dynamic import below is bundled as a lazily evaluated module, so the top level evaluates only class shells.
import { setEngineLoader } from "./company/engine";
import { coreHandler } from "./exports";
import { extrasCron, extrasQueue, type ExtrasEnv } from "../extras";
import type { CoreEnv } from "../shared/env";
import { logError, logEvent } from "../shared/log";

setEngineLoader(() => import("./company/weft-engine").then((m) => m.weftEngineModule));

export { CompanyDO, LobbyDO, SpendDO, ReseedWorkflow } from "./exports";
export { HostedExtras } from "../extras";

export default {
  ...coreHandler,
  /** Every 15 minutes: the Lobby sweep (one RPC), and the extras' due parked jobs and the daily weft-ops prune. */
  async scheduled(controller, env, ctx) {
    await coreHandler.scheduled!(controller, env, ctx);
    if (!env.OPS) return;   // the job ledger is D1 weft-ops; without it no job was parked
    ctx.waitUntil(extrasCron(env as unknown as ExtrasEnv & Parameters<typeof extrasCron>[0], new Date(controller.scheduledTime)).then(
      (r) => logEvent("cron.extras", { cron: controller.cron, outcome: "ok", ...(r as unknown as Record<string, unknown>) }),
      (e: unknown) => logError("cron.extras", e, { cron: controller.cron }),
    ));
  },
  /** weft-jobs (OCR, embeddings, exports), weft-render (PDF) and weft-dlq: cf6-extras' batch handlers (design 7.1). */
  async queue(batch, env, ctx) {
    await extrasQueue(batch as never, env as unknown as ExtrasEnv, ctx);
  },
} satisfies ExportedHandler<CoreEnv>;
