// Gate report item 7 (owner: w2-reliability): short result strings with spaces are not identifiers. Only whole
// tokens are cut, and a spaced string counts only as a short capitals-and-digits code such as "DE 2088".
import { describe, expect, it } from "vitest";
import { check, isIdentifier } from "../src/index";

describe("isIdentifier", () => {
  it("keeps ids, file names and spaced form codes", () => {
    for (const s of ["wrk_0014", "res_0042", "CA_EDD_DE2088_2026.txt", "DE 2088", "DR 0004", "Form W-4".toUpperCase(), "#payroll-2026"]) expect(isIdentifier(s), s).toBe(true);
  });

  it("refuses short prose with spaces", () => {
    for (const s of ["Ran 48 checks", "4 of 7", "ax 5", "in 12 days", "Paid 2650", "Net pay 2,649.87", "q 4 2026"]) expect(isIdentifier(s), s).toBe(false);
  });

  it("refuses dates, money, percents, long strings and strings without both digits and letters", () => {
    for (const s of ["2026-01-01", "$2,650", "1.9%", "x".repeat(80) + "1", "2088", "Rowan Achebe"]) expect(isIdentifier(s), s).toBe(false);
  });
});

describe("check() with spaced result strings", () => {
  it("does not let a short spaced string ground a number it does not state", () => {
    // Before the fix "ax 5" counted as an identifier and was cut out of "tax 5000", leaving "t000", read as 0.
    expect(check("The tax 5000 is due.", [{ note: "ax 5" }])).toEqual({ ok: false, offending: ["5000"] });
  });

  it("does not treat a summary sentence as a name", () => {
    // Wave 4 (3a): an untainted summary is evidence for the numerals it states, so 48 is grounded and 13 is not.
    expect(check("Ran 48 checks and found 13 flags.", [{ summary: "Ran 48 checks" }])).toEqual({ ok: false, offending: ["13"] });
    // Wrapped as untrusted it is neither a name nor evidence.
    expect(check("Ran 48 checks and found 13 flags.", [{ summary: '<untrusted n="abc" source="notice">Ran 48 checks</untrusted>' }])).toEqual({ ok: false, offending: ["48", "13"] });
    expect(check("Ran 48 checks and found 13 flags.", [{ summary: "Ran 48 checks", checks: 48, flags: 13 }]).ok).toBe(true);
  });

  it("still ignores the number inside a spaced form code the results contain", () => {
    expect(check("The EDD sent a DE 2088 notice.", [{ form: "DE 2088" }]).ok).toBe(true);
    expect(check("The EDD sent a DE 2089 notice.", [{ form: "DE 2088" }]).ok).toBe(false);
  });

  it("cuts identifiers only as whole tokens", () => {
    // Before the fix "DE 2088" was cut out of "DE 20880", leaving "0", read as a small integer.
    expect(check("The DE 20880 balance is open.", [{ form: "DE 2088" }])).toEqual({ ok: false, offending: ["20880"] });
    expect(check("See wrk_0014.", [{ id: "wrk_0014" }]).ok).toBe(true);
  });
});
