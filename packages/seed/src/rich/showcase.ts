// The showcase runs: real agent runs, recorded once on the live model (`pnpm seed:record-showcase`, scripts/
// record-showcase.ts), that the rich layer inserts as the last thing it does. The recorder boots a rich world without
// them, asks the agent the scripted questions and fires the routines, then writes what changed into showcase.json:
// every inserted, updated or deleted row by table (the runs, their steps, threads, answers, charts, grounding refs,
// approval cards, proposals, actions, routine runs, channel posts, paycheck explanations, id counters), the run
// workspace files (offloaded chart and table artifacts) and the memory writes in order. Applying it is a plain replay:
// no model, no executor call and no wall clock, so the same seed twice gives the same digest.
//
// The fixture fits exactly one world: the rich layer as it was when the runs were recorded. Every row it inserts must
// be new, every row it updates must still hold the recorded "before" values, and the action and approval chains must
// continue from the recorded heads; otherwise the seed stops with a message to record again, instead of writing a
// world whose runs point at rows that are not there.
//
// The file is read with node:fs on first use, never imported: the rich layer is on the hosted import graph (apps/api's
// reset route), where only Node runs it, and a static import would put the recording into the Worker bundle.
import { join } from "node:path";
import { sql } from "drizzle-orm";
import type { DbTx } from "@weft/db";
import { runFiles } from "@weft/db";
import type { SeedBlobMode } from "../blobs";

const fs = () => process.getBuiltinModule("node:fs");

export const SHOWCASE_FIXTURE_VERSION = 1;

/** One table's changes. `columns` orders every row in `insert`; `rowid` is set when the table's rowid is not its key. */
export interface ShowcaseTableDiff {
  columns: string[];
  key: string[];
  rowid: boolean;
  /** New rows, in rowid order; with `rowid`, each row starts with its rowid. */
  insert: unknown[][];
  update: { key: Record<string, unknown>; set: Record<string, unknown>; was: Record<string, unknown> }[];
  delete: { key: Record<string, unknown>; was: Record<string, unknown> }[];
}

/** A memory call the recorded runs made, replayed in order at the sim time it ran. */
export interface ShowcaseMemoryCall { at: string; op: "write" | "appendTimeline" | "seedFiles" | "digest"; args: unknown[] }

/** One scripted step as recorded: a chat turn, a routine run or a settings change, with what it produced. */
export interface ShowcaseStep {
  kind: "chat" | "routine" | "setting";
  at: string;
  /** chat: the person's text; routine: the routine id; setting: what changed. */
  text: string;
  who: string;
  threadId: string | null;
  runId: string | null;
  routineRunId: string | null;
  status: string;
  costUsd: number;
}

export interface ShowcaseFixture {
  version: number;
  /** What recorded it: the provider and model of the live runs, the total cost, and the steps in order. */
  /** memoryBefore: the company memory HEAD the runs were recorded on; memoryHead: the HEAD after their memory calls. */
  recorded: { provider: string; model: string; effort: string; costUsd: number; steps: ShowcaseStep[]; memoryBefore: string | null; memoryHead: string | null };
  tables: Record<string, ShowcaseTableDiff>;
  runFiles: { path: string; body: string }[];
  memory: ShowcaseMemoryCall[];
}

/** The committed fixture, beside this module. */
export function showcaseFixturePath(): string {
  return join(new URL(".", import.meta.url).pathname, "showcase.json");
}

const cache = new Map<string, ShowcaseFixture | null>();
/** The recorded fixture (parsed once per path), or null when the file is absent. */
export function readShowcaseFixture(path = showcaseFixturePath()): ShowcaseFixture | null {
  if (cache.has(path)) return cache.get(path)!;
  let text: string;
  try { text = fs().readFileSync(path, "utf8"); } catch { cache.set(path, null); return null; }
  const f = JSON.parse(text) as ShowcaseFixture;
  if (f.version !== SHOWCASE_FIXTURE_VERSION) throw new Error(`showcase fixture: version ${f.version}, this seed reads ${SHOWCASE_FIXTURE_VERSION}; record it again (pnpm seed:record-showcase)`);
  cache.set(path, f);
  return f;
}

/** BLOB cells travel as { $blob: hex }. */
const cellIn = (v: unknown): unknown => (v && typeof v === "object" && "$blob" in (v as Record<string, unknown>) ? Buffer.from(String((v as { $blob: string }).$blob), "hex") : v);
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

export class ShowcaseMismatch extends Error {
  constructor(detail: string) {
    super(`The showcase runs were recorded on a different rich world (${detail}). Record them again with pnpm seed:record-showcase, or keep the rich layer as it was.`);
    this.name = "ShowcaseMismatch";
  }
}

function where(key: Record<string, unknown>) {
  const parts = Object.entries(key).map(([k, v]) => sql`${sql.raw(ident(k))} IS ${cellIn(v)}`);
  return sql.join(parts, sql` AND `);
}

/**
 * Applies the fixture's rows in the rich layer's transaction. Checks first, writes second: every key it inserts is
 * free, every row it updates or deletes still holds the recorded values, and the action and approval chains continue
 * from their recorded heads. Returns the rows written per table.
 */
