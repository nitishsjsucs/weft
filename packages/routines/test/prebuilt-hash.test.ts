// The prebuilt-routine hash gate (docs/cloudflare/design.md 4.4, track cf2-platform). ensurePrebuilt keeps a hash of
// the code-owned prebuilt definitions in the store the composition root gives it (apps/api: kv_state); a second boot
// whose hash matches skips the comparison and writes nothing, a new build (another hash) compares and refreshes once,
// a world that lost its rows is repaired, and without a store the engine compares on every boot as before.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { AgentRuntime, ReadOnlyExecutor, SimClock, ToolOutcome } from "@weft/contracts";
import { closeDb, migrate, openDb, routines, type Db } from "@weft/db";
import { createRoutines, PREBUILT, prebuiltHash, type PrebuiltHashStore } from "../src/index";

let dataDir: string;
let db: Db;
/** The hash store: a row in a table of its own here, written through the same client, so the meter counts it. */
let store: PrebuiltHashStore & { sets: number };
beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "weft-rt-hash-"));
  db = openDb({ dataDir });
  await migrate(db);
  await db.run(sql`CREATE TABLE test_hash (k text PRIMARY KEY, v text NOT NULL)`);
  store = {
    sets: 0,
    async get() { return (await db.all<{ v: string }>(sql`SELECT v FROM test_hash WHERE k = 'h'`))[0]?.v ?? null; },
    async set(v) { store.sets++; await db.run(sql`INSERT INTO test_hash (k, v) VALUES ('h', ${v}) ON CONFLICT(k) DO UPDATE SET v = excluded.v`); },
  };
});
afterEach(async () => {
  await closeDb(db);
  rmSync(dataDir, { recursive: true, force: true });
});

const clock: SimClock = { now: () => "2026-10-26T15:30:00.000Z", rate: () => 0, advance: async () => {}, set: async () => {} };
const done: ToolOutcome = { ok: true, status: "done", resultId: "res_0001", data: {}, summary: "ok", actionSeq: null, artifactRef: null, tainted: false, label: "synthetic" };
const readOnly: ReadOnlyExecutor = { exec: async () => done };
const agent: AgentRuntime = {
  async boot() {}, async startChat() {}, async startRoutineRun() {}, async requeue() {}, async cancel() {},
  subscribe: () => () => undefined, async trace() { throw new Error("n/a"); },
};
const runs = { openRoutineRun: async () => ({ runId: "run_0001", token: "t" }) };
const engine = (withStore = true) => createRoutines({ db, clock, agent, runs, readOnly, ...(withStore ? { prebuiltHash: store } : {}) });

/** Statements and rows written through the client while `fn` runs (libsql reports rowsAffected per statement). */
async function metered(fn: () => Promise<unknown>): Promise<{ statements: string[]; rowsWritten: number }> {
  const c = db.$client as unknown as { execute: (...a: unknown[]) => Promise<{ rowsAffected: number }> };
  const orig = c.execute;
  const statements: string[] = [];
  let rowsWritten = 0;
  c.execute = async (...a: unknown[]) => {
    const text = typeof a[0] === "string" ? a[0] : String((a[0] as { sql: string }).sql);
    statements.push(text);
    const r = await orig.apply(c, a);
    if (!/^\s*(select|with|pragma)\b/i.test(text)) rowsWritten += r.rowsAffected;
    return r;
  };
  try { await fn(); } finally { c.execute = orig; }
  return { statements, rowsWritten };
}

describe("prebuilt routine hash gate", () => {
  it("writes the rows and the hash on the first boot, and nothing on the second", async () => {
    const first = await metered(() => engine().ensurePrebuilt());
    expect(first.rowsWritten).toBe(PREBUILT.length + 1);
    expect(await store.get()).toBe(prebuiltHash(PREBUILT, "cmp_larkspur"));

    const second = await metered(() => engine().ensurePrebuilt());
    expect(second.rowsWritten).toBe(0);
    // The gate reads the hash and counts the prebuilt ids; it never loads the routine rows to compare them.
    expect(second.statements).toHaveLength(2);
    expect(second.statements.some((s) => /select .*"routines"\."name"/i.test(s))).toBe(false);
  });

  it("a new build (another hash) compares and refreshes once, keeping enabled and autonomy, then is skipped again", async () => {
    await engine().ensurePrebuilt();
    await db.update(routines).set({ instructions: "older build instructions", enabled: false, autonomy: "recommend" }).where(eq(routines.id, "rt_pre_payroll"));
    await store.set("hash-of-an-older-build");
    const refreshed = await metered(() => engine().ensurePrebuilt());
    expect(refreshed.rowsWritten).toBe(2);   // the stale row and the hash
    const [r] = await db.select().from(routines).where(eq(routines.id, "rt_pre_payroll"));
    expect(r).toMatchObject({ instructions: PREBUILT.find((x) => x.id === "rt_pre_payroll")!.instructions, enabled: false, autonomy: "recommend" });
    expect((await metered(() => engine().ensurePrebuilt())).rowsWritten).toBe(0);
  });

  it("repairs a world that lost prebuilt rows even when the hash matches", async () => {
    await engine().ensurePrebuilt();
    await db.delete(routines).where(eq(routines.id, "rt_people_digest"));
    const repaired = await metered(() => engine().ensurePrebuilt());
    expect(repaired.rowsWritten).toBe(1);
    expect((await db.select().from(routines).where(eq(routines.id, "rt_people_digest"))).length).toBe(1);
  });

  it("without a store there is no gate: every boot compares the rows, as before", async () => {
    await engine(false).ensurePrebuilt();
    const second = await metered(() => engine(false).ensurePrebuilt());
    expect(second.rowsWritten).toBe(0);
    expect(second.statements.some((s) => /from "routines"$/i.test(s.trim()) || /select .*"routines"\."name"/i.test(s))).toBe(true);
    expect(store.sets).toBe(0);
  });

  it("hashes every field ensurePrebuilt writes, so any definition change moves it", () => {
    const base = prebuiltHash(PREBUILT, "cmp_larkspur");
    expect(prebuiltHash(PREBUILT, "cmp_larkspur")).toBe(base);
    expect(prebuiltHash(PREBUILT, "cmp_other")).not.toBe(base);
    const changed = PREBUILT.map((r, i) => (i === 0 ? { ...r, tools: [...r.tools, "notices.get"] } : r));
    expect(prebuiltHash(changed, "cmp_larkspur")).not.toBe(base);
    const reordered = PREBUILT.map((r, i) => (i === 1 ? { ...r, checklist: [...r.checklist].reverse() } : r));
    expect(prebuiltHash(reordered, "cmp_larkspur")).not.toBe(base);
  });
});
