// Memory fact lines as copy (owner: layout-and-ui): provenance dates and engine values read as words.
import { describe, expect, it } from "vitest";
import { memoryText } from "../src/components/app/memory/memory-view";

describe("memoryText", () => {
  it("reads a seeded fact's provenance and its date as words", () => {
    expect(memoryText("- Start date 2024-03-04 (2026-10-26, src: seed)")).toBe("- Start date Mar 4, 2024 (as of Oct 26, from setup)");
  });
  it("labels an engine status value", () => {
    expect(memoryText("- Status active (2026-10-26, src: seed)")).toBe("- Status Active (as of Oct 26, from setup)");
  });
  it("leaves a code span and a plain line alone", () => {
    expect(memoryText("3. Propose `tax.update_rate` with the notice as the source.")).toBe("3. Propose `tax.update_rate` with the notice as the source.");
  });
});
