// The composition root (SPEC 2, 9.0). createWeft(opts) is assembleWeft(nodePlatform, opts): the wiring itself lives in
// assemble.ts, over a WeftPlatform (docs/cloudflare/design.md 3.3), so the Cloudflare host composes the same code over
// the durable platform. Until every track lands, factories may still throw NotImplemented; unless `strict`, each such
// part becomes a stub that throws NotImplemented when used and is listed in `weft.stubs` (and in GET /v1/health).
import { assembleWeft, type CreateWeftOptions } from "./assemble";
import { nodePlatform } from "./platform/node";
import type { Weft } from "./http/context";

export type { Weft, WeftEnv } from "./http/context";
export { stubOf, type CreateWeftOptions } from "./assemble";

export async function createWeft(opts: CreateWeftOptions): Promise<Weft> {
  return assembleWeft(nodePlatform, opts);
}
