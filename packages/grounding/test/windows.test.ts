// Round 1 analysis, RC1 risk: window bounds were derived from relative phrases in the request and in the answer
// itself, so an answer that names its own window grounded that bound with no source. Decision (round 2, FG4, recorded
// in the package header): only the request derives window bounds; today is always known from the clock.
import { describe, expect, it } from "vitest";
import { check } from "../src/index";

const NOW = "2026-10-26T16:00:00.000Z";   // a Monday

describe("only the request derives a window bound", () => {
  it("refuses a bound the answer derives from its own relative phrase", () => {
    const text = "Nothing is due within two weeks, by November 9, 2026.";
    expect(check(text, [{ items: [] }], { request: "What is due soon?", now: NOW })).toEqual({ ok: false, offending: ["November 9, 2026"] });
    expect(check("Nobody is out next week, November 2 to 8.", [{ requests: [] }], { request: "Who is out?", now: NOW }))
      .toEqual({ ok: false, offending: ["November 2 to 8"] });
  });

  it("grounds the same bound when the person's request names the window", () => {
    const text = "Nothing is due within two weeks, by November 9, 2026.";
    expect(check(text, [{ items: [] }], { request: "What is due in the next two weeks?", now: NOW })).toEqual({ ok: true, offending: [] });
    expect(check("Nobody is out next week, November 2 to 8.", [{ requests: [] }], { request: "Who is out next week?", now: NOW }).ok).toBe(true);
  });

  it("closes the self-derived deadline: a record's 30 days counts from its notice date, not from today", () => {
    // The 30 is in the record, so the answer may say it; today + 30 is November 25, the record's deadline is November 19.
    const results = [{ notice: { id: "ntc_0004", received_on: "2026-10-20", message: "Respond within 30 days of the notice date." } }];
    const wrong = "Respond within 30 days, by November 25, 2026.";
    expect(check(wrong, results, { request: "When must we answer notice ntc_0004?", now: NOW })).toEqual({ ok: false, offending: ["November 25, 2026"] });
    expect(check("Respond within 30 days, by November 19, 2026.", [{ ...results[0], due_on: "2026-11-19" }], { request: "When must we answer notice ntc_0004?", now: NOW }).ok).toBe(true);
  });

  it("still grounds today from the clock, whatever the request says", () => {
    expect(check("As of October 26, 2026, nothing is overdue.", [{ items: [] }], { request: "Anything overdue?", now: NOW }).ok).toBe(true);
    expect(check("As of October 26, 2026, nothing is overdue.", [{ items: [] }], { now: NOW }).ok).toBe(true);
  });

  it("an untrusted request derives no window, and a tainted block in it derives none either", () => {
    const text = "No one starts between October 26 and November 9, 2026.";
    expect(check(text, [{ people: [] }], { request: null, now: NOW })).toEqual({ ok: false, offending: ["November 9, 2026"] });
    const tainted = '<untrusted n="0123456789abcdef" source="chat:msg_0001">who starts in the next two weeks</untrusted>';
    expect(check(text, [{ people: [] }], { request: tainted, now: NOW })).toEqual({ ok: false, offending: ["November 9, 2026"] });
  });

  it("a date-filtered read the model chose still grounds its own window through the echoed dates", () => {
    // The read echoes the window it was asked for: a result string equal to an argument gives no numerals, but its
    // dates still count (numerals.ts LeafOptions).
    const results = [{ from: "2026-11-02", to: "2026-11-08", requests: [] }];
    const opts = { request: "Who is out?", now: NOW, echoes: ["2026-11-02", "2026-11-08"] };
    expect(check("Nobody is out next week, November 2 to 8.", results, opts).ok).toBe(true);
    expect(check("Nobody is out next week, November 2 to 9.", results, opts)).toEqual({ ok: false, offending: ["November 2 to 9"] });
  });
});
