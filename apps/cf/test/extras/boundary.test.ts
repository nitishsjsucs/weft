// Design 3.2 and 6.4 for the extras: the queue consumers and HostedExtras never evaluate @weft/* (LobbyDO, SpendDO, the
// cron handler and the queue consumers stay small and fast to start), nothing on the worker side reaches node:fs,
// node:child_process or node:net, and @cloudflare/puppeteer loads only when a PDF is actually rendered. Checked on the
// esbuild module graph of apps/cf/src/extras/index.ts, following static imports only.
import { builtinModules } from "node:module";
import { join } from "node:path";
import { build, type Metafile } from "esbuild";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const WEFT_RUNTIME = /(^|\/)packages\/(agent|core|db|executor|grounding|integrations|payroll-tax|routines|seed|sim)\/|(^|\/)apps\/(api|mcp|web)\//;
const FORBIDDEN_NODE = /^(node:)?(fs|fs\/promises|child_process|net)$/;

async function graph(entry: string): Promise<Metafile> {
  const r = await build({
    absWorkingDir: ROOT, entryPoints: [entry], bundle: true, write: false, metafile: true, format: "esm", platform: "neutral",
    conditions: ["workerd", "worker", "browser", "import"], mainFields: ["module", "main"], external: ["cloudflare:*", "node:*", ...builtinModules], logLevel: "silent", target: "es2024",
  });
  return r.metafile;
}

/** Inputs reachable from the entry through static imports, and the external specifiers they import statically. */
function staticReach(meta: Metafile, entry: string): { inputs: Set<string>; externals: Set<string>; dynamic: Set<string> } {
  const inputs = new Set<string>(), externals = new Set<string>(), dynamic = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const cur = stack.pop()!;
    if (inputs.has(cur)) continue;
    inputs.add(cur);
    for (const imp of meta.inputs[cur]?.imports ?? []) {
      if (imp.kind === "dynamic-import") { dynamic.add(imp.path); continue; }
      if (imp.external) externals.add(imp.path);
      else stack.push(imp.path);
    }
  }
  return { inputs, externals, dynamic };
}

describe("extras module boundary", () => {
  it("the worker side imports no Weft runtime module and no node:fs, node:child_process or node:net", async () => {
    const entry = "apps/cf/src/extras/index.ts";
    const { inputs, externals, dynamic } = staticReach(await graph(entry), entry);
    const weft = [...inputs].filter((p) => WEFT_RUNTIME.test(p));
    expect(weft).toEqual([]);
    expect([...externals].filter((s) => FORBIDDEN_NODE.test(s))).toEqual([]);
    expect([...inputs].some((p) => p.includes("packages/cf-extras/src/"))).toBe(true);
    // Contracts arrive only through their ext files and type-free helpers, never the zod schemas of the root index.
    expect([...inputs].filter((p) => /packages\/contracts\/src\/(?!ext\/)/.test(p))).toEqual([]);
    expect([...externals]).toContain("cloudflare:workers");
    // Puppeteer is reached only through a dynamic import.
    expect([...inputs].some((p) => p.includes("@cloudflare/puppeteer"))).toBe(false);
    expect([...dynamic].some((p) => p.includes("puppeteer"))).toBe(true);
  }, 60_000);

  it("the Durable Object side is where the Weft modules are, as CompanyDO loads them", async () => {
    const entry = "apps/cf/src/extras/slot/index.ts";
    const { inputs } = staticReach(await graph(entry), entry);
    expect([...inputs].some((p) => p.includes("packages/core/src/"))).toBe(true);
  }, 60_000);
});
