// `pnpm lint:prose` (SPEC 0 rule 3): no em dashes (U+2014) or en dashes (U+2013) in tracked text.
// Scans tracked plus untracked-not-ignored text files (so it also works before a first commit), and with
// `--commits <range>` (for example `main..HEAD`) the commit messages in that range too.
// Untracked files that a tool generates on its own (Next writes apps/web/AGENTS.md on `next dev`) are skipped
// until someone tracks them; once tracked they are scanned like everything else.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoFiles, TEXT_EXT } from "./files";

const BANNED = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);
const SKIP = /(^|\/)(pnpm-lock\.yaml|node_modules\/)/;
const GENERATED_UNTRACKED = new Set(["apps/web/AGENTS.md"]);

const tracked = new Set(execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 << 20 }).split("\0").filter(Boolean));
const hits: string[] = [];
let scanned = 0;
for (const f of repoFiles()) {
  if (!TEXT_EXT.test(f) || SKIP.test(f)) continue;
  if (GENERATED_UNTRACKED.has(f) && !tracked.has(f)) continue;
  let text: string;
  try { text = readFileSync(f, "utf8"); } catch { continue; }
  scanned++;
  text.split("\n").forEach((line, i) => { if (BANNED.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`); });
}

const ci = process.argv.indexOf("--commits");
if (ci >= 0) {
  const range = process.argv[ci + 1] ?? "HEAD";
  const log = execFileSync("git", ["log", "--format=%h%x00%B%x01", range], { encoding: "utf8", maxBuffer: 64 << 20 });
  for (const entry of log.split("\x01")) {
    const [sha, body] = entry.trim().split("\0");
    if (sha && body && BANNED.test(body)) hits.push(`commit ${sha}: message has an em or en dash`);
  }
}

if (hits.length) {
  console.error(`lint:prose: ${hits.length} line(s) with an em or en dash (recast the sentence; do not swap in a hyphen pair):\n${hits.join("\n")}`);
  process.exit(1);
}
console.log(`lint:prose: ok (${scanned} files${ci >= 0 ? ", commit messages" : ""})`);
