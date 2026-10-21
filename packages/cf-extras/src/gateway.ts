// Every Workers AI call the extras make goes through AI Gateway `weft` (design 5.1): logs, cache and rate limits,
// with `cf-aig-metadata` style metadata of at most 5 keys. The gateway name is a secret (WEFT_AIG_GATEWAY) while
// the gateway is unauthenticated; without it (local runs, tests) calls go to the binding directly. Track cf6-extras.
import { AIG_ENV, type AigMetadata } from "../../contracts/src/ext/cf-agent";
import type { AiGatewayOption } from "./bindings";

export function gatewayOption(env: Readonly<Record<string, unknown>>, meta: AigMetadata): AiGatewayOption | null {
  const id = env[AIG_ENV.gateway];
  if (typeof id !== "string" || !id.trim()) return null;
  const metadata: AiGatewayOption["metadata"] = { slot: meta.slot.slice(0, 32), gen: meta.gen, run: meta.run, kind: meta.kind, visitor: meta.visitor };
  return { id: id.trim(), metadata };
}
