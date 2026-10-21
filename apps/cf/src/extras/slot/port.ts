// The Durable Object side of the extras seam (track cf6-extras): what CompanyDO's extras RPC methods do. cf4-worker
// builds one per world with the world's own parts (the platform's BlobStore, the SQL MemoryRepo, the executor) and
// delegates `extrasWorld`, `extrasBlob`, `extrasWriteBack`, `extrasMemoryText` and `extrasExport` to it. Every call
// runs outside any executor transaction: the write-back goes through the executor's own system path, which opens one.
import { sql } from "drizzle-orm";
import type { Db } from "@weft/db";
import { dumpDb } from "@weft/seed";
import { HIDDEN_SERVICE_COMMANDS } from "@weft/cf-extras";
import type { ToolOutcome } from "@weft/contracts";
import type { HiddenWriteBack, SlotExport, SlotExtrasPort, SlotWorldInfo, WriteBackOutcome } from "../ports";
import { RETRYABLE_WRITE_BACK_CODES } from "./commands";

/** The system principal the write-backs run as (HostedSystemPrincipal in cf-platform.ts). */
export const SVC_JOBS = "svc_jobs";

export interface SlotExtrasDeps {
  world(): SlotWorldInfo | Promise<SlotWorldInfo>;
  /** The platform's BlobStore (SQL on the durable platform). */
  blobs: { get(storagePath: string): Promise<Uint8Array | null> };
  /** MemoryRepo.read at a commit (cf1's SqlRepo on the durable platform): null when the note is not there; throws
   * when the read itself fails. */
  memoryText(path: string, commit: string): Promise<string | null>;
  /** MemoryRepo.exportFastImport. */
  exportMemory(): Promise<Uint8Array>;
  /** The world's tables as JSON (worldExportJson below), or another export the platform prefers. */
  exportWorld(): Promise<Uint8Array>;
  /** `weft.executor.system.exec("svc_jobs", command, args, ...)` once the executor allows svc_jobs. */
  exec(command: string, args: unknown): Promise<ToolOutcome>;
}

const ALLOWED = new Set<string>(Object.values(HIDDEN_SERVICE_COMMANDS));
const SHA_PATH = /^(blob:|uploads\/)[0-9a-f]{64}(\.bin)?$/;
const COMMIT = /^[0-9a-f]{40}$/;

/**
 * Refusals that mean the write-back has nothing left to do: the executor's write-backs (the one definition, kept at
 * integration) refuse a repeat or a changed subject with these codes before writing anything, so a redelivery adds no
 * action row, and the queue handler finishes the job as `already` or `skipped`.
 */
export const SETTLED_WRITE_BACK_REFUSALS: Readonly<Record<string, { status: "already" | "skipped"; reason: string | null }>> = {
  DOMAIN_ALREADY_APPLIED: { status: "already", reason: null },
  DOMAIN_STALE_RECEIPT: { status: "skipped", reason: "receipt_replaced" },
  DOMAIN_STALE_UPLOAD: { status: "skipped", reason: "upload_mismatch" },
  DOMAIN_EXTRACT_PRESENT: { status: "skipped", reason: "has_extract" },
};

/** A ToolOutcome as the queue handler needs it. */
export function writeBackOutcome(o: ToolOutcome): WriteBackOutcome {
  if (o.ok && o.status === "done") {
    const d = (o.data ?? {}) as { status?: unknown; reason?: unknown };
    const status = d.status === "already" || d.status === "skipped" ? d.status : "attached";
    return { ok: true, status, reason: typeof d.reason === "string" ? d.reason : null };
  }
  if (o.ok) return { ok: false, code: "UNEXPECTED_PROPOSAL", message: "a write-back must never become a proposal", retryable: false };
  const settled = SETTLED_WRITE_BACK_REFUSALS[o.refusal.code];
  if (settled) return { ok: true, ...settled };
  return { ok: false, code: o.refusal.code, message: o.refusal.message, retryable: RETRYABLE_WRITE_BACK_CODES.has(o.refusal.code) };
}

export function createSlotExtras(deps: SlotExtrasDeps): SlotExtrasPort {
  return {
    async extrasWorld() { return deps.world(); },
    async extrasBlob(storagePath) {
      if (!SHA_PATH.test(storagePath)) return null;
      return deps.blobs.get(storagePath);
    },
    async extrasWriteBack(w: HiddenWriteBack) {
      if (!ALLOWED.has(w.command)) return { ok: false, code: "NOT_PERMITTED", message: `${String(w.command)} is not a write-back`, retryable: false };
      try {
        return writeBackOutcome(await deps.exec(w.command, w.args));
      } catch (e) {
        return { ok: false, code: "INTERNAL", message: e instanceof Error ? e.message.slice(0, 200) : "write-back failed", retryable: true };
      }
    },
    async extrasMemoryText(path, commit) {
      if (!COMMIT.test(commit) || path.includes("..") || path.startsWith("/") || !path.endsWith(".md")) return null;
      // null means the note is not at that commit; a read that fails throws, so the embedding job retries.
      return deps.memoryText(path, commit);
    },
    async extrasExport(what): Promise<SlotExport> {
      return what === "memory"
        ? { bytes: await deps.exportMemory(), contentType: "application/octet-stream" }
        : { bytes: await deps.exportWorld(), contentType: "application/json" };
    },
  };
}

/** Tables a world export leaves out: memory (exported on its own), stored uploads, and hosted runtime state. */
export const WORLD_EXPORT_SKIP: readonly string[] = ["mem_objects", "mem_refs", "mem_log", "blobs", "run_files", "run_handles", "outbox", "kv_state"];

/**
 * The world's domain and harness tables as one JSON document, through the same dump `pnpm db:digest` hashes, so
 * token hashes, key material and vault ciphertext are already left out (DIGEST_EXCLUDE).
 */
export async function worldExportJson(db: Db, meta: { slot: string; gen: number; exportedAt: string }): Promise<Uint8Array> {
  const dump = await dumpDb(db);
  for (const t of WORLD_EXPORT_SKIP) delete dump[t];
  const [{ n } = { n: 0 }] = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'`);
  return new TextEncoder().encode(JSON.stringify({ format: "weft-world-export", version: 1, demo: "fictional company, simulated data", ...meta, tableCount: n, tables: dump }));
}
