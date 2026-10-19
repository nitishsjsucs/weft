// The explanation-coverage end-state check (demo-perfect round 2): on a pay run, every needs_review paycheck's saved
// explanation speaks to each of its review and block flags, by the same words payroll.explain_flags names back to the
// agent (packages/core/src/payroll/explain.ts FLAG_COVERAGE_WORDS). A note that covers one flag of three, or a later
// item that overwrote an earlier one, leaves a row this query counts. Tasks pin it with "equals": 0.
import { FLAG_COVERAGE_WORDS } from "../../packages/core/src/payroll/explain";

const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;

/** One SELECT: the count of (paycheck, flag) pairs on runId whose explanation is missing or does not cover the flag. */
export function flagCoverageSql(runId: string): string {
  const cases = Object.entries(FLAG_COVERAGE_WORDS)
    .map(([rule, words]) => `WHEN ${lit(rule)} THEN ${(words ?? []).map((w) => `instr(lower(p.explanation), ${lit(w)}) > 0`).join(" OR ")}`)
    .join(" ");
  return `SELECT COUNT(*) AS n FROM paychecks p, json_each(p.flags_json) f WHERE p.payroll_run_id = ${lit(runId)} AND p.review_group = 'needs_review' AND json_extract(f.value, '$.severity') <> 'info' AND (p.explanation IS NULL OR NOT (CASE json_extract(f.value, '$.rule') ${cases} ELSE 1 END))`;
}
