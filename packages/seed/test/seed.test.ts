import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { closeDb, migrate, openDb } from "@weft/db";
import { createSimClock } from "@weft/core";
import { digestDb, SEED_STEPS, seedWorld, SEED_CLOCK } from "../src/index";

async function seededDigest(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "weft-seed-"));
  const db = openDb({ dataDir: dir });
  try {
    await migrate(db);
    const clock = await createSimClock({ db, initial: { at: SEED_CLOCK, rate: 0 } });
    await seedWorld({ db, clock, executor: {} as never, sims: {} as never, dataDir: dir });
    expect(clock.now()).toBe(SEED_CLOCK);
    return await digestDb(db);
  } finally { await closeDb(db); rmSync(dir, { recursive: true, force: true }); }
}

describe("seed", () => {
  it("runs the SPEC 5 step order", () => {
    expect(SEED_STEPS.map(([n]) => n)).toEqual(["company", "people", "benefits", "tax", "it", "governance", "actions", "payroll"]);
  });
  it("is deterministic: two seeds give the same digest", async () => {
    expect(await seededDigest()).toBe(await seededDigest());
  });
});
