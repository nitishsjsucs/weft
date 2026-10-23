// World snapshots and resets (docs/cloudflare/design.md 4.6 and 9.2). The seeded world is built on Node and taken
// apart here into INSERT chunks under 90 KB, per-table seed rows for the delta reset and a manifest; a Durable Object
// restores the chunks after deleteAll() and migrate-durable, arms the dirty-key triggers, and later undoes a visitor's
// session with a delta reset instead of a full restore. Everything runs on DurableStorageLike, so the same code
// works on workerd, on the node:sqlite emulator and on a seeded Node file opened through the emulator.
//
// - Chunks are multi-row INSERTs with inlined literals; a row too large for a 90 KB statement goes alone with its
//   values bound (values up to 2 MB). Tables go parents first (foreign keys), rowids are kept exactly, so scan order
//   and every per-table digest match the source.
// - Dirty tracking: AFTER INSERT, UPDATE and DELETE triggers record each touched key in _weft_dirty(tbl, pk) with
//   INSERT ... WHERE NOT EXISTS (an INSERT OR IGNORE inside a trigger fails under an outer UPSERT, verified locally).
//   kv_state (UNTRACKED_TABLES) is restored with the chunks and checked by the restore, but never tracked and left out
//   of the standing verify (verifiedTables): a hosted world stamps itself there after every restore and reset.
// - The delta reset runs in one transactionSync with defer_foreign_keys on: delete the dirty rows, reinsert their seed
//   rows, drop and recreate the append-only triggers around those deletions, put sqlite_sequence back, wipe
//   _weft_dirty with DROP TABLE (0 rows written) and recreate it, then check the dirty tables' digests against the
//   manifest; a mismatch throws and rolls the whole reset back, and the caller falls back to a full restore.
import { createHash } from "node:crypto";
import { DIRTY_TABLE, RESERVED_TABLE_PREFIX, type DurableStorageLike, type SqlStorageValue } from "../../contracts/src/ext/cf-db";
import { migrateDurable, MIGRATIONS_TABLE } from "./migrate-durable";
import type { MigrationEntry } from "./migrations";
import { sqlLiteral } from "./durable";

export const SNAPSHOT_VERSION = 1;
/** Chunk statements stay under this many bytes (the Durable Object statement limit is 100,000). */
export const MAX_CHUNK_BYTES = 90_000;
const DIRTY_TRIGGER_PREFIX = "_weft_dirty_";

export interface SnapshotTable {
  name: string;
  columns: string[];
  /** True when the table's rowid is not one of its columns (it is restored explicitly, first). */
  rowid: boolean;
  /** The key the dirty triggers record: the primary key columns, or ["rowid"] for a table without one. */
  key: string[];
}

export interface SnapshotChunk {
  table: string;
  sql: string;
  /** Bound values, only for a single row too large to inline. */
  args?: SqlStorageValue[];
  rows: number;
}

export interface TableDigest { rows: number; digest: string }

export interface SnapshotManifest {
  version: number;
  /** journalHash() of the migrations the snapshot was taken under; a restore refuses others. */
  journalHash: string;
  /** Table order (parents first) and shape. */
  tables: SnapshotTable[];
  digests: Record<string, TableDigest>;
  /** sha256 over every table digest, in table order. */
  digest: string;
  sequences: Record<string, number>;
  chunks: number;
  rows: number;
  /** Extra fields the snapshot builder adds (cf4: db:digest, chain head, memory HEAD, stats). */
  extra?: Record<string, unknown>;
}

export interface SeedTable { columns: string[]; rowid: boolean; key: string[]; rows: SqlStorageValue[][] }
export type SeedRows = Record<string, SeedTable>;

export interface Snapshot { manifest: SnapshotManifest; chunks: SnapshotChunk[]; seed: SeedRows }

/** Rows read and written by one restore or reset, from the cursors (billing numbers on workerd). */
export interface SqlCost { statements: number; rowsRead: number; rowsWritten: number }

