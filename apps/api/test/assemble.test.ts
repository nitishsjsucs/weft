// The compose split (docs/cloudflare/tracks.md cf0-contracts): createWeft(opts) is assembleWeft(nodePlatform, opts)
// with the same signature. A durable platform without its secrets fails closed before opening anything (cf2-platform;
// the full durable platform is apps/api/test/hosted-platform.test.ts).
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { digestDb } from "@weft/seed";
import { createWeft } from "../src/compose";
import { assembleWeft, nodePlatform } from "../src/assemble";

const dirs: string[] = [];
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), "weft-assemble-")); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe("assembleWeft", () => {
  it("runs on a Node platform with no parts, so every part is today's code", () => {
    expect(nodePlatform).toEqual({ kind: "node" });
  });

  it("builds the same world as createWeft", async () => {
    const a = await createWeft({ dataDir: tempDir(), testMode: true });
    const b = await assembleWeft(nodePlatform, { dataDir: tempDir(), testMode: true });
    try {
      const health = async (w: typeof a) => {
        const { version: _v, ...rest } = (await (await w.app.request("/v1/health")).json()) as Record<string, unknown>;
        return rest;
      };
      expect(await health(b)).toEqual(await health(a));
      expect(b.stubs).toEqual(a.stubs);
      expect(await digestDb(b.db)).toBe(await digestDb(a.db));
    } finally { await a.close(); await b.close(); }
  });

  it("refuses a durable platform without WEFT_VAULT_KEY before opening anything", async () => {
    const dir = tempDir();
    await expect(assembleWeft({ kind: "durable", env: {} }, { dataDir: dir, testMode: true })).rejects.toThrow(/WEFT_VAULT_KEY/);
    expect(existsSync(join(dir, "weft.db"))).toBe(false);
  });
});
