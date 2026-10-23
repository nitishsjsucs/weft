// The vault key a snapshot is sealed with (docs/cloudflare/design.md 4.1 and 9.2). pnpm cf:snapshot --deploy seals
// the world with the deploy WEFT_VAULT_KEY; without --deploy it uses a local key under .scratch/, and the manifest
// records which as the key's fingerprint ("local:fp_..." for the local key). A restored world reads its vault with
// the Worker's WEFT_VAULT_KEY, so pnpm cf:dev must run under the key the snapshot was sealed with. Nothing here prints
// a key; a problem names the file, never its contents.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { REPO_ROOT } from "./env-file";

export const LOCAL_VAULT_KEY_FILE = join(REPO_ROOT, ".scratch/cf-snapshot.local-vault-key");
export const LOCAL_FINGERPRINT_PREFIX = "local:";

/** The fingerprint the manifest records for the vault key (the vault's own formula, design 4.1). */
export const vaultFingerprint = (keyHex: string): string => "fp_" + createHash("sha256").update("weft-vault-fingerprint:" + keyHex).digest("hex").slice(0, 12);

export type DevVaultKey = { ok: true; key: string } | { ok: false; problem: string };

/**
 * The key a local run needs for a snapshot whose manifest records `fingerprint`: the local key file's key when the
 * fingerprint is local and matches it. A deploy-sealed snapshot is refused, since a local run never loads the deploy
 * key, and so is a local fingerprint the key file does not match (a snapshot sealed before the key file changed).
 */
export function devVaultKey(fingerprint: string | null | undefined, keyFile: string = LOCAL_VAULT_KEY_FILE): DevVaultKey {
  const file = relative(REPO_ROOT, keyFile) || keyFile;
  if (!fingerprint) return { ok: false, problem: "the snapshot manifest records no vault key fingerprint; run pnpm cf:snapshot again" };
  if (!fingerprint.startsWith(LOCAL_FINGERPRINT_PREFIX)) {
    return { ok: false, problem: "the snapshot in apps/cf/generated is sealed with the deploy vault key (pnpm cf:snapshot --deploy), which a local run never loads; run pnpm cf:snapshot without --deploy first" };
  }
  if (!existsSync(keyFile)) return { ok: false, problem: `the snapshot is sealed with the local key, but ${file} is missing; run pnpm cf:snapshot again` };
  const key = readFileSync(keyFile, "utf8").trim();
  if (!/^[0-9a-f]{64}$/i.test(key)) return { ok: false, problem: `${file} does not hold a 64-hex key; run pnpm cf:snapshot again` };
  if (LOCAL_FINGERPRINT_PREFIX + vaultFingerprint(key) !== fingerprint) {
    return { ok: false, problem: `the snapshot was sealed with a different local key than the one in ${file}; run pnpm cf:snapshot again` };
  }
  return { ok: true, key };
}

/**
 * The vault key of the snapshot in apps/cf/generated, which every restored world reads its vault with (pnpm cf:dev
 * with the real engine). Throws devVaultKey's problem instead of returning a key a world could not use.
 */
export function snapshotVaultKey(manifestFile: string = join(REPO_ROOT, "apps/cf/generated/manifest.json"), keyFile: string = LOCAL_VAULT_KEY_FILE): string {
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as { extra?: { vaultKeyFingerprint?: string | null } };
  const r = devVaultKey(manifest.extra?.vaultKeyFingerprint ?? null, keyFile);
  if (!r.ok) throw new Error(r.problem);
  return r.key;
}
