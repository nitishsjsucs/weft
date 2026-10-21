// weft-core with the real engine and two test routes, for the isolate-memory case (engine-memory.test.ts), which
// starts weft-core alone under wrangler's startWorker to reach its V8 inspector. The routes exist only in this test
// entry: POST /__test/provision provisions the named worlds and waits for them; GET /__test/heartbeat?slot= wakes one.
import { setEngineLoader } from "../../src/core/company/engine";
import { coreHandler } from "../../src/core/exports";
import { DO_NAMES } from "../../src/shared/contracts";
import type { CoreEnv } from "../../src/shared/env";

setEngineLoader(() => import("../../src/core/company/weft-engine").then((m) => m.weftEngineModule));

export { CompanyDO, LobbyDO, SpendDO, ReseedWorkflow, ExtrasFallback as HostedExtras } from "../../src/core/exports";

export default {
  ...coreHandler,
  async fetch(req: Request, env: CoreEnv): Promise<Response> {
    const url = new URL(req.url);
    const lobby = env.LOBBY.get(env.LOBBY.idFromName(DO_NAMES.lobby));
    if (url.pathname === "/__test/provision" && req.method === "POST") {
      const slots = ((await req.json()) as { slots: string[] }).slots;
      await env.CONFIG.put("lobby.provision_rows_ceiling", "400000");
      await lobby.provision({ slots });
      for (let i = 0; i < 600; i++) {
        const ops = await lobby.ops();
        const want = ops.slots.filter((s) => slots.includes(s.name));
        if (want.every((s) => s.state === "ready")) return Response.json({ ok: true });
        if (want.some((s) => s.state === "failed")) return Response.json({ ok: false, slots: want }, { status: 500 });
        await new Promise((r) => setTimeout(r, 250));
      }
      return Response.json({ ok: false }, { status: 504 });
    }
    if (url.pathname === "/__test/heartbeat") {
      const slot = url.searchParams.get("slot") ?? "";
      return Response.json(await env.COMPANY.get(env.COMPANY.idFromName(slot)).heartbeat());
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<CoreEnv>;
