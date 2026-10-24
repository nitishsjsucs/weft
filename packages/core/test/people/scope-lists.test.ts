// The list helpers of the manager read scope (packages/core/src/people/scope.ts): which rows a narrowed person keeps,
// what the access block and the single-record refusal say. Pure functions; no database.
import { describe, expect, it } from "vitest";
import { hiringManagerInScope, outsideReports, reportsAccess, splitByScope, type ReadScope } from "../../src/people/scope";

const imani: ReadScope = { viewerId: "usr_imani", display: "Imani Ferreira", role: "manager", selfWorkerId: "wrk_0004", reports: new Set(["wrk_0010", "wrk_0011"]), grants: { people: "view", payroll: "none" } };
const rows = [{ w: "wrk_0004" }, { w: "wrk_0010" }, { w: "wrk_0003" }, { w: null }, { w: "wrk_0011" }];

describe("splitByScope", () => {
  it("keeps her own record and her reports, counts the rest, and drops a row about no one", () => {
    const { shown, withheld } = splitByScope(imani, rows, (r) => r.w);
    expect(shown.map((r) => r.w)).toEqual(["wrk_0004", "wrk_0010", "wrk_0011"]);
    expect(withheld).toBe(2);
  });
  it("keeps every row when the read is not narrowed", () => {
    expect(splitByScope(null, rows, (r) => r.w)).toEqual({ shown: rows, withheld: 0 });
  });
});

describe("the words a narrowed read carries", () => {
  it("the access block names the rows withheld and tells the model to decline", () => {
    const a = reportsAccess(imani, "time-off requests", 7);
    expect(a).toMatchObject({ scope: "reports", withheld_rows: 7 });
    expect(a.reason).toContain("Imani Ferreira is a manager: time-off requests are shared only for their own record");
    expect(a.reason).toContain("cannot share");
  });
  it("the single-record refusal never says whether the record exists", () => {
    const r = outsideReports(imani, "offboarding cases");
    expect(r.code).toBe("DOMAIN_OUTSIDE_REPORTS");
    expect(r.message).not.toMatch(/ofb_|wrk_|exists|no such/i);
  });
  it("an offer is hers when she or a report is the hiring manager", () => {
    expect(hiringManagerInScope(imani, "wrk_0004")).toBe(true);
    expect(hiringManagerInScope(imani, "wrk_0010")).toBe(true);
    expect(hiringManagerInScope(imani, "wrk_0003")).toBe(false);
    expect(hiringManagerInScope(imani, null)).toBe(false);
    expect(hiringManagerInScope(null, null)).toBe(true);
  });
});
