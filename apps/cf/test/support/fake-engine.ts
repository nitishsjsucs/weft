// A small fake world behind CompanyDO's EngineModule seam, for the Miniflare suite's plumbing cases (gates, leases,
// isolation, the WebSocket feed, alarms, the outbox, resets and restores) without the Weft stack. It keeps a
// `notes` table in the object's own SQLite, a meter that feeds commits to the feed, an IO_IN_TX-style guard, a
// "seed" of three notes restored in chunks, dirty tracking by trigger, and a delta reset back to the seed.
import { WORLD_MODEL_SETTING, type DurableStorageLike, type SqlCommit, type SqlMeter, type SqlUsage, type TxGuard } from "../../src/shared/contracts";
import type { EngineModule, SnapshotArtifacts, WorldBootInput, WorldEngine, WorldStore } from "../../src/core/company/engine";

const SEED = ["Larkspur Robotics handbook", "Payroll runs on Fridays", "Benefits renew in January"];
/** What a run's counted fetches ask for: the discard port on loopback, refused at once with no DNS lookup and no
 * proxy (loopback is in every NO_PROXY), so 40 of them take milliseconds on any machine. A name that does not
 * resolve would go through an HTTPS proxy where one is set and take about 0.3 s each. */
const UNREACHABLE_URL = "http://127.0.0.1:9/";

export const FAKE_SNAPSHOT_VERSION = "fake-snapshot-1";
/** A note with this text makes the fake delta reset report a digest mismatch and change nothing (cf1's deltaReset
 * throws inside its transaction on a mismatch, so the world is left as it was). */
export const FAKE_FORCE_MISMATCH = "fake: force a delta reset mismatch";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS kv_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, kind TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, status TEXT NOT NULL, live INTEGER NOT NULL, fetches INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS ticks (n INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL)`,
  // The real schema's settings table (packages/db/src/schema.ts): the model switch's WORLD_MODEL_SETTING row lives here.
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL)`,
];

