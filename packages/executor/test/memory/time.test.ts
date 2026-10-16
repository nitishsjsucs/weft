// Human-facing times in memory files (memory/time.ts): company time zone, the app's fmtDateTime style, machine
// shapes left alone, idempotent.
import { describe, expect, it } from "vitest";
import { companyDay, fmtDateTimePT, humanTimes } from "../../src/memory/time";

describe("memory times", () => {
  it("formats an instant like the payroll page does, in Pacific time", () => {
    expect(fmtDateTimePT("2026-10-29T00:00:00.000Z")).toBe("Wed, Oct 28, 5:00 PM PT");
    expect(fmtDateTimePT("2026-11-02T17:00:00.000Z")).toBe("Mon, Nov 2, 9:00 AM PT");   // after the DST change
    expect(fmtDateTimePT("2026-10-29T00:00:00.000Z")).not.toMatch(/[  ]/);
  });

  it("dates by the company calendar day", () => {
    expect(companyDay("2026-10-29T00:00:00.000Z")).toBe("2026-10-28");
    expect(companyDay("2026-10-29T08:00:00.000Z")).toBe("2026-10-29");
    expect(companyDay("2026-10-30")).toBe("2026-10-30");
  });

  it("rewrites instants in text, leaves dates, period keys and paths, and is idempotent", () => {
    const line = "Submitted pay_2026_10_30, settles 2026-10-30T13:00:00.000Z, payday 2026-10-30 (ref: timeline/hourly/2026-10-09T17.md)";
    const once = humanTimes(line);
    expect(once).toBe("Submitted pay_2026_10_30, settles Fri, Oct 30, 6:00 AM PT, payday 2026-10-30 (ref: timeline/hourly/2026-10-09T17.md)");
    expect(humanTimes(once)).toBe(once);
    expect(humanTimes("at 2026-10-30T06:00:00-07:00")).toBe("at Fri, Oct 30, 6:00 AM PT");
  });
});
