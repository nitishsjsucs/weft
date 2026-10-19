// What the guided tour needs from seed profiles (owner: tour): GET /v1/health names the world's profile, and
// POST /v1/sim/reset takes a strict { profile }. The rebuild itself (a rich world stays rich, base keeps its digest)
// is covered by sim-reset-profile.test.ts, which owns packages/seed/src/profile.ts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { ensureTestPrincipals } from "@weft/core";
import { digestDb } from "@weft/seed";
import { SEED_PROFILE_SETTING } from "@weft/seed/profile";
import { createTestWeft, type TestWeft } from "../src/testing";

let weft: TestWeft;
beforeAll(async () => { weft = await createTestWeft(); await ensureTestPrincipals(weft.db); });
afterAll(async () => { await weft.close(); });
const post = (path: string, body: string | undefined) =>
  weft.app.request(path, { method: "POST", headers: { ...weft.uiHeaders("usr_dana"), "content-type": "application/json" }, body });
const health = async () => (await (await weft.app.request("/v1/health")).json()) as { seedProfile?: string };

describe("tour seed profile seam", () => {
  it("health reports base on the base world", async () => {
    expect((await health()).seedProfile).toBe("base");
  });

  it("health reads the profile row a rich world carries", async () => {
    await weft.db.run(sql`INSERT INTO settings (key, value_json) VALUES (${SEED_PROFILE_SETTING}, ${JSON.stringify("rich")})`);
    try {
      expect((await health()).seedProfile).toBe("rich");
    } finally {
      await weft.db.run(sql`DELETE FROM settings WHERE key = ${SEED_PROFILE_SETTING}`);
    }
    expect((await health()).seedProfile).toBe("base");
  });

  it("rejects an unknown profile or an extra key with 400, before touching the world", async () => {
    const before = await digestDb(weft.db);
    for (const body of [{ profile: "huge" }, { profile: "base", extra: 1 }, { profile: 3 }]) {
      const res = await post("/v1/sim/reset", JSON.stringify(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(await digestDb(weft.db)).toBe(before);
  });

  it("a reset with no body or {} keeps the base world and its digest, and says so", async () => {
    const before = await digestDb(weft.db);
    for (const body of [undefined, "{}"]) {
      const res = await post("/v1/sim/reset", body);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(expect.objectContaining({ ok: true, profile: "base" }));
      expect(await digestDb(weft.db)).toBe(before);
      await ensureTestPrincipals(weft.db);
    }
    expect((await health()).seedProfile).toBe("base");
  });
});
