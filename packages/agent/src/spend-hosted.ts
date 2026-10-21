// Hosted spend (docs/cloudflare/design.md 4.3, 5.2, 5.3 and 6.3; section 0 for the caps): SpendDO's ledger over the
// SQL store, the caps read from KV `weft-config` (so they change without a redeploy), and the adapter a world's agent
// runtime receives, which charges every reservation to that world and its lease's visitor and IP hash. Background
// runs follow only from a visitor's mutation in that slot, so they are charged to the same lease (design 5.3).
// Portable: no node: imports.
import type { SpendLedger } from "@weft/contracts";
import {
  HOSTED_CAP_DEFAULTS, USD_PER_1K_NEURONS, WORKERS_AI_MODEL, type HostedCaps, type HostedReserveInput, type HostedSpendLedger,
  type HostedSpendStatus, type NeuronProduct,
} from "../../contracts/src/ext/cf-agent";
import { HOSTED_CONFIG_KEYS, HOSTED_SETTINGS } from "../../contracts/src/ext/cf-hosted";
import { createLedgerCore, neuronsForUsdMicros, type LedgerCore, type SpendStore } from "./spend-core";

export interface HostedSpendLedgerOptions {
  store: SpendStore;
  /** Read at every reservation and status call (a memoized KV reader in SpendDO). Default HOSTED_CAP_DEFAULTS. */
  caps?: () => HostedCaps | Promise<HostedCaps>;
  wallNow?: () => Date;
}

/** SpendDO's ledger: every hosted cap, orphan settle and the status the Platform page and admission read. */
export function createHostedSpendLedger(opts: HostedSpendLedgerOptions): HostedSpendLedger & { readonly core: LedgerCore } {
  const core = createLedgerCore({ store: opts.store, caps: opts.caps ?? (() => HOSTED_CAP_DEFAULTS), wallNow: opts.wallNow });
  return {
    core,
    reserve: (input) => core.reserve(input),
    settle: (id, actual, extra) => core.settle(id, actual, extra),
    release: (id) => core.release(id),
    spent: (scope) => core.spent(scope),
    status: (scope) => core.status(scope),
    settleOrphans: (now) => core.settleOrphans(now),
  };
}

// Caps from KV ----------------------------------------------------------------------------------------------------

const CAP_KEYS = [
  HOSTED_CONFIG_KEYS.capRunUsd, HOSTED_CONFIG_KEYS.capDayUsd, HOSTED_CONFIG_KEYS.capLiveUsd, HOSTED_CONFIG_KEYS.capVisitorDayUsd,
  HOSTED_CONFIG_KEYS.capIpDayUsd, HOSTED_CONFIG_KEYS.capNeuronsDay,
] as const;

