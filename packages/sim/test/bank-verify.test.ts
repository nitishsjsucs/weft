// Bank verification simulator (w2-onboarding): deterministic outcomes, last 4 digits only, fault target.
import { afterEach, describe, expect, it } from "vitest";
import { simBankVerifications } from "@weft/db";
import { createSimulators } from "../src/index";
import { simWorld, type SimTestWorld } from "./helpers";

let w: SimTestWorld | null = null;
afterEach(async () => { await w?.close(); w = null; });

describe("bankVerify simulator", () => {
  it("verifies a valid routing number, fails a bad checksum and a closed account, and stores last 4 digits only", async () => {
    w = await simWorld();
    const sims = createSimulators({ db: w.db, clock: w.clock });
    expect(await sims.bankVerify.verify({ workerId: "wrk_0100", routing: "021000021", accountLast4: "6789" })).toEqual({ status: "verified", reason: null });
    expect(await sims.bankVerify.verify({ workerId: "wrk_0100", routing: "021000022", accountLast4: "6789" })).toEqual({ status: "failed", reason: "routing number not found" });
    expect(await sims.bankVerify.verify({ workerId: "wrk_0100", routing: "021000021", accountLast4: "0000" })).toEqual({ status: "failed", reason: "account closed" });
    const rows = await w.db.select().from(simBankVerifications);
    expect(rows.map((r) => [r.id, r.routingLast4, r.accountLast4, r.status])).toEqual([["simk_0001", "0021", "6789", "verified"], ["simk_0002", "0022", "6789", "failed"], ["simk_0003", "0021", "0000", "failed"]]);
    expect(JSON.stringify(rows)).not.toContain("021000021");
  });

  it("throws at the bankVerify.verify fault target", async () => {
    w = await simWorld();
    const sims = createSimulators({ db: w.db, clock: w.clock });
    await sims.faults.arm({ target: "bankVerify.verify", kind: "error", mode: "once" });
    await expect(sims.bankVerify.verify({ workerId: "wrk_0100", routing: "021000021", accountLast4: "6789" })).rejects.toThrow(/bankVerify.verify/);
    expect((await sims.bankVerify.verify({ workerId: "wrk_0100", routing: "021000021", accountLast4: "6789" })).status).toBe("verified");
  });
});
