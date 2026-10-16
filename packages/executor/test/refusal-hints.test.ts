// A Refused error's own extra.hint and extra.example (values derived for this call) win over the command's static
// errorHints; without them the static hint is used (t2 finding, SPEC 9.2 refusal shape).
import { describe, expect, it } from "vitest";
import { Refused } from "@weft/contracts";
import type { WeftCommand } from "@weft/core";
import { hintsOfError, refusal } from "../src/outcome";

const def = { errorHints: { DOMAIN_NOTICE_MISMATCH: { hint: "static hint", example: { rate: "0.000" } } } } as unknown as WeftCommand;

describe("refusal hints", () => {
  it("prefers the derived hint and example from a Refused error", () => {
    const err = new Refused("DOMAIN_NOTICE_MISMATCH", "mismatch", { hint: "Use txa_0002, sui, 0.015 from 2026-01-01", example: { tax_account_id: "txa_0002", rate: "0.015" } });
    const out = refusal("DOMAIN_NOTICE_MISMATCH", "mismatch", false, def, hintsOfError(err));
    expect(out).toMatchObject({ ok: false, refusal: { hint: "Use txa_0002, sui, 0.015 from 2026-01-01", example: { tax_account_id: "txa_0002", rate: "0.015" } } });
  });
  it("falls back to the static errorHints", () => {
    const out = refusal("DOMAIN_NOTICE_MISMATCH", "mismatch", false, def, hintsOfError(new Error("plain")));
    expect(out).toMatchObject({ refusal: { hint: "static hint", example: { rate: "0.000" } } });
  });
});