const amount = (v: string | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  const t = v.trim();
  if (!t || !/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/**
 * Caps from KV `weft-config` values (absent or unreadable means the default). The live cap is "off" (the hosted
 * default, no lifetime or monthly ceiling) or an amount. The visitor and IP-hash caps each equal the day cap unless
 * set on their own (design section 0).
 */
export function hostedCapsFromConfig(read: (key: string) => string | null | undefined, base: HostedCaps = HOSTED_CAP_DEFAULTS): HostedCaps {
  const dayUsd = amount(read(HOSTED_CONFIG_KEYS.capDayUsd)) ?? base.dayUsd;
  const liveRaw = read(HOSTED_CONFIG_KEYS.capLiveUsd);
  const liveUsd = liveRaw === null || liveRaw === undefined ? base.liveUsd : liveRaw.trim().toLowerCase() === "off" ? null : amount(liveRaw) ?? base.liveUsd;
  const sameAsDay = (v: number) => (v === base.dayUsd ? dayUsd : v);
  return {
    runUsd: amount(read(HOSTED_CONFIG_KEYS.capRunUsd)) ?? base.runUsd,
    dayUsd,
    liveUsd,
    visitorDayUsd: amount(read(HOSTED_CONFIG_KEYS.capVisitorDayUsd)) ?? sameAsDay(base.visitorDayUsd),
    ipDayUsd: amount(read(HOSTED_CONFIG_KEYS.capIpDayUsd)) ?? sameAsDay(base.ipDayUsd),
    neuronsDay: amount(read(HOSTED_CONFIG_KEYS.capNeuronsDay)) ?? base.neuronsDay,
  };
}

/** The KV binding as the caps reader uses it, typed structurally. */
export interface KvLike { get(key: string): Promise<string | null> }

/**
 * A caps source over KV, memoized for HOSTED_SETTINGS.configMemoMs (60 s) per isolate: six KV reads a minute at most.
 * A KV error keeps the last caps read (or the defaults), so an outage never lifts a cap.
 */
export function kvCapsSource(kv: KvLike, opts: { memoMs?: number; now?: () => number; base?: HostedCaps } = {}): () => Promise<HostedCaps> {
  const memoMs = opts.memoMs ?? HOSTED_SETTINGS.configMemoMs;
  const now = opts.now ?? Date.now;
  let cached: { at: number; caps: HostedCaps } | null = null;
  return async () => {
    if (cached && now() - cached.at < memoMs) return cached.caps;
    try {
      const values = await Promise.all(CAP_KEYS.map((k) => kv.get(k)));
      const byKey = new Map<string, string | null>(CAP_KEYS.map((k, i) => [k, values[i] ?? null]));
      cached = { at: now(), caps: hostedCapsFromConfig((k) => byKey.get(k), opts.base) };
    } catch {
      cached = { at: now(), caps: cached?.caps ?? opts.base ?? HOSTED_CAP_DEFAULTS };
    }
    return cached.caps;
  };
}

// The world's ledger -----------------------------------------------------------------------------------------------

/** Who a world's reservations are charged to, read at every reservation (a reset or a new lease changes them). */
export interface LeaseBinding {
  /** "slot-N:gen-G": the run cap's world. */
  world(): string | null;
  visitor(): string | null;
  ipHash(): string | null;
}

export const isWorkersAiModel = (model: string): boolean => model === WORKERS_AI_MODEL || model.startsWith("@cf/");

/** The frozen SpendLedger the agent runtime gets on hosted, plus the lease's status for admission and the banner. */
export interface BoundSpendLedger extends SpendLedger {
  readonly hosted: HostedSpendLedger;
  status(): Promise<HostedSpendStatus>;
}

/**
 * An adapter over SpendDO bound to one world's lease. A Workers AI reservation also reserves its neurons (its USD
 * equivalents converted back at USD_PER_1K_NEURONS) against the neuron day cap and the agent share; its settle
 * records the neurons the step used.
 */
export function bindSpendLedger(hosted: HostedSpendLedger, bind: LeaseBinding, opts: { product?: NeuronProduct } = {}): BoundSpendLedger {
  const product = opts.product ?? "agent";
  /** Reservations made through this adapter that carry neurons (bounded; a lost entry settles at its reserved neurons). */
  const neuronReservations = new Set<string>();
  return {
    hosted,
    async reserve(input) {
      const neurons = isWorkersAiModel(input.model) ? neuronsForUsdMicros(input.usdMicros, USD_PER_1K_NEURONS) : 0;
      const full: HostedReserveInput = {
        ...input, world: bind.world(), visitor: bind.visitor(), ipHash: bind.ipHash(),
        ...(neurons > 0 ? { neurons, product } : {}),
      };
      const r = await hosted.reserve(full);
      if (r.ok && neurons > 0) {
        neuronReservations.add(r.reservationId);
        if (neuronReservations.size > 1000) neuronReservations.delete(neuronReservations.values().next().value!);
      }
      return r;
    },
    async settle(id, actualUsdMicros) {
      if (neuronReservations.delete(id)) return hosted.settle(id, actualUsdMicros, { neurons: neuronsForUsdMicros(actualUsdMicros, USD_PER_1K_NEURONS) });
      return hosted.settle(id, actualUsdMicros);
    },
    async release(id) {
      neuronReservations.delete(id);
      return hosted.release(id);
    },
    spent: (scope) => hosted.spent({ ...scope, ...(scope.runId !== undefined ? { world: bind.world() ?? undefined } : {}) }),
    status: () => hosted.status({ visitor: bind.visitor(), ipHash: bind.ipHash() }),
  };
}
