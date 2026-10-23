// The durable platform (docs/cloudflare/design.md 3.3, 4 and 6.4, track cf2-platform): what CompanyDO (cf4-worker)
// hands assembleWeft for one world. Every part lives in the slot's Durable Object storage or comes from the Worker
// env: the database through the cf1-db facade over ctx.storage, uploads in `blobs`, small state in `kv_state`, run
// handles and run files in their tables, the bundled fixtures, the SpendDO ledger bound to this world's lease, the
// alarm RunHost and SchedulerHost. No part calls node:fs (apps/api/test/hosted-platform.test.ts runs an fs guard).
import { DurableDbError, migrateDurable, migrationEntries, openDurableDb, type Db, type MigrationJournal } from "@weft/db";
import type { CommandDef, SpendLedger } from "@weft/contracts";
import { hostedServiceCommands, SqlRepo } from "@weft/executor";
import { isWorkersAiModel, neuronsForUsdMicros } from "@weft/agent";
import type { DurableDbHandle, DurableStorageLike, TxGuard } from "../../../../packages/contracts/src/ext/cf-db";
import { FROZEN_CAP, USD_PER_1K_NEURONS, type FetchCounter, type HostedReserveRefusal, type HostedSpendLedger, type HostedSpendStatus, type WorkersAiBindingLike } from "../../../../packages/contracts/src/ext/cf-agent";
import { HOSTED_SETTINGS, hostedWorldId, type HostedWorldRef } from "../../../../packages/contracts/src/ext/cf-hosted";
import type { MemoryRepo } from "../../../../packages/contracts/src/ext/cf-memory";
import { SMALL_STATE_KEYS, type DurablePlatformInput, type DurableWeftPlatform, type FixtureSource, type PlatformDb, type SmallState } from "../../../../packages/contracts/src/ext/cf-platform";
import type { HostedResetHook } from "../http/context";
import { markUncachable } from "../http/hosted";
import { FIXTURE_PATHS } from "./fixtures";
import { sqlBlobStore, sqlRunFileStore, sqlRunHandleStore } from "./sql";
import { sqlSmallState } from "./state";

/** How the durable platform opens and migrates its database (cf1-db's facade and migrator). */
export interface DurableDbDriver {
  /** openDurableDb(storage): the drizzle Db over ctx.storage, with its meter and IO_IN_TX guard. */
  open(storage: DurableStorageLike): DurableDbHandle<Db>;
  /** migrate-durable: one transactionSync per pending journal entry, from the bundled drizzle/*.sql and journal. */
  migrate(storage: DurableStorageLike, fixtures: FixtureSource): Promise<void> | void;
}

export interface DurablePlatformDeps {
  /** Defaults to cf1-db's facade and migrator (openDurableDb and migrateDurable from @weft/db). */
  driver?: DurableDbDriver;
  /** The SQL memory repo of a company; defaults to cf1-db's SqlRepo over the world's Db (every company of a world
   * shares the world's database, and the repo keeps one branch per database, as git keeps one per directory). */
  memoryRepo?: (db: Db, companyId: string) => MemoryRepo;
}

/** What CompanyDO passes besides the frozen DurablePlatformInput: the hosted reset (delta reset or full restore). */
export interface HostedPlatformInput extends DurablePlatformInput {
  reset?: HostedResetHook;
  /** Hosted upload cap (HOSTED_SETTINGS.uploadMaxBytes, 1.5 MB, by default). */
  uploadMaxBytes?: number;
}

/** What assemble's hosted model path reads beyond the frozen platform parts (cf3-agent's provider pool). */
export interface DurableHostedParts {
  /** The Worker env as CompanyDO keeps it: live, so a KV weft-config change (folded in under WEFT_* names, at most
   * 60 s old) reaches the next run without a reboot. `env` above is the same view. */
  readonly ai: WorkersAiBindingLike | null;
  readonly fetch: typeof fetch | null;
  readonly fetchCounter: FetchCounter | null;
  /** The lease's position in SpendDO (provider choice at run creation); null when it cannot be read. */
  spendStatus(): Promise<HostedSpendStatus | null>;
}