function meterFor(): SqlMeter & { note(read: number, written: number, tables: string[]): void } {
  let seq = 0;
  const versions = new Map<string, number>();
  const listeners = new Set<(c: SqlCommit) => void>();
  const totals: SqlUsage = { statements: 0, rowsRead: 0, rowsWritten: 0, tablesRead: [], tablesWritten: [] };
  const stack: SqlUsage[] = [];
  const add = (u: SqlUsage, read: number, written: number, tables: string[]) => {
    u.statements += 1; u.rowsRead += read; u.rowsWritten += written;
    if (written) u.tablesWritten = [...new Set([...u.tablesWritten, ...tables])].sort();
    else u.tablesRead = [...new Set([...u.tablesRead, ...tables])].sort();
  };
  return {
    note(read, written, tables) {
      add(totals, read, written, tables);
      for (const u of stack) add(u, read, written, tables);
      if (written) {
        seq += 1;
        for (const t of tables) versions.set(t, (versions.get(t) ?? 0) + 1);
        for (const l of listeners) l({ seq, tables: [...tables].sort() });
      }
    },
    async measure(fn) {
      const u: SqlUsage = { statements: 0, rowsRead: 0, rowsWritten: 0, tablesRead: [], tablesWritten: [] };
      stack.push(u);
      try { return { value: await fn(), usage: u }; } finally { stack.splice(stack.indexOf(u), 1); }
    },
    totals: () => ({ ...totals }),
    reset() { totals.statements = 0; totals.rowsRead = 0; totals.rowsWritten = 0; totals.tablesRead = []; totals.tablesWritten = []; },
    version: (t) => versions.get(t) ?? 0,
    versions: (ts) => Object.fromEntries([...ts].map((t) => [t, versions.get(t) ?? 0])),
    onCommit(l) { listeners.add(l); return () => listeners.delete(l); },
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function boot(input: WorldBootInput): Promise<WorldEngine> {
  const sql = input.storage.sql;
  const meter = meterFor();
  let inTx = false;
  const guard: TxGuard = {
    inTx: () => inTx,
    assertNotInTx(what) { if (inTx) throw Object.assign(new Error(`IO_IN_TX: ${what}`), { code: "IO_IN_TX" }); },
  };
  let rate = 0;
  const exec = (q: string, ...b: unknown[]) => {
    const c = sql.exec(q, ...b);
    const rows = c.toArray();
    const write = /^\s*(insert|update|delete)/i.test(q);
    const tables = [...q.matchAll(/(?:from|into|update)\s+([a-z_]+)/gi)].map((m) => m[1]!.toLowerCase());
    meter.note(c.rowsRead, write ? Math.max(1, c.rowsWritten) : 0, tables);
    return rows;
  };
  const secrets: string[] = [];
  const runs = new Map<string, { live: boolean; fetches: number; global: boolean }>();
  // The world's write lock, as cf1's withWriteLock: the fake's own write transactions take it, as executor ones do.
  let tail: Promise<unknown> = Promise.resolve();
  const writeLocked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };

  const app = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === "/v1/health") return json({ ok: true, version: "fake", provider: { id: "scripted", model: "fake", label: "Fake", live: false }, clock: { now: "2026-10-26T15:30:00.000Z", rate }, testMode: false, stubs: [] });
    if (p === "/v1/whoami") {
      const h: Record<string, string> = {};
      for (const [k, v] of req.headers) h[k] = v;
      return json({ headers: h, world: input.world, envLlm: input.env.WEFT_LLM ?? null, provider: input.env.WEFT_HOSTED_PROVIDER ?? null, agentEnabled: input.env.WEFT_AGENT_ENABLED ?? null });
    }
    if (p === "/v1/notes" && req.method === "GET") return json(exec(`SELECT id, text FROM notes ORDER BY id`));
    if (p === "/v1/notes" && req.method === "POST") {
      const body = (await req.json()) as { text?: string; job?: string; delayMs?: number };
      const text = String(body.text ?? "");
      // A slow mutation (awaiting I/O before it writes), to hold a request in flight across a lease's end.
      if (body.delayMs) await new Promise((r) => setTimeout(r, Math.min(5_000, body.delayMs!)));
      await writeLocked(async () => {
        inTx = true;
        try {
          input.storage.transactionSync(() => {
            exec(`INSERT INTO notes (text) VALUES (?)`, text);
            if (body.job) exec(`INSERT INTO outbox (id, kind, body, created_at) VALUES (?, ?, ?, ?)`, `obx_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`, body.job,
              JSON.stringify({ v: 1, kind: body.job, jobId: `obx_${Math.random().toString(16).slice(2, 18).padEnd(16, "0")}`, slot: input.world.slot, gen: input.world.gen, uploadId: "upl_1", expenseId: "exp_1", sha256: "0".repeat(64), storagePath: "blob:x", contentType: "image/png" }),
              new Date().toISOString());
          });
        } finally {
          inTx = false;
        }
      });
      if (body.job) input.onOutbox();
      return json({ ok: true }, 201);
    }
    if (p === "/v1/agent/runs" && req.method === "POST") {
      // global: the run fetches through globalThis.fetch, as a transport built without the world's fetch does.
      const body = (await req.json().catch(() => ({}))) as { live?: boolean; fetches?: number; global?: boolean };
      const id = `run_${String(runs.size + 1).padStart(4, "0")}`;
      runs.set(id, { live: body.live !== false, fetches: Math.min(60, body.fetches ?? 0), global: body.global === true });
      exec(`INSERT INTO runs (id, status, live) VALUES (?, 'queued', ?)`, id, body.live !== false ? 1 : 0);
      input.runHost.submit({
        runId: id, live: body.live !== false,
        async start() {
          exec(`UPDATE runs SET status = 'running' WHERE id = ?`, id);
          let made = 0;
          const cfg = runs.get(id);
          for (let i = 0; i < (cfg?.fetches ?? 0); i++) {
            try { await (cfg?.global ? globalThis.fetch : input.fetch)(UNREACHABLE_URL); } catch { /* unreachable on purpose */ }
            made += 1;
          }
          exec(`UPDATE runs SET status = 'done', fetches = ? WHERE id = ?`, made, id);
        },
      });
      return json({ runId: id }, 201);
    }
    const run = /^\/v1\/agent\/runs\/(run_\d+)$/.exec(p);
    if (run) return json(exec(`SELECT id, status, live, fetches FROM runs WHERE id = ?`, run[1])[0] ?? null);
    const events = /^\/v1\/agent\/runs\/(run_\d+)\/events$/.exec(p);
    if (events) {
      const enc = new TextEncoder();
      const body = new ReadableStream({ start(c) { c.enqueue(enc.encode(`event: step\ndata: {"run":"${events[1]}"}\n\n`)); c.close(); } });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }
    if (p === "/v1/clock" && req.method === "POST") {
      rate = Number(((await req.json()) as { rate?: number }).rate ?? 0);
      return json({ rate });
    }
    if (p === "/v1/ticks") return json(exec(`SELECT COUNT(*) AS n FROM ticks`)[0]);
    if (p === "/v1/spend" && req.method === "POST") {
      const body = (await req.json()) as { usdMicros: number; runId?: string | null; live?: boolean };
      const r = await input.spend.reserve({ runId: body.runId ?? null, usdMicros: body.usdMicros, model: "fake", live: body.live ?? true });
      return json(r);
    }
    if (p === "/v1/secrets") return json({ secrets });
    return json({ _tag: "NotFound", code: "NOT_FOUND", message: `fake world has no ${p}` }, 404);
  };

  input.schedulerHost.start({
    intervalMs: 50,
    clockRate: () => rate,
    tick: async () => { exec(`INSERT INTO ticks (at) VALUES (?)`, new Date().toISOString()); },
  });

  return {
    meter,
    guard,
    fetch: app,
    async mcp(req) {
      const body = (await req.json().catch(() => ({}))) as { method?: string };
      const key = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? req.headers.get("x-api-key") ?? "";
      if (body.method === "agent_ask") {
        const allowed = await input.mcpAskAllowed(key);
        return json({ allowed }, allowed ? 200 : 429);
      }
      return json({ mcp: true, method: body.method ?? null, key: key.slice(0, 7), world: input.world });
    },
    inScope: (fn) => fn(),
    writeLocked,
    outboxPending: () => writeLocked(async () => exec(`SELECT id, kind, body FROM outbox ORDER BY created_at, id`).map((r) => {
      try { return { id: String(r.id), kind: String(r.kind), job: JSON.parse(String(r.body)) as never }; } catch { return { id: String(r.id), kind: String(r.kind), job: null }; }
    })),
    outboxAck: (id) => writeLocked(async () => { exec(`DELETE FROM outbox WHERE id = ?`, id); }),
    clockRate: () => rate,
    async mintMcpKey(m) {
      const rand = Array.from({ length: 24 }, (_, i) => "abcdefghijklmnopqrstuvwxyz0123456789"[(i * 7 + m.gen) % 36]).join("");
      return { key: `wk_mcp_${m.slot}_${m.gen}_${rand}`, url: m.publicUrl, expiresAt: m.expiresAt };
    },
    async setWorldProvider({ provider }) {
      // As the real engine writes it: the JSON string under WORLD_MODEL_SETTING, deleted when cleared.
      if (provider === null) exec(`DELETE FROM settings WHERE key = ?`, WORLD_MODEL_SETTING);
      else exec(`INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`, WORLD_MODEL_SETTING, JSON.stringify(provider));
    },
    addSecret: (v) => { secrets.push(v.slice(0, 7)); },
    async close() { await input.schedulerHost.stop(); },
  };
}

