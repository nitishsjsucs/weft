import { describe, expect, it } from "vitest";
import { readConfig, SERVER_INSTRUCTIONS } from "../src/main";

describe("apps/mcp scaffold", () => {
  it("requires the mcp key and defaults the API URL", () => {
    expect(() => readConfig({})).toThrow(/WEFT_API_KEY/);
    expect(readConfig({ WEFT_API_KEY: "weft_sk_test" })).toEqual({ apiUrl: "http://127.0.0.1:4070", apiKey: "weft_sk_test" });
    expect(SERVER_INSTRUCTIONS).toMatch(/fictional/);
  });
});