export interface WeftDurablePlatform extends DurableWeftPlatform<Db> {
  readonly reset: HostedResetHook | null;
  /** The guard of the opened database, once openDb ran. */
  guard(): TxGuard | null;
  readonly hosted: DurableHostedParts;
}

const uniqueByName = (cmds: readonly CommandDef[]): CommandDef[] => [...new Map(cmds.map((c) => [c.name, c])).values()];

/** A read-only view of `base` with `over` on top, read at each use (CompanyDO's env is itself a live view). */
function overlayEnv(base: Readonly<Record<string, string | undefined>>, over: Record<string, string>): Readonly<Record<string, string | undefined>> {
  const keys = () => [...new Set([...Object.keys(base), ...Object.keys(over)])];
  return new Proxy({} as Record<string, string | undefined>, {
    get: (_t, k) => (typeof k !== "string" ? undefined : Object.hasOwn(over, k) ? over[k] : base[k]),
    has: (_t, k) => typeof k === "string" && (Object.hasOwn(over, k) || k in base),
    ownKeys: () => keys(),
    getOwnPropertyDescriptor: (_t, k) => {
      if (typeof k !== "string" || !(Object.hasOwn(over, k) || k in base)) return undefined;
      return { value: Object.hasOwn(over, k) ? over[k] : base[k], enumerable: true, configurable: true, writable: false };
    },
    set: () => false,
    deleteProperty: () => false,
  });
}

/** The migrations as drizzle reads its folder, from the bundled journal and SQL files (cf1-db migrations.ts). */
export function fixtureMigrations(fixtures: FixtureSource) {
  const journal = fixtures.text(FIXTURE_PATHS.journal);
  if (journal === null) throw new Error(`the fixtures have no migration journal (${FIXTURE_PATHS.journal})`);
  return migrationEntries(JSON.parse(journal) as MigrationJournal, (tag) => {
    const text = fixtures.text(`${FIXTURE_PATHS.migrations}/${tag}.sql`);
    if (text === null) throw new Error(`the fixtures have no migration ${tag}`);
    return text;
  });
}

/** cf1-db's facade and migrator: openDurableDb over the storage, and one transactionSync per pending journal entry. */
export function defaultDurableDriver(): DurableDbDriver {
  return {
    open: (storage) => openDurableDb(storage),
    migrate: (storage, fixtures) => { migrateDurable(storage, fixtureMigrations(fixtures)); },
  };
}

/**
 * The SpendDO ledger as the agent runtime sees it: the frozen SpendLedger, with every reservation charged to this
 * world ("slot-N:gen-G", the run cap key with the run id) and to the lease's visitor and IP hash, which CompanyDO
 * keeps in kv_state, so background runs fall inside the same caps (design 5.3). Every call is a DO RPC: never inside
 * a transaction (IO_IN_TX), and a request that reads it is not cached by the ETag layer.
 */
