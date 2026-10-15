// Contract tests for GET /v1/stats (public; owner: t2-world).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Stats } from "@weft/contracts";
import { createTestWeft, type TestWeft } from "../src/testing";

let weft: TestWeft;
beforeAll(async () => { weft = await createTestWeft(); });
afterAll(async () => { await weft.close(); });

describe("GET /v1/stats", () => {
  it("is public and counts the seeded world", async () => {
    const res = await weft.app.request("/v1/stats");
    expect(res.status).toBe(200);
    const s = Stats.parse(await res.json());
    expect(s).toMatchObject({ employees: 48, contractors: 3, simulatedAgencies: 7, realAgenciesContacted: 0 });
  });
});