export async function applyShowcaseRows(tx: DbTx, f: ShowcaseFixture): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const tables = Object.keys(f.tables).sort();
  // Checks.
  for (const t of tables) {
    const d = f.tables[t]!;
    for (const u of d.update) {
      const [row] = await tx.all<Record<string, unknown>>(sql`SELECT * FROM ${sql.raw(ident(t))} WHERE ${where(u.key)}`);
      if (!row) throw new ShowcaseMismatch(`${t} has no row ${JSON.stringify(u.key)} to update`);
      for (const [c, v] of Object.entries(u.was)) if (!same(row[c], cellIn(v))) throw new ShowcaseMismatch(`${t} ${JSON.stringify(u.key)}.${c} is ${JSON.stringify(row[c])}, recorded ${JSON.stringify(v)}`);
    }
    for (const x of d.delete) {
      const [row] = await tx.all<Record<string, unknown>>(sql`SELECT 1 AS one FROM ${sql.raw(ident(t))} WHERE ${where(x.key)}`);
      if (!row) throw new ShowcaseMismatch(`${t} has no row ${JSON.stringify(x.key)} to delete`);
    }
    const off = d.rowid ? 1 : 0;
    for (const r of d.insert) {
      const key = Object.fromEntries(d.key.map((k) => [k, r[off + d.columns.indexOf(k)]]));
      const [hit] = await tx.all<Record<string, unknown>>(sql`SELECT 1 AS one FROM ${sql.raw(ident(t))} WHERE ${where(key)}`);
      if (hit) throw new ShowcaseMismatch(`${t} already has a row ${JSON.stringify(key)}`);
    }
  }
  for (const [t, keyCol] of [["actions", "seq"], ["approval_audit", "seq"]] as const) {
    const d = f.tables[t];
    if (!d?.insert.length) continue;
    const off = d.rowid ? 1 : 0;
    const first = d.insert[0]!;
    const seq = Number(first[off + d.columns.indexOf(keyCol)]);
    const prev = first[off + d.columns.indexOf("prev_hash")];
    const [head] = await tx.all<{ seq: number; hash: string }>(sql.raw(`SELECT ${keyCol} AS seq, hash FROM ${t} ORDER BY ${keyCol} DESC LIMIT 1`));
    if ((head?.seq ?? 0) !== seq - 1 || (head?.hash ?? "0".repeat(64)) !== prev) throw new ShowcaseMismatch(`the ${t} chain head is #${head?.seq ?? 0}, the recording continues from #${seq - 1}`);
  }
  // Writes: deletes, updates, then inserts in recorded order.
  for (const t of tables) {
    const d = f.tables[t]!;
    for (const x of d.delete) await tx.run(sql`DELETE FROM ${sql.raw(ident(t))} WHERE ${where(x.key)}`);
    for (const u of d.update) {
      const set = sql.join(Object.entries(u.set).map(([c, v]) => sql`${sql.raw(ident(c))} = ${cellIn(v)}`), sql`, `);
      await tx.run(sql`UPDATE ${sql.raw(ident(t))} SET ${set} WHERE ${where(u.key)}`);
    }
    const cols = d.rowid ? ["rowid", ...d.columns] : d.columns;
    const list = sql.raw(cols.map(ident).join(", "));
    for (const r of d.insert) {
      await tx.run(sql`INSERT INTO ${sql.raw(ident(t))} (${list}) VALUES (${sql.join(r.map((v) => sql`${cellIn(v)}`), sql`, `)})`);
    }
    counts[t] = d.insert.length + d.update.length + d.delete.length;
  }
  return counts;
}

/**
 * The run workspace files the recorded runs wrote (offloaded artifacts): where the world keeps run files, under the
 * data dir on Node and in the run_files table when the world's blobs are SQL (the hosted snapshot is seeded that way,
 * and a hosted world reads run files from that table).
 */
export async function applyShowcaseFiles(o: { tx: DbTx; dataDir: string; mode: SeedBlobMode }, f: ShowcaseFixture): Promise<number> {
  for (const file of f.runFiles) {
    if (o.mode === "sqlite") {
      await o.tx.insert(runFiles).values({ path: file.path, body: file.body });
      continue;
    }
    const abs = join(o.dataDir, file.path);
    fs().mkdirSync(join(abs, ".."), { recursive: true });
    fs().writeFileSync(abs, file.body);
  }
  return f.runFiles.length;
}

/**
 * The memory calls the runs made, at the sim time each ran, so the company memory and its commit ids come out the
 * same. The runs read memory (recall blocks, memory.search hits with their commit ids), so the memory they were
 * recorded on must be the one here: a HEAD other than the recorded one, before or after the replay, stops the seed.
 */
export async function applyShowcaseMemory(o: { clock: { set(at: string, rate?: number): Promise<void> }; memory: unknown }, f: ShowcaseFixture): Promise<number> {
  const mem = o.memory as Record<string, (...args: unknown[]) => Promise<unknown>> & { root?: () => string | null; head(): Promise<string> };
  if (typeof mem.root === "function" && !mem.root()) return 0;
  if (f.recorded.memoryBefore && (await mem.head()) !== f.recorded.memoryBefore) throw new ShowcaseMismatch(`the company memory is at ${(await mem.head()).slice(0, 12)}, the runs read ${f.recorded.memoryBefore.slice(0, 12)}`);
  let n = 0;
  for (const c of f.memory) {
    await o.clock.set(c.at, 0);
    const fn = mem[c.op];
    if (typeof fn !== "function") throw new Error(`showcase fixture: the memory store has no ${c.op}`);
    await fn.apply(mem, c.args);
    n += 1;
  }
  if (f.recorded.memoryHead && (await mem.head()) !== f.recorded.memoryHead) throw new ShowcaseMismatch(`the replayed memory is at ${(await mem.head()).slice(0, 12)}, recorded ${f.recorded.memoryHead.slice(0, 12)}`);
  return n;
}
