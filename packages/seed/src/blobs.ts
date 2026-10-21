// Seeded uploads (receipt images) go where the world's uploads go (docs/cloudflare/design.md 4.1 and 9.2): files at
// uploads/<sha256>.bin under the data dir by default, exactly as before, or rows of the blobs table when the world's
// BlobStore is the SQL one (WEFT_BLOBS=sqlite, which the hosted snapshot is seeded with). Rows are written in the
// caller's transaction, so a seed step that rolls back leaves no blob behind.
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ExecutorBundle } from "@weft/contracts";
import { blobs, type DbTx } from "@weft/db";
import { executorInternals } from "@weft/executor";
import { BLOB_CHUNK_BYTES } from "../../contracts/src/ext/cf-db";

/** node:fs on first use, never a static import: this module is on the hosted import graph (docs/cloudflare/design.md
 * 6.4), where only Node's code paths call it. */
const fs = () => process.getBuiltinModule("node:fs");

export type SeedBlobMode = "file" | "sqlite";

/** Where this world keeps uploads: the SQL store's kind when the composition root gave the executor one, else files. */
export function seedBlobMode(executor: ExecutorBundle | null | undefined): SeedBlobMode {
  try { return executor && executorInternals(executor)?.blobs?.kind === "sqlite" ? "sqlite" : "file"; } catch { return "file"; }
}

/**
 * Stores one seeded upload and returns its storage_path and sha256. File mode also writes the `<sha>.extract.json`
 * sidecar beside it, as the seed always has; the SQL mode keeps only the bytes (the extract is in the expense row).
 */
export async function seedUpload(o: { tx: DbTx; dataDir: string; mode: SeedBlobMode }, bytes: Buffer, sidecar: string | null): Promise<{ storagePath: string; sha256: string; chunks: number }> {
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (o.mode === "sqlite") {
    let chunks = 0;
    for (let at = 0, idx = 0; at < bytes.length || idx === 0; at += BLOB_CHUNK_BYTES, idx++) {
      await o.tx.insert(blobs).values({ key: sha, idx, bytes: Buffer.from(bytes.subarray(at, at + BLOB_CHUNK_BYTES)) }).onConflictDoNothing();
      chunks++;
    }
    return { storagePath: `blob:${sha}`, sha256: sha, chunks };
  }
  const rel = `uploads/${sha}.bin`;
  fs().mkdirSync(join(o.dataDir, "uploads"), { recursive: true });
  fs().writeFileSync(join(o.dataDir, rel), bytes);
  if (sidecar !== null) fs().writeFileSync(join(o.dataDir, "uploads", `${sha}.extract.json`), sidecar);
  return { storagePath: rel, sha256: sha, chunks: 0 };
}
