// Seed profiles for the guided tour (owner: tour): POST /v1/sim/reset { profile }, GET /v1/health seedProfile, and
// the rich layer seam. The base world and its digest never change.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { ensureTestPrincipals } from "@weft/core";
import { digestDb } from "@weft/seed";
import { createTestWeft, type TestWeft } from "../src/testing";
import { applyProfile, envProfile, loadRichLayer, storedProfile } from "../src/seed-profile";

let weft: TestWeft;
beforeAll(async () => { weft = await createTestWeft(); await ensureTestPrincipals(weft.db); });
afterAll(async () => { await weft.close(); });
const post = (path: string, body: unknown) => weft.app.request(path, { method: "POST", headers: { ...weft.uiHeaders("usr_dana"), "content-type": "application/json" }, body: JSON.stringify(body) });

describe("seed profiles", () => {
  it("reads WEFT_SEED_PROFILE, defaulting to base", () => {
    expect(envProfile({})).toBe("base");
    expect(envProfile({ WEFT_SEED_PROFILE: "rich" })).toBe("rich");
    expect(envProfile({ WEFT_SEED_PROFILE: "huge" })).toBe("base");
  });

  it("health reports base on the base world", async () => {
    const res = await weft.app.request("/v1/health");
    expect((await res.json()).seedProfile).toBe("base");
    expect(await storedProfile(weft.db)).toBeNull();
  });

  it("reset with no body or {} keeps the base world and its digest", async () => {
    const before = await digestDb(weft.db);
    const res = await post("/v1/sim/reset", {});
    expect(res.status).toBe(200);
    expect((await res.json()).profile).toBe("base");
    expect(await digestDb(weft.db)).toBe(before);
    await ensureTestPrincipals(weft.db);
  });

  it("rejects an unknown profile with 400", async () => {
    const res = await post("/v1/sim/reset", { profile: "huge" });
    expect(res.status).toBe(400);
    expect((await post("/v1/sim/reset", { profile: "base", extra: 1 })).status).toBe(400);
  });

  it("a rich reset reports the profile the world got, and health agrees", async () => {
    const layer = await loadRichLayer();
    const res = await post("/v1/sim/reset", { profile: "rich" });
    expect(res.status).toBe(200);
    const got = (await res.json()).profile;
    expect(got).toBe(layer ? "rich" : "base");
    expect((await (await weft.app.request("/v1/health")).json()).seedProfile).toBe(got);
    await ensureTestPrincipals(weft.db);
    // Back to base for whatever runs next in this file.
    expect((await (await post("/v1/sim/reset", { profile: "base" })).json()).profile).toBe("base");
    await ensureTestPrincipals(weft.db);
  });

  it("applyProfile runs the layer and records the key; base is a no-op", async () => {
    let ran = 0;
    expect(await applyProfile(weft, "base", async () => { ran++; })).toBe("base");
    expect(ran).toBe(0);
    expect(await applyProfile(weft, "rich", null)).toBe("base");
    expect(await applyProfile(weft, "rich", async () => { ran++; })).toBe("rich");
    expect(ran).toBe(1);
    expect(await storedProfile(weft.db)).toBe("rich");
    // An omitted profile keeps the world's own: this world now says rich.
    await weft.db.run(sql`DELETE FROM settings WHERE key = 'seed.profile'`);
    expect(await storedProfile(weft.db)).toBeNull();
  });
});
