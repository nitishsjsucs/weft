// Workday simulator (w3-integrations-hr): { total, data } collections with limit capped at 100, references with
// 32-character hex WIDs, Get_Workers over the transaction log window with Response_Results paging, the documented
// three-step time-off flow (eligible types, valid dates, requestTimeOff In Progress, then approval), balances, and
// the workday.getWorkers and workday.requestTimeOff faults.
import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { HrisConnector, W3WorkdaySimControls } from "@weft/contracts";
import { createSimulators } from "../../src/index";
import { simWorld, type SimTestWorld } from "../helpers";
import { WD_ABSENCE_TYPES } from "../../src/vendors/workday";

let w: SimTestWorld | null = null;
afterEach(async () => { await w?.close(); w = null; });
const T0 = "2026-10-26T15:30:00.000Z";
async function wd() {
  w = await simWorld(T0);
  const db = w.db;
  await db.run(sql`INSERT INTO companies (id, legal_name, domain, ein, hq_state, founded_on, created_at) VALUES ('cmp_demo', 'Demo Robotics', 'demo.example', '00-0000000', 'CA', '2020-01-01', ${T0})`);
  await db.run(sql`INSERT INTO departments (id, company_id, name) VALUES ('dpt_engineering', 'cmp_demo', 'Engineering')`);
  const people: [string, string, string, string, string, number, string][] = [
    ["wrk_0001", "Ada", "Quill", "ada.quill@demo.example", "Staff Engineer", 18_500_000, "salary"],
    ["wrk_0002", "Bo", "Reyes", "bo.reyes@demo.example", "Controls Engineer", 14_200_000, "salary"],
    ["wrk_0003", "Cy", "Tan", "cy.tan@demo.example", "Technician", 3_850, "hourly"],
  ];
  for (const [id, first, last, email, title, cents, kind] of people) {
    await db.run(sql`INSERT INTO workers (id, company_id, type, worker_type, status, first_name, last_name, work_email, title, department_id, work_state, timezone, start_date, created_at, updated_at) VALUES (${id}, 'cmp_demo', 'employee', 'w2', 'active', ${first}, ${last}, ${email}, ${title}, 'dpt_engineering', 'CA', 'America/Los_Angeles', '2024-02-01', ${T0}, ${T0})`);
    await db.run(sql`INSERT INTO pay_rates (id, worker_id, kind, amount_cents, currency, effective_from) VALUES (${`prt_${id.slice(4)}`}, ${id}, ${kind}, ${cents}, 'USD', '2024-02-01')`);
  }
  const sims = createSimulators({ db, clock: w.clock });
  const s = sims.vendors.workday as HrisConnector & W3WorkdaySimControls;
  await s.seedLarkspur();
  return { sims, s, clock: w.clock };
}

