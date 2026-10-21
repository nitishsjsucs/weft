// FixtureSource (docs/cloudflare/design.md 4.1): bundled fixture files by repo-relative path with "/" separators,
// for example packages/sim/fixtures/notices/<name>.txt. Node reads the repo; the durable platform reads the generated
// module apps/cf/generated/fixtures.ts, which cf4-worker builds from the same paths (FIXTURE_PATHS lists every file
// and directory the durable path reads, so the generator and the tests agree on what must be bundled).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FixtureSource } from "../../../../packages/contracts/src/ext/cf-platform";

/** What the durable path reads through the FixtureSource: the migrations, the notice scenarios and the mailed samples. */
export const FIXTURE_PATHS = {
  migrations: "packages/db/drizzle",
  journal: "packages/db/drizzle/meta/_journal.json",
  noticeScenarios: "packages/sim/fixtures/notices",
  mailedNotices: "packages/sim/src/notices/mailed",
} as const;

export const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");

const norm = (p: string) => p.replace(/^\.?\/+/, "").replace(/\/+$/, "");
const SAFE = (p: string) => !p.split("/").some((s) => s === ".." || s === "") && !p.includes("\\") && !p.includes("\0");

/** Node: the repository files themselves. */
export function repoFixtures(root: string = REPO_ROOT): FixtureSource {
  const abs = (p: string) => { const n = norm(p); if (!SAFE(n)) throw new Error(`bad fixture path ${JSON.stringify(p).slice(0, 60)}`); return join(root, n); };
  return {
    text(path) { try { return readFileSync(abs(path), "utf8"); } catch { return null; } },
    bytes(path) { try { return new Uint8Array(readFileSync(abs(path))); } catch { return null; } },
    list(dir) {
      const d = norm(dir);
      try {
        return readdirSync(abs(d)).filter((f) => !f.startsWith(".") && statSync(join(abs(d), f)).isFile()).sort().map((f) => `${d}/${f}`);
      } catch { return []; }
    },
  };
}

/** A FixtureSource over an in-memory map of path to text or bytes (the generated module's shape, and tests). */
export function mapFixtures(files: Readonly<Record<string, string | Uint8Array>>): FixtureSource {
  const m = new Map<string, string | Uint8Array>(Object.entries(files).map(([k, v]) => [norm(k), v]));
  const enc = new TextEncoder(), dec = new TextDecoder();
  return {
    text(path) { const v = m.get(norm(path)); return v === undefined ? null : typeof v === "string" ? v : dec.decode(v); },
    bytes(path) { const v = m.get(norm(path)); return v === undefined ? null : typeof v === "string" ? enc.encode(v) : v; },
    list(dir) {
      const d = `${norm(dir)}/`;
      return [...m.keys()].filter((k) => k.startsWith(d) && !k.slice(d.length).includes("/")).sort();
    },
  };
}

/** Reads every file under FIXTURE_PATHS from the repo into a map (what the generated module holds; tests use it). */
export function bundleFixtures(root: string = REPO_ROOT): Record<string, string> {
  const src = repoFixtures(root);
  const out: Record<string, string> = {};
  for (const dir of [FIXTURE_PATHS.migrations, `${FIXTURE_PATHS.migrations}/meta`, FIXTURE_PATHS.noticeScenarios, FIXTURE_PATHS.mailedNotices]) {
    for (const f of src.list(dir)) out[f] = src.text(f)!;
  }
  return out;
}
