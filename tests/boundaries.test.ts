// Scaffold (frozen): the three import-scan rules (SPEC 2, harness 2 and 6.1). tests/ and the composition root
// (apps/api/src/compose.ts and assemble.ts) are exempt. Weft on Cloudflare (docs/cloudflare/tracks.md cf0-contracts)
// adds the Cloudflare rule and the no-agents-package rule at the end.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
function files(dir: string): string[] {
  const out: string[] = [];
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (e === "node_modules" || e === ".next" || e === "dist") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(ts|tsx|mts|cts|js|mjs)$/.test(e)) out.push(p);
  }
  return out;
}
const specifiers = (src: string) => [...src.matchAll(/(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? "");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const brain = ["packages/agent", "packages/routines"].flatMap((d) => files(join(root, d)));
const hands = ["packages/executor", "packages/core", "packages/sim", "packages/payroll-tax"].flatMap((d) => files(join(root, d)));

/** Rule 1 bans: domain packages, executor internals, drizzle domain tables. */
const BRAIN_BANNED = [/^@weft\/integrations(\/|$)/, /(^|\/)packages\/integrations\//, /^@weft\/core(\/|$)/, /^@weft\/sim(\/|$)/, /^@weft\/payroll-tax(\/|$)/, /^@weft\/seed(\/|$)/, /^@weft\/executor\/src\/(vault|memory|sandbox|taint|runs)/, /(^|\/)packages\/(core|sim|payroll-tax|seed)\//, /(^|\/)executor\/src\/(vault|memory|sandbox|taint|runs)/];
/** Run-store tables the brain may touch through @weft/db; any other table import is a domain table. routineWaits: wave 4, the engine's wait-and-resume rows (docs/wave4.md). */
const RUN_STORE = new Set(["agentRuns", "runSteps", "routineRuns", "routines", "routineWaits", "openDb", "closeDb", "withWriteLock", "ready", "migrate", "Db", "DbTx", "Schema", "type"]);

describe("import boundaries", () => {
  it("scans real files", () => {
    expect(brain.length).toBeGreaterThan(0);
    expect(hands.length).toBeGreaterThan(0);
  });

  it("rule 1: packages/agent and packages/routines import no domain or executor internals", () => {
    const bad: string[] = [];
    for (const f of brain) {
      const src = readFileSync(f, "utf8");
      for (const s of specifiers(src)) if (BRAIN_BANNED.some((re) => re.test(s))) bad.push(`${relative(root, f)} -> ${s}`);
      for (const m of src.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']@weft\/db["']/g)) {
        for (const name of m[1]!.split(",").map((x) => x.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!).filter(Boolean)) {
          if (!RUN_STORE.has(name)) bad.push(`${relative(root, f)} -> @weft/db ${name}`);
        }
      }
      if (/from\s+["']@weft\/db\/src\/schema/.test(src) || /import\s+\*\s+as\s+\w+\s+from\s+["']@weft\/db["']/.test(src)) bad.push(`${relative(root, f)} -> whole @weft/db schema`);
    }
    expect(bad).toEqual([]);
  });

  it("rule 2: executor, core, sim and payroll-tax never import providers, openai or @anthropic-ai/sdk", () => {
    const bad: string[] = [];
    for (const f of hands) {
      for (const s of specifiers(readFileSync(f, "utf8"))) {
        if (/^openai(\/|$)/.test(s) || /^@anthropic-ai\/sdk/.test(s) || /agent\/src\/providers/.test(s) || /^@weft\/agent(\/|$)/.test(s)) bad.push(`${relative(root, f)} -> ${s}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("rule 3: decide, rollback, HumanExecutor and RunAuthority do not appear in the brain", () => {
    const bad: string[] = [];
    for (const f of brain) {
      // Registry command names in string literals ("expenses.decide", a tool a routine may call, which the executor
      // always turns into a proposal) are not the approval API; a call such as executor.decide(...) still fails.
      const src = stripComments(readFileSync(f, "utf8")).replace(/"[a-z_]+\.decide"/g, '""');
      for (const id of ["decide", "rollback", "HumanExecutor", "RunAuthority"]) if (new RegExp(`\\b${id}\\b`).test(src)) bad.push(`${relative(root, f)}: ${id}`);
    }
    expect(bad).toEqual([]);
  });

  it("openai is imported only by packages/agent/src/providers/openai.ts", () => {
    const all = ["apps", "packages"].flatMap((d) => files(join(root, d)));
    const bad = all.filter((f) => !f.endsWith(join("packages/agent/src/providers/openai.ts")) && specifiers(readFileSync(f, "utf8")).some((s) => /^openai(\/|$)/.test(s)));
    expect(bad.map((f) => relative(root, f))).toEqual([]);
  });

  it("only apps/cf and packages/cf-extras import cloudflare:*, @cloudflare/*, miniflare or wrangler", () => {
    const bad: string[] = [];
    for (const f of ["apps", "packages"].flatMap((d) => files(join(root, d)))) {
      const rel = posix(f);
      if (CF_ALLOWED.some((p) => rel.startsWith(p))) continue;
      for (const s of allSpecifiers(readFileSync(f, "utf8"))) if (CF_SPECIFIER.test(s)) bad.push(`${rel} -> ${s}`);
    }
    // Global types count too: a tsconfig outside the allowed folders may not load the Workers types.
    for (const f of tsconfigs()) {
      const rel = posix(f);
      if (!CF_ALLOWED.some((p) => rel.startsWith(p)) && /@cloudflare\//.test(readFileSync(f, "utf8"))) bad.push(`${rel} names @cloudflare/`);
    }
    expect(bad).toEqual([]);
  });

  it("the Cloudflare rule sees every import form", () => {
    const src = 'import { DurableObject } from "cloudflare:workers";\nimport "miniflare";\nexport * from "wrangler";\n/// <reference types="@cloudflare/workers-types" />\nconst m = await import("@cloudflare/puppeteer");';
    expect(allSpecifiers(src).filter((s) => CF_SPECIFIER.test(s)).sort()).toEqual(["@cloudflare/puppeteer", "@cloudflare/workers-types", "cloudflare:workers", "miniflare", "wrangler"]);
    expect(allSpecifiers('import { x } from "./cloudflare-like"; import y from "@weft/cf-extras";').filter((s) => CF_SPECIFIER.test(s))).toEqual([]);
  });

  it("no workspace package depends on or imports the agents package", () => {
    const manifests = [join(root, "package.json"), join(root, "tests", "package.json"),
      ...["apps", "packages"].flatMap((d) => readdirSync(join(root, d)).map((p) => join(root, d, p, "package.json")))].filter((f) => existsSync(f));
    const bad: string[] = [];
    for (const f of manifests) {
      const pkg = JSON.parse(readFileSync(f, "utf8")) as Record<string, Record<string, string> | undefined>;
      for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) if (pkg[field]?.agents) bad.push(`${posix(f)} ${field}`);
    }
    for (const f of ["apps", "packages"].flatMap((d) => files(join(root, d)))) {
      for (const s of allSpecifiers(readFileSync(f, "utf8"))) if (/^agents(\/|$)/.test(s)) bad.push(`${posix(f)} -> ${s}`);
    }
    expect(manifests.length).toBeGreaterThan(10);
    expect(bad).toEqual([]);
  });
});

/** Cloudflare runtime and tooling specifiers (design 3.2): Node code paths never load them. */
const CF_SPECIFIER = /^cloudflare:|^@cloudflare\/|^miniflare(\/|$)|^wrangler(\/|$)/;
/** Where they may appear: the Worker app, the extras package, and the db package's Miniflare conformance suite
 * (design 11.3). Root tooling (scripts/cf, e2e/cf, playwright.cf.config.ts) is outside apps/ and packages/. */
const CF_ALLOWED = ["apps/cf/", "packages/cf-extras/", "packages/db/test-workerd/"];
const posix = (f: string) => relative(root, f).split(sep).join("/");
/** The scaffold's specifiers plus side-effect imports and triple-slash type references. */
function allSpecifiers(src: string): string[] {
  const bare = [...src.matchAll(/(?:^|[;\s])import\s*["']([^"']+)["']/g)].map((m) => m[1]!);
  const refs = [...src.matchAll(/\/\/\/\s*<reference\s+(?:types|path)\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]!);
  return [...specifiers(src), ...bare, ...refs];
}
function tsconfigs(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (e === "node_modules" || e === ".next" || e === "dist") continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/^tsconfig.*\.json$/.test(e)) out.push(p);
    }
  };
  for (const d of ["apps", "packages"]) walk(join(root, d));
  return out;
}
