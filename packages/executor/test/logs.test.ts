import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Simulators } from "@weft/contracts";
import { createSimClock, SEED_TIME, type WeftCommand } from "@weft/core";
import { closeDb, migrate, openDb } from "@weft/db";
import { createExecutor, encodings } from "../src/index";
import { CMP, fakeSims, fixtureCommands, seedFixtureRows } from "./fixtures";
import { seedGovernance } from "../../seed/src/governance";

const leaky: WeftCommand = {
  ...fixtureCommands[0]!, name: "people.leaky", summary: "Leaky", description: "Throws with a credential in the message.", input: z.object({}), effect: "draft", risk: () => "R1",
  async run(_i, _ctx, deps) { const v = await deps.resolveCredential("vault:ca-edd-portal"); throw new Error(`login failed for ${v} (${Buffer.from(v).toString("hex")})`); },
};

describe("redaction of logs and refusal messages", () => {
  it("an INTERNAL error that carries a vault value is redacted in the outcome and the captured log", async () => {
    const dir = mkdtempSync(join(tmpdir(), "weft-logs-"));
    const db = openDb({ dataDir: dir });
    await migrate(db);
    const clock = await createSimClock({ db, initial: { at: SEED_TIME, rate: 0 } });
    await seedFixtureRows(db);
    const lines: string[] = [];
    const ex = await createExecutor({ db, clock, dataDir: dir, commands: [...fixtureCommands, leaky], simulators: fakeSims as never, testMode: true, log: (l) => lines.push(l) });
    await seedGovernance({ db, clock, executor: ex, sims: {} as Simulators, dataDir: dir, companyId: CMP, faker: null as never });
    const h = await ex.runs.openChatRun({ principalId: "usr_dana", companyId: CMP, via: "ui", keyScope: null }, { threadId: null, surface: "human_ui" });
    const o = await ex.agent.exec(h, { callId: "1", command: "people.leaky", args: {} });
    expect(!o.ok && o.refusal.code).toBe("INTERNAL");
    const [row] = await db.all<{ value: string }>(`SELECT name AS value FROM vault_secrets WHERE name = 'ca-edd-portal'` as never);
    expect(row).toBeTruthy();
    // recover the plaintext through the executor's own resolver to know what to look for
    const { executorInternals } = await import("../src/index");
    const value = await executorInternals(ex)!.engine.vault.resolve(db, "vault:ca-edd-portal");
    const text = JSON.stringify(o) + lines.join("\n");
    expect(lines.length).toBeGreaterThan(0);
    for (const f of encodings(value)) expect(text.includes(f), f).toBe(false);
    await closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  });
});
