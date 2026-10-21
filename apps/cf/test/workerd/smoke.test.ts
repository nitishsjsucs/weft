import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Harness } from "../support/harness";

let h: Harness;
beforeAll(async () => { h = await Harness.start(); });
afterAll(async () => { await h?.close(); });

describe("harness", () => {
  it("serves the session status and provisions the pool", async () => {
    const r = await h.fetch("/api/_session");
    expect(r.status).toBe(200);
    const slots = await h.provision();
    expect(slots.map((s) => s.name).sort()).toEqual(["showcase", "slot-1", "slot-2", "slot-smoke"]);
  });
});
