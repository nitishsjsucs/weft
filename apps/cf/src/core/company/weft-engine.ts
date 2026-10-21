// The real world engine (design 3.1 and 3.3): assembleWeft over the durable platform, inside the world's WorldScope.
// Loaded lazily by CompanyDO (src/core/index.ts wires it), so the @weft/* modules evaluate only inside
// blockConcurrencyWhile and never in the Lobby, SpendDO, cron or queue consumers.
//
//   storage --cf1 openDurableDb (via cf2's platform.openDb)--> Db, SqlMeter, TxGuard
//   DurablePlatformInput --cf2 durablePlatform--> WeftPlatform --assembleWeft--> Weft (Hono app, agent, routines)
//   /mcp --cf3 createRemoteMcpHandler--> tools that call the same Hono app in process
//
// The parts come from deps.ts by name; until a track has exported its part the boot fails with a message naming it.
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { apiKeys, principals, settings, type Db, type DbTx } from "@weft/db";
import { newId } from "@weft/core";
import {
  formatHostedMcpKey, hostedWorldId, WORLD_MODEL_SETTING,
  type DurableWeftPlatform, type PlatformDb, type SqlMeter, type TxGuard,
} from "../../shared/contracts";
import { randomAlnum } from "../../shared/crypto";
import { json } from "../../shared/http";
import { bundledFixtures } from "../fixtures";
import { weftDeps } from "./deps";
import type { EngineModule, WorldBootInput, WorldEngine, WorldStore } from "./engine";
import { snapshotArtifacts } from "./snapshot-assets";

type Session = { principalId: string; companyId: string; via: "ui"; keyScope: null };

/** The admin session the hosted settings run as: the persona the visitor is viewing as, Dana (demo) by default. */
async function adminSession(db: Db, principalId: string | null): Promise<Session> {
  const id = principalId ?? "usr_dana";
  const [p] = await db.select().from(principals).where(eq(principals.id, id)).limit(1);
  if (!p || p.kind !== "human") throw Object.assign(new Error(`Unknown human principal ${id}`), { status: 401 });
  return { principalId: p.id, companyId: p.companyId, via: "ui", keyScope: null };
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

  return {
    meter,
    guard,
    fetch: appFetch,
    async mcp(req, call) {
      const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
        const u = new URL(url, origin);
        const inner = new Request(`${origin}${u.pathname}${u.search}`, init);
        if (inner.method === "POST" && u.pathname === "/v1/agent/runs" && !(await call.allowAgentAsk())) {
          return json({ _tag: "RateLimitExceeded", code: "MCP_AGENT_ASK_LIMIT", message: "agent_ask is limited per MCP key per day" }, { status: 429 });
        }
        return appFetch(inner);
      };
      const handler = d.createRemoteMcpHandler({ apiUrl: origin, apiKey: call.apiKey }, fetchImpl);
      return inScope(() => handler(req));
    },
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

const store: WorldStore = {
  async migrate(storage) {
    const r = await weftDeps().migrateDurable(storage);
    return { applied: typeof r === "number" ? r : (r as { applied?: number } | undefined)?.applied ?? 0 };
  },
  isClean: (storage) => weftDeps().snapshot.isWorldClean(storage),
  chunkCount: (a) => weftDeps().snapshot.snapshotChunkCount(a.snapshotSql),
  restoreChunk(storage, a, index) {
    const r = weftDeps().snapshot.restoreSnapshotChunk(storage, a.snapshotSql, index);
    return { rowsWritten: typeof r === "number" ? r : (r as { rowsWritten?: number } | undefined)?.rowsWritten ?? 0 };
  },
  armDirty: (storage) => weftDeps().snapshot.armDirtyTracking(storage),
  verify: (storage, a, opts) => weftDeps().snapshot.verifySnapshot(storage, { manifest: a.manifest.dump, full: opts.full }),
  deltaReset: (storage, a) => weftDeps().snapshot.deltaReset(storage, { seedRows: a.seedRows, manifest: a.manifest.dump }),
  async conformance(storage) {
    const run = weftDeps().runConformance;
    if (!run) throw new Error("cf1-db: @weft/db does not export runConformance yet");
    return run(storage);
  },
};

export const weftEngineModule: EngineModule = { boot, store, artifacts: snapshotArtifacts };
