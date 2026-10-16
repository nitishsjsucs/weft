// Raw ISO instants in server text (audit summaries, tool outcomes, refusals, headlines) read in Pacific time, in the
// same style as the payroll page and the memory files.
import { describe, expect, it } from "vitest";
import type { RunStepRow } from "@weft/contracts";
import { fmtDateTime, humanTimes } from "../src/components/app/format";
import { stepSummary } from "../src/components/app/agent/run-steps";
import { fmtDateTimePT } from "../../../packages/executor/src/memory/time";

const plain = (s: string) => s.replace(/[  ]/g, " ");

describe("humanTimes", () => {
  it("rewrites instants in audit summaries and leaves dates, ids and hashes alone", () => {
    expect(plain(humanTimes("Submitted pay_2026_10_30: 47 paychecks, $168,619.15 to the bank, settles 2026-10-30T13:00:00.000Z; excluded wrk_0022")))
      .toBe("Submitted pay_2026_10_30: 47 paychecks, $168,619.15 to the bank, settles Fri, Oct 30, 6:00 AM PT; excluded wrk_0022");
    expect(humanTimes("No draft has its approval deadline on 2026-10-26 PT.")).toBe("No draft has its approval deadline on 2026-10-26 PT.");
    expect(humanTimes("cron slot timeline/hourly/2026-10-09T17.md, sha256 1ff507ce")).toBe("cron slot timeline/hourly/2026-10-09T17.md, sha256 1ff507ce");
    const once = humanTimes("expired at 2026-10-29T00:00:00.000Z");
    expect(humanTimes(once)).toBe(once);
  });

  it("matches the memory files' formatter, so the one-pager and the payroll page agree", () => {
    expect(plain(fmtDateTime("2026-10-29T00:00:00.000Z"))).toBe(fmtDateTimePT("2026-10-29T00:00:00.000Z"));
    expect(plain(fmtDateTime("2026-11-02T17:00:00.000Z"))).toBe(fmtDateTimePT("2026-11-02T17:00:00.000Z"));
  });

  it("step chips in the run view and agent panel show tool summaries in Pacific time", () => {
    const s = { runId: "run_0001", n: 5, parentN: null, stage: "dispatch", kind: "tool_call", callId: "c", toolName: "payroll__submit_run", toolArgs: null,
      outcome: "ok", result: { output: "{}", outcome: { ok: true, status: "done", summary: "Submitted pay_2026_10_30: 47 paychecks, settles 2026-10-30T13:00:00.000Z" } },
      native: null, usage: null, costUsdMicros: 0, attempt: 1, requestId: null, prefixHash: null, timings: null, createdAt: "2026-10-26T15:30:00.000Z" } as RunStepRow;
    expect(plain(stepSummary(s))).toBe("Submitted pay_2026_10_30: 47 paychecks, settles Fri, Oct 30, 6:00 AM PT");
  });
});
