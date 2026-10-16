// Scenario GP17, Workday half (docs/wave3.md 5): Workday as the system of record for people and time off. Owner:
// w3-integrations-hr. The simulated tenant mirrors the seeded employees, so the first Sync now links every active
// employee by work email with no conflict and Workday takes ownership of people, compensation and time off. A
// promotion entered in Workday (new title and a 4 percent raise) applies the title and turns the raise into a
// human-only sync conflict with people.external_change. Two vacation days approved in Workday land in the native
// Time Off model as approved, read-only requests with source workday, exactly once, and the 15-minute poll applies
// later changes on its own (sync_now as svc_scheduler, apply_hris_change as svc_events). GP6 and the Greenhouse half are untouched.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestWeft, type TestWeft } from "./helpers";

describe("GP17 Workday worker and time-off sync", () => {
  let weft: TestWeft;
  beforeAll(async () => {
    weft = await createTestWeft();
    // The native Time Off policies (w3-timeoff seeds the same ids); kept here so the scenario stands on its own.
    await weft.db.run(sql`INSERT OR IGNORE INTO time_off_types (id, company_id, kind, name, paid, counts_as_vacation) VALUES ('tot_vacation', 'cmp_larkspur', 'vacation', 'Vacation', 1, 1)`);
    await weft.db.run(sql`INSERT OR IGNORE INTO time_off_policies (id, company_id, type_id, name, jurisdiction, schedule, minutes_per_period, effective_from) VALUES ('top_vac_us', 'cmp_larkspur', 'tot_vacation', 'Larkspur Vacation', 'US', 'per_pay_period', 300, '2023-01-01')`);
  });
  afterAll(async () => { await weft.close(); });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await weft.app.request(path, { method, headers: { ...weft.uiHeaders("usr_dana"), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as any };
  };
  const workdayRequests = () => weft.db.all<{ id: string; worker_id: string; policy_id: string; status: string; start_at: string; requested_minutes: number; source: string; ext_ref: string }>(sql`SELECT id, worker_id, policy_id, status, start_at, requested_minutes, source, ext_ref FROM time_off_requests WHERE source = 'workday' ORDER BY id`);

  let employees = 0, changedWorker = "";
  it("the Workday card starts simulated and owned by Weft; the connection test reads one worker", async () => {
    const card = (await call("GET", "/v1/integrations/workday")).json;
    expect(card.status).toMatchObject({ vendor: "workday", mode: "simulated", lastSyncAt: null });
    expect(card.ownership).toEqual({ people: "weft", compensation: "weft", time_off: "weft" });
    const t = await call("POST", "/v1/integrations/workday/test");
    expect(t.json).toMatchObject({ vendor: "workday", health: "ok", services: ["Human_Resources", "Staffing", "Absence_Management"] });
  });

  it("the first sync links every active employee by work email with no conflict, and Workday takes ownership", async () => {
    [{ n: employees }] = await weft.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM workers WHERE type = 'employee' AND status = 'active'`) as [{ n: number }];
    expect(employees).toBeGreaterThan(10);
    const r = await call("POST", "/v1/integrations/workday/sync");
    expect(r.status).toBe(200);
    expect(r.json.data.detected).toHaveLength(employees);
    expect(r.json.data.applied).toMatchObject({ workers_seen: employees, applied: [], external_changes: [], time_off_imported: [], sync_item_ids: [] });
    expect(r.json.data.applied.linked).toHaveLength(employees);
    const [{ n }] = await weft.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM ext_links WHERE vendor = 'workday' AND ext_type = 'worker' AND weft_type = 'worker'`) as [{ n: number }];
    expect(n).toBe(employees);
    expect((await call("GET", "/v1/integrations/workday")).json.ownership).toEqual({ people: "vendor", compensation: "vendor", time_off: "vendor" });
    const again = await call("POST", "/v1/integrations/workday/sync");
    expect(again.json.data.detected).toEqual([]);
  });

  it("one changed worker: the title applies, the raise becomes a human-only conflict with people.external_change", async () => {
    const sim = await call("POST", "/v1/integrations/workday/simulate", { kind: "worker_change" });
    expect(sim.status).toBe(200);
    const [link] = await weft.db.all<{ weft_id: string }>(sql`SELECT weft_id FROM ext_links WHERE vendor = 'workday' AND ext_id = ${sim.json.data.workerRef}`);
    changedWorker = link!.weft_id;
    const [before] = await weft.db.all<{ title: string; amount_cents: number }>(sql`SELECT w.title, p.amount_cents FROM workers w JOIN pay_rates p ON p.worker_id = w.id AND p.effective_to IS NULL WHERE w.id = ${changedWorker}`);
    const r = await call("POST", "/v1/integrations/workday/sync");
    expect(r.json.data.detected).toEqual([sim.json.data.workerRef]);
    const a = r.json.data.applied;
    expect(a.applied).toEqual([{ worker_id: changedWorker, field: "title", from: before!.title, to: `Senior ${before!.title}` }]);
    expect(a.external_changes).toEqual([changedWorker]);
    const [after] = await weft.db.all<{ title: string; amount_cents: number }>(sql`SELECT w.title, p.amount_cents FROM workers w JOIN pay_rates p ON p.worker_id = w.id AND p.effective_to IS NULL WHERE w.id = ${changedWorker}`);
    expect(after).toEqual({ title: `Senior ${before!.title}`, amount_cents: before!.amount_cents });   // pay is never changed silently
    const items = (await call("GET", "/v1/sync-items?vendor=workday")).json;
    expect(items).toEqual([expect.objectContaining({ kind: "sync_conflict", subjectRef: changedWorker, detail: expect.objectContaining({ field: "base_cents", weft_value: String(before!.amount_cents), vendor_value: String(Math.round(before!.amount_cents / 100 * 1.04) * 100), reason: "pay_affecting" }) })]);
    const evts = await weft.db.all<{ subject_ref: string; payload_json: string }>(sql`SELECT subject_ref, payload_json FROM events WHERE type = 'people.external_change'`);
    expect(evts).toEqual([{ subject_ref: changedWorker, payload_json: JSON.stringify({ worker_id: changedWorker, vendor: "workday" }) }]);
    // The raise is a decision for People: taking the Workday value here is refused, keeping Weft closes the item.
    const take = await call("POST", `/v1/sync-items/${items[0].id}/resolve`, { take: "vendor" });
    expect([take.status, take.json.code]).toEqual([422, "DOMAIN_PAY_CHANGE_IN_PEOPLE"]);
    const keep = await call("POST", `/v1/sync-items/${items[0].id}/resolve`, { take: "weft" });
    expect(keep.json).toMatchObject({ ok: true, data: { take: "weft" } });
  });

  it("two approved time-off entries land read-only with source workday, exactly once", async () => {
    const sim = await call("POST", "/v1/integrations/workday/simulate", { kind: "time_off" });
    const entryRefs: string[] = sim.json.data.entryRefs;
    expect(entryRefs).toHaveLength(2);
    const r = await call("POST", "/v1/integrations/workday/sync");
    expect(r.json.data.applied.time_off_imported).toHaveLength(2);
    expect(r.json.data.applied.applied).toEqual([]);   // the time-off transaction does not re-apply the title
    const rows = await workdayRequests();
    expect(rows.map((x) => ({ worker: x.worker_id, policy: x.policy_id, status: x.status, minutes: x.requested_minutes, source: x.source }))).toEqual([
      { worker: changedWorker, policy: "top_vac_us", status: "approved", minutes: 480, source: "workday" },
      { worker: changedWorker, policy: "top_vac_us", status: "approved", minutes: 480, source: "workday" },
    ]);
    expect(rows.map((x) => x.ext_ref).sort()).toEqual([...entryRefs].sort());
    // A second sync and a second apply of the same window import nothing new.
    expect((await call("POST", "/v1/integrations/workday/sync")).json.data.detected).toEqual([]);
    expect(await workdayRequests()).toHaveLength(2);
    // The agent's read shows both entries with the request Weft imported for each.
    const dana = { principalId: "usr_dana", companyId: "cmp_larkspur", via: "ui" as const, keyScope: null };
    const read = await weft.executor.human.exec(dana, "hris.list_time_off", { worker_id: changedWorker, from: rows[0]!.start_at.slice(0, 8) + "01", to: "2027-12-31" });
    expect(read.ok && read.status === "done" && (read.data as { entries: { weft_request_id: string | null }[] }).entries.map((e) => e.weft_request_id).sort()).toEqual(rows.map((x) => x.id).sort());
    const cmp = await weft.executor.human.exec(dana, "hris.get_worker_external", { worker_id: changedWorker });
    expect(cmp.ok && cmp.status === "done" && (cmp.data as { fields: { field: string; same: boolean }[] }).fields.filter((f) => !f.same).map((f) => f.field)).toEqual(["base_cents"]);
  });

  it("the 15-minute poll applies a later Workday change on its own", async () => {
    const now = weft.clock.now();
    await weft.clock.set(new Date(Date.parse(now) + 16 * 60_000).toISOString(), 0);
    const sim = await call("POST", "/v1/integrations/workday/simulate", { kind: "time_off" });
    await weft.scheduler.tick();
    expect((await workdayRequests()).map((x) => x.ext_ref)).toEqual(expect.arrayContaining(sim.json.data.entryRefs));
    expect(await workdayRequests()).toHaveLength(4);
    const acts = await weft.db.all<{ command: string; actor_id: string }>(sql`SELECT command, actor_id FROM actions WHERE command LIKE 'integrations.%' ORDER BY seq DESC LIMIT 2`);
    expect(acts.map((a) => `${a.command} ${a.actor_id}`)).toEqual(["integrations.apply_hris_change svc_events", "integrations.sync_now svc_scheduler"]);
  });
});
