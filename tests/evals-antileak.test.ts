// The held-out test split (owner: w4-eval-heldout): every task validates and is covered by the manifest, the world
// mutators apply as written, and no test task's distinctive strings appear where fixers work (docs/wave4.md section 4,
// research/wave4/evals.md section 7). This file reads the test tasks at run time and never prints their content; a
// failure names the task id, the kind of token and the file, not the token itself.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { EvalGroup, EvalTask } from "../packages/contracts/src/evals";
import { parseNotice } from "../packages/sim/src/notices/parser";
import { buildTestManifest, manifestDrift, MANIFEST_PATH, testTaskFiles } from "../evals/suite/tasks/test/manifest";
import { memoryFiles, sqlSteps, TEST_MUTATOR_NAMES, TEST_MUTATORS } from "../evals/suite/tasks/test/worlds";

const ROOT = resolve(import.meta.dirname, "..");
const tasks = testTaskFiles(ROOT).map((rel) => EvalTask.parse(JSON.parse(readFileSync(join(ROOT, rel), "utf8"))));

// ---------- the scan ----------

interface LeakToken { taskId: string; kind: "literal" | "input" | "mutator"; text: string }
interface LeakHit { taskId: string; kind: LeakToken["kind"]; file: string }

const SHINGLE = 7;
const norm = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;

function inputText(t: EvalTask): string {
  const i = t.input as Record<string, unknown>;
  return String(i.chat ?? i.portal ?? i.mention ?? "");
}

/** Shingles of a task's input text: every run of SHINGLE words, or the whole text when it is shorter. */
function shingles(text: string): string[] {
  const words = norm(text).trim().split(" ").filter(Boolean);
  if (words.length <= SHINGLE) return words.length >= 4 ? [words.join(" ")] : [];
  const out: string[] = [];
  for (let i = 0; i + SHINGLE <= words.length; i++) out.push(words.slice(i, i + SHINGLE).join(" "));
  return out;
}

/** The reference note's fenced leak block: one distinctive literal per line. */
function leakLiterals(referencePath: string): string[] {
  const md = readFileSync(join(ROOT, referencePath), "utf8");
  const m = /```leak\n([\s\S]*?)```/.exec(md);
  return m ? m[1]!.split("\n").map((l) => l.trim()).filter(Boolean) : [];
}

function leakTokens(list: readonly EvalTask[]): LeakToken[] {
  const out: LeakToken[] = [];
  for (const t of list) {
    for (const text of leakLiterals(t.reference)) out.push({ taskId: t.id, kind: "literal", text });
    for (const text of t.world.mutators) out.push({ taskId: t.id, kind: "mutator", text });
    for (const text of shingles(inputText(t))) out.push({ taskId: t.id, kind: "input", text });
  }
  return out;
}

const SKIP_DIRS = new Set(["node_modules", ".next", "dist", ".turbo", "test-results", "playwright-report", ".data", ".data-e2e", ".data-demo", "screenshots", "reference"]);
const TEXT_EXT = /\.(ts|tsx|js|mjs|cjs|json|md|sql|txt|css|html|yaml|yml)$/;

function walk(dir: string, skip: (abs: string) => boolean, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    const abs = join(dir, name);
    if (skip(abs)) continue;
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) { if (!SKIP_DIRS.has(name)) walk(abs, skip, out); }
    else if (TEXT_EXT.test(name) && st.size < 2_000_000) out.push(abs);
  }
  return out;
}

/** Every file under `roots` (absolute) that contains a token: literals and mutator names as case-insensitive
 * substrings, input shingles on word-normalized text. */
