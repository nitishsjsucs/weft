// Round 1 analysis R8 (docs/evals/round1-analysis.md): a day range after a month name was read as a date plus a bare
// number, so CP-04's "November 23 to 27, 2026" had its "27" refused although 2026-11-27 was in the result.
import { describe, expect, it } from "vitest";
import { check, datesIn, readTextDates } from "../src/index";

const EN_DASH = "\u2013";
const request = [{ resultId: "res_0003", data: { requests: [{ id: "tor_0003", start_date: "2026-11-23", end_date: "2026-11-27", conflict_dates: ["2026-11-23", "2026-11-25"] }] } }];
const key = (s: string) => readTextDates(s).dates.map((k) => `${k.y}-${k.m}-${k.d}`);

describe("R8: a month day range is two dates", () => {
  it("reads every joining form, with and without a year", () => {
    const forms: [string, string[]][] = [
      ["November 23 to 27, 2026", ["2026-11-23", "2026-11-27"]],
      ["November 23 to 27 2026", ["2026-11-23", "2026-11-27"]],
      ["November 23 to 25", ["0-11-23", "0-11-25"]],
      ["Nov 23-27", ["0-11-23", "0-11-27"]],
      ["Nov. 23 - 27, 2026", ["2026-11-23", "2026-11-27"]],
      [`November 23${EN_DASH}27, 2026`, ["2026-11-23", "2026-11-27"]],
      [`November 23 ${EN_DASH} 25`, ["0-11-23", "0-11-25"]],
      ["November 23 through 27", ["0-11-23", "0-11-27"]],
      ["November 23rd to 27th, 2026", ["2026-11-23", "2026-11-27"]],
    ];
    for (const [text, want] of forms) {
      expect(key(text), text).toEqual(want);
      expect(check(`Ruth is off ${text}.`, request), text).toEqual({ ok: true, offending: [] });
    }
  });

  it("CP-04 shape: the draft the round 1 guard refused for 27 and 25 now keeps its dates", () => {
    const draft = `Ruth Okoro's pending request is tor_0003, for November 23${EN_DASH}27, 2026. It has a coverage conflict, with 3 of 9 out on November 23${EN_DASH}25.`;
    expect(check(draft, request)).toEqual({ ok: true, offending: [] });
    expect(check("Ruth is off November 23 to 27, 2026 and November 23 to 25.", request).ok).toBe(true);
  });

  it("refuses a range whose second day no record holds, naming the whole range", () => {
    expect(check("Ruth is off November 23 to 28, 2026.", request)).toEqual({ ok: false, offending: ["November 23 to 28, 2026"] });
    expect(check(`Ruth is off Nov 24${EN_DASH}27.`, request)).toEqual({ ok: false, offending: [`Nov 24${EN_DASH}27`] });
  });

  it("still checks a bare number written right after a range", () => {
    expect(check("Ruth is off November 23 to 27, 2026, 45 hours in all.", request)).toEqual({ ok: false, offending: ["45"] });
    expect(check("Ruth is off November 23 to 27 for 45 hours.", request)).toEqual({ ok: false, offending: ["45"] });
    expect(check("Ruth is off Nov 23-27 45 hours.", request)).toEqual({ ok: false, offending: ["45"] });
    expect(check("Ruth is off November 23 to 27, 2026, 40 hours in all.", [{ ...request[0], hours: 40 }]).ok).toBe(true);
  });

  it("does not read a second number that cannot be a later day as a date, and checks it as a number", () => {
    const nov30 = [{ date: "2026-11-30" }];
    expect(readTextDates("November 30 to 12")).toMatchObject({ raw: "November 30", rest: " 12" });
    expect(check("Paid November 30 to 12 people.", nov30)).toEqual({ ok: false, offending: ["12"] });
    expect(check("Paid November 30-45 times.", nov30)).toEqual({ ok: false, offending: ["45"] });
    expect(check("Paid November 30 to 12 people.", [{ date: "2026-11-30", count: 12 }]).ok).toBe(true);
  });

  it("reads ranges inside source strings as two dates, not as a date and a value", () => {
    expect(datesIn("Time off Nov 23-27, 2026 (pending)").dates.map((k) => k.d)).toEqual([23, 27]);
    const results = [{ summary: "Ruth Okoro is off Nov 23-27, 2026" }];
    expect(check("Ruth is off until November 27, 2026.", results).ok).toBe(true);
    expect(check("Ruth has 27 hours left.", results)).toEqual({ ok: false, offending: ["27"] });
  });

  it("keeps the second day of a range in the person's request repeatable as their numeral (OC-01, CP-01 shapes)", () => {
    const opts = { request: "How much would Hollis Grey's missed pay for Oct 1 to 15 be?" };
    expect(check("Missed pay for October 1 to 15 is $3,166.67.", [{ gross_cents: 316667 }], opts).ok).toBe(true);
    expect(check("The 15 day period pays $3,166.67.", [{ gross_cents: 316667 }], opts).ok).toBe(true);
    expect(check("Missed pay for October 1 to 16 is $3,166.67.", [{ gross_cents: 316667 }], opts)).toEqual({ ok: false, offending: ["October 1 to 16"] });
  });
});
