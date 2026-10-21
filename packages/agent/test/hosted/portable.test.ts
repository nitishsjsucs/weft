// The Worker entry (portable.ts; docs/cloudflare/design.md 3.2 and 6.4): a Worker bundle resolves @weft/agent through
// the package's `workerd` condition to an entry with the same export names as Node's, from which no module imports
// node:fs, node:os, node:child_process or node:net. Its secrets come from the environment only and its scripts from
// the bundled fixtures. apps/mcp's index (what CompanyDO loads for /mcp) is node-free too.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FixtureSource } from "../../../contracts/src/ext/cf-platform";
import * as node from "../../src/index";
import * as portable from "../../src/portable";

const pkgRoot = join(import.meta.dirname, "..", "..");
const repoRoot = join(pkgRoot, "..", "..");
const FORBIDDEN = /^(node:)?(fs|fs\/promises|os|child_process|net)$/;

/** Every module reachable from `entry` through relative imports, with every specifier each one names. */
function graph(entry: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const visit = (file: string) => {
    if (out.has(file)) return;
    const src = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
    const specs = [...src.matchAll(/(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|(?:^|[;\s])import\s*["']([^"']+)["']/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? "");
    out.set(file, specs);
    for (const s of specs) {
      if (!s.startsWith(".")) continue;
      const base = resolve(dirname(file), s);
      const hit = [`${base}.ts`, join(base, "index.ts"), base].find((p) => existsSync(p) && p.endsWith(".ts"));
      if (hit) visit(hit);
    }
  };
  visit(entry);
  return out;
}
const forbiddenIn = (entry: string) => [...graph(entry)].flatMap(([f, specs]) => specs.filter((s) => FORBIDDEN.test(s)).map((s) => `${f.slice(repoRoot.length + 1)} -> ${s}`));

afterEach(() => { portable.setScriptSource(null); });

describe("the Worker entry of @weft/agent", () => {
  it("acceptance: no module reachable from it imports node:fs, node:os, node:child_process or node:net", () => {
    expect(forbiddenIn(join(pkgRoot, "src", "portable.ts"))).toEqual([]);
    expect(graph(join(pkgRoot, "src", "portable.ts")).size).toBeGreaterThan(20);
    // The Node entry does reach them (the JSONL ledger, the secrets file, scenarios/): the scan sees real imports.
    expect(forbiddenIn(join(pkgRoot, "src", "index.ts")).length).toBeGreaterThan(0);
  });

  it("a Worker bundle resolves it: the workerd and worker conditions name portable.ts, everything else index.ts", () => {
    const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as { exports: Record<string, unknown> };
    expect(pkg.exports["."]).toEqual({ workerd: "./src/portable.ts", worker: "./src/portable.ts", default: "./src/index.ts" });
    expect(pkg.exports["./portable"]).toBe("./src/portable.ts");
  });

  it("has exactly the Node entry's export names", () => {
    expect(Object.keys(portable).sort()).toEqual(Object.keys(node).sort());
  });

  it("reads secrets from the environment only: a secrets file is never consulted", () => {
    const env = { VITEST: "true", WEFT_LIVE_OPENAI: "1", WEFT_LLM: "openai", WEFT_SECRETS_FILE: join(repoRoot, "package.json") };
    expect(portable.loadSecret("OPENAI_API_KEY", { WEFT_SECRETS_FILE: "/nowhere" })).toBeNull();
    expect(portable.loadSecret("OPENAI_API_KEY", { OPENAI_API_KEY: " sk-test-not-real " })).toBe("sk-test-not-real");
    expect(() => portable.createProvider({ env, ledger: null as never, testMode: true })).toThrow(/PROVIDER_CONFIG: OPENAI_API_KEY is not set in the environment \(Worker secrets only/);
    expect(portable.createProvider({ env: { ...env, OPENAI_API_KEY: "sk-test-not-real" }, ledger: null as never, testMode: true })).toMatchObject({ id: "openai", live: true });
    // The guard still applies.
    expect(() => portable.createProvider({ env: { VITEST: "true", WEFT_LLM: "workers_ai" }, ledger: null as never, testMode: true })).toThrow(/LIVE_PROVIDER_IN_TEST/);
  });

  it("scripts come from the registered fixtures (or a passed source); without one it says what to pass", async () => {
    expect(() => portable.scriptedProvider({})).toThrow(/no script source; pass scriptSource or call setScriptSource/);
    expect(() => portable.createProvider({ env: {}, ledger: null as never, testMode: true })).toThrow(/no script source/);
    const files: Record<string, string> = {
      "scenarios/chat_hello.json": JSON.stringify({ match: "hello", agents: { main: [{ output: [{ type: "text", text: "Hi from the bundle." }] }] } }),
      "scenarios/notes.txt": "not a script",
    };
    const fixtures: Pick<FixtureSource, "text" | "list"> = {
      text: (p) => files[p] ?? null,
      list: (dir) => Object.keys(files).filter((p) => p.startsWith(`${dir}/`)).sort(),
    };
    const source = portable.fixtureScriptSource(fixtures);
    expect(source.names()).toEqual(["chat_hello"]);
    expect(source.get("../etc/passwd")).toBeNull();
    portable.setScriptSource(source);
    const p = portable.createProvider({ env: {}, ledger: null as never, testMode: true });
    const r = await p.step({ runId: "run_1", agentKind: "main", model: "scripted", frozenPrompt: "F", tools: [], toolChoice: { mode: "auto" }, history: [{ kind: "context", text: "<context n=\"x\">\n<request>hello</request>\n</context>" }], effort: "low", maxOutputTokens: 8000, cacheKey: "weft:main:chat:c" });
    expect(r.text).toBe("Hi from the bundle.");
  });

  it("the Node-only parts say so instead of touching a file", () => {
    expect(() => portable.createSpendLedger({ dir: "/tmp/x" })).toThrow(/createSpendLedger \(the JSONL spend ledger\) is Node only/);
    expect(() => portable.dirScriptSource("/tmp")).toThrow(/is Node only/);
    expect(portable.DEFAULT_SCRIPTS_DIR).toBe("scenarios");
  });
});

describe("apps/mcp's index", () => {
  it("acceptance: reaches no node: module, so the slot Durable Object can load the remote handler", () => {
    const entry = join(repoRoot, "apps", "mcp", "src", "index.ts");
    const all = [...graph(entry)].flatMap(([f, specs]) => specs.filter((s) => s.startsWith("node:") || FORBIDDEN.test(s)).map((s) => `${f.slice(repoRoot.length + 1)} -> ${s}`));
    expect(all).toEqual([]);
    expect([...graph(entry).keys()].map((f) => f.slice(repoRoot.length + 1)).sort()).toEqual(["apps/mcp/src/index.ts", "apps/mcp/src/remote.ts", "apps/mcp/src/server.ts", "packages/contracts/src/ext/cf-agent.ts", "packages/contracts/src/provider.ts", "packages/contracts/src/spend.ts"]);
  });
});