const store: WorldStore = {
  beginRestore(storage) {
    storage.transactionSync(() => { for (const q of SCHEMA) storage.sql.exec(q); });
    return { applied: SCHEMA.length, triggers: [] };
  },
  isClean(storage) {
    const t = storage.sql.exec(`SELECT 1 AS x FROM sqlite_master WHERE name = '_weft_dirty'`).toArray();
    return !t.length || storage.sql.exec(`SELECT COUNT(*) AS n FROM _weft_dirty`).one().n === 0;
  },
  chunkCount: () => SEED.length,
  restoreChunk(storage, _a, index) {
    storage.sql.exec(`INSERT INTO notes (id, text) VALUES (?, ?)`, index + 1, SEED[index]!);
    return { rowsWritten: 1 };
  },
  finishRestore(storage) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS _weft_dirty (tbl TEXT NOT NULL, pk TEXT NOT NULL)`);
    for (const op of ["INSERT", "UPDATE", "DELETE"]) {
      const ref = op === "DELETE" ? "OLD" : "NEW";
      storage.sql.exec(`CREATE TRIGGER IF NOT EXISTS notes_dirty_${op.toLowerCase()} AFTER ${op} ON notes BEGIN
        INSERT INTO _weft_dirty (tbl, pk) SELECT 'notes', ${ref}.id WHERE NOT EXISTS (SELECT 1 FROM _weft_dirty WHERE tbl = 'notes' AND pk = ${ref}.id); END`);
      storage.sql.exec(`CREATE TRIGGER IF NOT EXISTS settings_dirty_${op.toLowerCase()} AFTER ${op} ON settings BEGIN
        INSERT INTO _weft_dirty (tbl, pk) SELECT 'settings', ${ref}.key WHERE NOT EXISTS (SELECT 1 FROM _weft_dirty WHERE tbl = 'settings' AND pk = ${ref}.key); END`);
    }
    const n = storage.sql.exec(`SELECT COUNT(*) AS n FROM notes`).one().n as number;
    return { ok: n === SEED.length, mismatches: n === SEED.length ? [] : [`notes ${n} != ${SEED.length}`], rowsWritten: 2 };
  },
  verify(storage) {
    const n = storage.sql.exec(`SELECT COUNT(*) AS n FROM notes`).one().n as number;
    return { ok: n === SEED.length, mismatches: n === SEED.length ? [] : [`notes ${n} != ${SEED.length}`], rows: n, chainValid: true };
  },
  deltaReset(storage) {
    if (storage.sql.exec(`SELECT 1 AS x FROM notes WHERE text = ?`, FAKE_FORCE_MISMATCH).toArray().length) return { ok: false, rowsWritten: 0, mismatches: ["notes"] };
    let rowsWritten = 0;
    storage.transactionSync(() => {
      const dirty = storage.sql.exec(`SELECT COUNT(*) AS n FROM _weft_dirty`).one().n as number;
      storage.sql.exec(`DELETE FROM notes`);
      storage.sql.exec(`DELETE FROM settings`);
      for (let i = 0; i < SEED.length; i++) storage.sql.exec(`INSERT INTO notes (id, text) VALUES (?, ?)`, i + 1, SEED[i]!);
      storage.sql.exec(`DELETE FROM outbox`);
      storage.sql.exec(`DELETE FROM runs`);
      storage.sql.exec(`DELETE FROM _weft_dirty`);
      rowsWritten = dirty * 2 + SEED.length;
    });
    const n = storage.sql.exec(`SELECT COUNT(*) AS n FROM notes`).one().n as number;
    return { ok: n === SEED.length, rowsWritten, mismatches: [] };
  },
  async conformance(storage: DurableStorageLike) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS conf (v INTEGER)`);
    storage.sql.exec(`INSERT INTO conf VALUES (1)`);
    return { passed: 1, failed: 0, cases: [{ name: "fake conformance", ok: true }] };
  },
};

const artifacts: SnapshotArtifacts = {
  version: FAKE_SNAPSHOT_VERSION,
  manifest: { journalHash: "fake", digest: "fake", chunks: SEED.length, rows: SEED.length },
  snapshot: {},
};

export const fakeEngineModule: EngineModule = { boot, store, artifacts: async () => artifacts };