function scanForLeaks(roots: readonly string[], tokens: readonly LeakToken[], skip: (abs: string) => boolean = () => false, base = ROOT): LeakHit[] {
  const hits: LeakHit[] = [];
  const literal = tokens.filter((t) => t.kind !== "input").map((t) => ({ ...t, needle: t.text.toLowerCase() }));
  const input = tokens.filter((t) => t.kind === "input").map((t) => ({ ...t, needle: ` ${t.text} ` }));
  for (const root of roots) {
    for (const file of walk(root, skip)) {
      const raw = readFileSync(file, "utf8");
      const lower = raw.toLowerCase();
      const words = norm(raw);
      const rel = relative(base, file);
      const seen = new Set<string>();
      for (const t of literal) if (lower.includes(t.needle) && !seen.has(`${t.taskId}:${t.kind}`)) { seen.add(`${t.taskId}:${t.kind}`); hits.push({ taskId: t.taskId, kind: t.kind, file: rel }); }
      for (const t of input) if (words.includes(t.needle) && !seen.has(`${t.taskId}:input`)) { seen.add(`${t.taskId}:input`); hits.push({ taskId: t.taskId, kind: "input", file: rel }); }
    }
  }
  return hits;
}

/** Where fixers work and read: product code, scripted scenarios, docs, research, and the eval suite outside the
 * held-out paths. The held-out paths themselves and this test are excluded. */
const FIXER_ROOTS = ["packages", "apps", "scenarios", "docs", "research", "evals", "e2e", "scripts"].map((d) => join(ROOT, d));
const HELD_OUT = [join(ROOT, "evals/suite/tasks/test"), join(ROOT, "evals/suite/reference/test"), join(ROOT, "evals/suite/judges"), join(ROOT, MANIFEST_PATH), join(ROOT, "docs/tracks/w4-eval-heldout.md"), join(ROOT, "evals/results")];
const skipHeldOut = (abs: string) => HELD_OUT.some((p) => abs === p || abs.startsWith(`${p}/`));

// ---------- tests ----------

