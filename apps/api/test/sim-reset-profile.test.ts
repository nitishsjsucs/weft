// POST /v1/sim/reset keeps the world's seed profile: a rich dev world (pnpm dev) comes back rich after the tour or a
// demo reset, a base world (tests, pnpm e2e) comes back base, and { profile } picks one explicitly.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { ensureTestPrincipals } from "@weft/core";
import { digestDb } from "@weft/seed";
import { readSeedProfile, seedWorldProfile } from "@weft/seed/profile";
import { createTestWeft, type TestWeft } from "../src/testing";

let weft: TestWeft;
let baseDigest: string;
beforeAll(async () => {
  const fresh = await createTestWeft();
  baseDigest = await digestDb(fresh.db);
  await fresh.close();
  weft = await createTestWeft({ seed: false });
  await seedWorldProfile(weft, "rich");
  await ensureTestPrincipals(weft.db);
}, 120_000);
afterAll(async () => { await weft.close(); });

const reset = async (body: unknown = {}) => {
  const res = await weft.app.request("/v1/sim/reset", { method: "POST", headers: { ...weft.uiHeaders("usr_dana"), "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as { ok: boolean; profile: string } };
};
const runs = async () => (await weft.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM agent_runs`))[0]!.n;

describe("POST /v1/sim/reset and seed profiles", () => {
  it("rebuilds a rich world as rich", async () => {
    expect(await readSeedProfile(weft.db)).toBe("rich");
    const r = await reset();
    expect(r).toEqual({ status: 200, json: expect.objectContaining({ ok: true, profile: "rich" }) });
    expect(await readSeedProfile(weft.db)).toBe("rich");
    expect(await runs()).toBeGreaterThanOrEqual(20);
  }, 120_000);

  it("rebuilds the base world on request, and a base world stays base", async () => {
    const r = await reset({ profile: "base" });
    expect(r.json.profile).toBe("base");
    expect(await readSeedProfile(weft.db)).toBe("base");
    await ensureTestPrincipals(weft.db);
    expect((await reset()).json.profile).toBe("base");
    expect(await digestDb(weft.db)).toBe(baseDigest);
  }, 120_000);
});
