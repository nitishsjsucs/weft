// The weft-ops D1 schema for local runs (Miniflare and pnpm cf:dev): Miniflare creates the database but applies no
// migrations, so the extras' job ledger, run catalog and failed jobs would have no tables. Deployed, the same files go
// through `wrangler d1 migrations apply weft-ops --remote` (design 9.5).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { APPS_CF } from "./configs";

/** The statements of apps/cf/d1/*.sql, in file order, comments dropped. */
export function d1Statements(dir = join(APPS_CF, "d1")): string[] {
  const out: string[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(dir, f), "utf8").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    out.push(...sql.split(/;\s*\n/).map((s) => s.trim().replace(/;$/, "")).filter(Boolean));
  }
  return out;
}

interface D1Like { prepare(q: string): { run(): Promise<unknown> } }
/** Applies the schema to a fresh local database, one statement at a time. */
export async function applyLocalD1(db: D1Like, dir?: string): Promise<number> {
  const stmts = d1Statements(dir);
  for (const s of stmts) await db.prepare(s).run();
  return stmts.length;
}
