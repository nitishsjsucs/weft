// notices.escalate procedure_ref (wave 4 round 2, FG2; docs/evals/round1-analysis.md R3). The core schema accepts only
// a knowledge/procedures/ note path; the executor checks that the note exists and is untainted (packages/executor
// memory/citations.ts), and the escalation records it, returns it in its data and names it in its summary
// (packages/routines/test/agency-notice-procedure.test.ts runs the whole path).
import { describe, expect, it } from "vitest";
import { parityCommands, PROCEDURE_REF } from "../src/commands/parity";

const escalate = parityCommands.find((c) => c.name === "notices.escalate")!;
const parse = (procedure_ref: unknown) => escalate.input.safeParse({ notice_id: "ntc_0001", reason_code: "missing_filing", ...(procedure_ref === undefined ? {} : { procedure_ref }) }).success;

describe("notices.escalate procedure_ref", () => {
  it("is optional and stays R1 with no approval", () => {
    expect(parse(undefined)).toBe(true);
    expect(escalate).toMatchObject({ approval: "never", tiers: { main: "executable" } });
    expect(escalate.risk({} as never)).toBe("R1");
    expect(escalate.description.length).toBeLessThanOrEqual(400);
    expect(escalate.description).toContain("procedure_ref");
  });

  it("accepts only a knowledge/procedures/ Markdown path", () => {
    expect(parse("knowledge/procedures/notice-escalation.md")).toBe(true);
    expect(parse("knowledge/procedures/tax/state-sui-rate-notice.md")).toBe(true);
    for (const bad of ["knowledge/decisions/DEC-0001.md", "knowledge/procedures/x.txt", "/knowledge/procedures/x.md", "entities/people/wrk_0001.md", "knowledge/procedures/", "", 7]) {
      expect(parse(bad), String(bad)).toBe(false);
    }
    expect(PROCEDURE_REF.test("knowledge/procedures/../decisions/x.md")).toBe(false);
    // A deeper climb fits the shape; the executor normalizes the path and refuses it (memory-procedures.test.ts).
    expect(PROCEDURE_REF.test("knowledge/procedures/a/../../decisions/x.md")).toBe(true);
  });
});
