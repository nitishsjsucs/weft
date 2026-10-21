// The seeded world as weft-core bundles it (design 4.1): snapshot-rich.sql.gz and seed-rows.json.gz as Data modules
// and manifest.json, all written by pnpm cf:snapshot into apps/cf/generated/ (gitignored: they hold vault ciphertext
// sealed with the deploy key and key hashes, so they are private modules, never public assets). Decompressed once
// per isolate, on the first restore or reset, never at startup.
import snapshotGz from "../../../generated/snapshot-rich.sql.gz";
import seedRowsGz from "../../../generated/seed-rows.json.gz";
import manifest from "../../../generated/manifest.json";
import type { SnapshotArtifacts, SnapshotManifest } from "./engine";

async function gunzipText(data: ArrayBuffer): Promise<string> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

let loaded: Promise<SnapshotArtifacts> | null = null;

export function snapshotArtifacts(): Promise<SnapshotArtifacts> {
  loaded ??= (async () => {
    const [snapshotSql, seedRowsText] = await Promise.all([gunzipText(snapshotGz), gunzipText(seedRowsGz)]);
    return { manifest: manifest as unknown as SnapshotManifest, snapshotSql, seedRows: JSON.parse(seedRowsText) as unknown };
  })().catch((e: unknown) => { loaded = null; throw e; });
  return loaded;
}

export const bundledSnapshotVersion = (): string => manifest.version;
