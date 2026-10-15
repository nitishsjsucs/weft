import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { closeDb, migrate, openDb } from "@weft/db";
import { commands, createSimClock } from "@weft/core";
import { createExecutor } from "@weft/executor";
import { createSimulators } from "@weft/sim";
import { digestDb, SEED_STEPS, seedWorld, SEED_CLOCK } from "../src/index";

async function seededDigest(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "weft-seed-"));
  const db = openDb({ dataDir: dir });
  try {
    await migrate(db);
    const clock = await createSimClock({ db, initial: { at: SEED_CLOCK, rate: 0 } });
    // The governance step writes the vault through the executor and the payroll step submits bank batches through
    // the bank simulator, so the seed needs the real parts.
    const executor = await createExecutor({ db, clock, dataDir: dir, commands, simulators: createSimulators, testMode: true });
    try {
      await seedWorld({ db, clock, executor, sims: createSimulators({ db, clock }), dataDir: dir });
    } finally { await executor.close(); }
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
