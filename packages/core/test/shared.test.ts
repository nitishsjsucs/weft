import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, migrate, openDb, events, type Db } from "@weft/db";
import { canonicalJson, commands, createSimClock, emitEvent, formatCents, handlers, newId, SEED_TIME, sha256Hex } from "../src/index";

let dir: string;
let db: Db;
beforeAll(async () => { dir = mkdtempSync(join(tmpdir(), "weft-core-")); db = openDb({ dataDir: dir }); await migrate(db); });
afterAll(async () => { await closeDb(db); rmSync(dir, { recursive: true, force: true }); });

describe("shared", () => {
  it("canonicalJson sorts keys and sha256Hex matches node:crypto", () => {
    expect(canonicalJson({ b: 1, a: [true, null, "x"] })).toBe('{"a":[true,null,"x"],"b":1}');
    const text = canonicalJson({ run: "pay_2026_10_30", net: 123456 });
    expect(sha256Hex(text)).toBe(createHash("sha256").update(text).digest("hex"));
    expect(() => canonicalJson({ x: 1.5 })).toThrow();
  });
  it("formatCents uses integer cents", () => {
    expect(formatCents(189900)).toBe("$1,899.00");
    expect(formatCents(-5)).toBe("-$0.05");
  });
  it("SimClock with rate 0 is frozen, persists and advances", async () => {
    let wall = 1_000;
    const clock = await createSimClock({ db, initial: { at: SEED_TIME, rate: 0 }, wall: () => wall });
    wall += 60_000;
    expect(clock.now()).toBe(SEED_TIME);
    await clock.advance("2026-10-26T16:00:00.000Z");
    expect(clock.now()).toBe("2026-10-26T16:00:00.000Z");
    await expect(clock.advance("2026-10-01T00:00:00.000Z")).rejects.toThrow(/before now/);
    const again = await createSimClock({ db, wall: () => wall });
    expect(again.now()).toBe("2026-10-26T16:00:00.000Z");
    await clock.set(SEED_TIME, 60);
    wall += 1_000;
    expect(clock.now()).toBe("2026-10-26T15:31:00.000Z");
    await clock.set(SEED_TIME, 0);
  });
  it("newId counts per prefix", async () => {
    expect(await newId(db, "wrk_")).toBe("wrk_0001");
    expect(await newId(db, "wrk_")).toBe("wrk_0002");
    expect(await newId(db, "offr_")).toBe("offr_0001");
  });
  it("emitEvent validates id-only payloads", async () => {
    const clock = await createSimClock({ db });
    const evt = await emitEvent(db, clock, { body: { type: "notice.received", payload: { notice_id: "ntc_0001" } }, subjectRef: "ntc_0001", attended: true, requestedBy: "usr_dana" });
    expect(evt.id).toBe("evt_0001");
    expect((await db.select().from(events)).length).toBe(1);
    await expect(emitEvent(db, clock, { body: { type: "notice.received", payload: { notice_id: "free text" } } as never, subjectRef: "x", attended: false, requestedBy: null })).rejects.toThrow();
  });
  it("command and handler arrays are arrays (tracks append to them)", () => {
    expect(Array.isArray(commands)).toBe(true);
    expect(Array.isArray(handlers)).toBe(true);
  });
});
