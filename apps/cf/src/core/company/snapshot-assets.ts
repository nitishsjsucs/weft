// The seeded world as weft-core bundles it (design 4.1): cf1's encodeSnapshot files, written by pnpm cf:snapshot into
// apps/cf/generated/ (gitignored: they hold vault ciphertext sealed with the deploy key and key hashes, so they are
// private Data modules, never public assets): snapshot-rich.sql.gz (the INSERT chunks), seed-rows.json.gz (per-table
// seed rows for the delta reset) and manifest.json. Only the real engine imports this module.
import chunksGz from "../../../generated/snapshot-rich.sql.gz";
import seedGz from "../../../generated/seed-rows.json.gz";
import manifest from "../../../generated/manifest.json";

export interface SnapshotFiles { chunks: Uint8Array; seed: Uint8Array; manifest: string }

export function bundledSnapshotFiles(): SnapshotFiles {
  return { chunks: new Uint8Array(chunksGz), seed: new Uint8Array(seedGz), manifest: JSON.stringify(manifest) };
}
