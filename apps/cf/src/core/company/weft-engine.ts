// The real world engine (design 3.1 and 3.3): assembleWeft over the durable platform, inside the world's WorldScope.
// Loaded lazily by CompanyDO (src/core/index.ts wires it), so the @weft/* modules evaluate only inside
// blockConcurrencyWhile and never in the Lobby, SpendDO, cron or queue consumers.
//
//   storage --cf2 durablePlatform.openDb (cf1 openDurableDb)--> Db, SqlMeter, TxGuard
//   DurablePlatformInput --cf2 durablePlatform--> WeftPlatform --assembleWeft--> Weft (Hono app, agent, routines)
//   /mcp --cf3 createRemoteMcpHandler--> tools that call the same Hono app in process
//   restore and reset steps --cf1 snapshot.ts--> chunks, triggers, dirty tracking, digests
//
// The parts come from deps.ts by name; until a track has exported its part the boot fails with a message naming it.
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { apiKeys, principals, settings, type Db, type DbTx } from "@weft/db";
import { newId } from "@weft/core";
import {
  formatHostedMcpKey, hostedWorldId, MCP_AGENT_ASK_PER_KEY_DAY, WORLD_MODEL_SETTING,
  type DurableStorageLike, type DurableWeftPlatform, type PlatformDb, type SqlMeter, type TxGuard,
} from "../../shared/contracts";
import { randomAlnum } from "../../shared/crypto";
import { hostedError } from "../../shared/http";
import { isModelAdmission } from "../../shared/routes";
import { bundledFixtures } from "../fixtures";
import { weftDeps, type MigrationEntryLike, type SnapshotLike } from "./deps";
import type { EngineModule, SnapshotArtifacts, SnapshotExtra, WorldBootInput, WorldEngine, WorldStore } from "./engine";
import { bundledSnapshotFiles } from "./snapshot-assets";

type Session = { principalId: string; companyId: string; via: "ui"; keyScope: null };

/** The admin session the hosted settings run as: the persona the visitor is viewing as, Dana (demo) by default. */
async function adminSession(db: Db, principalId: string | null): Promise<Session> {
  const id = principalId ?? "usr_dana";
  const [p] = await db.select().from(principals).where(eq(principals.id, id)).limit(1);
  if (!p || p.kind !== "human") throw Object.assign(new Error(`Unknown human principal ${id}`), { status: 401 });
  return { principalId: p.id, companyId: p.companyId, via: "ui", keyScope: null };
}

let migrations: MigrationEntryLike[] | null = null;
/** The migrations from the bundled fixtures, read exactly as drizzle reads the folder (cf1 migrations.ts). */
export function bundledMigrations(): MigrationEntryLike[] {
  if (migrations) return migrations;
  const journal = bundledFixtures.text("packages/db/drizzle/meta/_journal.json");
  if (!journal) throw new Error("the bundled fixtures have no migration journal (pnpm cf:fixtures)");
  migrations = weftDeps().migrationEntries(JSON.parse(journal) as never, (tag) => {
    const t = bundledFixtures.text(`packages/db/drizzle/${tag}.sql`);
    if (t === null) throw new Error(`the bundled fixtures have no migration ${tag}`);
    return t;
  });
  return migrations;
}

async function boot(input: WorldBootInput): Promise<WorldEngine> {
  const d = weftDeps();
  d.bindWorldScope?.(d.worldScope);
  const key = hostedWorldId(input.world);
  const inScope = <T>(fn: () => T): T => d.worldScope.run(key, fn);
  let opened: PlatformDb<unknown> | null = null;
  const platform = d.durablePlatform({
    storage: input.storage, env: input.env, world: input.world, fixtures: bundledFixtures, spend: input.spend,
    runHost: input.runHost, schedulerHost: input.schedulerHost, onOutbox: input.onOutbox, fetch: input.fetch,
  });
  const wrapped: DurableWeftPlatform<unknown> = {
    ...platform,
    openDb: async (dataDir: string) => (opened = await platform.openDb(dataDir)),
  };
  const weft = await inScope(() => d.assembleWeft(wrapped as never, { dataDir: `/weft/${input.world.slot}`, testMode: false }));
  const db = opened as PlatformDb<unknown> | null;
  if (!db?.meter || !db.guard) {
    await weft.close();
    throw new Error("the durable platform opened a database without a meter and guard (cf2-platform openDb)");
  }
  const meter: SqlMeter = db.meter;
  const guard: TxGuard = db.guard;
  const internals = d.executorInternals(weft.executor);
  const origin = (input.env.WEFT_PUBLIC_ORIGIN ?? "https://weft.invalid").replace(/\/$/, "");
  const appFetch = async (req: Request): Promise<Response> => inScope(() => weft.app.fetch(req));
  /** The MCP tools' in-process fetch: only the path and query of the URL they build are kept. */
  const toolFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url, origin);
    const req = new Request(`${origin}${u.pathname}${u.search}`, init);
    // agent_ask is a model-calling admission: the kill switch (KV agent.enabled=false) answers it as the front does.
    if (req.method === "POST" && isModelAdmission(req.method, u.pathname) && (input.env.WEFT_AGENT_ENABLED ?? "").toLowerCase() === "false") {
      return hostedError("AGENT_PAUSED", "The agent is paused on this demo right now", { retryAfterS: 300 });
    }
    return appFetch(req);
  };
  const mcp = d.createRemoteMcpHandler({
    apiUrl: origin,
    allowedOrigins: [origin],
    askLimiter: { take: async (apiKey) => ((await input.mcpAskAllowed(apiKey)) ? { ok: true } : { ok: false, limit: MCP_AGENT_ASK_PER_KEY_DAY }) },
  }, toolFetch);

  return {
    meter,
    guard,
    fetch: appFetch,
    mcp: (req) => inScope(() => mcp(req)),
    inScope: (fn) => inScope(fn),
    clockRate: () => weft.clock.rate(),
    async mintMcpKey(m) {
      if (!internals) throw new Error("executor internals unavailable");
      const session = await adminSession(weft.db, m.principalId);
      const plaintext = formatHostedMcpKey(m.slot, m.gen, randomAlnum(40));
      internals.addSecret(plaintext);
      await inScope(() => d.adminChange(internals.engine, session, "settings.create_api_key", { label: "hosted mcp", scope: "mcp" }, "Created this demo company's MCP key", async (tx: DbTx) => {
        const id = await newId(tx, "key_");
        await tx.insert(apiKeys).values({
          id, companyId: session.companyId, principalId: session.principalId, prefix: plaintext.slice(0, 16),
          hash: createHash("sha256").update(plaintext).digest("hex"), label: "hosted mcp", scope: "mcp", surface: "mcp", createdAt: weft.clock.now(), revokedAt: null,
        });
        return { id };
      }));
      return { key: plaintext, url: m.publicUrl, expiresAt: m.expiresAt };
    },
    async setWorldProvider({ provider, principalId }) {
      if (!internals) throw new Error("executor internals unavailable");
      const session = await adminSession(weft.db, principalId);
      const summary = provider ? `New runs in this demo company use ${provider}` : "New runs in this demo company use the default model";
      await inScope(() => d.adminChange(internals.engine, session, "settings.hosted_model_provider", { provider }, summary, async (tx: DbTx) => {
        if (provider === null) await tx.delete(settings).where(eq(settings.key, WORLD_MODEL_SETTING));
        else await tx.insert(settings).values({ key: WORLD_MODEL_SETTING, valueJson: JSON.stringify(provider) })
          .onConflictDoUpdate({ target: settings.key, set: { valueJson: JSON.stringify(provider) } });
        return { provider };
      }));
    },
    addSecret: (v) => internals?.addSecret(v),
    close: () => inScope(() => weft.close()),
  };
}

