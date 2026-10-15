// lint:prose and lint:brand catch what they claim to (SPEC 0 rules 1 to 3, SPEC 13). Owner: t6-site.
// Each case builds a small throwaway git repo under this test's output folder, runs the real script against it with
// HOME pointed at that folder (so the main checkout's reference folder and denylist are out of reach), and checks
// the exit code and message. The denylist phrase and the "reference file" here are synthetic, so no reference
// material is ever read or copied. The last case runs both lints on the real repo.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test, type TestInfo } from "@playwright/test";

const ROOT = join(import.meta.dirname, "..");
const TSX = join(ROOT, "node_modules/.bin/tsx");
const NAME = ["W", "a", "r", "p"].join("");
const DASH = String.fromCharCode(0x2014);
const PHRASE = "payroll that hums like a quiet loom";
const FAKE_SCREENSHOT = Buffer.from(Array.from({ length: 256 }, (_, i) => (i * 37) % 251));

interface Sandbox { dir: string; home: string; write(path: string, body: string | Buffer): void; commit(message?: string): void }

function sandbox(info: TestInfo, files: Record<string, string | Buffer>): Sandbox {
  const home = info.outputPath("home");
  const dir = info.outputPath("repo");
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  const git = (...a: string[]) => {
    const r = spawnSync("git", a, { cwd: dir, encoding: "utf8", env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1" } });
    if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "lint-test");
  git("config", "user.email", "lint-test@example.invalid");
  const sb: Sandbox = {
    dir, home,
    write(path, body) { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), body); },
    commit(message = "test: fixture") { git("add", "-A"); git("commit", "-q", "--allow-empty", "-m", message); },
  };
  sb.write("README.md", "# Fixture\n\nPlain prose, hyphens only - fine.\n");
  sb.write("apps/web/src/page.tsx", "export const copy = \"Payroll for a fictional company\";\n");
  for (const [p, b] of Object.entries(files)) sb.write(p, b);
  sb.commit();
  return sb;
}

/** A reference folder and denylist outside the sandbox repo, as the main checkout keeps them. */
function reference(sb: Sandbox, opts: { denylist?: boolean; screenshot?: boolean } = {}): NodeJS.ProcessEnv {
  const ref = join(sb.home, "reference");
  mkdirSync(join(ref, "screens"), { recursive: true });
  if (opts.screenshot !== false) writeFileSync(join(ref, "screens", "home.png"), FAKE_SCREENSHOT);
  if (opts.denylist !== false) writeFileSync(join(ref, "brand-denylist.txt"), `# synthetic test list\n${PHRASE}\n`);
  return { WEFT_BRAND_REFERENCE_DIR: ref, WEFT_BRAND_DENYLIST: opts.denylist === false ? join(ref, "absent.txt") : join(ref, "brand-denylist.txt") };
}

