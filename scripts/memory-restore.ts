// `pnpm memory:restore <bundle> [--company <id>]`: verifies a memory bundle and restores it as the company's
// memory repo (harness 18 item 6). The replaced repo is kept beside it as memory.replaced-<iso>. Stop the API
// first: the executor is the only git caller while it runs. Data dir: $WEFT_DATA_DIR (default .data).
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { restoreMemory } from "../packages/executor/src/memory/bundle";

const repoRoot = resolve(import.meta.dirname, "..");
const dataDir = resolve(process.env.WEFT_DATA_DIR ?? join(repoRoot, ".data"));
const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const bundle = process.argv.slice(2).find((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--company");
if (!bundle) throw new Error("Usage: pnpm memory:restore <path/to/x.bundle> [--company <id>]");

function company(): string {
  const named = arg("company");
  if (named) return named;
  const all = (() => { try { return readdirSync(join(dataDir, "companies")); } catch { return []; } })().filter((d) => d.startsWith("cmp_")).sort();
  if (all.length !== 1) throw new Error(`Pass --company <id> (found ${all.length} companies under ${join(dataDir, "companies")})`);
  return all[0]!;
}

const out = await restoreMemory(resolve(bundle), join(dataDir, "companies", company(), "memory"));
console.log(`memory:restore: HEAD ${out.head} restored and verified${out.replaced ? `; previous repo kept at ${out.replaced}` : ""}`);
