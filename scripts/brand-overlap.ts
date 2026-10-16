// `pnpm brand:overlap` (SPEC 0 rule 1): Weft may mirror the reference site's look but never its marketing copy.
// Extracts the visible text of every saved reference page (research/design/reference/**/*.html, gitignored) and
// reports each run of 8 or more consecutive words that a repo text file in apps/, packages/, docs/, research/,
// README.md or SPEC.md shares with it, after normalizing case, punctuation and whitespace (scripts/overlap.ts).
// Fails on any run not covered by scripts/brand-overlap.allow.txt, which stays empty unless a run is a generic phrase
// (each entry carries its reason). When no reference folder exists, as in CI, it says so and exits 0.
// The reference folder is read from WEFT_BRAND_REFERENCE_DIR, this checkout, or the main checkout's absolute path,
// because worktrees do not have it.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { repoFiles, TEXT_EXT } from "./files";
import { MIN_RUN, parseAllowlist, shingles, sharedRuns, visibleText, words } from "./overlap";

const MAIN_REFERENCE = join(homedir(), "Developer/projects/weft/research/design/reference");
const REFERENCE_DIR = [process.env.WEFT_BRAND_REFERENCE_DIR, "research/design/reference", MAIN_REFERENCE]
  .find((p): p is string => !!p && existsSync(p)) ?? "";
const ALLOWLIST = "scripts/brand-overlap.allow.txt";
// `--words N` lowers or raises the run length for a one-off investigation (for example `-- --words 6` to find
// near-verbatim fragments); the gate itself always runs at the default of 8.
const wi = process.argv.indexOf("--words");
const N = wi >= 0 ? Math.max(3, Number(process.argv[wi + 1]) || MIN_RUN) : MIN_RUN;
const SCOPE = /^(apps\/|packages\/|docs\/|research\/|README\.md$|SPEC\.md$)/;
const EXCLUDE = /^research\/design\/reference\/|(^|\/)node_modules\//;
const GENERATED_UNTRACKED = new Set(["apps/web/AGENTS.md"]);   // written by `next dev`; see check-prose.ts

if (!REFERENCE_DIR) {
  console.log("brand:overlap: skipped, no reference folder (research/design/reference/ is gitignored and absent here, as in CI; set WEFT_BRAND_REFERENCE_DIR to point at one)");
  process.exit(0);
}

function htmlFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) htmlFiles(p, out);
    else if (e.isFile() && /\.html?$/i.test(e.name)) out.push(p);
  }
  return out.sort();
}

const pages = htmlFiles(REFERENCE_DIR);
if (!pages.length) {
  console.log(`brand:overlap: skipped, no .html pages under ${REFERENCE_DIR}`);
  process.exit(0);
}

// Reference shingles, each mapped to the first page it appears on (for the report).
const reference = new Map<string, string>();
let referenceWords = 0;
for (const p of pages) {
  const ws = words(visibleText(readFileSync(p, "utf8"))).map((x) => x.w);
  referenceWords += ws.length;
  const name = relative(REFERENCE_DIR, p);
  for (const s of shingles(ws, N)) if (!reference.has(s)) reference.set(s, name);
}

const problems: string[] = [];
const allow = existsSync(ALLOWLIST) ? parseAllowlist(readFileSync(ALLOWLIST, "utf8")) : { phrases: [], problems: [] };
problems.push(...allow.problems.map((p) => `${ALLOWLIST}: ${p}`));
const allowed = new Set<string>();
for (const phrase of allow.phrases) for (const s of shingles(words(phrase).map((x) => x.w), N)) allowed.add(s);
const usedAllowed = new Set<string>();

const tracked = new Set(execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 << 20 }).split("\0").filter(Boolean));
let scanned = 0;
for (const f of repoFiles()) {
  if (!SCOPE.test(f) || EXCLUDE.test(f) || !TEXT_EXT.test(f)) continue;
  if (GENERATED_UNTRACKED.has(f) && !tracked.has(f)) continue;
  let text: string;
  try { text = readFileSync(f, "utf8"); } catch { continue; }
  scanned++;
  for (const run of sharedRuns(text, reference, new Set(), N)) {
    const ws = run.phrase.split(" ");
    const windows = [...shingles(ws, N)];
    const blocked = windows.filter((s) => !allowed.has(s));
    windows.filter((s) => allowed.has(s)).forEach((s) => usedAllowed.add(s));
    if (!blocked.length) continue;
    const page = reference.get(blocked[0]!) ?? "?";
    problems.push(`${f}:${run.line}: ${run.words} words shared with ${page}: "${run.phrase}"`);
  }
}

for (const phrase of allow.phrases) {
  const keys = [...shingles(words(phrase).map((x) => x.w), N)];
  if (!keys.some((k) => usedAllowed.has(k))) console.warn(`brand:overlap: warning: allowlist entry no longer matches anything, remove it: "${phrase}"`);
}

if (problems.length) {
  console.error(`brand:overlap: ${problems.length} run(s) of ${N}+ words shared with the reference pages (restate them in Weft's own words, or allowlist a generic phrase with a reason in ${ALLOWLIST}):\n${problems.join("\n")}`);
  process.exit(1);
}
console.log(`brand:overlap: ok (${scanned} files checked against ${pages.length} reference pages, ${referenceWords} words, ${reference.size} ${N}-word runs; ${allow.phrases.length} allowlisted phrases)`);
