import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { openDb, closeDb, migrate, withWriteLock, actions, approvalAudit, type Db } from "../src/index";

/** Drizzle wraps driver errors; the trigger message is on the cause. */
async function failure(p: Promise<unknown>): Promise<string> {
  try { await p; return "no error"; } catch (e) { const err = e as Error & { cause?: Error }; return `${err.message} ${err.cause?.message ?? ""}`; }
}

let dir: string;
let db: Db;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "weft-db-"));
  db = openDb({ dataDir: dir });
  await migrate(db);
  await migrate(db); // idempotent
  await db.insert(actions).values({ seq: 1, actionId: "act_0001", ts: "2026-10-26T15:30:00Z", actorKind: "human", actorId: "usr_dana", command: "people.set_pay_rate", argsJson: "{}", argsHash: "h", summary: "s", reversible: "yes", prevHash: "0", hash: "h1" });
  await db.insert(approvalAudit).values({ seq: 1, proposalId: "prp_0001", principalId: "usr_dana", attempt: "approve", outcome: "ok", ts: "2026-10-26T15:30:00Z", prevHash: "0", hash: "h1" });
});
afterAll(async () => { await closeDb(db); rmSync(dir, { recursive: true, force: true }); });

describe("append-only triggers", () => {
  it("abort UPDATE and DELETE on actions", async () => {
    expect(await failure(db.run(sql`UPDATE actions SET summary = 'x' WHERE seq = 1`))).toMatch(/append-only/);
    expect(await failure(db.run(sql`DELETE FROM actions WHERE seq = 1`))).toMatch(/append-only/);
  });
  it("abort UPDATE and DELETE on approval_audit", async () => {
    expect(await failure(db.run(sql`UPDATE approval_audit SET outcome = 'x' WHERE seq = 1`))).toMatch(/append-only/);
    expect(await failure(db.run(sql`DELETE FROM approval_audit WHERE seq = 1`))).toMatch(/append-only/);
  });
  it("still allows INSERT", async () => {
    const rows = await db.select().from(actions);
    expect(rows).toHaveLength(1);
  });
});

describe("withWriteLock", () => {
  it("serializes writers in call order", async () => {
    const order: number[] = [];
    const slow = (n: number, ms: number) => withWriteLock(async () => { await new Promise((r) => setTimeout(r, ms)); order.push(n); });
    await Promise.all([slow(1, 20), slow(2, 0), slow(3, 5)]);
    expect(order).toEqual([1, 2, 3]);
  });
  it("keeps going after a failing writer", async () => {
    await expect(withWriteLock(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(withWriteLock(async () => 7)).resolves.toBe(7);
  });
});
