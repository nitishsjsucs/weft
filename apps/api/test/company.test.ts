// Contract tests for GET /v1/company (owner: t2-world).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Company, Department, PaySchedule, Workplace } from "@weft/contracts";
import { ensureTestPrincipals } from "@weft/core";
import { createTestWeft, type TestWeft } from "../src/testing";

let weft: TestWeft;
beforeAll(async () => { weft = await createTestWeft(); await ensureTestPrincipals(weft.db); });
afterAll(async () => { await weft.close(); });

describe("GET /v1/company", () => {
  it("returns the company bundle with 4 workplaces, 6 departments with leads, and the schedules", async () => {
    const res = await weft.app.request("/v1/company", { headers: weft.uiHeaders("usr_dana") });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Company.parse(body.company)).toEqual({ id: "cmp_larkspur", legalName: "Larkspur Robotics, Inc.", domain: "larkspur.example", ein: "00-4817265", hqState: "CA", foundedOn: "2023-03-01" });
    expect(body.workplaces.map((w: unknown) => Workplace.parse(w).id)).toEqual(["wkp_austin", "wkp_brooklyn", "wkp_oakland", "wkp_remote"]);
    const depts = body.departments.map((d: unknown) => Department.parse(d));
    expect(depts).toHaveLength(6);
    expect(depts.every((d: { leadWorkerId: string | null }) => d.leadWorkerId?.startsWith("wrk_"))).toBe(true);
    expect(depts.find((d: { name: string }) => d.name === "Hardware").leadWorkerId).toBe("wrk_0004");
    expect(body.paySchedules.map((p: unknown) => PaySchedule.parse(p).id)).toEqual(["ps_global_monthly", "ps_us_semimonthly"]);
  });
  it("requires a session", async () => {
    expect((await weft.app.request("/v1/company")).status).toBe(401);
  });
});