describe("workday simulator", () => {
  it("answers { total, data } with limit at most 100 and { id, descriptor, href } references with WIDs", async () => {
    const { s } = await wd();
    const r = await s.rest("/common/v1/workers", { limit: "2" });
    expect(r.status).toBe(200);
    const body = r.body as { total: number; data: { id: string; descriptor: string; href: string; workerId: string; primarySupervisoryOrganization: { id: string } }[] };
    expect(body.total).toBe(3);
    expect(body.data.map((x) => x.descriptor)).toEqual(["Ada Quill", "Bo Reyes"]);
    for (const x of body.data) { expect(x.id).toMatch(/^[0-9a-f]{32}$/); expect(x.href).toContain(x.id); expect(x.primarySupervisoryOrganization.id).toMatch(/^[0-9a-f]{32}$/); }
    expect((await s.rest("/common/v1/workers", { limit: "2", offset: "2" })).body).toMatchObject({ total: 3, data: [{ descriptor: "Cy Tan" }] });
    expect((await s.rest("/common/v1/workers", { limit: "101" })).status).toBe(400);
    expect((await s.rest("/absenceManagement/v5/workers/Employee_ID=99999/timeOffDetails")).status).toBe(404);
  });

  it("Get_Workers returns the workers with a transaction in the window, with Response_Results paging", async () => {
    const { s, clock } = await wd();
    const all = await s.listChangedWorkers({ updatedFrom: "2026-01-01T00:00:00.000Z", updatedThrough: T0, page: 1 });
    expect(all.items.map((x) => [x.first, x.title, x.baseAmountMinor, x.frequency, x.locationState])).toEqual([
      ["Ada", "Staff Engineer", 18_500_000, "Annual", "CA"], ["Bo", "Controls Engineer", 14_200_000, "Annual", "CA"], ["Cy", "Technician", 3_850, "Hourly", "CA"],
    ]);
    expect(all.nextCursor).toBeNull();
    await clock.set("2026-10-26T16:00:00.000Z");
    const changed = await s.simulate("worker_change");
    const later = await s.listChangedWorkers({ updatedFrom: "2026-10-26T15:45:00.000Z", updatedThrough: "2026-10-26T16:00:00.000Z", page: 1 });
    expect(later.items.map((x) => [x.workerRef, x.title, x.baseAmountMinor])).toEqual([[changed.workerRef, "Senior Controls Engineer", 14_768_000]]);
    expect((await s.listChangedWorkers({ updatedFrom: "2026-10-26T16:00:00.001Z", updatedThrough: "2026-10-26T16:30:00.000Z", page: 1 })).items).toEqual([]);
    const raw = await s.rest("/ccx/service/Human_Resources/Get_Workers", { Updated_From: "2026-01-01T00:00:00.000Z", Updated_Through: "2026-10-26T16:00:00.000Z", Page: "2", Count: "2" });
    expect(raw.body).toMatchObject({ Response_Results: { Total_Results: 3, Total_Pages: 2, Page_Results: 1, Page: 2 } });
    expect((await s.rest("/ccx/service/Human_Resources/Get_Workers", { Updated_From: "2026-10-27T00:00:00.000Z", Updated_Through: "2026-10-26T00:00:00.000Z" })).status).toBe(400);
  });

  it("runs the three-step time-off flow: In Progress with Submitted entries, Approved after the manager", async () => {
    const { s } = await wd();
    const [bo] = (await s.listChangedWorkers({ updatedFrom: "2026-01-01T00:00:00.000Z", updatedThrough: T0, page: 1 })).items.filter((x) => x.first === "Bo");
    const types = (await s.rest(`/absenceManagement/v5/workers/${bo!.workerRef}/eligibleAbsenceTypes`)).body as { total: number; data: { id: string; descriptor: string }[] };
    expect(types.data.map((t) => t.descriptor)).toEqual(["Vacation", "Sick"]);
    const valid = (await s.rest(`/absenceManagement/v5/workers/Employee_ID=${bo!.employeeId}/validTimeOffDates`, { date: "2026-11-07,2026-11-09" })).body as { data: { date: string; valid: boolean }[] };
    expect(valid.data).toEqual([{ date: "2026-11-07", valid: false }, { date: "2026-11-09", valid: true }]);   // a Saturday is not valid
    const req = await s.requestTimeOff({ workerRef: bo!.workerRef, days: [{ date: "2026-11-09", minutes: 480, typeRef: WD_ABSENCE_TYPES.sick.id }], credential: "simulated" });
    expect(req.status).toBe("In Progress");
    expect((await s.listTimeOff({ workerRef: bo!.workerRef, from: "2026-11-01", to: "2026-11-30", status: "all" })).items).toEqual([expect.objectContaining({ date: "2026-11-09", quantityMinutes: 480, status: "Submitted", typeRef: WD_ABSENCE_TYPES.sick.id })]);
    expect((await s.listTimeOff({ workerRef: bo!.workerRef, from: "2026-11-01", to: "2026-11-30", status: "approved" })).items).toEqual([]);
    await expect(s.requestTimeOff({ workerRef: bo!.workerRef, days: [{ date: "2026-11-09", minutes: 480, typeRef: WD_ABSENCE_TYPES.vacation.id }], credential: "simulated" })).rejects.toThrow(/not a valid time off date/);

    const sim = await s.simulate("time_off", { employeeId: bo!.employeeId });
    expect(sim.entryRefs).toHaveLength(2);
    const approved = (await s.listTimeOff({ workerRef: bo!.workerRef, from: "2026-11-01", to: "2026-12-31", status: "approved" })).items;
    expect(approved.map((e) => [e.date, e.quantityMinutes, e.status])).toEqual([["2026-11-25", 480, "Approved"], ["2026-11-26", 480, "Approved"]]);
    const bal = await s.listBalances({ workerRef: bo!.workerRef, asOf: "2026-10-26" });
    expect(bal.items).toEqual([expect.objectContaining({ minutes: (80 - 16) * 60 })]);
  });

  it("fails Get_Workers and requestTimeOff under their faults, and tests the connection", async () => {
    const { sims, s } = await wd();
    expect(await s.testConnection()).toMatchObject({ vendor: "workday", mode: "simulated", health: "ok", services: ["Human_Resources", "Staffing", "Absence_Management"] });
    await sims.faults.arm({ target: "workday.getWorkers", kind: "error", mode: "once" });
    await expect(s.listChangedWorkers({ updatedFrom: "2026-01-01T00:00:00.000Z", updatedThrough: T0, page: 1 })).rejects.toThrow();
    expect((await s.listChangedWorkers({ updatedFrom: "2026-01-01T00:00:00.000Z", updatedThrough: T0, page: 1 })).items).toHaveLength(3);
    await sims.faults.arm({ target: "workday.requestTimeOff", kind: "error", mode: "once" });
    await expect(s.simulate("time_off")).rejects.toThrow();
    expect((await s.listOrganizations({ cursor: null })).items).toEqual([expect.objectContaining({ name: "Engineering", kind: "Supervisory" })]);
  });
});
