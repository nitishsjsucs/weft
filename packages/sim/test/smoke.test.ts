import { describe, expect, it } from "vitest";
import * as mod from "../src/index";

describe("@weft/sim scaffold", () => {
  it("exports the frozen factory as a NotImplemented stub", async () => {
    expect(typeof mod.createSimulators).toBe("function");
    await expect(Promise.resolve().then(() => (mod.createSimulators as (o: never) => unknown)({} as never))).rejects.toThrow(/Not implemented/);
  });
});
