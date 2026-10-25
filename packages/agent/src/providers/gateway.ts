// The AI Gateway transport for model calls (docs/cloudflare/design.md 5.1 and 9.3). The OpenAI request body is
// unchanged; only the base URL and headers differ: `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/openai`,
// `cf-aig-metadata` with at most five keys {slot, gen, run, kind, visitor}, and `cf-aig-authorization` once the gateway
// is authenticated. No `cf-aig-skip-cache`, and no `cf-aig-collect-log` override unless the KV `aig.collect_log`
// operations lever turns logging off, so the gateway's logging and caching apply as configured. BYOK (phase 2): the gateway holds the OpenAI key, so the Worker sends no Authorization header
// (the SDK's placeholder is stripped by the fetch). Every fetch asserts it is not inside a database transaction
// (IO_IN_TX) and counts toward the invocation's fetch budget. Portable; openai.ts alone imports the SDK.
import type { ModelStepResult } from "@weft/contracts";
import {
  AIG_ENV, AIG_HEADERS, aiGatewayOpenAiBaseUrl, type AigCallKind, type AigMetadata, type AiGatewayConfig, type FetchCounter,
} from "../../../contracts/src/ext/cf-agent";
import { guardedFetch, type TxGuardLike } from "../run-host";

/** Sent only when the operations lever turns gateway logging off for Weft's calls. */
export const AIG_COLLECT_LOG_HEADER = "cf-aig-collect-log";

/** The gateway settings from the environment (WEFT_AIG_ACCOUNT_ID, WEFT_AIG_GATEWAY, CF_AIG_TOKEN), or null. */
export function aiGatewayFromEnv(env: Record<string, string | undefined>): AiGatewayConfig | null {
  const accountId = (env[AIG_ENV.accountId] ?? "").trim();
  const gateway = (env[AIG_ENV.gateway] ?? "").trim();
  if (!accountId || !gateway) return null;
  const token = (env[AIG_ENV.token] ?? "").trim();
  return { accountId, gateway, token: token || null };
}

/** The call kind from a run's cache key (weft:<agentKind>:<routineId|chat|assist|routine_draft>:<companyId>). */
export function aigKindOf(cacheKey: string): AigCallKind {
  const part = cacheKey.split(":")[2] ?? "chat";
  return part === "chat" ? "chat" : part === "assist" ? "assist" : part === "routine_draft" ? "draft" : "routine";
}

/** Who a call is for: the world (slot and generation) and the lease's visitor, read per call. */
export interface AigWorld { slot: string; gen: number; visitor: string | null }

/** `cf-aig-metadata`: at most five keys, and keys whose value is null or absent are left out. */
export function aigMetadataHeader(m: Partial<AigMetadata>): string {
  const out: Record<string, string | number> = {};
  for (const k of ["slot", "gen", "run", "kind", "visitor"] as const) {
    const v = m[k];
    if (v !== null && v !== undefined) out[k] = v;
  }
  return JSON.stringify(out);
}

export interface GatewayTransportOptions {
  gateway: AiGatewayConfig;
  /** The world the call is for; absent, the metadata carries only the run and kind. */
  world?: () => AigWorld | null;
  /** Phase 2: the gateway holds the OpenAI key (needs `token`). */
  byok?: boolean;
  /** The fetch underneath (tests pass a fake; default the global fetch). */
  fetch?: typeof fetch;
  counter?: FetchCounter | null;
  guard?: TxGuardLike | null;
  /** KV `aig.collect_log` (design 5.1, an operations lever): false sends `cf-aig-collect-log: false` so the gateway
   * keeps no log of the call; anything else sends no override and the gateway's own setting applies. */
  collectLog?: () => boolean | null;
}

/** What openai.ts hands the SDK for the gateway, and the headers each request adds. */
export interface GatewayTransport {
  readonly baseURL: string;
  readonly fetch: typeof fetch;
  readonly defaultHeaders: Record<string, string>;
  readonly byok: boolean;
  headersFor(req: { runId: string; cacheKey: string }): Record<string, string>;
}

/** A fetch that drops the Authorization header (BYOK: the SDK requires an API key and sends a placeholder). */
export function stripAuthorization(base: typeof fetch): typeof fetch {
  const f = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (input instanceof Request) {
      const req = new Request(input, init);
      req.headers.delete("authorization");
      return base(req);
    }
    const headers = new Headers(init?.headers);
    headers.delete("authorization");
    return base(input, { ...init, headers });
  };
  return f as typeof fetch;
}

export function openAiGatewayTransport(o: GatewayTransportOptions): GatewayTransport {
  if (o.byok && !o.gateway.token) throw new Error("BYOK needs CF_AIG_TOKEN: the gateway authenticates the request and holds the OpenAI key");
  const base = o.fetch ?? ((input, init) => fetch(input, init));
  const guarded = guardedFetch(base, { what: "openai gateway fetch", guard: o.guard, counter: o.counter });
  const defaultHeaders: Record<string, string> = o.gateway.token ? { [AIG_HEADERS.authorization]: `Bearer ${o.gateway.token}` } : {};
  return {
    baseURL: aiGatewayOpenAiBaseUrl(o.gateway),
    fetch: o.byok ? stripAuthorization(guarded) : guarded,
    defaultHeaders,
    byok: o.byok === true,
    headersFor(req) {
      const w = o.world?.() ?? null;
      return {
        [AIG_HEADERS.metadata]: aigMetadataHeader({ ...(w ? { slot: w.slot, gen: w.gen, visitor: w.visitor } : {}), run: req.runId || null, kind: aigKindOf(req.cacheKey) }),
        ...(o.collectLog?.() === false ? { [AIG_COLLECT_LOG_HEADER]: "false" } : {}),
      };
    },
  };
}

/** A step result that also says whether AI Gateway served it from its cache (then the call cost nothing, design 5.1). */
export type GatewayStepResult = ModelStepResult & { gatewayCacheHit?: boolean };

/** The gateway's cache verdict on a response: true only for `cf-aig-cache-status: HIT`. */
export function gatewayCacheHit(headers: Headers | null | undefined): boolean {
  return (headers?.get(AIG_HEADERS.cacheStatus) ?? "").trim().toUpperCase() === "HIT";
}
