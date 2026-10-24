// The rich profile's new hire personas reach the portal at several checklist stages, and the portal's time-off,
// expenses and training sections answer for the persona's own record (never the Viewing-as admin's).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { ensureTestPrincipals } from "@weft/core";
import { seedWorldProfile } from "@weft/seed/profile";
import { createWeft } from "../src/compose";
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
    expect(stages["Odette Marsh"]).toBe(7);
    expect(stages["Elias Brandt"]).toBe(5);
    expect(stages["Tobias Wren"]).toBe(2);
    expect(stages["Marisol Quint"]).toBe(0);
  });

  it("offers the policies the persona's state calls for in the portal's Request time off section", async () => {
    type Mine = { workerId: string | null; balances: { policyId: string }[] };
    const ny = await get<Mine>("/v1/portal/time-off", persona("Odette").id);
    expect(ny.status).toBe(200);
    expect(ny.json.workerId).toBe(persona("Odette").worker_id);
    const ids = ny.json.balances.map((b) => b.policyId);
    expect(ids).toContain("top_vac_us");
    expect(ids).not.toContain("top_sick_ca");
    const ca = await get<Mine>("/v1/portal/time-off", persona("Tobias").id);
    expect(ca.json.balances.map((b) => b.policyId)).toContain("top_sick_ca");
  });

  it("lists the persona's own claim and training, not Vic's", async () => {
    const exp = await get<{ workerId: string; data: { status: string; category: string }[] }>("/v1/portal/expenses", persona("Odette").id);
    expect(exp.json.workerId).toBe(persona("Odette").worker_id);
    expect(exp.json.data.map((x) => [x.category, x.status])).toEqual([["equipment", "approved"]]);
    const tr = await get<{ workerId: string; courseCode: string }[]>("/v1/portal/training", persona("Odette").id);
    expect(tr.json.map((t) => t.courseCode)).toEqual(["ny_harassment"]);
    expect(tr.json.every((t) => t.workerId === persona("Odette").worker_id)).toBe(true);
  });
});

describe("a rich world after an API restart", () => {
  it("keeps the chain valid once memory is read (the git head is read with the lazily found repo)", async () => {
    const again = await createWeft({ dataDir: weft.dataDir, testMode: true });
    try {
      expect((await again.executor.verifyChain()).ok).toBe(true);
      await again.executor.memory.tree("timeline/");
      const v = await again.executor.verifyChain();
      expect(v.head!.seq).toBeGreaterThan(100);
      expect(v).toMatchObject({ ok: true, gitLag: 0 });
    } finally { await again.close(); }
  }, 60_000);
});
