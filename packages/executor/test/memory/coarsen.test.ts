// Timeline coarsening (harness 18 item 1): closed periods only, counts by kind, importance 2 and 3 verbatim,
// path#L<n> back-references, idempotent per period, raw past the window leaves the tree. Owner: w2-memory.
import { describe, expect, it } from "vitest";
import { digestKey, isoWeek, parseRaw, periodOf, planCoarsen } from "../../src/memory/coarsen";

const fm = (day: string) => `---\nid: "timeline-${day}"\ntype: "timeline_raw"\naliases: []\nlinks: []\nsources: []\nstatus: null\nupdated: "${day}"\ntainted_by: null\n---\n# ${day}\n`;
const raw = (day: string, lines: string[]) => ({ path: `timeline/raw/${day}.md`, text: fm(day) + lines.map((l) => `${l}\n`).join("") });
const week = [
  raw("2026-10-12", [
    "- 2026-10-12T16:10:00.000Z [i1] people.update: Updated [[entities/people/wrk_0002|Theo Marsh (demo)]] (src: action:2)",
    "- 2026-10-12T16:40:00.000Z [i2] tax.update_rate: Updated the CA SUI rate for [[entities/notices/ntc_0002]] (src: action:3)",
    "- 2026-10-12T18:00:00.000Z [i0] comms.post_update: Posted a run update (src: action:4)",
  ]),
  raw("2026-10-14", ["- 2026-10-14T20:00:00.000Z [i3] payroll.submit: Submitted payroll pay_2026_10_15 (src: action:5)"]),
  raw("2026-10-26", ["- 2026-10-26T09:00:00.000Z [i1] people.update: Updated wrk_0003 (src: action:6)"]),
];

describe("coarsening", () => {
  it("parses raw lines with 1-based line numbers over the whole file", () => {
    const ev = parseRaw(week[0]!.path, week[0]!.text);
    expect(ev.map((e) => e.ref)).toEqual(["timeline/raw/2026-10-12.md#L12", "timeline/raw/2026-10-12.md#L13", "timeline/raw/2026-10-12.md#L14"]);
    expect(ev[1]).toMatchObject({ importance: 2, command: "tax.update_rate" });
  });

  it("names periods on the sim clock (ISO weeks, calendar months)", () => {
    expect(isoWeek("2026-10-12")).toEqual({ key: "2026-W42", monday: "2026-10-12" });
    expect(isoWeek("2027-01-01").key).toBe("2026-W53");
    expect(periodOf("hourly", "2026-10-12T16:40:00.000Z").path).toBe("timeline/hourly/2026-10-12T16.md");
    expect(periodOf("monthly", "2026-10-12T16:40:00.000Z")).toMatchObject({ key: "2026-10", end: "2026-11-01T00:00:00.000Z" });
  });

  it("summarises closed periods with counts, verbatim importance 2 and 3 events and back-references", () => {
    const plan = planCoarsen({ now: "2026-10-26T15:30:00.000Z", raw: week, daily: [], rawCommit: "a".repeat(40) });
    expect(digestKey(plan.periods)).toBe("daily:2026-10-12,daily:2026-10-14,hourly:2026-10-12T16,hourly:2026-10-12T18,hourly:2026-10-14T20,hourly:2026-10-26T09,weekly:2026-W42");
    const daily = plan.writes.find((w) => w.path === "timeline/daily/2026-10-12.md")!;
    expect(daily.frontmatter).toMatchObject({ type: "timeline_daily", links: ["entities/notices/ntc_0002", "entities/people/wrk_0002"], sources: ["timeline/raw/2026-10-12.md"] });
    expect(daily.body).toContain("- tax.update_rate: 1 (timeline/raw/2026-10-12.md#L13)");
    expect(daily.body).toContain("- 2026-10-12T16:40:00.000Z [i2] tax.update_rate: Updated the CA SUI rate for [[entities/notices/ntc_0002]] (src: action:3) (ref: timeline/raw/2026-10-12.md#L13)");
    expect(daily.body).not.toContain("[i0] comms.post_update: Posted");   // importance 0 and 1 are counted, not copied
    expect(daily.body).toContain(`resolve at commit ${"a".repeat(40)}`);
    const weekly = plan.writes.find((w) => w.path === "timeline/weekly/2026-W42.md")!;
    expect(weekly.body).toContain("Events: 4.");
    expect(weekly.body).toContain("[i3] payroll.submit");
    expect(weekly.body).toContain("- timeline/daily/2026-10-14.md");
    // The open day (2026-10-26) gets no daily; its closed hour does. The open month gets no monthly.
    expect(plan.writes.some((w) => w.path === "timeline/daily/2026-10-26.md")).toBe(false);
    expect(plan.writes.some((w) => w.path.startsWith("timeline/monthly/"))).toBe(false);
    expect(plan.removes).toEqual(["timeline/raw/2026-10-12.md", "timeline/raw/2026-10-14.md"]);
  });

  it("is idempotent: the same inputs plan the same summaries, and weeklies rebuild identically from dailies alone", () => {
    const a = planCoarsen({ now: "2026-10-26T15:30:00.000Z", raw: week, daily: [], rawCommit: "b".repeat(40) });
    const b = planCoarsen({ now: "2026-10-26T15:30:00.000Z", raw: week, daily: [], rawCommit: "b".repeat(40) });
    expect(b).toEqual(a);
    const dailies = a.writes.filter((w) => w.frontmatter.type === "timeline_daily").map((w) => ({ path: w.path, body: w.body }));
    const after = planCoarsen({ now: "2026-10-26T16:30:00.000Z", raw: [week[2]!], daily: dailies, rawCommit: "c".repeat(40) });
    expect(after.writes.find((w) => w.path === "timeline/weekly/2026-W42.md")).toEqual(a.writes.find((w) => w.path === "timeline/weekly/2026-W42.md"));
    expect(after.removes).toEqual([]);
  });

  it("monthly summaries appear once the month closes", () => {
    const plan = planCoarsen({ now: "2026-11-09T00:00:00.000Z", raw: week, daily: [] });
    const monthly = plan.writes.find((w) => w.path === "timeline/monthly/2026-10.md")!;
    expect(monthly.frontmatter.type).toBe("timeline_monthly");
    expect(monthly.body).toContain("Events: 5.");
  });
});
