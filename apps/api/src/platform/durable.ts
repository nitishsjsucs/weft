// The durable platform (docs/cloudflare/design.md 3.3, 4 and 6.4, track cf2-platform): what CompanyDO (cf4-worker)
// hands assembleWeft for one world. Every part lives in the slot's Durable Object storage or comes from the Worker
// env: the database through the cf1-db facade over ctx.storage, uploads in `blobs`, small state in `kv_state`, run
// handles and run files in their tables, the bundled fixtures, the SpendDO ledger bound to this world's lease, the
// alarm RunHost and SchedulerHost. No part calls node:fs (apps/api/test/hosted-platform.test.ts runs an fs guard).
import * as weftDb from "@weft/db";
import { NotImplemented, type CommandDef, type SpendLedger } from "@weft/contracts";
import type { Db } from "@weft/db";
import * as weftExecutor from "@weft/executor";
import { hostedServiceCommands } from "@weft/executor";
import type { DurableDbHandle, DurableStorageLike, TxGuard } from "../../../../packages/contracts/src/ext/cf-db";
import type { HostedSpendLedger } from "../../../../packages/contracts/src/ext/cf-agent";
import { HOSTED_SETTINGS, hostedWorldId, type HostedWorldRef } from "../../../../packages/contracts/src/ext/cf-hosted";
import type { MemoryRepo } from "../../../../packages/contracts/src/ext/cf-memory";
import { SMALL_STATE_KEYS, type DurablePlatformInput, type DurableWeftPlatform, type FixtureSource, type PlatformDb, type SmallState } from "../../../../packages/contracts/src/ext/cf-platform";
import type { HostedResetHook } from "../http/context";
import { markUncachable } from "../http/hosted";
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
  /** Defaults to cf1-db's exports (openDurableDb and migrateDurable from @weft/db). */
  driver?: DurableDbDriver;
  /** The SQL memory repo of a company; defaults to cf1-db's createSqlRepo(storage, companyId) from @weft/executor. */
  memoryRepo?: (storage: DurableStorageLike, companyId: string) => MemoryRepo;
}

/** What CompanyDO passes besides the frozen DurablePlatformInput: the hosted reset (delta reset or full restore). */
export interface HostedPlatformInput extends DurablePlatformInput {
  reset?: HostedResetHook;
  /** Hosted upload cap (HOSTED_SETTINGS.uploadMaxBytes, 1.5 MB, by default). */
  uploadMaxBytes?: number;
}

export interface WeftDurablePlatform extends DurableWeftPlatform<Db> {
  readonly reset: HostedResetHook | null;
  /** The guard of the opened database, once openDb ran. */
  guard(): TxGuard | null;
}

const fromModule = <T>(mod: unknown, name: string, track: string): T => {
  const f = (mod as Record<string, unknown>)[name];
  if (typeof f !== "function") throw new NotImplemented(`${name} is not exported yet (${track})`);
  return f as T;
};

/** cf1-db's facade and migrator, looked up when the platform opens its database. */
export function defaultDurableDriver(): DurableDbDriver {
  return {
    open: (storage) => fromModule<(s: DurableStorageLike) => DurableDbHandle<Db>>(weftDb, "openDurableDb", "cf1-db")(storage),
    migrate: (storage, fixtures) => fromModule<(s: DurableStorageLike, f: FixtureSource) => Promise<void> | void>(weftDb, "migrateDurable", "cf1-db")(storage, fixtures),
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
  const lease = () => {
    const s = o.state();
    const read = (k: string) => { try { return s?.get(k) ?? null; } catch { return null; } };
    return { visitor: read(SMALL_STATE_KEYS.leaseVisitor), ipHash: read(SMALL_STATE_KEYS.leaseIpHash) };
  };
  return {
    async reserve(input) {
      io("SpendDO.reserve");
      return spend.reserve({ ...input, world: worldId, ...lease() });
    },
    async settle(reservationId, actualUsdMicros) { io("SpendDO.settle"); await spend.settle(reservationId, actualUsdMicros); },
    async release(reservationId) { io("SpendDO.release"); await spend.release(reservationId); },
    async spent(scope) {
      io("SpendDO.spent");
      return spend.spent(scope.runId ? { ...scope, world: worldId } : scope);
    },
  };
}

/** The durable platform for one world. CompanyDO builds it from its ctx.storage, env and the SpendDO stub. */
export function durablePlatform(input: HostedPlatformInput, deps: DurablePlatformDeps = {}): WeftDurablePlatform {
  const driver = deps.driver ?? defaultDurableDriver();
  const env: Readonly<Record<string, string | undefined>> = Object.freeze({ WEFT_RUNTIME: "cloudflare", ...input.env });
  const state = sqlSmallState(input.storage.sql);
  let guard: TxGuard | null = null;
  // The guard exists once openDb ran; parts built before that see it through this indirection.
  const liveGuard: TxGuard = { inTx: () => guard?.inTx() ?? false, assertNotInTx: (what) => guard?.assertNotInTx(what) };
  const memoryRepo = deps.memoryRepo ?? ((storage: DurableStorageLike, companyId: string) =>
    fromModule<(s: DurableStorageLike, c: string) => MemoryRepo>(weftExecutor, "createSqlRepo", "cf1-db")(storage, companyId));
  return {
    kind: "durable",
    env,
    world: input.world,
    readOnly: input.world.mode === "showcase",
    reset: input.reset ?? null,
    guard: () => guard,
    async openDb(): Promise<PlatformDb<Db>> {
      await driver.migrate(input.storage, input.fixtures);
      const h = driver.open(input.storage);
      guard = h.guard;
      // The storage belongs to the Durable Object; closing the world leaves it open for the next request.
      return { db: h.db, meter: h.meter, guard: h.guard, close: async () => undefined };
    },
    blobs: (ctx) => sqlBlobStore(ctx.db, { maxBytes: input.uploadMaxBytes ?? HOSTED_SETTINGS.uploadMaxBytes, guard: liveGuard }),
    state: () => state,
    fixtures: input.fixtures,
    runHandles: (ctx) => sqlRunHandleStore(ctx.db),
    runFiles: (ctx) => sqlRunFileStore(ctx.db),
    memoryRepo: (_ctx, companyId) => memoryRepo(input.storage, companyId),
    spendLedger: () => hostedSpendLedger(input.spend, { world: input.world, state: () => state, guard: () => liveGuard }),
    runHost: input.runHost,
    schedulerHost: input.schedulerHost,
    executor: {
      // Design 4.4: page GETs and MCP reads write no rows on hosted.
      ephemeralReadIds: true,
      // The hidden OCR write-backs (hosted/commands.ts) plus whatever CompanyDO adds.
      extraCommands: [...(hostedServiceCommands() as unknown as CommandDef[]), ...(input.extraCommands ?? [])],
      ...(input.onOutbox ? { onOutbox: input.onOutbox } : {}),
    },
  };
}
