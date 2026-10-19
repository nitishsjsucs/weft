// The pre-payroll task's explanation-coverage check (evals/suite/coverage.ts): RT-02 pins it, and on a small table it
// counts the paycheck whose note speaks to one flag of two (the last-write-wins slip), not the one that covers both.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { flagCoverageSql } from "../evals/suite/coverage";

const ROOT = join(import.meta.dirname, "..");

describe("explanation coverage end-state check", () => {
  it("RT-02 pins it on the Oct 30 draft with equals 0", () => {
    const t = JSON.parse(readFileSync(join(ROOT, "evals/suite/tasks/dev/RT-02.json"), "utf8")) as { expect: { default: { endState: { sql: string; equals: unknown }[] } } };
    expect(t.expect.default.endState).toContainEqual({ sql: flagCoverageSql("pay_2026_10_30"), equals: 0 });
  });

  it("counts each review or block flag a saved explanation misses, and a missing explanation", async () => {
    const db = createClient({ url: ":memory:" });
    try {
      await db.execute("CREATE TABLE paychecks (id TEXT, payroll_run_id TEXT, review_group TEXT, flags_json TEXT, explanation TEXT)");
      const flags = JSON.stringify([
        { rule: "NEW_IN_RUN", severity: "review", message: "", evidence: {} },
        { rule: "MISSING_BANK_ACCOUNT", severity: "block", message: "", evidence: {} },
        { rule: "TOTAL_CHANGE", severity: "info", message: "", evidence: {} },
      ]);
      const rows: [string, string | null][] = [
        ["pyc_1", "First paycheck in this schedule. No active bank account, so this paycheck is blocked."],
        ["pyc_2", "No active bank account for direct deposit; paycheck is blocked."],
        ["pyc_3", null],
      ];
      for (const [id, e] of rows) await db.execute({ sql: "INSERT INTO paychecks VALUES (?, 'pay_x', 'needs_review', ?, ?)", args: [id, flags, e] });
      await db.execute({ sql: "INSERT INTO paychecks VALUES ('pyc_4', 'pay_other', 'needs_review', ?, NULL)", args: [flags] });
      const r = await db.execute(flagCoverageSql("pay_x"));
      // pyc_2 misses NEW_IN_RUN (1); pyc_3 has no note, so both of its review and block flags count (2); info is skipped.
      expect(Number(r.rows[0]!.n)).toBe(3);
    } finally {
      db.close();
    }
  });
});