function lint(script: "check-brand" | "check-prose", cwd: string, env: NodeJS.ProcessEnv = {}, args: string[] = []) {
  const { WEFT_BRAND_REFERENCE_DIR: _r, WEFT_BRAND_DENYLIST: _d, ...base } = process.env;
  const r = spawnSync(TSX, [join(ROOT, "scripts", `${script}.ts`), ...args], { cwd, encoding: "utf8", env: { ...base, ...env } });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test.describe("lint:brand", () => {
  test("a clean tree passes with the denylist and the reference hashes loaded", async ({}, info) => {
    const sb = sandbox(info, {});
    const r = lint("check-brand", sb.dir, { HOME: sb.home, ...reference(sb) });
    expect(r.out).toContain("lint:brand: ok");
    expect(r.out).toMatch(/1 denylist phrases, 1 reference files hashed/);
    expect(r.code).toBe(0);
  });

  test("a denylist phrase planted in apps/ fails, even when it wraps across lines", async ({}, info) => {
    const sb = sandbox(info, { "apps/web/src/hero.tsx": `export const hero = \`Weft: ${PHRASE.replace("like a", "like\n  a")}.\`;\n` });
    const r = lint("check-brand", sb.dir, { HOME: sb.home, ...reference(sb) });
    expect(r.code).toBe(1);
    expect(r.out).toContain("apps/web/src/hero.tsx: denylisted reference phrase");
    expect(r.out).not.toContain(PHRASE);   // the report never echoes the reference phrase
  });

  test("an untracked file is scanned too, and research/ is out of the denylist's scope", async ({}, info) => {
    const sb = sandbox(info, { "research/notes.md": `Reference says: ${PHRASE}\n` });
    sb.write("packages/ui/src/draft.ts", `// ${PHRASE}\n`);
    const r = lint("check-brand", sb.dir, { HOME: sb.home, ...reference(sb) });
    expect(r.code).toBe(1);
    expect(r.out).toContain("packages/ui/src/draft.ts: denylisted reference phrase");
    expect(r.out).not.toContain("research/notes.md");
  });

  test("a byte-identical copy of a reference file fails wherever it lands", async ({}, info) => {
    const sb = sandbox(info, { "apps/web/public/brand/hero-shot.png": FAKE_SCREENSHOT });
    const r = lint("check-brand", sb.dir, { HOME: sb.home, ...reference(sb) });
    expect(r.code).toBe(1);
    expect(r.out).toContain("apps/web/public/brand/hero-shot.png: byte-identical copy of reference file screens/home.png");
  });

  test("the reference name or domain fails outside research/, NOTICE and SPEC.md", async ({}, info) => {
    const sb = sandbox(info, {
      "docs/intro.md": `Inspired by ${NAME.toLowerCase()}.co pages.\n`,
      "NOTICE": `Layout studied from ${NAME}.\n`,
      "SPEC.md": `Reference: ${NAME}.\n`,
      "research/product.md": `${NAME} ships payroll.\n`,
    });
    const r = lint("check-brand", sb.dir, { HOME: sb.home, ...reference(sb) });
    expect(r.code).toBe(1);
    expect(r.out).toContain("docs/intro.md:1: reference-site name or domain");
    expect(r.out).not.toMatch(/NOTICE:|SPEC\.md:|research\/product\.md:/);
  });

  test("tracking anything under research/design/reference/ fails", async ({}, info) => {
    const sb = sandbox(info, { "research/design/reference/notes.txt": "kept locally only\n" });
    const r = lint("check-brand", sb.dir, { HOME: sb.home, ...reference(sb) });
    expect(r.code).toBe(1);
    expect(r.out).toContain("research/design/reference/notes.txt: reference material must never be tracked");
  });

  test("a missing denylist is a warning, not a failure", async ({}, info) => {
    const sb = sandbox(info, {});
    const r = lint("check-brand", sb.dir, { HOME: sb.home, ...reference(sb, { denylist: false }) });
    expect(r.code).toBe(0);
    expect(r.out).toContain("warning: brand-denylist.txt not found");
  });
});

test.describe("lint:prose", () => {
  test("an em dash in a tracked file fails and names the line", async ({}, info) => {
    const sb = sandbox(info, { "docs/guide.md": `# Guide\n\nRun it ${DASH} then stop it.\n` });
    const r = lint("check-prose", sb.dir, { HOME: sb.home });
    expect(r.code).toBe(1);
    expect(r.out).toContain("docs/guide.md:3:");
  });

  test("an en dash in a commit message fails with --commits", async ({}, info) => {
    const sb = sandbox(info, {});
    sb.write("docs/a.md", "Plain.\n");
    sb.commit(`docs: pages 1${String.fromCharCode(0x2013)}3`);
    expect(lint("check-prose", sb.dir, { HOME: sb.home }).code).toBe(0);
    const r = lint("check-prose", sb.dir, { HOME: sb.home }, ["--commits", "HEAD~1..HEAD"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("message has an em or en dash");
  });

  test("the generated apps/web/AGENTS.md is skipped only while untracked", async ({}, info) => {
    const sb = sandbox(info, {});
    sb.write("apps/web/AGENTS.md", `Generated ${DASH} by next dev.\n`);
    expect(lint("check-prose", sb.dir, { HOME: sb.home }).code).toBe(0);
    sb.commit("chore: track the generated file");
    expect(lint("check-prose", sb.dir, { HOME: sb.home }).code).toBe(1);
  });
});

test("the real repo passes lint:prose (with this branch's commit messages) and lint:brand", async () => {
  const prose = lint("check-prose", ROOT, {}, ["--commits", "HEAD~5..HEAD"]);
  expect(prose.out).toContain("lint:prose: ok");
  const brand = lint("check-brand", ROOT);
  expect(brand.out).toContain("lint:brand: ok");
});
