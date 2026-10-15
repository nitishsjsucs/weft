// `pnpm lint:brand` (SPEC 0 rules 1 and 2, SPEC 13). Owner: t6-site. Four checks:
//   1. The reference site's name and domains are banned outside research/, NOTICE and SPEC.md.
//   2. A phrase denylist (research/design/reference/brand-denylist.txt, gitignored) is scanned across apps/,
//      packages/, docs/, e2e/ and README.md. When the file is absent the check warns and is skipped.
//   3. No file copied from research/design/reference/ may exist in the repo: every tracked or untracked file is
//      compared by size and sha256 against the reference files (read from the main checkout's absolute path,
//      since worktrees do not have them). Nothing under research/design/reference/ may be tracked either.
//   4. The reference site's proprietary font families may not be named in apps/ or packages/.
// The banned names are assembled at runtime so this file passes its own scan.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { repoFiles, TEXT_EXT } from "./files";

const NAME = ["w", "a", "r", "p"].join("");
const NAME_RE = new RegExp(`\\b${NAME}\\b|join${NAME}|${NAME}\\.co\\b|${NAME}-(dash|agent)`, "i");
const ALLOW = /^(research\/|NOTICE$|SPEC\.md$|pnpm-lock\.yaml$)/;
const FONT_RE = new RegExp([["Restart", "Soft"].join(" "), ["Ma", "can"].join(""), ["Berkeley", "Mono"].join(" ")].map((s) => `\\b${s}\\b`).join("|"));
const FONT_SCOPE = /^(apps|packages)\//;
const DENY_SCOPE = /^(apps\/|packages\/|docs\/|e2e\/|README\.md$)/;
const GENERATED_UNTRACKED = new Set(["apps/web/AGENTS.md"]);   // written by `next dev`; see check-prose.ts

const MAIN_REFERENCE = join(homedir(), "Developer/projects/weft/research/design/reference");
const REFERENCE_DIR = [process.env.WEFT_BRAND_REFERENCE_DIR, "research/design/reference", MAIN_REFERENCE]
  .find((p): p is string => !!p && existsSync(p)) ?? "";
const DENYLIST = [process.env.WEFT_BRAND_DENYLIST, REFERENCE_DIR && join(REFERENCE_DIR, "brand-denylist.txt"), join(MAIN_REFERENCE, "brand-denylist.txt")]
  .find((p): p is string => !!p && existsSync(p)) ?? "";

const files = repoFiles();
const problems: string[] = [];
const warnings: string[] = [];

// 3a. Nothing under the reference folder is tracked.
for (const f of files) if (f.startsWith("research/design/reference/")) problems.push(`${f}: reference material must never be tracked or left unignored`);

// 3b. No byte-identical copy of a reference file anywhere in the repo.
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.isFile()) out.push(p);
  }
  return out;
}
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
let referenceCount = 0;
if (REFERENCE_DIR) {
  const bySize = new Map<number, Map<string, string>>();   // size -> sha -> reference path
  for (const p of walk(REFERENCE_DIR)) {
    if (p.endsWith("brand-denylist.txt")) continue;
    const size = statSync(p).size;
    if (size < 64) continue;   // tiny files (empty json, one-line css) are not evidence of copying
    referenceCount++;
    let m = bySize.get(size);
    if (!m) bySize.set(size, (m = new Map()));
    m.set(sha(p), p.slice(REFERENCE_DIR.length + 1));
  }
  for (const f of files) {
    let size: number;
    try { size = statSync(f).size; } catch { continue; }
    const candidates = bySize.get(size);
    if (!candidates) continue;
    const hit = candidates.get(sha(f));
    if (hit) problems.push(`${f}: byte-identical copy of reference file ${hit}`);
  }
} else {
  warnings.push("reference folder not found; skipped the copied-file hash check");
}

// 2. Phrase denylist.
const normalize = (s: string) => s.replace(/\s+/g, " ");
const phrases = DENYLIST
  ? readFileSync(DENYLIST, "utf8").split("\n").map((l) => normalize(l.trim())).filter((l) => l && !l.startsWith("#") && l.length >= 4)
  : [];
if (!DENYLIST) warnings.push("brand-denylist.txt not found (set WEFT_BRAND_DENYLIST or create research/design/reference/brand-denylist.txt); skipped the phrase check");

// 1, 2 and 4 over text files.
const tracked = new Set(execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 << 20 }).split("\0").filter(Boolean));
for (const f of files) {
  if (!TEXT_EXT.test(f) || f.includes("node_modules/") || (GENERATED_UNTRACKED.has(f) && !tracked.has(f))) continue;
  let text: string;
  try { text = readFileSync(f, "utf8"); } catch { continue; }
  const lines = text.split("\n");
  if (!ALLOW.test(f)) lines.forEach((line, i) => { if (NAME_RE.test(line)) problems.push(`${f}:${i + 1}: reference-site name or domain`); });
  if (FONT_SCOPE.test(f)) lines.forEach((line, i) => { if (FONT_RE.test(line)) problems.push(`${f}:${i + 1}: reference-site font family (use Inter Variable or JetBrains Mono)`); });
  if (DENY_SCOPE.test(f) && phrases.length) {
    const flat = normalize(text);
    for (const p of phrases) if (flat.includes(p)) problems.push(`${f}: denylisted reference phrase (${p.length} chars; see the denylist file)`);
  }
}

for (const w of warnings) console.warn(`lint:brand: warning: ${w}`);
if (problems.length) {
  console.error(`lint:brand: ${problems.length} problem(s):\n${problems.join("\n")}`);
  process.exit(1);
}
console.log(`lint:brand: ok (${files.length} files, ${phrases.length} denylist phrases, ${referenceCount} reference files hashed)`);
