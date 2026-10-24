// SQL-backed platform parts over the drizzle Db (docs/cloudflare/design.md 4.1), shared by the durable platform and,
// behind WEFT_BLOBS=sqlite, by Node: uploads in the `blobs` table (1 MiB chunks, storage_path blob:<sha256>), run
// handles in `run_handles` (bearer credentials, read by no route) and run artifact and code bodies in `run_files`.
// No node:fs anywhere in this module.
import { createHash } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { blobs, runFiles, runHandles, withWriteLock, type Db } from "@weft/db";
import { safeRunFileKey } from "@weft/executor";
import { BLOB_CHUNK_BYTES, type TxGuard } from "../../../../packages/contracts/src/ext/cf-db";
import type { BlobStore, RunFileStore, RunHandleRecord, RunHandleStore } from "../../../../packages/contracts/src/ext/cf-platform";

export const SQL_BLOB_PREFIX = "blob:";
const SHA = /^[0-9a-f]{64}$/;
const SAFE_RUN_ID = /^run_[A-Za-z0-9_]+$/;

export class BlobTooLarge extends Error {
  readonly code = "UPLOAD_LIMIT";
  constructor(readonly bytes: number, readonly maxBytes: number) { super(`The file is ${bytes} bytes; uploads here are at most ${maxBytes} bytes`); }
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
/** The sha256 a blob storage path names, or null when it is not one. */
export function blobKeyOf(storagePath: string): string | null {
  if (!storagePath.startsWith(SQL_BLOB_PREFIX)) return null;
  const k = storagePath.slice(SQL_BLOB_PREFIX.length);
  return SHA.test(k) ? k : null;
}
// Buffer.isBuffer is a type guard under @types/node but not under workers-types (apps/cf typechecks this file too).
const toBuffer = (v: unknown): Buffer => (Buffer.isBuffer(v) ? (v as Buffer) : v instanceof ArrayBuffer ? Buffer.from(v) : ArrayBuffer.isView(v) ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : Buffer.from(String(v ?? ""), "latin1"));

export interface SqlBlobStoreOptions {
  /** Hosted uploads are capped (HOSTED_SETTINGS.uploadMaxBytes, 1.5 MB); put refuses bigger files with BlobTooLarge. */
  maxBytes?: number | null;
  /** Writes hold their own transaction and must never run inside a command's (IO_IN_TX on the durable platform). */
  guard?: TxGuard | null;
}

/** Uploads in the blobs table: content-addressed, chunked under the 2 MB row limit, written in one transaction. */
export function sqlBlobStore(db: Db, opts: SqlBlobStoreOptions = {}): BlobStore {
  const exists = async (key: string) => (await db.select({ idx: blobs.idx }).from(blobs).where(and(eq(blobs.key, key), eq(blobs.idx, 0))).limit(1)).length > 0;
  return {
    kind: "sqlite",
    async put(bytes) {
      if (opts.maxBytes != null && bytes.byteLength > opts.maxBytes) throw new BlobTooLarge(bytes.byteLength, opts.maxBytes);
      opts.guard?.assertNotInTx("BlobStore.put");
      const key = sha256(bytes);
      const storagePath = `${SQL_BLOB_PREFIX}${key}`;
      if (await exists(key)) return { storagePath, sha256: key, bytes: bytes.byteLength, fresh: false };
      const buf = toBuffer(bytes);
      const chunks: Buffer[] = [];
      for (let at = 0; at < buf.length || chunks.length === 0; at += BLOB_CHUNK_BYTES) chunks.push(buf.subarray(at, at + BLOB_CHUNK_BYTES));
      let fresh = true;
      await withWriteLock(() => db.transaction(async (tx) => {
        // A concurrent put of the same bytes may have won between the check and the lock.
        const again = await tx.select({ idx: blobs.idx }).from(blobs).where(and(eq(blobs.key, key), eq(blobs.idx, 0))).limit(1);
        if (again.length) { fresh = false; return; }
        for (const [idx, chunk] of chunks.entries()) await tx.insert(blobs).values({ key, idx, bytes: Buffer.from(chunk) });
      }));
      return { storagePath, sha256: key, bytes: bytes.byteLength, fresh };
    },
    async get(storagePath) {
      const key = blobKeyOf(storagePath);
      if (!key) return null;
      const rows = await db.select({ idx: blobs.idx, bytes: blobs.bytes }).from(blobs).where(eq(blobs.key, key)).orderBy(asc(blobs.idx));
      if (!rows.length) return null;
      return new Uint8Array(Buffer.concat(rows.map((r) => toBuffer(r.bytes))));
    },
    async has(storagePath) {
      const key = blobKeyOf(storagePath);
      return key ? exists(key) : false;
    },
    async delete(storagePath) {
      const key = blobKeyOf(storagePath);
      if (!key) return;
      opts.guard?.assertNotInTx("BlobStore.delete");
      await withWriteLock(() => db.delete(blobs).where(eq(blobs.key, key)));
    },
  };
}

/** Run handles in the run_handles table. Keyed by run id; the token never reaches run_steps or any route. */
export function sqlRunHandleStore(db: Db): RunHandleStore {
  return {
    async save(handle: RunHandleRecord) {
      if (!SAFE_RUN_ID.test(handle.runId)) throw new Error(`unsafe run id ${JSON.stringify(handle.runId).slice(0, 40)}`);
      const nonce = typeof handle.nonce === "string" ? handle.nonce : null;
      await withWriteLock(() => db.insert(runHandles).values({ runId: handle.runId, token: handle.token, nonce }).onConflictDoUpdate({ target: runHandles.runId, set: { token: handle.token, nonce } }));
    },
    async load(runId) {
      if (!SAFE_RUN_ID.test(runId)) return null;
      const [r] = await db.select().from(runHandles).where(eq(runHandles.runId, runId)).limit(1);
      if (!r || typeof r.token !== "string") return null;
      return Object.freeze(r.nonce ? { runId, token: r.token, nonce: r.nonce } : { runId, token: r.token });
    },
    async drop(runId) {
      if (!SAFE_RUN_ID.test(runId)) return;
      await withWriteLock(() => db.delete(runHandles).where(eq(runHandles.runId, runId)));
    },
  };
}

/** Characters per run_files part: at most 4 bytes each in UTF-8, so a part stays under the 2 MB row limit. */
export const RUN_FILE_PART_CHARS = 450_000;
// A control character no JSON or script body starts with (SQLite text drops everything after a NUL on some drivers).
const CHUNKED = "\u001fweft-parts:";
const partKey = (path: string, n: number) => `${path}#part${n}`;

/**
 * Run artifact and code bodies in the run_files table. They are written inside the command's savepoint (offloadIfLarge
 * runs in the pipeline), so they commit and roll back with the command. Bodies over one part are split into parts
 * under the 2 MB row limit, behind a marker row at the path itself.
 */
export function sqlRunFileStore(db: Db): RunFileStore {
  return {
    async write(path, body) {
      safeRunFileKey(path);
      // Inside the executor's transaction the drizzle db joins it (the facade's transaction is the closure in scope).
      const parts: string[] = [];
      for (let at = 0; at < body.length; at += RUN_FILE_PART_CHARS) parts.push(body.slice(at, at + RUN_FILE_PART_CHARS));
      // The path and its parts as a key range ("#part" up to "#paru"), so the primary key finds them: a substr test
      // would read every row of the table on each write, and hosted counts every row read.
      await db.delete(runFiles).where(sql`${runFiles.path} = ${path} OR (${runFiles.path} >= ${`${path}#part`} AND ${runFiles.path} < ${`${path}#paru`})`);
      if (parts.length <= 1) { await db.insert(runFiles).values({ path, body }); return; }
      await db.insert(runFiles).values({ path, body: `${CHUNKED}${parts.length}` });
      for (const [i, p] of parts.entries()) await db.insert(runFiles).values({ path: partKey(path, i + 1), body: p });
    },
    async read(path) {
      try { safeRunFileKey(path); } catch { return null; }
      const [r] = await db.select({ body: runFiles.body }).from(runFiles).where(eq(runFiles.path, path)).limit(1);
      if (!r) return null;
      if (!r.body.startsWith(CHUNKED)) return r.body;
      const n = Number(r.body.slice(CHUNKED.length));
      const out: string[] = [];
      for (let i = 1; i <= n; i++) {
        const [p] = await db.select({ body: runFiles.body }).from(runFiles).where(eq(runFiles.path, partKey(path, i))).limit(1);
        if (!p) return null;
        out.push(p.body);
      }
      return out.join("");
    },
    async removePrefix(prefix) {
      const p = safeRunFileKey(prefix.replace(/\/+$/, ""));
      // Everything under "<prefix>/" as a key range ("/" up to "0", the next character), and any parts of the path itself.
      await withWriteLock(() => db.delete(runFiles).where(sql`${runFiles.path} = ${p} OR (${runFiles.path} >= ${`${p}/`} AND ${runFiles.path} < ${`${p}0`}) OR (${runFiles.path} >= ${`${p}#part`} AND ${runFiles.path} < ${`${p}#paru`})`));
    },
  };
}
