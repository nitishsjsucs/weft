// The Weft stack CompanyDO's real engine needs, by name, in one place. The cf0 contracts type each part; cf1-db,
// cf2-platform and cf3-agent export the implementations. Each name is looked up on its module's namespace at boot,
// so a part that a track has not exported yet fails the boot with a message naming the track and the export
// (CompanyDO answers 503 WORLD_NOT_READY) instead of failing the bundle. .scratch/contract-requests/cf4-worker.md
// lists every name; once all three tracks are merged the Integrate stage checks this file against their exports.
import * as dbModule from "@weft/db";
import * as assembleModule from "@weft/api/assemble";
import * as agentModule from "@weft/agent";
import * as executorModule from "@weft/executor";
import * as mcpModule from "../../../../mcp/src/main";
import type {
  DurablePlatformInput, DurableStorageLike, DurableWeftPlatform, FetchCounter, OpenDurableDb, RemoteMcpHandler, WorldScope,
} from "../../shared/contracts";
import type { DeltaResetResult, SnapshotArtifacts, VerifyResult } from "./engine";

/** cf1-db's snapshot.ts as the restore and reset steps call it (design 4.6). */
export interface SnapshotOps {
  /** Number of INSERT chunks in the restore script. */
  snapshotChunkCount(snapshotSql: string): number;
  /** Runs one chunk inside the caller's transactionSync; returns rows written. */
  restoreSnapshotChunk(storage: DurableStorageLike, snapshotSql: string, index: number): { rowsWritten: number } | number | void;
  /** Creates the dirty-key table and its triggers (INSERT ... WHERE NOT EXISTS). Idempotent. */
  armDirtyTracking(storage: DurableStorageLike): void;
  /** True when the dirty-key table holds no row. */
  isWorldClean(storage: DurableStorageLike): boolean;
  /** The delta reset in one transactionSync, then the per-table digests of the dirty tables against the manifest. */
  deltaReset(storage: DurableStorageLike, input: { seedRows: unknown; manifest: unknown }): DeltaResetResult;
  /** Per-table counts and digests (all tables when `full`), and the action chain head, against the manifest. */
  verifySnapshot(storage: DurableStorageLike, input: { manifest: unknown; full: boolean }): VerifyResult;
}

export interface WeftDeps {
  /** cf1-db */
  openDurableDb: OpenDurableDb<unknown>;
  migrateDurable(storage: DurableStorageLike): Promise<{ applied: number } | number | void>;
  worldScope: WorldScope;
  snapshot: SnapshotOps;
  runConformance?(storage: DurableStorageLike): Promise<{ passed: number; failed: number; cases: { name: string; ok: boolean; detail?: string }[] }>;
  /** cf2-platform */
  durablePlatform(input: DurablePlatformInput & { fetch?: typeof fetch; fetchCounter?: FetchCounter; config?: KVNamespace }): DurableWeftPlatform<unknown>;
  assembleWeft: typeof assembleModule.assembleWeft;
  /** cf3-agent */
  bindWorldScope?(scope: Pick<WorldScope, "current"> | null): void;
  createRemoteMcpHandler(cfg: { apiUrl: string; apiKey: string }, fetchImpl: (url: string, init?: RequestInit) => Promise<Response>): RemoteMcpHandler;
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

function pick<T>(mod: object, module: string, name: string, track: string): T {
  const v = (mod as Record<string, unknown>)[name];
  if (v === undefined || v === null) throw new MissingDependency(track, module, name);
  return v as T;
}
function maybe<T>(mod: object, name: string): T | undefined {
  return (mod as Record<string, unknown>)[name] as T | undefined;
}

let resolved: WeftDeps | null = null;

/** Resolves every part once per isolate; throws MissingDependency naming the first part that is not exported yet. */
export function weftDeps(): WeftDeps {
  if (resolved) return resolved;
  const db = dbModule as object;
  resolved = {
    openDurableDb: pick(db, "@weft/db", "openDurableDb", "cf1-db"),
    migrateDurable: pick(db, "@weft/db", "migrateDurable", "cf1-db"),
    worldScope: pick(db, "@weft/db", "worldScope", "cf1-db"),
    snapshot: {
      snapshotChunkCount: pick(db, "@weft/db", "snapshotChunkCount", "cf1-db"),
      restoreSnapshotChunk: pick(db, "@weft/db", "restoreSnapshotChunk", "cf1-db"),
      armDirtyTracking: pick(db, "@weft/db", "armDirtyTracking", "cf1-db"),
      isWorldClean: pick(db, "@weft/db", "isWorldClean", "cf1-db"),
      deltaReset: pick(db, "@weft/db", "deltaReset", "cf1-db"),
      verifySnapshot: pick(db, "@weft/db", "verifySnapshot", "cf1-db"),
    },
    runConformance: maybe(db, "runConformance"),
    durablePlatform: pick(assembleModule, "@weft/api/assemble", "durablePlatform", "cf2-platform"),
    assembleWeft: assembleModule.assembleWeft,
    bindWorldScope: maybe(agentModule, "bindWorldScope"),
    createRemoteMcpHandler: pick(mcpModule, "apps/mcp/src/main.ts", "createRemoteMcpHandler", "cf3-agent"),
    adminChange: executorModule.adminChange,
    executorInternals: executorModule.executorInternals,
  };
  return resolved;
}

/** Which parts are exported now (the Miniflare suite's real-engine cases run once every part is). */
export function missingDeps(): string[] {
  try {
    resolved = null;
    weftDeps();
    return [];
  } catch (e) {
    if (e instanceof MissingDependency) {
      const out: string[] = [];
      const all: [object, string, string, string][] = [
        [dbModule, "@weft/db", "openDurableDb", "cf1-db"], [dbModule, "@weft/db", "migrateDurable", "cf1-db"], [dbModule, "@weft/db", "worldScope", "cf1-db"],
        [dbModule, "@weft/db", "snapshotChunkCount", "cf1-db"], [dbModule, "@weft/db", "restoreSnapshotChunk", "cf1-db"], [dbModule, "@weft/db", "armDirtyTracking", "cf1-db"],
        [dbModule, "@weft/db", "isWorldClean", "cf1-db"], [dbModule, "@weft/db", "deltaReset", "cf1-db"], [dbModule, "@weft/db", "verifySnapshot", "cf1-db"],
        [assembleModule, "@weft/api/assemble", "durablePlatform", "cf2-platform"], [mcpModule, "apps/mcp/src/main.ts", "createRemoteMcpHandler", "cf3-agent"],
      ];
      for (const [m, mod, name, track] of all) if ((m as Record<string, unknown>)[name] === undefined) out.push(`${track}: ${mod} ${name}`);
      return out;
    }
    throw e;
  }
}

export type { SnapshotArtifacts };
