// `pnpm lint:brand` (SPEC 13): the reference site's name and domains are banned outside research/, NOTICE and SPEC.md;
// a phrase denylist (gitignored, read when present) is scanned across apps/ and packages/; no file from
// research/design/reference/ may be tracked. The banned name is assembled at runtime so this file passes itself.
import { existsSync, readFileSync } from "node:fs";
import { repoFiles, TEXT_EXT } from "./files";

const NAME = ["w", "a", "r", "p"].join("");
const NAME_RE = new RegExp(`\\b${NAME}\\b|join${NAME}|${NAME}\\.co\\b|${NAME}-(dash|agent)`, "i");
const ALLOW = /^(research\/|NOTICE$|SPEC\.md$|pnpm-lock\.yaml$)/;
const DENYLIST = "research/design/reference/brand-denylist.txt";
const DENY_SCOPE = /^(apps|packages)\//;

const files = repoFiles();
const problems: string[] = [];
for (const f of files) if (f.startsWith("research/design/reference/")) problems.push(`${f}: reference material must never be tracked`);

const phrases = existsSync(DENYLIST)
  ? readFileSync(DENYLIST, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && l.length >= 4)
  : [];

for (const f of files) {
  if (!TEXT_EXT.test(f) || f.includes("node_modules/")) continue;
  let text: string;
  try { text = readFileSync(f, "utf8"); } catch { continue; }
  const lines = text.split("\n");
  if (!ALLOW.test(f)) lines.forEach((line, i) => { if (NAME_RE.test(line)) problems.push(`${f}:${i + 1}: reference-site name or domain`); });
  if (DENY_SCOPE.test(f)) for (const p of phrases) if (text.includes(p)) problems.push(`${f}: denylisted reference phrase (${p.length} chars)`);
}
if (problems.length) {
  console.error(`lint:brand: ${problems.length} problem(s):\n${problems.join("\n")}`);
  process.exit(1);
}
console.log(`lint:brand: ok (${phrases.length} denylist phrases${phrases.length ? "" : ", denylist file not present"})`);
