// The fs guard (docs/cloudflare/design.md 6.4, track cf2-platform): while active, every call of a node:fs,
// node:fs/promises, node:child_process or node:net function is recorded with its stack and attributed to the repo
// source file that made it, by track ownership (docs/cloudflare/tracks.md). The durable path runs in a Worker, where
// the data dir, the repo files and git do not exist, so any call from Weft code on that path is a defect. Module
// loading (node:internal/modules frames) and calls with no Weft frame (the test runner itself) are kept apart.
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { relative, resolve, sep } from "node:path";

export const REPO = resolve(import.meta.dirname, "..", "..", "..", "..");

export type Owner = "cf1-db" | "cf2-platform" | "cf3-agent" | "cf6-extras" | "frozen" | "test" | "other";
export interface GuardedCall { module: string; fn: string; arg: string; owner: Owner; file: string | null; stack: string }

/** Who owns a repo-relative source path (tracks.md owned paths; frozen means a cf0 contract path nobody may change). */
export function ownerOf(path: string): Owner {
  if (/(^|\/)test\//.test(path) || /\.test\.ts$/.test(path)) return "test";
  if (path.startsWith("packages/db/")) return "cf1-db";
  if (path.startsWith("packages/executor/src/memory/")) return "cf1-db";
  if (path.startsWith("packages/agent/") || path.startsWith("apps/mcp/")) return "cf3-agent";
  if (path.startsWith("apps/api/src/memory/") || path.startsWith("packages/cf-extras/")) return "cf6-extras";
  if (path === "apps/api/src/compose.ts" || path === "packages/seed/src/index.ts" || path === "packages/seed/src/cli.ts" || path === "packages/seed/src/digest.ts") return "frozen";
  if (path.startsWith("apps/api/src/") || path.startsWith("packages/executor/src/") || path.startsWith("packages/routines/") || path.startsWith("packages/sim/src/notices/")
    || path === "packages/core/src/commands/time-off.ts" || path === "packages/integrations/src/secrets.ts" || path.startsWith("packages/seed/")) return "cf2-platform";
  return "other";
}

const MODULES: Record<string, Record<string, unknown>> = {
  "node:fs": fs as unknown as Record<string, unknown>,
  "node:fs/promises": fs.promises as unknown as Record<string, unknown>,
  "node:child_process": childProcess as unknown as Record<string, unknown>,
  "node:net": net as unknown as Record<string, unknown>,
};
const SKIP = new Set(["constants", "promises"]);

function attribute(stack: string): { owner: Owner; file: string | null } | "loader" | null {
  if (stack.includes("node:internal/modules")) return "loader";
  for (const line of stack.split("\n").slice(1)) {
    const m = /\(?((?:file:\/\/)?\/[^():]+\.(?:ts|js|mjs|cjs)):\d+:\d+\)?\s*$/.exec(line);
    if (!m) continue;
    const abs = m[1]!.replace(/^file:\/\//, "");
    if (!abs.startsWith(REPO + sep) || abs.includes(`${sep}node_modules${sep}`)) continue;
    const rel = relative(REPO, abs).split(sep).join("/");
    if (rel === "apps/api/test/support/fs-guard.ts") continue;
    return { owner: ownerOf(rel), file: rel };
  }
  return null;
}

export interface FsGuard {
  /** Weft calls made while the guard was on (module loading and runner calls excluded). */
  readonly calls: GuardedCall[];
  /** Calls with no Weft frame (the test runner) and module loads, kept for the record. */
  readonly ignored: number;
  byOwner(owner: Owner): GuardedCall[];
  restore(): void;
}

export function installFsGuard(): FsGuard {
  const calls: GuardedCall[] = [];
  let ignored = 0;
  const originals: [Record<string, unknown>, string, unknown][] = [];
  const prevLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = 80;
  for (const [name, mod] of Object.entries(MODULES)) {
    for (const key of Object.keys(mod)) {
      const f = mod[key];
      if (typeof f !== "function" || SKIP.has(key) || /^[A-Z]/.test(key)) continue;
      originals.push([mod, key, f]);
      const wrapped = function (this: unknown, ...args: unknown[]) {
        const stack = new Error("fs guard").stack ?? "";
        const who = attribute(stack);
        if (who === null || who === "loader") ignored++;
        else calls.push({ module: name, fn: key, arg: typeof args[0] === "string" ? args[0] : String(args[0]).slice(0, 120), owner: who.owner, file: who.file, stack });
        return (f as (...a: unknown[]) => unknown).apply(this, args);
      };
      Object.defineProperty(wrapped, "name", { value: key });
      try { mod[key] = wrapped; } catch { /* read-only export */ }
    }
  }
  syncBuiltinESMExports();
  return {
    calls,
    get ignored() { return ignored; },
    byOwner: (owner) => calls.filter((c) => c.owner === owner),
    restore() {
      for (const [mod, key, f] of originals) { try { mod[key] = f; } catch { /* read-only */ } }
      syncBuiltinESMExports();
      Error.stackTraceLimit = prevLimit;
    },
  };
}

/** One line per call site, for an assertion message. */
export const describeCalls = (calls: GuardedCall[]): string[] => [...new Set(calls.map((c) => `${c.owner} ${c.file} ${c.module}.${c.fn}`))].sort();