class Meter implements SqlCost {
  statements = 0; rowsRead = 0; rowsWritten = 0;
  constructor(private readonly storage: DurableStorageLike) {}
  exec(sql: string, ...args: unknown[]) {
    const c = this.storage.sql.exec(sql, ...args);
    const rows = c.toArray();
    this.statements++;
    this.rowsRead += c.rowsRead;
    this.rowsWritten += c.rowsWritten;
    return rows;
  }
  cost(): SqlCost { return { statements: this.statements, rowsRead: this.rowsRead, rowsWritten: this.rowsWritten }; }
}

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
const isUserTable = (name: string) => !name.startsWith("sqlite_") && !name.startsWith(RESERVED_TABLE_PREFIX) && name !== MIGRATIONS_TABLE && name !== DIRTY_TABLE;

/**
 * Tables a snapshot restores (and finishRestore checks) but the dirty triggers never track and the standing verify
 * leaves out. kv_state is the world's small runtime state, never world content (the world digest skips it too): a
 * hosted world keeps its own stamp there (world.id, the lease) beside the seed's routines.prebuilt_hash, so a stamped
 * world always differs from the seed in kv_state while its content is clean. Tracked, every clean world would look
 * dirty and every weekly verify would fail and start a full restore.
 */
export const UNTRACKED_TABLES: readonly string[] = ["kv_state"];
const tracked = (t: { name: string }) => !UNTRACKED_TABLES.includes(t.name);

/** The tables the standing verify of a restored, stamped world checks: every manifest table but UNTRACKED_TABLES. */
export const verifiedTables = (manifest: { tables: readonly { name: string }[] }): string[] => manifest.tables.filter(tracked).map((t) => t.name);

// ---- schema ---------------------------------------------------------------------------------------------------

