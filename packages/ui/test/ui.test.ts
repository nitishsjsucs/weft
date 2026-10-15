import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cn, ACCENT_9 } from "../src/index";

const tokens = readFileSync(new URL("../src/tokens.css", import.meta.url), "utf8");

describe("@weft/ui", () => {
  it("cn merges Tailwind classes, last wins", () => {
    expect(cn("px-2 text-sm", false && "hidden", "px-4")).toBe("text-sm px-4");
  });
  it("tokens use the madder accent and the renamed effects", () => {
    expect(tokens).toContain(`--accent-9: ${ACCENT_9}`);
    for (const c of [".weft-hatch", ".weft-hatch-strong", ".weft-rule"]) expect(tokens).toContain(c);
    expect(tokens).not.toMatch(/\.text-lined|\.border-lined|#fa4800/);
  });
});
