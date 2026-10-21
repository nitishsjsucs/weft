// The spend ledger's fold, totals and cap code (harness 4.5, 13.7; SPEC 9.10; docs/cloudflare/design.md 4.3, 5.2 and
// 6.3), shared by the Node file store (spend.ts, <dir>/<yyyy-mm-dd UTC>.jsonl) and the SQL store SpendDO runs
// (spend-sql.ts). A store only keeps entries and runs a body exclusively; everything that decides lives here, so the
// two stores give identical results for every cap. Portable: no node: imports, so the Worker bundle can load it.
//
// An entry is a reservation, its settle or its release. Open reservations count at their reserved amount. Settle and
// release entries copy the reservation's day, run, world, visitor and IP hash, so every scope filter sees a
// reservation and its close together. A reservation closes once: a second settle or release is ignored, so a replayed
// alarm never moves a settled figure.
import type { SpendEntry } from "@weft/contracts";
import {
  FROZEN_CAP, NEURON_SHARES, ORPHAN_SETTLE_MS, type HostedCap, type HostedCaps, type HostedReserveInput, type HostedReserveRefusal,
  type HostedSpendScope, type HostedSpendStatus, type NeuronProduct,
} from "../../contracts/src/ext/cf-agent";

/** A ledger line: the contract's entry plus who it is charged to, when the ledger knows. Absent fields are omitted. */
export type LedgerEntry = SpendEntry & {
  /** The world the run id belongs to ("wld_..." on Node, "slot-N:gen-G" on hosted). */
  world?: string;
  visitor?: string;
  ipHash?: string;
  /** Workers AI: neurons reserved (reserve) or used (settle), against the neuron day cap and the product's share. */
  neurons?: number;
  product?: NeuronProduct;
};

/** The Node caps (the frozen three). */
export interface SpendCaps { runUsd: number; dayUsd: number; liveUsd: number }

export function capsFromEnv(env: Record<string, string | undefined>): SpendCaps {
  const num = (v: string | undefined, d: number) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
  return { runUsd: num(env.WEFT_RUN_USD_CAP, 0.1), dayUsd: num(env.WEFT_DAY_USD_CAP, 2), liveUsd: num(env.WEFT_LIVE_USD_CAP, 0.5) };
}

/** Node caps as hosted caps: no visitor, IP-hash or neuron cap applies to a reservation that names none. */
export function nodeCaps(c: SpendCaps): HostedCaps {
  return { runUsd: c.runUsd, dayUsd: c.dayUsd, liveUsd: c.liveUsd, visitorDayUsd: Infinity, ipDayUsd: Infinity, neuronsDay: Infinity };
}

/** What a store is asked for. A store may return more entries than match; the fold and filters below decide. */
export interface EntryQuery {
  /** UTC days of the reservations (a settle is filed under its reservation's day). */
  days?: string[];
  runId?: string;
  /** With runId: only that world's run. Absent: the run id alone. */
  world?: string;
  live?: boolean;
  reservationId?: string;
}

export interface SpendStore {
  readonly kind: "file" | "sqlite";
  /** Runs `fn` exclusively against every other writer (file: an mkdir lock; SQL: one synchronous transaction). */
  exclusive<T>(fn: () => T): Promise<T>;
  entries(q: EntryQuery): LedgerEntry[];
  append(e: LedgerEntry): void;
  newReservationId(): string;
}

export interface Folded { e: LedgerEntry; micros: number; neurons: number; open: boolean }

/** Fold entries into per-reservation state: open reservations count at their reserved amount. */
export function fold(entries: Iterable<LedgerEntry>): Map<string, Folded> {
  const m = new Map<string, Folded>();
  for (const e of entries) {
    if (e.kind === "reserve") m.set(e.reservationId, { e, micros: e.usdMicros, neurons: e.neurons ?? 0, open: true });
    else {
      const cur = m.get(e.reservationId);
      if (!cur) continue;
      cur.micros = e.kind === "settle" ? e.usdMicros : 0;
      cur.neurons = e.kind === "settle" ? (e.neurons ?? 0) : 0;
      cur.open = false;
    }
  }
  return m;
}

export interface TotalsScope { day?: string; runId?: string; world?: string; live?: boolean; visitor?: string; ipHash?: string; product?: NeuronProduct }
export interface Totals { settledMicros: number; openMicros: number; neurons: number }

export function totalsOf(folded: Iterable<Folded>, scope: TotalsScope): Totals {
  let settledMicros = 0;
  let openMicros = 0;
  let neurons = 0;
  for (const r of folded) {
    if (scope.day !== undefined && r.e.at.slice(0, 10) !== scope.day) continue;
    if (scope.runId !== undefined && r.e.runId !== scope.runId) continue;
    if (scope.world !== undefined && r.e.world !== scope.world) continue;
    if (scope.live !== undefined && r.e.live !== scope.live) continue;
    if (scope.visitor !== undefined && r.e.visitor !== scope.visitor) continue;
    if (scope.ipHash !== undefined && r.e.ipHash !== scope.ipHash) continue;
    if (scope.product !== undefined && r.e.product !== scope.product) continue;
    if (r.open) openMicros += r.micros;
    else settledMicros += r.micros;
    neurons += r.neurons;
  }
  return { settledMicros, openMicros, neurons };
}