export function hostedSpendLedger(spend: HostedSpendLedger, o: { world: HostedWorldRef; state: () => SmallState | null; guard: () => TxGuard | null }): SpendLedger {
  const worldId = hostedWorldId(o.world);
  const io = (what: string) => { o.guard()?.assertNotInTx(what); markUncachable(what); };
  // A Workers AI step also reserves its neurons (its USD equivalent converted back) against the neuron day cap and the
  // agent's share, and settles the neurons it used, as bindSpendLedger does; without this a world switched to
  // workers_ai would spend the day's free neurons (OCR, dictation, embeddings) under the USD caps alone.
  const neuronReservations = new Set<string>();
  /** The lease's visitor and IP hash, or null when either cannot be read or was never stored. */
  const lease = (): { visitor: string; ipHash: string } | null => {
    try {
      const s = o.state();
      const visitor = s?.get(SMALL_STATE_KEYS.leaseVisitor) ?? null, ipHash = s?.get(SMALL_STATE_KEYS.leaseIpHash) ?? null;
      return visitor && ipHash ? { visitor, ipHash } : null;
    } catch { return null; }
  };
  return {
    async reserve(input) {
      io("SpendDO.reserve");
      const who = lease();
      // Fails closed: a reservation that could spend money is never made without the lease's visitor and IP hash, so
      // no run escapes the visitor and IP caps (a slot between leases, or kv_state unreadable). A non-live attempt (the
      // scripted provider reserves and settles at zero, as slot-smoke does) needs no lease.
      if (!who && (input.live || input.usdMicros > 0)) {
        return { ok: false, code: "BUDGET_EXCEEDED", cap: FROZEN_CAP.visitor, hostedCap: "visitor", spentMicros: 0, capMicros: 0 } satisfies HostedReserveRefusal;
      }
      const neurons = isWorkersAiModel(input.model) ? neuronsForUsdMicros(input.usdMicros, USD_PER_1K_NEURONS) : 0;
      const r = await spend.reserve({ ...input, world: worldId, visitor: who?.visitor ?? null, ipHash: who?.ipHash ?? null, ...(neurons > 0 ? { neurons, product: "agent" as const } : {}) });
      if (r.ok && neurons > 0) {
        neuronReservations.add(r.reservationId);
        if (neuronReservations.size > 1000) neuronReservations.delete(neuronReservations.values().next().value!);
      }
      return r;
    },
    async settle(reservationId, actualUsdMicros) {
      io("SpendDO.settle");
      if (neuronReservations.delete(reservationId)) await spend.settle(reservationId, actualUsdMicros, { neurons: neuronsForUsdMicros(actualUsdMicros, USD_PER_1K_NEURONS) });
      else await spend.settle(reservationId, actualUsdMicros);
    },
    async release(reservationId) { io("SpendDO.release"); neuronReservations.delete(reservationId); await spend.release(reservationId); },
    async spent(scope) {
      io("SpendDO.spent");
      return spend.spent(scope.runId ? { ...scope, world: worldId } : scope);
    },
  };
}

/** What a statement or transaction on a closed world's database throws (closableStorage). */
export const ENGINE_CLOSED = "ENGINE_CLOSED";

/**
 * The Durable Object's storage as one world's engine sees it, with a fence: once `close()` ran, every statement and
 * every transaction through it (the Db, its migrations and the world's small state) throws ENGINE_CLOSED, and a
 * transaction still open then rolls back at its next statement. A reset waits for in-flight work only so long (the
 * QUIESCE_MS bound in CompanyDO, then the close's own drain), so a write-back or an alarm-hosted run that outlives
 * them would otherwise commit into the next generation's world on the same storage. The storage itself stays open
 * for the Durable Object, and the next world's engine gets its own fence.
 */
