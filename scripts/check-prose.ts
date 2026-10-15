// `pnpm lint:prose` (SPEC 0 rule 3): no em dashes (U+2014) or en dashes (U+2013) in tracked text.
import { readFileSync } from "node:fs";
import { repoFiles, TEXT_EXT } from "./files";

const BANNED = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);
const SKIP = /(^|\/)(pnpm-lock\.yaml|node_modules\/)/;
const hits: string[] = [];
for (const f of repoFiles()) {
  if (!TEXT_EXT.test(f) || SKIP.test(f)) continue;
  let text: string;
  try { text = readFileSync(f, "utf8"); } catch { continue; }
  text.split("\n").forEach((line, i) => { if (BANNED.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`); });
}
if (hits.length) {
  console.error(`lint:prose: ${hits.length} line(s) with an em or en dash:\n${hits.join("\n")}`);
  process.exit(1);
}
console.log("lint:prose: ok");