/** The world's tables, parents before children, with the columns and keys the snapshot and the resets use. */
export function snapshotTables(storage: DurableStorageLike): SnapshotTable[] {
  const s = storage.sql;
  const rows = s.exec("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").toArray() as { name: string; sql: string }[];
  const tables = rows.filter((r) => isUserTable(String(r.name)));
  const byName = new Map<string, SnapshotTable>();
  const parents = new Map<string, string[]>();
  for (const t of tables) {
    const name = String(t.name);
    if (/WITHOUT\s+ROWID/i.test(String(t.sql))) throw new Error(`snapshot: ${name} is WITHOUT ROWID, which the snapshot does not handle`);
    const info = s.exec(`PRAGMA table_info(${q(name)})`).toArray() as { name: string; type: string; pk: number }[];
    const pk = info.filter((c) => Number(c.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map((c) => String(c.name));
    const aliased = pk.length === 1 && /^INTEGER$/i.test(String(info.find((c) => c.name === pk[0])!.type));
    byName.set(name, { name, columns: info.map((c) => String(c.name)), rowid: !aliased, key: pk.length > 0 ? pk : ["rowid"] });
    parents.set(name, [...new Set((s.exec(`PRAGMA foreign_key_list(${q(name)})`).toArray() as { table: string }[]).map((f) => String(f.table)))].filter((p) => p !== name));
  }
  const out: SnapshotTable[] = [];
  const state = new Map<string, number>();
  const visit = (n: string) => {
    if (state.get(n) === 2 || !byName.has(n)) return;
    if (state.get(n) === 1) throw new Error(`snapshot: a foreign key cycle through ${n}`);
    state.set(n, 1);
    for (const p of parents.get(n) ?? []) visit(p);
    state.set(n, 2);
    out.push(byName.get(n)!);
  };
  for (const t of [...byName.keys()].sort()) visit(t);
  return out;
}

const selectList = (t: SnapshotTable) => [...(t.rowid ? ["rowid"] : []), ...t.columns.map(q)].join(", ");
const insertColumns = (t: SnapshotTable) => [...(t.rowid ? ["rowid"] : []), ...t.columns.map(q)].join(", ");

function rowsOf(storage: DurableStorageLike, t: SnapshotTable): SqlStorageValue[][] {
  return [...storage.sql.exec(`SELECT ${selectList(t)} FROM ${q(t.name)} ORDER BY rowid`).raw()];
}

// ---- digests --------------------------------------------------------------------------------------------------

const hex = (b: ArrayBuffer | Uint8Array) => Array.from(b instanceof Uint8Array ? b : new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
const canonicalCell = (v: unknown): unknown => (v instanceof ArrayBuffer || ArrayBuffer.isView(v) ? { $blob: hex(v instanceof ArrayBuffer ? v : new Uint8Array((v as ArrayBufferView).buffer, (v as ArrayBufferView).byteOffset, (v as ArrayBufferView).byteLength)) } : v);

/** sha256 of a table's rows (rowid first when it is not a column) in rowid order, one JSON line per row. */
export function tableDigest(storage: DurableStorageLike, t: SnapshotTable): TableDigest {
  const h = createHash("sha256");
  let rows = 0;
  for (const r of storage.sql.exec(`SELECT ${selectList(t)} FROM ${q(t.name)} ORDER BY rowid`).raw()) {
    h.update(JSON.stringify(r.map(canonicalCell)));
    h.update("\n");
    rows++;
  }
  return { rows, digest: h.digest("hex") };
}

export function tableDigests(storage: DurableStorageLike, tables: readonly SnapshotTable[]): Record<string, TableDigest> {
  const out: Record<string, TableDigest> = {};
  for (const t of tables) out[t.name] = tableDigest(storage, t);
  return out;
}

const overall = (tables: readonly SnapshotTable[], digests: Record<string, TableDigest>) =>
  createHash("sha256").update(tables.map((t) => `${t.name}\t${digests[t.name]!.rows}\t${digests[t.name]!.digest}`).join("\n")).digest("hex");

function sequences(storage: DurableStorageLike): Record<string, number> {
  const has = storage.sql.exec("SELECT count(*) AS n FROM sqlite_master WHERE name = 'sqlite_sequence'").one().n;
  if (!Number(has)) return {};
  const out: Record<string, number> = {};
  for (const r of storage.sql.exec("SELECT name, seq FROM sqlite_sequence ORDER BY name").toArray()) if (isUserTable(String(r.name))) out[String(r.name)] = Number(r.seq);
  return out;
}

// ---- build ----------------------------------------------------------------------------------------------------

const literal = (v: SqlStorageValue) => sqlLiteral(v instanceof ArrayBuffer ? new Uint8Array(v) : v);
const byteLen = (s: string) => new TextEncoder().encode(s).byteLength;

/** Takes the snapshot of a world: chunks, seed rows and the manifest. The world must be quiet (no open transaction). */
export function buildSnapshot(storage: DurableStorageLike, opts: { journalHash: string; maxChunkBytes?: number; extra?: Record<string, unknown> }): Snapshot {
  const max = opts.maxChunkBytes ?? MAX_CHUNK_BYTES;
  const tables = snapshotTables(storage);
  const chunks: SnapshotChunk[] = [];
  const seed: SeedRows = {};
  const digests: Record<string, TableDigest> = {};
  let total = 0;
  for (const t of tables) {
    const rows = rowsOf(storage, t);
    seed[t.name] = { columns: t.columns, rowid: t.rowid, key: t.key, rows };
    digests[t.name] = tableDigest(storage, t);
    total += rows.length;
    const head = `INSERT INTO ${q(t.name)} (${insertColumns(t)}) VALUES `;
    let tuples: string[] = [];
    let size = byteLen(head);
    const flush = () => {
      if (tuples.length === 0) return;
      chunks.push({ table: t.name, sql: head + tuples.join(", "), rows: tuples.length });
      tuples = [];
      size = byteLen(head);
    };
    for (const r of rows) {
      const tuple = `(${r.map(literal).join(", ")})`;
      const n = byteLen(tuple) + 2;
      if (byteLen(head) + n > max) {
        flush();
        chunks.push({ table: t.name, sql: `${head}(${r.map(() => "?").join(", ")})`, args: r, rows: 1 });
        continue;
      }
      if (size + n > max) flush();
      tuples.push(tuple);
      size += n;
    }
    flush();
  }
  const manifest: SnapshotManifest = {
    version: SNAPSHOT_VERSION, journalHash: opts.journalHash, tables, digests, digest: overall(tables, digests),
    sequences: sequences(storage), chunks: chunks.length, rows: total, ...(opts.extra ? { extra: opts.extra } : {}),
  };
  return { manifest, chunks, seed };
}

// ---- restore --------------------------------------------------------------------------------------------------

export interface RestoreOutcome extends SqlCost { chunks: number; rows: number; armed: boolean; digest: string }

/** The non-dirty triggers of the schema, to drop around the inserts and recreate after. */
function userTriggers(storage: DurableStorageLike): { name: string; table: string; sql: string }[] {
  return (storage.sql.exec("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name").toArray() as { name: string; tbl_name: string; sql: string }[])
    .filter((r) => !String(r.name).startsWith(DIRTY_TRIGGER_PREFIX)).map((r) => ({ name: String(r.name), table: String(r.tbl_name), sql: String(r.sql) }));
}

/**
 * Step 1 of a full restore: the caller has run deleteAll(); this migrates and drops the schema's triggers so the
 * chunks insert without firing them (finishRestore recreates them). Returns the triggers to recreate.
 */
export function beginRestore(storage: DurableStorageLike, snap: Pick<Snapshot, "manifest">, migrations: readonly MigrationEntry[], journalHash: string): { triggers: { name: string; sql: string }[]; cost: SqlCost } {
  if (snap.manifest.version !== SNAPSHOT_VERSION) throw new Error(`snapshot: version ${snap.manifest.version}, expected ${SNAPSHOT_VERSION}`);
  if (snap.manifest.journalHash !== journalHash) throw new Error("snapshot: taken under other migrations (journal hash differs); rebuild it");
  migrateDurable(storage, migrations);
  const m = new Meter(storage);
  const triggers = userTriggers(storage);
  storage.transactionSync(() => { for (const t of triggers) m.exec(`DROP TRIGGER ${q(t.name)}`); });
  return { triggers, cost: m.cost() };
}

/** Step 2, repeatable across Workflow steps: chunks [from, to), each in its own transactionSync. */
export function restoreChunks(storage: DurableStorageLike, chunks: readonly SnapshotChunk[], from = 0, to = chunks.length): SqlCost {
  const m = new Meter(storage);
  for (let i = from; i < to; i++) {
    const c = chunks[i]!;
    storage.transactionSync(() => {
      m.exec("PRAGMA defer_foreign_keys = ON");
      m.exec(c.sql, ...(c.args ?? []));
    });
  }
  return m.cost();
}

/** Step 3: triggers back, sqlite_sequence as the source had it, dirty tracking armed, then the full verify of every
 * table (kv_state included: nothing has stamped the world yet). */
export function finishRestore(storage: DurableStorageLike, snap: Pick<Snapshot, "manifest">, triggers: readonly { sql: string }[], opts: { arm?: boolean } = {}): RestoreOutcome {
  const m = new Meter(storage);
  storage.transactionSync(() => {
    for (const t of triggers) m.exec(t.sql);
    writeSequences(m, snap.manifest.sequences);
  });
  const armed = opts.arm ?? true;
  if (armed) {
    const a = armDirtyTracking(storage, snap.manifest.tables);
    m.statements += a.statements; m.rowsRead += a.rowsRead; m.rowsWritten += a.rowsWritten;
  }
  const verify = verifyAgainstManifest(storage, snap.manifest);
  if (verify.mismatched.length) throw new Error(`snapshot: restore does not match the manifest in ${verify.mismatched.join(", ")}`);
  return { ...m.cost(), chunks: snap.manifest.chunks, rows: snap.manifest.rows, armed, digest: verify.digest };
}

function writeSequences(m: Meter, seqs: Record<string, number>): void {
  if (Object.keys(seqs).length === 0) return;
  const present = new Map((m.exec("SELECT name, seq FROM sqlite_sequence").map((r) => [String(r.name), Number(r.seq)] as const)));
  for (const [name, seq] of present) if (!(name in seqs) && isUserTable(name)) m.exec("DELETE FROM sqlite_sequence WHERE name = ?", name);
  for (const [name, seq] of Object.entries(seqs)) {
    if (present.get(name) === seq) continue;
    if (present.has(name)) m.exec("UPDATE sqlite_sequence SET seq = ? WHERE name = ?", seq, name);
    else m.exec("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)", name, seq);
  }
}

/** A full restore in one call (tests, the emulator, and a CompanyDO restoring outside a Workflow). */
export async function restoreSnapshot(storage: DurableStorageLike, snap: Snapshot, migrations: readonly MigrationEntry[], journalHash: string, opts: { arm?: boolean } = {}): Promise<RestoreOutcome> {
  await storage.deleteAll();
  const begin = beginRestore(storage, snap, migrations, journalHash);
  const chunks = restoreChunks(storage, snap.chunks);
  const done = finishRestore(storage, snap, begin.triggers, opts);
  return {
    ...done,
    statements: begin.cost.statements + chunks.statements + done.statements,
    rowsRead: begin.cost.rowsRead + chunks.rowsRead + done.rowsRead,
    rowsWritten: begin.cost.rowsWritten + chunks.rowsWritten + done.rowsWritten,
  };
}

export function verifyAgainstManifest(storage: DurableStorageLike, manifest: SnapshotManifest, only?: readonly string[]): { mismatched: string[]; digest: string; digests: Record<string, TableDigest> } {
  const tables = only ? manifest.tables.filter((t) => only.includes(t.name)) : manifest.tables;
  const digests = tableDigests(storage, tables);
  const mismatched = tables.filter((t) => digests[t.name]!.digest !== manifest.digests[t.name]?.digest || digests[t.name]!.rows !== manifest.digests[t.name]?.rows).map((t) => t.name);
  return { mismatched, digests, digest: only ? "" : overall(tables, digests) };
}

// ---- dirty tracking -------------------------------------------------------------------------------------------

const DIRTY_DDL = `CREATE TABLE IF NOT EXISTS ${DIRTY_TABLE} (tbl TEXT NOT NULL, pk TEXT NOT NULL, PRIMARY KEY (tbl, pk)) WITHOUT ROWID`;

function keyExpr(prefix: "NEW" | "OLD", key: readonly string[]): string {
  return `json_array(${key.map((k) => (k === "rowid" ? `${prefix}.rowid` : `${prefix}.${q(k)}`)).join(", ")})`;
}
function recordKey(table: string, prefix: "NEW" | "OLD", key: readonly string[]): string {
  const lit = sqlLiteral(table);
  return `INSERT INTO ${DIRTY_TABLE} (tbl, pk) SELECT ${lit}, ${keyExpr(prefix, key)} WHERE NOT EXISTS (SELECT 1 FROM ${DIRTY_TABLE} WHERE tbl = ${lit} AND pk = ${keyExpr(prefix, key)});`;
}

/**
 * Creates _weft_dirty and one AFTER INSERT, UPDATE and DELETE trigger per table, skipping UNTRACKED_TABLES (and
 * dropping a trigger one of them still has from an earlier build). Idempotent.
 */
export function armDirtyTracking(storage: DurableStorageLike, tables: readonly SnapshotTable[]): SqlCost {
  const m = new Meter(storage);
  storage.transactionSync(() => {
    m.exec(DIRTY_DDL);
    const existing = new Set((m.exec("SELECT name FROM sqlite_master WHERE type = 'trigger' AND substr(name, 1, ?) = ?", DIRTY_TRIGGER_PREFIX.length, DIRTY_TRIGGER_PREFIX)).map((r) => String(r.name)));
    for (const name of UNTRACKED_TABLES) {
      for (const op of ["i", "u", "d"]) if (existing.has(`${DIRTY_TRIGGER_PREFIX}${name}_${op}`)) m.exec(`DROP TRIGGER ${q(`${DIRTY_TRIGGER_PREFIX}${name}_${op}`)}`);
    }
    for (const t of tables.filter(tracked)) {
      const base = `${DIRTY_TRIGGER_PREFIX}${t.name}`;
      const defs: [string, string][] = [
        [`${base}_i`, `CREATE TRIGGER ${q(`${base}_i`)} AFTER INSERT ON ${q(t.name)} BEGIN ${recordKey(t.name, "NEW", t.key)} END`],
        [`${base}_u`, `CREATE TRIGGER ${q(`${base}_u`)} AFTER UPDATE ON ${q(t.name)} BEGIN ${recordKey(t.name, "OLD", t.key)} ${recordKey(t.name, "NEW", t.key)} END`],
        [`${base}_d`, `CREATE TRIGGER ${q(`${base}_d`)} AFTER DELETE ON ${q(t.name)} BEGIN ${recordKey(t.name, "OLD", t.key)} END`],
      ];
      for (const [name, ddl] of defs) if (!existing.has(name)) m.exec(ddl);
    }
  });
  return m.cost();
}

/** Keys the dirty triggers recorded, per table. */
export function dirtyKeys(storage: DurableStorageLike): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const present = Number(storage.sql.exec("SELECT count(*) AS n FROM sqlite_master WHERE name = ?", DIRTY_TABLE).one().n);
  if (!present) return out;
  for (const r of storage.sql.exec(`SELECT tbl, pk FROM ${DIRTY_TABLE} ORDER BY tbl, pk`).toArray()) {
    const list = out.get(String(r.tbl)) ?? [];
    list.push(String(r.pk));
    out.set(String(r.tbl), list);
  }
  return out;
}

// ---- delta reset ----------------------------------------------------------------------------------------------

export interface DeltaResetOutcome extends SqlCost { tables: string[]; keys: number; deleted: number; reinserted: number }

const canonicalKey = (values: readonly unknown[]) => JSON.stringify(values);

/**
 * Puts every row the dirty triggers recorded back to the seed, in one transactionSync. Throws (and rolls back) when
 * the touched tables' digests do not match the manifest afterwards.
 */
export function deltaReset(storage: DurableStorageLike, snap: Pick<Snapshot, "manifest" | "seed">): DeltaResetOutcome {
  const m = new Meter(storage);
  const byTable = new Map(snap.manifest.tables.map((t) => [t.name, t]));
  let deleted = 0;
  let reinserted = 0;
  let keyCount = 0;
  let touched: string[] = [];
  storage.transactionSync(() => {
    m.exec("PRAGMA defer_foreign_keys = ON");
    const dirty = new Map<string, string[]>();
    for (const r of m.exec(`SELECT tbl, pk FROM ${DIRTY_TABLE}`)) {
      const list = dirty.get(String(r.tbl)) ?? [];
      list.push(String(r.pk));
      dirty.set(String(r.tbl), list);
    }
    touched = [...dirty.keys()].sort();
    const triggers = userTriggers(storage);
    for (const name of touched) {
      const t = byTable.get(name);
      if (!t) throw new Error(`delta reset: ${name} is not in the snapshot`);
      const seed = snap.seed[name];
      if (!seed) throw new Error(`delta reset: no seed rows for ${name}`);
      const keys = dirty.get(name)!;
      keyCount += keys.length;
      // The append-only triggers refuse the deletions: drop them, delete, recreate (design 4.6).
      const blocking = triggers.filter((tr) => tr.table === name);
      for (const tr of blocking) m.exec(`DROP TRIGGER ${q(tr.name)}`);
      const where = t.key.map((k) => (k === "rowid" ? "rowid = ?" : `${q(k)} = ?`)).join(" AND ");
      const keyIndex = t.key.map((k) => (k === "rowid" ? 0 : (t.rowid ? 1 : 0) + t.columns.indexOf(k)));
      const seedByKey = new Map<string, SqlStorageValue[]>();
      for (const row of seed.rows) seedByKey.set(canonicalKey(keyIndex.map((i) => row[i])), row);
      const ins = `INSERT INTO ${q(name)} (${insertColumns(t)}) VALUES (${[...(t.rowid ? ["?"] : []), ...t.columns.map(() => "?")].join(", ")})`;
      // Delete every dirty key first, then reinsert: a key can move (an UPDATE of the primary key keeps the rowid),
      // so a seed row's rowid may still be held by a row that is deleted later in the list.
      const back: SqlStorageValue[][] = [];
      for (const k of keys) {
        const values = JSON.parse(k) as unknown[];
        const res = storage.sql.exec(`DELETE FROM ${q(name)} WHERE ${where}`, ...values);
        res.toArray();
        m.statements++; m.rowsRead += res.rowsRead; m.rowsWritten += res.rowsWritten;
        deleted += Number(m.exec("SELECT changes() AS c")[0]!.c);
        const row = seedByKey.get(canonicalKey(values));
        if (row) back.push(row);
      }
      for (const row of back) { m.exec(ins, ...row); reinserted++; }
      for (const tr of blocking) m.exec(tr.sql);
    }
    const seqs = sequences(storage);
    if (JSON.stringify(seqs) !== JSON.stringify(snap.manifest.sequences)) writeSequences(m, snap.manifest.sequences);
    // Wipe the dirty keys: DROP TABLE writes no rows; deleting each key would write one per key.
    m.exec(`DROP TABLE ${DIRTY_TABLE}`);
    m.exec(DIRTY_DDL);
    const verify = verifyAgainstManifest(storage, snap.manifest as SnapshotManifest, touched);
    m.rowsRead += Object.values(verify.digests).reduce((n, d) => n + d.rows, 0);
    if (verify.mismatched.length) throw new Error(`delta reset: ${verify.mismatched.join(", ")} do not match the manifest after the reset`);
  });
  return { ...m.cost(), tables: touched, keys: keyCount, deleted, reinserted };
}

// ---- files ----------------------------------------------------------------------------------------------------

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(b64: string): ArrayBuffer {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out.buffer;
}

/** JSON with blobs as { $b64 }: the format snapshot files hold (gzip it; decodeSnapshot reads it back). */
export function snapshotToJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v instanceof ArrayBuffer) return { $b64: toBase64(new Uint8Array(v)) };
    if (ArrayBuffer.isView(v) && !(v instanceof DataView)) return { $b64: toBase64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
    return v;
  });
}
export function snapshotFromJson<T>(text: string): T {
  return JSON.parse(text, (_k, v) => {
    if (v && typeof v === "object" && typeof (v as { $b64?: unknown }).$b64 === "string" && Object.keys(v).length === 1) return fromBase64((v as { $b64: string }).$b64);
    return v;
  }) as T;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
export const gzip = (bytes: Uint8Array) => pipe(bytes, new CompressionStream("gzip"));
export const gunzip = (bytes: Uint8Array) => pipe(bytes, new DecompressionStream("gzip"));

/** The three snapshot files: chunks and seed rows gzipped, the manifest as plain JSON. */
export async function encodeSnapshot(snap: Snapshot): Promise<{ chunks: Uint8Array; seed: Uint8Array; manifest: string }> {
  const enc = new TextEncoder();
  return { chunks: await gzip(enc.encode(snapshotToJson(snap.chunks))), seed: await gzip(enc.encode(snapshotToJson(snap.seed))), manifest: JSON.stringify(snap.manifest, null, 2) };
}
export async function decodeSnapshot(files: { chunks: Uint8Array; seed: Uint8Array; manifest: string }): Promise<Snapshot> {
  const dec = new TextDecoder();
  return {
    manifest: JSON.parse(files.manifest) as SnapshotManifest,
    chunks: snapshotFromJson<SnapshotChunk[]>(dec.decode(await gunzip(files.chunks))),
    seed: snapshotFromJson<SeedRows>(dec.decode(await gunzip(files.seed))),
  };
}
