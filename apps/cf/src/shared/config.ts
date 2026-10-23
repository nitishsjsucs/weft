// KV `weft-config` (design 4.1, 6.3 and section 0): flags, the model default, the kill switch, the snapshot version
// and every cap, memoized per isolate for HOSTED_SETTINGS.configMemoMs so a busy isolate reads each key about once
// a minute. Absent keys mean the default. Caps resolve KV first, then the Worker var, then HOSTED_CAP_DEFAULTS; the
// visitor and IP-hash caps follow the day cap unless set on their own (Nitish, 2026-10-20).
import { HOSTED_CAP_DEFAULTS, HOSTED_CONFIG_KEYS, HOSTED_SETTINGS, type HostedCaps } from "./contracts";

/** apps/cf's own KV keys beside the contract's HOSTED_CONFIG_KEYS (operations levers; none is read by other tracks). */
export const CF4_CONFIG_KEYS = {
  /** "on": slot resets use point-in-time recovery when a bookmark exists (only after the first-deploy check). */
  resetPitr: "reset.pitr",
  /** A DegradationLevel the Lobby never goes below (for example "4" while the account request cap is reached). */
  levelFloor: "degradation.level_floor",
  /** Weft's share of DO rows written per UTC day (default 60,000) and the ceiling on provisioning days. */
  rowsWrittenShare: "lobby.rows_written_share",
  provisionRowsCeiling: "lobby.provision_rows_ceiling",
  /** Rows written one full restore costs (default 20,556, verified locally on the rich world). */
  fullRestoreRows: "lobby.full_restore_rows",
  /** A leased generation's rows budget (core/company/budget.ts WORLD_BUDGET): written, then read. */
  leaseRowsWritten: "budget.lease_rows_written",
  leaseRowsRead: "budget.lease_rows_read",
  /** The showcase's rows read per UTC day. */
  showcaseRowsRead: "budget.showcase_rows_read",
} as const;

export const CONFIG_KEYS: readonly string[] = [...Object.values(HOSTED_CONFIG_KEYS), ...Object.values(CF4_CONFIG_KEYS)];

type Memo = { at: number; values: Map<string, string | null> };
const memos = new WeakMap<KVNamespace, Memo>();

/** What the config reads as when it cannot be read at all: the kill switch on (agent.enabled=false), nothing else. */
const failClosed = (): Map<string, string | null> => new Map<string, string | null>([[HOSTED_CONFIG_KEYS.agentEnabled, "false"]]);

/**
 * All config keys, at most memoMs old. A failed KV read keeps the previous values. With none to keep (a cold isolate
 * while KV fails) the kill switch reads as on (agent.enabled=false) and nothing else is set, so model-calling
 * admissions fail closed until KV answers; the failure is not memoized, so the next call reads KV again. A Worker
 * with no KV binding at all (a misconfigured deploy) fails closed the same way.
 */
export async function readConfig(kv: KVNamespace | undefined, now = Date.now(), memoMs: number = HOSTED_SETTINGS.configMemoMs): Promise<Map<string, string | null>> {
  if (!kv) return failClosed();
  const memo = memos.get(kv);
  if (memo && now - memo.at < memoMs) return memo.values;
  const values = new Map<string, string | null>();
  try {
    const got = await (kv.get as unknown as (keys: string[], type: "text") => Promise<Map<string, string | null>>)([...CONFIG_KEYS], "text");
    for (const k of CONFIG_KEYS) values.set(k, got.get(k) ?? null);
  } catch {
    // Older runtimes without the bulk form: one read per key.
    try {
      await Promise.all(CONFIG_KEYS.map(async (k) => values.set(k, await kv.get(k))));
    } catch {
      return memo?.values ?? failClosed();
    }
  }
  memos.set(kv, { at: now, values });
  return values;
}

/** The env's config: KV CONFIG, memoized for WEFT_CONFIG_MEMO_MS (default HOSTED_SETTINGS.configMemoMs, 60 s). */
export function envConfig(env: { CONFIG?: KVNamespace; WEFT_CONFIG_MEMO_MS?: unknown }, now = Date.now()): Promise<Map<string, string | null>> {
  const ms = Number(env.WEFT_CONFIG_MEMO_MS);
  return readConfig(env.CONFIG, now, Number.isFinite(ms) && ms >= 0 ? ms : HOSTED_SETTINGS.configMemoMs);
}

/** Drops the memo (tests and the admin config route). */
export function forgetConfig(kv: KVNamespace): void {
  memos.delete(kv);
}

const num = (v: string | null | undefined): number | null => {
  if (v === null || v === undefined || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const offOrNum = (v: string | null | undefined): number | null | undefined => {
  if (v === null || v === undefined || v.trim() === "") return undefined;
  if (v.trim().toLowerCase() === "off") return null;
  return num(v) ?? undefined;
};

export function capsFrom(values: Map<string, string | null>, env: Record<string, unknown>): HostedCaps {
  const e = (k: string) => (typeof env[k] === "string" ? (env[k] as string) : null);
  const runUsd = num(values.get(HOSTED_CONFIG_KEYS.capRunUsd)) ?? num(e("WEFT_RUN_USD_CAP")) ?? HOSTED_CAP_DEFAULTS.runUsd;
  const dayUsd = num(values.get(HOSTED_CONFIG_KEYS.capDayUsd)) ?? num(e("WEFT_DAY_USD_CAP")) ?? HOSTED_CAP_DEFAULTS.dayUsd;
  const kvLive = offOrNum(values.get(HOSTED_CONFIG_KEYS.capLiveUsd));
  const envLive = offOrNum(e("WEFT_LIVE_USD_CAP"));
  const liveUsd = kvLive !== undefined ? kvLive : envLive !== undefined ? envLive : HOSTED_CAP_DEFAULTS.liveUsd;
  const visitorDayUsd = num(values.get(HOSTED_CONFIG_KEYS.capVisitorDayUsd)) ?? num(e("WEFT_VISITOR_DAY_USD_CAP")) ?? dayUsd;
  const ipDayUsd = num(values.get(HOSTED_CONFIG_KEYS.capIpDayUsd)) ?? num(e("WEFT_IP_DAY_USD_CAP")) ?? dayUsd;
  const neuronsDay = num(values.get(HOSTED_CONFIG_KEYS.capNeuronsDay)) ?? num(e("WEFT_NEURON_DAY_CAP")) ?? HOSTED_CAP_DEFAULTS.neuronsDay;
  return { runUsd, dayUsd, liveUsd, visitorDayUsd, ipDayUsd, neuronsDay };
}

export const agentEnabled = (values: Map<string, string | null>): boolean => (values.get(HOSTED_CONFIG_KEYS.agentEnabled) ?? "true").trim().toLowerCase() !== "false";

export function configNumber(values: Map<string, string | null>, key: string, fallback: number): number {
  return num(values.get(key)) ?? fallback;
}
