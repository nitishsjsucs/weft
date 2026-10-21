// Migration sources (docs/cloudflare/design.md 4.2 and 9.5). The journal and SQL files under packages/db/drizzle are
// read exactly as drizzle-orm's readMigrationFiles reads them (split on "--> statement-breakpoint", sha256 of the
// whole file, the journal's `when` as folderMillis), so both migrators write identical __drizzle_migrations rows.
// The durable side gets the same entries from a bundled module (apps/cf/generated/fixtures.ts); the Node side reads
// the folder. node:fs is reached through process.getBuiltinModule only, so nothing on the durable import path pulls
// it in statically.
import { createHash } from "node:crypto";

export interface MigrationJournal { entries: ReadonlyArray<{ idx: number; tag: string; when: number; breakpoints: boolean }> }

export interface MigrationEntry {
  tag: string;
  /** The journal's `when`; __drizzle_migrations.created_at. */
  folderMillis: number;
  /** sha256 of the whole SQL file; __drizzle_migrations.hash. */
  hash: string;
  /** The file split on "--> statement-breakpoint", each piece as drizzle passes it to the driver. */
  statements: string[];
}

/** Builds the entries from a journal and each tag's file text. */
export function migrationEntries(journal: MigrationJournal, fileText: (tag: string) => string): MigrationEntry[] {
  return journal.entries.map((e) => {
    const query = fileText(e.tag);
    return { tag: e.tag, folderMillis: e.when, hash: createHash("sha256").update(query).digest("hex"), statements: query.split("--> statement-breakpoint") };
  });
}

/** One hash over the whole journal (tags, times and file hashes), for the snapshot manifest's freshness check. */
export function journalHash(entries: readonly MigrationEntry[]): string {
  return createHash("sha256").update(entries.map((e) => `${e.tag}\t${e.folderMillis}\t${e.hash}`).join("\n")).digest("hex");
}

type FsLike = { readFileSync(path: string): { toString(): string }; existsSync(path: string): boolean };
function nodeFs(): FsLike {
  const fs = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule?.("node:fs") as FsLike | undefined;
  if (!fs) throw new Error("readMigrationsFromDir needs node:fs (Node only)");
  return fs;
}

/** Reads packages/db/drizzle (or another drizzle folder) on Node. */
export function readMigrationsFromDir(dir: string): MigrationEntry[] {
  const fs = nodeFs();
  const journalPath = `${dir}/meta/_journal.json`;
  if (!fs.existsSync(journalPath)) throw new Error(`Can't find meta/_journal.json file`);
  const journal = JSON.parse(fs.readFileSync(journalPath).toString()) as MigrationJournal;
  return migrationEntries(journal, (tag) => {
    try { return fs.readFileSync(`${dir}/${tag}.sql`).toString(); } catch { throw new Error(`No file ${dir}/${tag}.sql found in ${dir} folder`); }
  });
}
