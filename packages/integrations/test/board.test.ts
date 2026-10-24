// Public job board parsing on a hand-written fictional Larkspur fixture (single and multi-select metadata), plus one
// opt-in live smoke read (WEFT_LIVE_PUBLIC=1) that checks the shape only. The default run never touches the network.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fetchBoardJobs, parseBoardJobs } from "../src/board";

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/larkspur-board.json"), "utf8"));

describe("public job board", () => {
  it("parses the Larkspur fixture: single_select is a string, multi_select an array, offsets normalized", () => {
    const { total, jobs } = parseBoardJobs(fixture);
    expect(total).toBe(2);
    expect(jobs[0]).toMatchObject({ id: "7100201", internalJobId: "4400103", name: "Firmware Test Engineer", departmentName: "Hardware", officeName: "Boulder, CO", location: "Hybrid", requisitionId: "LR-103", updatedAt: "2026-10-14T00:57:01.000Z" });
    expect(jobs[0]!.metadata).toEqual([
      { name: "Career Site Department", type: "single_select", values: ["Hardware"] },
      { name: "Job Posting Location", type: "multi_select", values: ["Boulder, CO", "Remote US"] },
      { name: "Cost Center", type: "single_select", values: [] },
    ]);
    expect(jobs[1]).toMatchObject({ internalJobId: null, requisitionId: null, officeName: "Oakland, CA" });
  });
  it("refuses a body that is not a board listing", () => {
    expect(() => parseBoardJobs({ data: [] })).toThrow(/jobs/);
    expect(() => parseBoardJobs({ jobs: [{ title: "x" }] })).toThrow(/id/);
  });
  it.runIf(process.env.WEFT_LIVE_PUBLIC === "1")("live smoke: one read of a public board has the same shape", async () => {
    const r = await fetchBoardJobs(process.env.WEFT_LIVE_PUBLIC_BOARD ?? "cloudflare");
    expect(r.jobs.length).toBeGreaterThan(0);
    expect(typeof r.jobs[0]!.name).toBe("string");
  });
});
