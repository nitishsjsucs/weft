// Worker environments (design 9.3 and 9.4). Type-only imports of the Durable Object classes, so the front Worker's
// bundle never evaluates weft-core code.
import type { CompanyDO } from "../core/company/company-do";
import type { LobbyDO } from "../core/lobby/lobby-do";
import type { SpendDO } from "../core/spend/spend-do";
import type { HostedExtrasApi } from "../core/extras-port";
import type { ReseedParams } from "../core/reseed";

/** Vars both scripts read. */
export interface SharedVars {
  WEFT_PUBLIC_ORIGIN?: string;
  /** Pool slots besides the showcase and slot-smoke (design section 0: 2). */
  WEFT_POOL_SIZE?: string;
  /** How long a KV weft-config read is memoized per isolate, in ms (default 60,000; local runs shorten it). */
  WEFT_CONFIG_MEMO_MS?: string;
}

/** Secrets both scripts hold (design 9.3). */
export interface SharedSecrets {
  WEFT_SESSION_SECRET?: string;
  WEFT_CTX_SECRET?: string;
  WEFT_PROXY_SECRET?: string;
}

export interface FrontEnv extends SharedVars, SharedSecrets {
  ASSETS: Fetcher;
  COMPANY: DurableObjectNamespace<CompanyDO>;
  LOBBY: DurableObjectNamespace<LobbyDO>;
  SPEND: DurableObjectNamespace<SpendDO>;
  CORE: Service<HostedExtrasApi>;
  CONFIG: KVNamespace;
  RL_API: RateLimit;
  RL_MUTATE: RateLimit;
  RL_MCP: RateLimit;
  TURNSTILE_SITEKEY?: string;
  TURNSTILE_SECRET?: string;
  /** Override for local runs only; production always uses Cloudflare's siteverify. */
  TURNSTILE_VERIFY_URL?: string;
  WEFT_SMOKE_TOKEN?: string;
  WEFT_ADMIN_TOKEN?: string;
}

export interface CoreEnv extends SharedVars, SharedSecrets {
  COMPANY: DurableObjectNamespace<CompanyDO>;
  LOBBY: DurableObjectNamespace<LobbyDO>;
  SPEND: DurableObjectNamespace<SpendDO>;
  RESEED: Workflow<ReseedParams>;
  AI?: Ai;
  BROWSER?: Fetcher;
  IMAGES?: ImagesBinding;
  CONFIG: KVNamespace;
  OPS?: D1Database;
  FILES?: R2Bucket;
  MEMVEC?: VectorizeIndex;
  JOBS: Queue;
  RENDER: Queue;
  RL_RUN: RateLimit;
  WEFT_VAULT_KEY?: string;
  OPENAI_API_KEY?: string;
  WEFT_AIG_GATEWAY?: string;
  WEFT_AIG_ACCOUNT_ID?: string;
  CF_AIG_TOKEN?: string;
  [key: string]: unknown;
}

/** Only the string-valued entries of an env (vars and secrets): what the durable platform receives as its env. */
export function stringEnv(env: object): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") out[k] = v;
  return out;
}

export function poolSize(env: SharedVars): number {
  const n = Number(env.WEFT_POOL_SIZE ?? "2");
  return Number.isInteger(n) && n >= 1 && n <= 32 ? n : 2;
}

/** True only for the exact name of a pool slot, slot-1 to slot-<WEFT_POOL_SIZE> (not slot-0, slot-01 or slot-smoke). */
export function isPoolSlot(env: SharedVars, slot: string): boolean {
  const m = /^slot-([1-9]\d{0,1})$/.exec(slot);
  return !!m && Number(m[1]) <= poolSize(env);
}
