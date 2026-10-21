// `pnpm memory:restore <bundle> [--company <id>]`: verifies a memory bundle and restores it as the company's
// memory repo (harness 18 item 6). The replaced repo is kept beside it as memory.replaced-<iso>. Stop the API
// first: the executor is the only git caller while it runs. Data dir: $WEFT_DATA_DIR (default .data).
// With WEFT_MEMORY=sqlite the bundle replaces the SQL memory repo in the world database (docs/cloudflare/design.md
// 4.1), and the replaced history is bundled under companies/<id>/bundles/replaced/ first, so nothing is lost.
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { closeDb, openDb } from "../packages/db/src/index";
import { restoreMemory, restoreSqlMemory } from "../packages/executor/src/memory/bundle";

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

if (process.env.WEFT_MEMORY === "sqlite") {
  const db = openDb({ dataDir });
  try {
    const id = arg("company") ?? String((await db.$client.execute("SELECT id FROM companies ORDER BY id LIMIT 1")).rows[0]?.id ?? "");
    if (!id) throw new Error(`No company in ${join(dataDir, "weft.db")}`);
    const out = await restoreSqlMemory(resolve(bundle), db, { keepDir: join(dataDir, "companies", id, "bundles", "replaced") });
    console.log(`memory:restore: HEAD ${out.head} restored into the SQL memory repo and verified${out.replaced ? `; previous history kept at ${out.replaced}` : ""}`);
  } finally {
    await closeDb(db);
  }
} else {
  const out = await restoreMemory(resolve(bundle), join(dataDir, "companies", company(), "memory"));
  console.log(`memory:restore: HEAD ${out.head} restored and verified${out.replaced ? `; previous repo kept at ${out.replaced}` : ""}`);
}