const snap = (a: SnapshotArtifacts) => a.snapshot as SnapshotLike;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The action chain head as the snapshot recorded it, against this storage's. */
function chainHeadMatches(storage: DurableStorageLike, a: SnapshotArtifacts): boolean {
  const want = a.manifest.extra?.chainHead ?? null;
  let head: string | null = null;
  try { head = (storage.sql.exec(`SELECT hash FROM actions ORDER BY seq DESC LIMIT 1`).toArray()[0]?.hash as string | undefined) ?? null; } catch { head = null; }
  return want === head;
}

const store: WorldStore = {
  beginRestore(storage, a) {
    const migs = bundledMigrations();
    const d = weftDeps();
    const r = d.beginRestore(storage, snap(a), migs, d.journalHash(migs));
    return { applied: migs.length, triggers: r.triggers.map((t) => ({ name: t.name, sql: t.sql })) };
  },
  chunkCount: (a) => snap(a).chunks.length,
  restoreChunk(storage, a, index) {
    return { rowsWritten: weftDeps().restoreChunks(storage, snap(a).chunks, index, index + 1).rowsWritten };
  },
  finishRestore(storage, a, triggers) {
    try {
      const r = weftDeps().finishRestore(storage, snap(a), triggers, { arm: true });
      return { ok: true, mismatches: [], rowsWritten: r.rowsWritten };
    } catch (e) {
      return { ok: false, mismatches: [message(e)], rowsWritten: 0 };
    }
  },
  verify(storage, a, opts) {
    const v = weftDeps().verifyAgainstManifest(storage, snap(a).manifest, opts.full ? undefined : []);
    const rows = Object.values(v.digests).reduce((n, t) => n + t.rows, 0);
    return { ok: v.mismatched.length === 0, mismatches: v.mismatched, rows, chainValid: chainHeadMatches(storage, a) };
  },
  isClean(storage) {
    for (const t of weftDeps().dirtyKeys(storage).keys()) if (t !== "kv_state") return false;
    return true;
  },
  deltaReset(storage, a) {
    try {
      const r = weftDeps().deltaReset(storage, snap(a));
      return { ok: true, rowsWritten: r.rowsWritten, mismatches: [] };
    } catch (e) {
      return { ok: false, rowsWritten: 0, mismatches: [message(e)] };
    }
  },
  async conformance(storage) {
    const run = weftDeps().runConformance;
    if (!run) throw new Error("cf1-db: @weft/db does not export runConformance yet");
    return run(storage);
  },
};

let artifacts: Promise<SnapshotArtifacts> | null = null;
function loadArtifacts(): Promise<SnapshotArtifacts> {
  artifacts ??= (async () => {
    const decoded = await weftDeps().decodeSnapshot(bundledSnapshotFiles());
    const extra = decoded.manifest.extra as SnapshotExtra | undefined;
    return {
      version: extra?.snapshotId ?? decoded.manifest.digest.slice(0, 16),
      manifest: { journalHash: decoded.manifest.journalHash, digest: decoded.manifest.digest, chunks: decoded.manifest.chunks, rows: decoded.manifest.rows, ...(extra ? { extra } : {}) },
      snapshot: decoded,
    };
  })().catch((e: unknown) => { artifacts = null; throw e; });
  return artifacts;
}

export const weftEngineModule: EngineModule = { boot, store, artifacts: loadArtifacts };
