// The Weft stack CompanyDO's real engine needs, by name, in one place (the names cf1-db, cf2-platform and cf3-agent
// export on their branches as of 2026-10-20). Each name is looked up on its module's namespace when the engine
// boots, so a part a track has not exported yet fails the boot with a message naming the track and the export
// (CompanyDO answers 503 WORLD_NOT_READY) instead of failing the bundle. .scratch/contract-requests/cf4-worker.md
// lists every name; the Integrate stage checks this file once the three tracks are merged.
import * as dbModule from "@weft/db";
import * as assembleModule from "@weft/api/assemble";
import * as agentModule from "@weft/agent";
import * as executorModule from "@weft/executor";
// cf3 exports createRemoteMcpHandler from apps/mcp/src/index.ts (`@weft/mcp`), which this branch does not have yet;
// main.ts is the module that exists on every branch. Integrate: import it from "@weft/mcp".
import * as mcpModule from "../../../../mcp/src/main";
import type { DurablePlatformInput, DurableStorageLike, DurableWeftPlatform, FetchCounter, RemoteMcpHandler, WorldScope } from "../../shared/contracts";

/** cf1-db's MigrationEntry (migrations.ts). */
export interface MigrationEntryLike { tag: string; folderMillis: number; hash: string; statements: string[] }
export interface SqlCostLike { statements: number; rowsRead: number; rowsWritten: number }
/** cf1-db's Snapshot, as far as CompanyDO reads it. */
export interface SnapshotLike { manifest: { journalHash: string; digest: string; chunks: number; rows: number; extra?: Record<string, unknown> }; chunks: unknown[]; seed: unknown }

export interface WeftDeps {
  /** cf1-db: migrate-durable.ts, migrations.ts, scope.ts, snapshot.ts */
  migrateDurable(storage: DurableStorageLike, migrations: readonly MigrationEntryLike[]): { applied: string[]; skipped: number };
  migrationEntries(journal: { entries: ReadonlyArray<{ idx: number; tag: string; when: number; breakpoints: boolean }> }, fileText: (tag: string) => string): MigrationEntryLike[];
  journalHash(entries: readonly MigrationEntryLike[]): string;
  worldScope: WorldScope;
  decodeSnapshot(files: { chunks: Uint8Array; seed: Uint8Array; manifest: string }): Promise<SnapshotLike>;
  beginRestore(storage: DurableStorageLike, snap: SnapshotLike, migrations: readonly MigrationEntryLike[], journalHash: string): { triggers: { name: string; sql: string }[]; cost: SqlCostLike };
  restoreChunks(storage: DurableStorageLike, chunks: readonly unknown[], from?: number, to?: number): SqlCostLike;
  finishRestore(storage: DurableStorageLike, snap: SnapshotLike, triggers: readonly { sql: string }[], opts?: { arm?: boolean }): SqlCostLike & { digest: string };
  verifyAgainstManifest(storage: DurableStorageLike, manifest: SnapshotLike["manifest"], only?: readonly string[]): { mismatched: string[]; digest: string; digests: Record<string, { rows: number; digest: string }> };
  deltaReset(storage: DurableStorageLike, snap: SnapshotLike): SqlCostLike & { tables: string[]; keys: number };
  dirtyKeys(storage: DurableStorageLike): Map<string, string[]>;
  runConformance?(storage: DurableStorageLike): Promise<{ passed: number; failed: number; cases: { name: string; ok: boolean; detail?: string }[] }>;
  /** cf2-platform: apps/api/src/platform/durable.ts, exported from @weft/api/assemble */
  durablePlatform(input: DurablePlatformInput & { fetch?: typeof fetch; fetchCounter?: FetchCounter }): DurableWeftPlatform<unknown>;
  assembleWeft: typeof assembleModule.assembleWeft;
  /** cf3-agent: @weft/agent world.ts and script-source.ts, @weft/mcp remote.ts */
  bindWorldScope?(scope: Pick<WorldScope, "current"> | null): void;
  /** The scripted provider's scenarios come from the bundled fixtures in a Worker (there is no scenarios/ folder). */
  setScriptSource?(source: unknown): void;
  fixtureScriptSource?(fixtures: { text(path: string): string | null; list(dir: string): string[] }, dir?: string): unknown;
  createRemoteMcpHandler(
    cfg: { apiUrl?: string; askLimiter?: { take(apiKey: string): Promise<{ ok: true } | { ok: false; limit: number }> } | null; allowedOrigins?: readonly string[] },
    fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
  ): RemoteMcpHandler;
  /** Today's executor exports (present on every branch). */
  adminChange: typeof executorModule.adminChange;
  executorInternals: typeof executorModule.executorInternals;
}

