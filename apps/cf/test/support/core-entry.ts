// weft-core for the Miniflare suite: the real Durable Objects, Workflow, cron and queue dispatch, with the fake world
// engine behind CompanyDO's seam and job handlers that record each delivery in KV (so redelivery and dead letters are
// observable from the tests).
import { setEngineLoader } from "../../src/core/company/engine";
import { coreHandler } from "../../src/core/exports";
import { registerJobHandlers } from "../../src/core/extras-port";
import type { CoreEnv } from "../../src/shared/env";
import { fakeEngineModule } from "./fake-engine";

setEngineLoader(async () => fakeEngineModule);

async function count(env: CoreEnv, key: string): Promise<void> {
  const n = Number((await env.CONFIG.get(key)) ?? "0");
  await env.CONFIG.put(key, String(n + 1));
}

registerJobHandlers({
  "ocr.receipt": async (job, env) => {
    await count(env, `test.job:${job.jobId}`);
    if (job.kind === "ocr.receipt" && job.uploadId === "upl_fail") throw new Error("fake OCR failure");
  },
  "render.pdf": async (job, env) => { await count(env, `test.job:${job.jobId}`); },
}, async (job, env) => {
  const id = (job as { jobId?: string } | null)?.jobId ?? "unknown";
  await count(env, `test.dead:${id}`);
});

export { CompanyDO, LobbyDO, SpendDO, ReseedWorkflow, ExtrasFallback as HostedExtras } from "../../src/core/exports";
export default coreHandler;
