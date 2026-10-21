// The durable import path stays free of Node-only built-ins (docs/cloudflare/design.md 6.4: an import scan fails if
// node:fs, node:child_process or node:net is reachable from the weft-core entry). @weft/db is imported by every
// package, so its static graph, and the memory store's, reach none of them (nor node:sqlite, which workerd lacks);
// Node-only code gets them through process.getBuiltinModule when it runs. Owner: cf1-db.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const FORBIDDEN = ["node:fs", "node:fs/promises", "node:child_process", "node:net", "node:sqlite", "fs", "child_process", "net"];
const specifiers = (src: string) => [...src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").matchAll(/^\s*(?:import|export)\s+(?!type\b)[^'"]*?from\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/gm)].map((m) => m[1] ?? m[2] ?? "");

/** Every module reachable through static, non-type imports from `entry`, following relative paths only. */
function reachable(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    const src = readFileSync(file, "utf8");
    const specs = specifiers(src);
    seen.set(file, specs);
    for (const s of specs) {
      if (!s.startsWith(".")) continue;
      const base = resolve(dirname(file), s);
      const candidates = [`${base}.ts`, join(base, "index.ts"), base];
      const hit = candidates.find((c) => { try { readFileSync(c); return c.endsWith(".ts"); } catch { return false; } });
      if (hit) visit(hit);
    }
  };
  visit(entry);
  return seen;
}

describe("the durable import path", () => {
  for (const entry of ["../src/index.ts", "../../executor/src/memory/store.ts", "../../executor/src/memory/repo-sql.ts"]) {
    it(`${entry} reaches no Node-only built-in statically`, () => {
      const graph = reachable(resolve(import.meta.dirname, entry));
      const bad = [...graph].flatMap(([file, specs]) => specs.filter((s) => FORBIDDEN.includes(s)).map((s) => `${file.split("/packages/")[1]} -> ${s}`));
      expect(bad).toEqual([]);
      expect(graph.size).toBeGreaterThan(1);
    });
  }
});