export class MissingDependency extends Error {
  readonly code = "WEFT_DEP_MISSING";
  constructor(readonly track: string, readonly module: string, readonly exportName: string) {
    super(`${track}: ${module} does not export ${exportName} yet`);
  }
}

const REQUIRED: readonly [object, string, string, string][] = [
  [dbModule, "@weft/db", "migrateDurable", "cf1-db"],
  [dbModule, "@weft/db", "migrationEntries", "cf1-db"],
  [dbModule, "@weft/db", "journalHash", "cf1-db"],
  [dbModule, "@weft/db", "worldScope", "cf1-db"],
  [dbModule, "@weft/db", "decodeSnapshot", "cf1-db"],
  [dbModule, "@weft/db", "beginRestore", "cf1-db"],
  [dbModule, "@weft/db", "restoreChunks", "cf1-db"],
  [dbModule, "@weft/db", "finishRestore", "cf1-db"],
  [dbModule, "@weft/db", "verifyAgainstManifest", "cf1-db"],
  [dbModule, "@weft/db", "deltaReset", "cf1-db"],
  [dbModule, "@weft/db", "dirtyKeys", "cf1-db"],
  [assembleModule, "@weft/api/assemble", "durablePlatform", "cf2-platform"],
  [mcpModule, "@weft/mcp", "createRemoteMcpHandler", "cf3-agent"],
];

const get = (mod: object, name: string): unknown => (mod as Record<string, unknown>)[name];

let resolved: WeftDeps | null = null;

/** Resolves every part once per isolate; throws MissingDependency naming the first part that is not exported yet. */
export function weftDeps(): WeftDeps {
  if (resolved) return resolved;
  for (const [mod, module, name, track] of REQUIRED) if (get(mod, name) === undefined) throw new MissingDependency(track, module, name);
  const db = <K extends keyof WeftDeps>(name: K): WeftDeps[K] => get(dbModule, name) as WeftDeps[K];
  const out: WeftDeps = {
    migrateDurable: db("migrateDurable"),
    migrationEntries: db("migrationEntries"),
    journalHash: db("journalHash"),
    worldScope: db("worldScope"),
    decodeSnapshot: db("decodeSnapshot"),
    beginRestore: db("beginRestore"),
    restoreChunks: db("restoreChunks"),
    finishRestore: db("finishRestore"),
    verifyAgainstManifest: db("verifyAgainstManifest"),
    deltaReset: db("deltaReset"),
    dirtyKeys: db("dirtyKeys"),
    runConformance: get(dbModule, "runConformance") as WeftDeps["runConformance"],
    durablePlatform: get(assembleModule, "durablePlatform") as WeftDeps["durablePlatform"],
    assembleWeft: assembleModule.assembleWeft,
    bindWorldScope: get(agentModule, "bindWorldScope") as WeftDeps["bindWorldScope"],
    setScriptSource: get(agentModule, "setScriptSource") as WeftDeps["setScriptSource"],
    fixtureScriptSource: get(agentModule, "fixtureScriptSource") as WeftDeps["fixtureScriptSource"],
    createRemoteMcpHandler: get(mcpModule, "createRemoteMcpHandler") as WeftDeps["createRemoteMcpHandler"],
    adminChange: executorModule.adminChange,
    executorInternals: executorModule.executorInternals,
  };
  resolved = out;
  return out;
}

/** Every part not exported yet, as "track: module name" (empty once cf1, cf2 and cf3 are merged). */
export function missingDeps(): string[] {
  return REQUIRED.filter(([mod, , name]) => get(mod, name) === undefined).map(([, module, name, track]) => `${track}: ${module} ${name}`);
}
