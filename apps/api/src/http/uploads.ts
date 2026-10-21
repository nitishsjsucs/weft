// Upload storage for the routes (docs/cloudflare/design.md 4.1): every route that takes a file (receipts, I-9 images,
// notice scans, training certificates, agent-surface documents) stores the bytes through the world's BlobStore
// before its command runs, and removes them again if the command refuses and nothing else held them. Node keeps
// uploads/<sha256>.bin under the data dir; WEFT_BLOBS=sqlite and the durable platform use the blobs table, where a
// file over the hosted cap (1.5 MB) is answered 413 UPLOAD_LIMIT.
import type { Context } from "hono";
import { HOSTED_ERRORS } from "../../../../packages/contracts/src/ext/cf-hosted";
import type { BlobStore } from "../../../../packages/contracts/src/ext/cf-platform";
import { fileBlobStore } from "../platform/node";
import { BlobTooLarge } from "../platform/sql";
import type { Weft, WeftEnv } from "./context";

export interface StoredUpload { storagePath: string; sha256: string; bytes: number; fresh: boolean; undo(): Promise<void> }

/** The world's BlobStore (route tests that hand in a partial Weft get the Node file store). */
export function blobsOf(weft: Weft): BlobStore {
  return weft.blobs ?? fileBlobStore(weft.dataDir);
}

export async function storeUpload(weft: Weft, bytes: Uint8Array): Promise<StoredUpload> {
  const store = blobsOf(weft);
  const r = await store.put(bytes);
  return { ...r, undo: async () => { if (r.fresh) { try { await store.delete(r.storagePath); } catch { /* already gone */ } } } };
}

/** 413 UPLOAD_LIMIT for a file over the hosted cap; null for any other error (the caller rethrows it). */
export function uploadLimitResponse(c: Context<WeftEnv>, err: unknown): Response | null {
  if (!(err instanceof BlobTooLarge)) return null;
  const e = HOSTED_ERRORS.UPLOAD_LIMIT;
  return c.json({ _tag: e.tag, code: "UPLOAD_LIMIT", message: err.message, hint: `Upload a file of at most ${err.maxBytes} bytes`, example: null }, e.status);
}
