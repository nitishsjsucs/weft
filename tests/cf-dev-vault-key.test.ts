// pnpm cf:dev's vault key (scripts/cf/lib/vault-key.ts; docs/cloudflare/design.md 9.2 and 11.5): a restored world reads
// its vault with the key the snapshot was sealed with, so a local run takes the local key pnpm cf:snapshot wrote when
// the manifest's fingerprint is that key's, and refuses a deploy-sealed snapshot or a stale local one. No real key is
// used: each case writes its own throwaway key file.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { devVaultKey, LOCAL_FINGERPRINT_PREFIX, snapshotVaultKey, vaultFingerprint } from "../scripts/cf/lib/vault-key";

const dir = mkdtempSync(join(tmpdir(), "weft-cf-dev-vault-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const KEY = "ab".repeat(32);
const keyFile = join(dir, "local-vault-key");
writeFileSync(keyFile, `${KEY}\n`, { mode: 0o600 });
const local = LOCAL_FINGERPRINT_PREFIX + vaultFingerprint(KEY);

describe("cf:dev's vault key", () => {
  it("takes the local key when the manifest's fingerprint is local and matches it", () => {
    expect(devVaultKey(local, keyFile)).toEqual({ ok: true, key: KEY });
    const manifest = join(dir, "manifest.json");
    writeFileSync(manifest, JSON.stringify({ digest: "d", extra: { vaultKeyFingerprint: local } }));
    expect(snapshotVaultKey(manifest, keyFile)).toBe(KEY);
  });

  it("refuses a deploy-sealed snapshot, a stale or missing local key and a manifest without a fingerprint, never naming the key", () => {
    const cases: [string | null, string, RegExp][] = [
      [vaultFingerprint(KEY), keyFile, /sealed with the deploy vault key/],
      [LOCAL_FINGERPRINT_PREFIX + vaultFingerprint("cd".repeat(32)), keyFile, /sealed with a different local key/],
      [local, join(dir, "missing"), /is missing/],
      [null, keyFile, /records no vault key fingerprint/],
    ];
    for (const [fp, file, why] of cases) {
      const r = devVaultKey(fp, file);
      expect(r.ok, String(fp)).toBe(false);
      const problem = (r as { problem: string }).problem;
      expect(problem).toMatch(why);
      expect(problem).not.toContain(KEY);
    }
    const bad = join(dir, "bad-key");
    writeFileSync(bad, "not-a-key\n");
    expect(devVaultKey(local, bad)).toMatchObject({ ok: false, problem: expect.stringMatching(/does not hold a 64-hex key/) });
    const deploy = join(dir, "deploy-manifest.json");
    writeFileSync(deploy, JSON.stringify({ extra: { vaultKeyFingerprint: vaultFingerprint(KEY) } }));
    expect(() => snapshotVaultKey(deploy, keyFile)).toThrow(/a local run never loads/);
  });
});
