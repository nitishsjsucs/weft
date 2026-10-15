import { describe, expect, it } from "vitest";
import { check } from "../src/index";

describe("grounding.check", () => {
  it("has the frozen signature", () => {
    expect(check("Net pay is $1,234.56", [{ net_cents: 123456 }])).toEqual({ ok: true, offending: [] });
  });
  it.todo("flags a number that no tool result contains (t4-agent)");
  it.todo("applies the cents rule: $1,234.56 matches 123456 in a *_cents field (t4-agent)");
});
