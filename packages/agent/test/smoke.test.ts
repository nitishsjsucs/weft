import { describe, expect, it } from "vitest";
import * as mod from "../src/index";

describe("@weft/agent scaffold", () => {
  it("exports the frozen factory as a NotImplemented stub", async () => {
    expect(typeof mod.createAgentRuntime).toBe("function");
    await expect(Promise.resolve().then(() => (mod.createAgentRuntime as (o: never) => unknown)({} as never))).rejects.toThrow(/Not implemented/);
  });
});
