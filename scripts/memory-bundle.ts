// `pnpm memory:bundle [--company <id>]`: writes a verified `git bundle create --all` snapshot of a company's memory
// repo to $WEFT_DATA_DIR/companies/<id>/bundles/<iso>.bundle (harness 18 item 6). Data dir defaults to .data.
// With WEFT_MEMORY=sqlite the memory lives in the world database (mem_objects, mem_refs, mem_log; docs/cloudflare/
// design.md 4.1): the same bundle is built from it through `git fast-import`. Uploading bundles to object storage (for
// example R2) is designed in docs/tracks/w2-memory.md only.
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { closeDb, openDb } from "../packages/db/src/index";
import { bundleMemory, bundleSqlMemory } from "../packages/executor/src/memory/bundle";

const repoRoot = resolve(import.meta.dirname, "..");
const dataDir = resolve(process.env.WEFT_DATA_DIR ?? join(repoRoot, ".data"));
const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };

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
    const out = await bundleSqlMemory(db, join(dataDir, "companies", id, "bundles"));
    console.log(`memory:bundle: ${out.path} (${out.bytes} bytes, HEAD ${out.head}, verified, from the SQL memory repo)`);
  } finally {
    await closeDb(db);
  }
} else {
  const id = company();
  const out = await bundleMemory(join(dataDir, "companies", id, "memory"), join(dataDir, "companies", id, "bundles"));
  console.log(`memory:bundle: ${out.path} (${out.bytes} bytes, HEAD ${out.head}, verified)`);
}
