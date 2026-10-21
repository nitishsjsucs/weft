// weft-core's exports without the engine wiring (design 3.1): the Durable Object classes, the Workflow, the
// HostedExtras entrypoint and the default handler for cron and the queues. src/core/index.ts wires the real Weft
// engine on top of this; the Miniflare suite's entry wires a fake one. Top-level evaluation is class shells only
// (design 8.1: startup), so @weft/* loads lazily, inside CompanyDO's blockConcurrencyWhile.
import { DO_NAMES } from "../shared/contracts";
import type { CoreEnv } from "../shared/env";
import { logError, logEvent } from "../shared/log";
import { handleQueue } from "./queues";

export { CompanyDO } from "./company/company-do";
export { LobbyDO } from "./lobby/lobby-do";
export { SpendDO } from "./spend/spend-do";
export { ReseedWorkflow } from "./reseed";
export { ExtrasFallback } from "./extras-port";

export const coreHandler: ExportedHandler<CoreEnv> = {
  // weft-core has no public route (workers_dev false, preview_urls false); nothing should reach this.
  async fetch() {
    return new Response("Not found", { status: 404 });
  },
  /** The cron trigger, every 15 minutes: one Lobby RPC (design 8.1: at most 5 ms of CPU here). */
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(env.LOBBY.get(env.LOBBY.idFromName(DO_NAMES.lobby)).sweep().then(
      (r) => logEvent("cron.sweep", { cron: controller.cron, outcome: "ok", released: r.released, orphans: r.orphans, level: r.level }),
      (e: unknown) => logError("cron.sweep", e, { cron: controller.cron }),
    ));
  },
  async queue(batch, env) {
    await handleQueue(batch, env);
  },
};
