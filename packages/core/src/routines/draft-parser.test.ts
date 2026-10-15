import { describe, expect, it } from "vitest";
import { parseRoutineDraft, validateCron } from "./draft-parser";

describe("routine draft parser", () => {
  it("'Every Friday' gives 0 9 * * 5 in America/Los_Angeles with comms.send_message", () => {
    expect(parseRoutineDraft("Every Friday, post open approvals to #payroll")).toMatchObject({
      ok: true, cron: "0 9 * * 5", tz: "America/Los_Angeles", channel: "#payroll", tools: ["comms.send_message"], template: "open_approvals",
    });
  });

  it("parses times, several days, every day and weekdays", () => {
    expect(parseRoutineDraft("Mondays and Thursdays at 2:30pm post pending approvals to #people-ops")).toMatchObject({ ok: true, cron: "30 14 * * 1,4" });
    expect(parseRoutineDraft("Every day post open approvals")).toMatchObject({ ok: true, cron: "0 9 * * *", channel: "#people-ops" });
    expect(parseRoutineDraft("Weekdays at 8am, open approvals to #general")).toMatchObject({ ok: true, cron: "0 8 * * 1-5" });
  });

  it("refuses what it cannot resolve with a hint", () => {
    expect(parseRoutineDraft("remind me sometimes")).toMatchObject({ ok: false, reason: "NO_SCHEDULE" });
    expect(parseRoutineDraft("Every Friday post open approvals to #random")).toMatchObject({ ok: false, reason: "UNKNOWN_CHANNEL" });
    expect(parseRoutineDraft("Every Friday order pizza")).toMatchObject({ ok: false, reason: "UNKNOWN_TEMPLATE" });
  });

  it("validates cron with croner", () => {
    expect(validateCron("0 9 * * 5").ok).toBe(true);
    expect(validateCron("61 9 * * 5").ok).toBe(false);
  });
});
