// FixtureSource (docs/cloudflare/design.md 4.1): bundled fixture files by repo-relative path with "/" separators,
// for example packages/sim/fixtures/notices/<name>.txt. Node reads the repo; the durable platform reads the generated
// module apps/cf/generated/fixtures.ts, which cf4-worker builds from the same paths (FIXTURE_PATHS lists every file
// and directory the durable path reads, so the generator and the tests agree on what must be bundled).
import { join, resolve } from "node:path";
import type { FixtureSource } from "../../../../packages/contracts/src/ext/cf-platform";

/** node:fs on first use, never a static import: this module is on the hosted import graph (docs/cloudflare/design.md
 * 6.4), where only Node's code paths call it. */
const fs = () => process.getBuiltinModule("node:fs");

/** What the durable path reads through the FixtureSource: the migrations, the notice scenarios, the mailed samples and
 * the scripted provider's scenarios (scenarios/<name>.json, read through cf3-agent's fixtureScriptSource). */
export const FIXTURE_PATHS = {
  migrations: "packages/db/drizzle",
  journal: "packages/db/drizzle/meta/_journal.json",
  noticeScenarios: "packages/sim/fixtures/notices",
  mailedNotices: "packages/sim/src/notices/mailed",
  scripts: "scenarios",
} as const;

/**
 * The repo root on Node, computed when first asked, never at module evaluation: in workerd (the hosted entry imports
 * this module through assemble.ts) import.meta.dirname is undefined and import.meta.url is null, and only Node reads
 * the repo.
 */
let root: string | null = null;
export function repoRoot(): string {
  if (root === null) {
    const dir = (import.meta as { dirname?: string }).dirname;
    if (typeof dir !== "string") throw new Error("the repo fixtures are read on Node only; the durable platform passes its bundled FixtureSource");
    root = resolve(dir, "..", "..", "..", "..");
  }
  return root;
}

const norm = (p: string) => p.replace(/^\.?\/+/, "").replace(/\/+$/, "");
const SAFE = (p: string) => !p.split("/").some((s) => s === ".." || s === "") && !p.includes("\\") && !p.includes("\0");

/** Node: the repository files themselves. */
export function repoFixtures(at?: string): FixtureSource {
  let base: string | null = at ?? null;
  const abs = (p: string) => { const n = norm(p); if (!SAFE(n)) throw new Error(`bad fixture path ${JSON.stringify(p).slice(0, 60)}`); return join((base ??= repoRoot()), n); };
  return {
    text(path) { try { return fs().readFileSync(abs(path), "utf8"); } catch { return null; } },
    bytes(path) { try { return new Uint8Array(fs().readFileSync(abs(path))); } catch { return null; } },
    list(dir) {
      const d = norm(dir);
      try {
        return fs().readdirSync(abs(d)).filter((f) => !f.startsWith(".") && fs().statSync(join(abs(d), f)).isFile()).sort().map((f) => `${d}/${f}`);
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
export function bundleFixtures(at?: string): Record<string, string> {
  const src = repoFixtures(at);
  const out: Record<string, string> = {};
  for (const dir of [FIXTURE_PATHS.migrations, `${FIXTURE_PATHS.migrations}/meta`, FIXTURE_PATHS.noticeScenarios, FIXTURE_PATHS.mailedNotices, FIXTURE_PATHS.scripts]) {
    for (const f of src.list(dir)) out[f] = src.text(f)!;
  }
  return out;
}