export function closableStorage<S extends DurableStorageLike>(storage: S): { storage: S; close(): void; closed(): boolean } {
  let closed = false;
  const check = (what: string) => {
    if (closed) throw new DurableDbError(ENGINE_CLOSED, `${ENGINE_CLOSED}: ${what} on a world whose engine has closed (a reset or restore replaced it), so nothing more is written to it`);
  };
  /** `target` with `over` in front; every other member is the target's own (methods bound to it, getters read on it). */
  const view = <T extends object>(target: T, over: Record<string, unknown>): T => new Proxy(target, {
    get(t, k) {
      if (typeof k === "string" && Object.hasOwn(over, k)) return over[k];
      const v = Reflect.get(t, k, t) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
  const sql = view(storage.sql, {
    exec: (query: string, ...bindings: unknown[]) => { check("a statement"); return storage.sql.exec(query, ...bindings); },
  });
  const fenced = view(storage, {
    sql,
    transaction: <T>(closure: (txn: unknown) => Promise<T>) => { check("a transaction"); return storage.transaction(closure); },
    transactionSync: <T>(closure: () => T) => { check("a transaction"); return storage.transactionSync(closure); },
    deleteAll: () => { check("deleteAll"); return storage.deleteAll(); },
  });
  return { storage: fenced, close: () => { closed = true; }, closed: () => closed };
}

/** The durable platform for one world. CompanyDO builds it from its ctx.storage, env and the SpendDO stub. */
export function durablePlatform(input: HostedPlatformInput, deps: DurablePlatformDeps = {}): WeftDurablePlatform {
  const driver = deps.driver ?? defaultDurableDriver();
  // Live, not a copy: CompanyDO folds KV weft-config into its env view, and the model switch, the kill switch and the
  // caps must reach a running world (the provider is chosen at each run creation).
  const env = overlayEnv(input.env, { WEFT_RUNTIME: "cloudflare" });
  // Everything this world reads and writes goes through the fence its close() shuts (closableStorage).
  const fence = closableStorage(input.storage);
  const state = sqlSmallState(fence.storage.sql);
  let guard: TxGuard | null = null;
  // The guard exists once openDb ran; parts built before that see it through this indirection.
  const liveGuard: TxGuard = { inTx: () => guard?.inTx() ?? false, assertNotInTx: (what) => guard?.assertNotInTx(what) };
  const memoryRepo = deps.memoryRepo ?? ((db: Db) => new SqlRepo(db));
  return {
    kind: "durable",
    env,
    world: input.world,
    readOnly: input.world.mode === "showcase",
    reset: input.reset ?? null,
    guard: () => guard,
    hosted: {
      ai: input.ai ?? null,
      fetch: input.fetch ?? null,
      fetchCounter: input.fetchCounter ?? null,
      async spendStatus() {
        const s = (() => { try { return { visitor: state.get(SMALL_STATE_KEYS.leaseVisitor), ipHash: state.get(SMALL_STATE_KEYS.leaseIpHash) }; } catch { return null; } })();
        if (!s || liveGuard.inTx()) return null;
        markUncachable("SpendDO.status");
        try { return await input.spend.status(s); } catch { return null; }
      },
    },
    async openDb(): Promise<PlatformDb<Db>> {
      await driver.migrate(fence.storage, input.fixtures);
      const h = driver.open(fence.storage);
      guard = h.guard;
      // The storage belongs to the Durable Object and stays open for the next world; this world's view of it closes,
      // last in assembleWeft's close (after the scheduler stopped and the runs and finalizations drained).
      return { db: h.db, meter: h.meter, guard: h.guard, close: async () => fence.close() };
    },
    blobs: (ctx) => sqlBlobStore(ctx.db, { maxBytes: input.uploadMaxBytes ?? HOSTED_SETTINGS.uploadMaxBytes, guard: liveGuard }),
    state: () => state,
    fixtures: input.fixtures,
    runHandles: (ctx) => sqlRunHandleStore(ctx.db),
    runFiles: (ctx) => sqlRunFileStore(ctx.db),
    memoryRepo: (ctx, companyId) => memoryRepo(ctx.db, companyId),
    spendLedger: () => hostedSpendLedger(input.spend, { world: input.world, state: () => state, guard: () => liveGuard }),
    runHost: input.runHost,
    schedulerHost: input.schedulerHost,
    executor: {
      // Design 4.4: page GETs and MCP reads write no rows on hosted.
      ephemeralReadIds: true,
      // The hidden OCR write-backs (their one definition, the executor's hosted/commands.ts) plus whatever CompanyDO
      // adds; a command passed twice under one name is registered once.
      extraCommands: uniqueByName([...(hostedServiceCommands() as unknown as CommandDef[]), ...(input.extraCommands ?? [])]),
      ...(input.onOutbox ? { onOutbox: input.onOutbox } : {}),
    },
  };
}