/** The store query that covers a totals scope: a day reads that day, a run its run, live every live entry. */
export function queryFor(scope: TotalsScope): EntryQuery {
  if (scope.day !== undefined) return { days: [scope.day] };
  if (scope.runId !== undefined) return { runId: scope.runId, ...(scope.world !== undefined ? { world: scope.world } : {}) };
  if (scope.live === true) return { live: true };
  return {};
}

export const utcDay = (d: Date): string => d.toISOString().slice(0, 10);
const previousDay = (d: Date): string => utcDay(new Date(d.getTime() - 86_400_000));

/** USD equivalents of Workers AI neurons (cf-agent.ts USD_PER_1K_NEURONS: 11 micro dollars per neuron), rounded up. */
export function neuronsForUsdMicros(micros: number, usdPer1k: number): number {
  if (!(micros > 0)) return 0;
  return Math.ceil(micros / (usdPer1k * 1000) - 1e-9);
}

export interface LedgerCoreOptions {
  store: SpendStore;
  caps: () => HostedCaps | Promise<HostedCaps>;
  /** Wall clock, injectable for tests. Never the sim clock. */
  wallNow?: () => Date;
  /** The world a run scope defaults to when the caller names none (Node's world id, read at every call). */
  world?: () => string | null;
}

export interface LedgerCore {
  reserve(input: HostedReserveInput): Promise<{ ok: true; reservationId: string } | HostedReserveRefusal>;
  settle(reservationId: string, actualUsdMicros: number, actual?: { neurons?: number }): Promise<void>;
  release(reservationId: string): Promise<void>;
  /** Settled plus open reservations for a scope; what the cap check uses. */
  committed(scope: HostedSpendScope & { product?: NeuronProduct }): Promise<Totals>;
  spent(scope: HostedSpendScope): Promise<number>;
  status(scope: { visitor?: string | null; ipHash?: string | null }): Promise<HostedSpendStatus>;
  settleOrphans(now?: Date): Promise<number>;
  readonly store: SpendStore;
}

const PRODUCTS = Object.keys(NEURON_SHARES) as NeuronProduct[];

