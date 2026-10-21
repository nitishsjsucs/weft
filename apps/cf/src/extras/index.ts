// The worker side of the extras in weft-core (track cf6-extras): HostedExtras, the queue consumers and the seams they
// use. Nothing reachable from this file evaluates @weft/* runtime modules (design 3.2; pinned by
// apps/cf/test/extras/boundary.test.ts). The Durable Object side (hidden commands, the slot port, the PDF route, the
// outbox mapping and the run catalog source) is in ./slot and loads inside CompanyDO only.
export { HostedExtras, extrasQueue } from "./entrypoint";
export { extrasCron, type ExtrasCronEnv, type ExtrasCronResult } from "./cron";
export { createHostedExtras, type HostedExtrasDeps } from "./hosted";
export { exportObjectKey, handleExtrasBatch, retryDelaySeconds, runJob, type ExtrasJobDeps } from "./queues";
export { consoleLog, flagsFor, hostedDepsFromEnv, jobDepsFromEnv, type ExecutionContextLike, type ExtrasEnv, type ExtrasLog } from "./env";
export type * from "./ports";
