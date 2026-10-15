import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestWeft, uiHeaders, type TestWeft } from "./scenarios/helpers";

let weft: TestWeft;
beforeAll(async () => { weft = await createTestWeft(); });
afterAll(async () => { await weft.close(); });

describe("createTestWeft", () => {
  it("builds a seeded world with a frozen clock and a non-live provider", async () => {
    expect(weft.clock.now()).toBe("2026-10-26T15:30:00.000Z");
    expect(weft.clock.rate()).toBe(0);
    expect(weft.provider.live).toBe(false);
    await weft.scheduler.tick();   // tolerates stubbed parts
  });
  it("uiHeaders carries the generated proxy secret", () => {
    expect(uiHeaders("usr_dana")).toEqual({ "x-weft-principal": "usr_dana", "x-weft-proxy": weft.proxySecret });
  });
});
