// Scaffold (frozen): the three import-scan rules (SPEC 2, harness 2 and 6.1). tests/ and apps/api/src/compose.ts are exempt.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
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
const BRAIN_BANNED = [/^@weft\/core(\/|$)/, /^@weft\/sim(\/|$)/, /^@weft\/payroll-tax(\/|$)/, /^@weft\/seed(\/|$)/, /^@weft\/executor\/src\/(vault|memory|sandbox|taint|runs)/, /(^|\/)packages\/(core|sim|payroll-tax|seed)\//, /(^|\/)executor\/src\/(vault|memory|sandbox|taint|runs)/];
/** Run-store tables the brain may touch through @weft/db; any other table import is a domain table. */
const RUN_STORE = new Set(["agentRuns", "runSteps", "routineRuns", "routines", "openDb", "closeDb", "withWriteLock", "ready", "migrate", "Db", "DbTx", "Schema", "type"]);

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
      const src = stripComments(readFileSync(f, "utf8"));
      for (const id of ["decide", "rollback", "HumanExecutor", "RunAuthority"]) if (new RegExp(`\\b${id}\\b`).test(src)) bad.push(`${relative(root, f)}: ${id}`);
    }
    expect(bad).toEqual([]);
  });

  it("openai is imported only by packages/agent/src/providers/openai.ts", () => {
    const all = ["apps", "packages"].flatMap((d) => files(join(root, d)));
    const bad = all.filter((f) => !f.endsWith(join("packages/agent/src/providers/openai.ts")) && specifiers(readFileSync(f, "utf8")).some((s) => /^openai(\/|$)/.test(s)));
    expect(bad.map((f) => relative(root, f))).toEqual([]);
  });
});