describe("held-out test split", () => {
  it("has 41 valid test tasks with unique ids, a reference note each and an expectation per variant", () => {
    expect(tasks).toHaveLength(41);
    expect(new Set(tasks.map((t) => t.id)).size).toBe(41);
    for (const t of tasks) {
      expect(t.split, t.id).toBe("test");
      expect(t.reference, t.id).toBe(`evals/suite/reference/test/${t.id}.md`);
      expect(readFileSync(join(ROOT, t.reference), "utf8").startsWith(`# ${t.id}:`), t.id).toBe(true);
      for (const v of t.variants) expect(t.expect[v], `${t.id} ${v}`).toBeTruthy();
      expect(t.legacyCase, t.id).toBeNull();
      expect(t.world.base, t.id).toBe("seed@v4");
    }
  });

  it("covers every capability group, with adversarial cases, and never turns a pending decision on by default", () => {
    const groups = new Set(tasks.map((t) => t.group));
    for (const g of EvalGroup.options) expect(groups.has(g), g).toBe(true);
    expect(tasks.filter((t) => t.kind === "adversarial").length).toBeGreaterThanOrEqual(10);
    // The chat_can_propose variant is always paired with the default variant, and the default never expects a chat proposal.
    for (const t of tasks) {
      if (t.variants.includes("chat_can_propose")) expect(t.variants, t.id).toContain("default");
      if (t.surface === "chat") expect(t.expect.default?.proposals ?? [], t.id).toEqual([]);
    }
  });

  it("is covered exactly by test-manifest.json, which publishes only per-group counts", () => {
    expect(manifestDrift(ROOT)).toEqual([]);
    const m = buildTestManifest(ROOT);
    expect(m.taskCount).toBe(41);
    expect(Object.values(m.groups).reduce((a, b) => a + b, 0)).toBe(41);
    expect(Object.keys(m.files)).toHaveLength(41 * 2 + 1);
  });

  it("detects an edited task through the manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "weft-heldout-"));
    try {
      for (const rel of [...Object.keys(buildTestManifest(ROOT).files), MANIFEST_PATH]) {
        mkdirSync(dirname(join(dir, rel)), { recursive: true });
        writeFileSync(join(dir, rel), readFileSync(join(ROOT, rel)));
      }
      expect(manifestDrift(dir)).toEqual([]);
      const first = testTaskFiles(dir)[0]!;
      writeFileSync(join(dir, first), readFileSync(join(dir, first), "utf8").replace("\"budget\"", "\"budget\" "));
      expect(manifestDrift(dir)).toEqual([`changed: ${first}`]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("resolves every mutator a task names, and every mutator is used", () => {
    const used = new Set(tasks.flatMap((t) => t.world.mutators));
    for (const n of used) expect(TEST_MUTATOR_NAMES, n).toContain(n);
    for (const n of TEST_MUTATOR_NAMES) expect(used.has(n), n).toBe(true);
    expect(() => sqlSteps(["noSuchMutator"])).toThrow(/UNKNOWN_MUTATOR/);
    for (const f of memoryFiles(TEST_MUTATOR_NAMES)) expect(f.path, f.path).toMatch(/^(knowledge\/(facts|procedures|decisions)\/|workstreams\/)[a-z0-9-]+\.md$/);
  });

  it("stores notice extracts that equal what the agency parser reads from each notice body", () => {
    let checked = 0;
    for (const m of Object.values(TEST_MUTATORS)) {
      for (const s of m.steps) {
        if (!("sql" in s) || !s.sql.startsWith("INSERT INTO notices")) continue;
        const [, agency, kind, formCode, , , , , , body, extractedJson] = s.args as string[];
        const parsed = parseNotice({ agency: agency as never, formCode: formCode!, kind: kind as never, text: body! });
        const stored = JSON.parse(extractedJson!) as Record<string, unknown>;
        expect({ ...parsed, taxAccountId: stored.taxAccountId }, m.name).toEqual(stored);
        checked++;
      }
    }
    expect(checked).toBe(4);
  });
});

describe("anti-leak scan", () => {
  const tokens = leakTokens(tasks);

  it("derives literal, mutator and input tokens for the split", () => {
    expect(tokens.filter((t) => t.kind === "input").length).toBeGreaterThan(41);
    expect(new Set(tokens.filter((t) => t.kind === "mutator").map((t) => t.text)).size).toBe(TEST_MUTATOR_NAMES.length);
    expect(tokens.filter((t) => t.kind === "literal").length).toBeGreaterThan(20);
  });

  it("finds no test task string where fixers work", () => {
    const hits = scanForLeaks(FIXER_ROOTS, tokens, skipHeldOut);
    expect(hits.map((h) => `${h.taskId} ${h.kind} in ${h.file}`)).toEqual([]);
  });

  it("fails on a planted literal, a planted mutator name and a pasted prompt", () => {
    const dir = mkdtempSync(join(tmpdir(), "weft-leak-"));
    try {
      const lit = tokens.find((t) => t.kind === "literal")!;
      const mut = tokens.find((t) => t.kind === "mutator")!;
      const inp = tokens.find((t) => t.kind === "input" && t.taskId !== lit.taskId)!;
      mkdirSync(join(dir, "packages/agent/src"), { recursive: true });
      mkdirSync(join(dir, "scenarios"), { recursive: true });
      writeFileSync(join(dir, "packages/agent/src/role.ts"), `export const HINT = ${JSON.stringify(`if you see ${lit.text.toUpperCase()} then`)};\n`);
      writeFileSync(join(dir, "packages/agent/src/world.ts"), `// ${mut.text}\n`);
      // Light obfuscation (commas between the words, upper case) still matches after word normalization.
      writeFileSync(join(dir, "scenarios/x.json"), JSON.stringify({ match: `(?i)${inp.text.toUpperCase().replace(/ /g, ", ")}` }));
      const hits = scanForLeaks([join(dir, "packages"), join(dir, "scenarios")], tokens, () => false, dir);
      expect(hits).toEqual(expect.arrayContaining([
        { taskId: lit.taskId, kind: "literal", file: "packages/agent/src/role.ts" },
        { taskId: mut.taskId, kind: "mutator", file: "packages/agent/src/world.ts" },
        { taskId: inp.taskId, kind: "input", file: "scenarios/x.json" },
      ]));
      // A clean file next to them is not reported.
      writeFileSync(join(dir, "packages/agent/src/clean.ts"), "export const OK = 1;\n");
      expect(scanForLeaks([join(dir, "packages")], tokens, () => false, dir).some((h) => h.file.endsWith("clean.ts"))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
