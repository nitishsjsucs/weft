// The rich profile's new hire personas reach the portal at several checklist stages, and the portal's time-off,
// expenses and training sections answer for the persona's own record (never the Viewing-as admin's).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { ensureTestPrincipals } from "@weft/core";
import { seedWorldProfile } from "@weft/seed/profile";
import { createTestWeft, type TestWeft } from "../src/testing";

let weft: TestWeft;
let personas: { id: string; display: string; worker_id: string }[];
beforeAll(async () => {
  weft = await createTestWeft({ seed: false });
  await seedWorldProfile(weft, "rich");
  await ensureTestPrincipals(weft.db);
  personas = await weft.db.all(sql`SELECT id, display, worker_id FROM principals WHERE role = 'employee' AND worker_id IS NOT NULL ORDER BY id`);
}, 120_000);
afterAll(async () => { await weft.close(); });

const get = async <T,>(path: string, who: string) => {
  const res = await weft.app.request(path, { headers: weft.uiHeaders(who) });
  return { status: res.status, json: (await res.json()) as T };
};
const persona = (name: string) => personas.find((p) => p.display.startsWith(name))!;

describe("rich profile portal personas", () => {
  it("has a new hire at each checklist stage", async () => {
    const stages: Record<string, number> = {};
    for (const p of personas) {
      const r = await get<{ done: number; total: number }>("/v1/portal/me", p.id);
      expect(r.status, p.display).toBe(200);
      stages[p.display] = r.json.done;
    }
    expect(stages["Odette Marsh (demo)"]).toBe(7);
    expect(stages["Elias Brandt (demo)"]).toBe(5);
    expect(stages["Tobias Wren (demo)"]).toBe(2);
    expect(stages["Marisol Quint (demo)"]).toBe(0);
  });

  it("shows the policies and holidays that will apply, read-only, for the persona's own work state", async () => {
    const ny = await get<{ startDate: string; policies: { id: string; usableFrom: string; accrual: string }[]; holidays: { date: string }[] }>("/v1/portal/time-off", persona("Odette").id);
    expect(ny.status).toBe(200);
    expect(ny.json.startDate).toBe("2026-11-02");
    const ids = ny.json.policies.map((p) => p.id);
    expect(ids).toContain("top_vac_us");
    expect(ids).toContain("top_sick_ny");
    expect(ids).not.toContain("top_sick_ca");
    expect(ny.json.policies.every((p) => p.usableFrom >= "2026-11-02" && p.accrual.length > 0)).toBe(true);
    expect(ny.json.holidays.length).toBeGreaterThan(0);
    expect(ny.json.holidays.every((h) => h.date >= "2026-11-02")).toBe(true);
    const ca = await get<{ policies: { id: string }[] }>("/v1/portal/time-off", persona("Tobias").id);
    expect(ca.json.policies.map((p) => p.id)).toContain("top_sick_ca");
    expect((await get("/v1/portal/time-off", "usr_dana")).status).toBe(403);
  });

  it("lists the persona's own claim and training, not Dana's", async () => {
    const exp = await get<{ workerId: string; data: { status: string; category: string }[] }>("/v1/portal/expenses", persona("Odette").id);
    expect(exp.json.workerId).toBe(persona("Odette").worker_id);
    expect(exp.json.data.map((x) => [x.category, x.status])).toEqual([["equipment", "approved"]]);
    const tr = await get<{ workerId: string; courseCode: string }[]>("/v1/portal/training", persona("Odette").id);
    expect(tr.json.map((t) => t.courseCode)).toEqual(["ny_harassment"]);
    expect(tr.json.every((t) => t.workerId === persona("Odette").worker_id)).toBe(true);
  });
});
