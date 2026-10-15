import { describe, expect, it } from "vitest";
import * as mod from "../src/index";

describe("@weft/executor scaffold", () => {
  it("exports the frozen factory as a NotImplemented stub", async () => {
    expect(typeof mod.createExecutor).toBe("function");
    await expect(Promise.resolve().then(() => (mod.createExecutor as (o: never) => unknown)({} as never))).rejects.toThrow(/Not implemented/);
  });
});