export function createLedgerCore(opts: LedgerCoreOptions): LedgerCore {
  const { store } = opts;
  const wallNow = opts.wallNow ?? (() => new Date());
  const defaultWorld = (): string | undefined => opts.world?.() ?? undefined;

  /** A run scope means that run id in its world: an earlier world's run_0001 is another run. */
  const scoped = (s: HostedSpendScope & { product?: NeuronProduct }): TotalsScope => {
    const world = s.world ?? (s.runId !== undefined ? defaultWorld() : undefined);
    return {
      ...(s.day !== undefined ? { day: s.day } : {}), ...(s.runId !== undefined ? { runId: s.runId } : {}), ...(world !== undefined ? { world } : {}),
      ...(s.live !== undefined ? { live: s.live } : {}), ...(s.visitor !== undefined ? { visitor: s.visitor } : {}), ...(s.ipHash !== undefined ? { ipHash: s.ipHash } : {}),
      ...(s.product !== undefined ? { product: s.product } : {}),
    };
  };
  const totals = (scope: TotalsScope): Totals => totalsOf(fold(store.entries(queryFor(scope))).values(), scope);
  const usd = (t: Totals) => t.settledMicros + t.openMicros;

  /** The reservation and whether it has closed, or null. */
  function reservation(id: string): { r: LedgerEntry; closed: boolean } | null {
    const es = store.entries({ reservationId: id }).filter((e) => e.reservationId === id);
    const r = es.find((e) => e.kind === "reserve");
    return r ? { r, closed: es.some((e) => e.kind !== "reserve") } : null;
  }

  /** A close entry copies the reservation's day (its `at`), run, world, visitor, IP hash and product. */
  function closeOf(r: LedgerEntry, kind: "settle" | "release", usdMicros: number, neurons: number | undefined): LedgerEntry {
    return {
      at: r.at, runId: r.runId, kind, reservationId: r.reservationId, usdMicros, model: r.model, live: r.live,
      ...(r.world !== undefined ? { world: r.world } : {}), ...(r.visitor !== undefined ? { visitor: r.visitor } : {}), ...(r.ipHash !== undefined ? { ipHash: r.ipHash } : {}),
      ...(r.neurons !== undefined ? { neurons: neurons ?? 0, product: r.product } : {}),
    };
  }

  return {
    store,
    async reserve(input) {
      const caps = await opts.caps();
      return store.exclusive(() => {
        const now = wallNow();
        const day = utcDay(now);
        const world = input.runId !== null ? (input.world === undefined ? defaultWorld() : input.world ?? undefined) : undefined;
        const visitor = input.visitor ?? undefined;
        const ipHash = input.ipHash ?? undefined;
        const neurons = input.neurons !== undefined && input.neurons > 0 ? Math.ceil(input.neurons) : 0;
        const checks: { cap: HostedCap; capMicros: number; committed: number }[] = [];
        // The frozen three first, in their order (run, day, live), then the hosted caps.
        if (input.runId !== null) checks.push({ cap: "run", capMicros: caps.runUsd * Math.max(1, input.runCapScale ?? 1) * 1e6, committed: usd(totals({ runId: input.runId, ...(world !== undefined ? { world } : {}) })) });
        checks.push({ cap: "day", capMicros: caps.dayUsd * 1e6, committed: usd(totals({ day })) });
        if (input.live && caps.liveUsd !== null) checks.push({ cap: "live", capMicros: caps.liveUsd * 1e6, committed: usd(totals({ live: true })) });
        if (visitor !== undefined) checks.push({ cap: "visitor", capMicros: caps.visitorDayUsd * 1e6, committed: usd(totals({ day, visitor })) });
        if (ipHash !== undefined) checks.push({ cap: "ip", capMicros: caps.ipDayUsd * 1e6, committed: usd(totals({ day, ipHash })) });
        for (const c of checks) {
          if (c.committed + input.usdMicros > c.capMicros) return refusal(c.cap, c.committed, c.capMicros);
        }
        if (neurons > 0) {
          // The neuron cap counts neurons, not dollars: spentMicros and capMicros carry neurons for this cap.
          const used = totals({ day }).neurons;
          if (used + neurons > caps.neuronsDay) return refusal("neurons", used, caps.neuronsDay);
          if (input.product !== undefined) {
            const share = NEURON_SHARES[input.product];
            const byProduct = totals({ day, product: input.product }).neurons;
            if (byProduct + neurons > share) return refusal("neurons", byProduct, share);
          }
        }
        const reservationId = store.newReservationId();
        store.append({
          at: now.toISOString(), runId: input.runId, kind: "reserve", reservationId, usdMicros: Math.ceil(input.usdMicros), model: input.model, live: input.live,
          ...(world !== undefined ? { world } : {}), ...(visitor !== undefined ? { visitor } : {}), ...(ipHash !== undefined ? { ipHash } : {}),
          ...(neurons > 0 ? { neurons, ...(input.product !== undefined ? { product: input.product } : {}) } : {}),
        });
        return { ok: true as const, reservationId };
      });
    },
    async settle(reservationId, actualUsdMicros, actual) {
      await store.exclusive(() => {
        const hit = reservation(reservationId);
        if (!hit || hit.closed) return;
        const neurons = hit.r.neurons !== undefined ? Math.max(0, Math.ceil(actual?.neurons ?? hit.r.neurons)) : undefined;
        store.append(closeOf(hit.r, "settle", Math.max(0, Math.ceil(actualUsdMicros)), neurons));
      });
    },
    async release(reservationId) {
      await store.exclusive(() => {
        const hit = reservation(reservationId);
        if (!hit || hit.closed) return;
        store.append(closeOf(hit.r, "release", 0, hit.r.neurons !== undefined ? 0 : undefined));
      });
    },
    async committed(scope) {
      return totals(scoped(scope));
    },
    async spent(scope) {
      return totals(scoped(scope)).settledMicros;
    },
    async status(scope) {
      const caps = await opts.caps();
      const day = utcDay(wallNow());
      const f = [...fold(store.entries({ days: [day] })).values()];
      const of = (s: TotalsScope) => totalsOf(f, { day, ...s });
      const byProduct = Object.fromEntries(PRODUCTS.map((p) => [p, of({ product: p }).neurons])) as Record<NeuronProduct, number>;
      return {
        day,
        caps,
        spentMicros: {
          day: usd(of({})),
          visitor: scope.visitor ? usd(of({ visitor: scope.visitor })) : null,
          ip: scope.ipHash ? usd(of({ ipHash: scope.ipHash })) : null,
          // Cumulative live spend is read only while the live cap is on (the hosted default has it off).
          live: caps.liveUsd !== null ? usd(totals({ live: true })) : 0,
        },
        neurons: { used: of({}).neurons, byProduct },
        openReservations: f.filter((r) => r.open && r.e.at.slice(0, 10) === day).length,
      };
    },
    async settleOrphans(now = wallNow()) {
      return store.exclusive(() => {
        // Sweeps run every 15 minutes, so yesterday and today hold every reservation still open.
        const cutoff = now.getTime() - ORPHAN_SETTLE_MS;
        let n = 0;
        for (const r of fold(store.entries({ days: [previousDay(now), utcDay(now)] })).values()) {
          if (!r.open || Date.parse(r.e.at) > cutoff) continue;
          // At its reserved worst case, which errs toward the cap (design 6.3).
          store.append(closeOf(r.e, "settle", r.e.usdMicros, r.e.neurons));
          n++;
        }
        return n;
      });
    },
  };
}

function refusal(cap: HostedCap, spent: number, capValue: number): HostedReserveRefusal {
  return { ok: false, code: "BUDGET_EXCEEDED", cap: FROZEN_CAP[cap], hostedCap: cap, spentMicros: spent, capMicros: capValue };
}

/** Reservation ids: rsv_ plus 16 random hex (Web Crypto, so Node and workerd share it). */
export function randomReservationId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return `rsv_${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}
