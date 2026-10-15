import { describe, expect, it } from "vitest";
import * as mod from "../src/index";

describe("@weft/routines scaffold", () => {
  it("exports the frozen factory as a NotImplemented stub", async () => {
    expect(typeof mod.createRoutines).toBe("function");
    await expect(Promise.resolve().then(() => (mod.createRoutines as (o: never) => unknown)({} as never))).rejects.toThrow(/Not implemented/);
  });
});
