// Contract tests for /v1/workers and the people.* and onboarding.* read commands (owner: t2-world).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Page, Worker } from "@weft/contracts";
import { directCtx, directDeps, ensureTestPrincipals, findCommand, nonEmptyUntrusted, runDirect } from "@weft/core";
import { createSimulators } from "@weft/sim";
import { sql } from "drizzle-orm";
import { createTestWeft, type TestWeft } from "../src/testing";

let weft: TestWeft;
beforeAll(async () => { weft = await createTestWeft(); await ensureTestPrincipals(weft.db); });
afterAll(async () => { await weft.close(); });
const deps = () => directDeps(weft.db, weft.clock, createSimulators({ db: weft.db, clock: weft.clock }));
const get = async (path: string, who = "usr_dana") => weft.app.request(path, { headers: weft.uiHeaders(who) });

describe("seed people (SPEC 5.2)", () => {
  it("has exactly 48 employees (CA 22, NY 14, TX 12), 3 contractors and 1 sent offer", async () => {
    const rows = await weft.db.all<{ type: string; state: string | null; n: number }>(sql`SELECT type, work_state AS state, COUNT(*) AS n FROM workers GROUP BY type, work_state ORDER BY type, work_state`);
    expect(rows).toEqual([{ type: "contractor", state: null, n: 3 }, { type: "employee", state: "CA", n: 22 }, { type: "employee", state: "NY", n: 14 }, { type: "employee", state: "TX", n: 12 }]);
    const offers = await weft.db.all<{ id: string; status: string; candidate_first: string; work_state: string }>(sql`SELECT id, status, candidate_first, work_state FROM offers`);
    expect(offers).toEqual([{ id: "offr_0001", status: "sent", candidate_first: "Noor", work_state: "CO" }]);
  });

  it("every displayed name ends with (demo) and every email domain is *.example", async () => {
    const res = await get("/v1/workers?limit=100");
    const body = Page(Worker).parse(await res.json());
    expect(body.count).toBe(51);
    for (const w of body.data) {
      expect(w.displayName.endsWith(" (demo)"), w.id).toBe(true);
      expect(w.workEmail.endsWith(".example"), w.id).toBe(true);
    }
    const emails = await weft.db.all<{ e: string }>(sql`SELECT candidate_email AS e FROM offers UNION ALL SELECT personal_email FROM workers WHERE personal_email IS NOT NULL`);
    for (const { e } of emails) expect(e.split("@")[1]!.endsWith(".example")).toBe(true);
    const co = await weft.db.all<{ legal_name: string; domain: string }>(sql`SELECT legal_name, domain FROM companies`);
    expect(co).toEqual([{ legal_name: "Larkspur Robotics, Inc. (demo)", domain: "larkspur.example" }]);
  });

  it("exactly 3 CA workers are under the $7,000 SUI wage base before the Oct 30 run", async () => {
    // Uses the YTD ledger once T1's payroll seed lands; until then, the salary arithmetic over paydays before Oct 30.
    const ca = await weft.db.all<{ id: string; start_date: string; amount_cents: number }>(sql`SELECT w.id, w.start_date, p.amount_cents FROM workers w JOIN pay_rates p ON p.worker_id = w.id WHERE w.work_state = 'CA' AND w.type = 'employee'`);
    expect(ca.length).toBe(22);
    const ledger = await weft.db.all<{ worker_id: string; c: number }>(sql`SELECT worker_id, SUM(amount_cents) AS c FROM ytd_ledger WHERE year = 2026 AND code = 'sui_wages:CA' GROUP BY worker_id`);
    let under: string[];
    if (ledger.length > 0) {
      const m = new Map(ledger.map((r) => [r.worker_id, r.c]));
      under = ca.filter((w) => (m.get(w.id) ?? 0) < 700_000).map((w) => w.id);
    } else {
      const paydays = ["01-15", "01-31", "02-15", "02-28", "03-15", "03-31", "04-15", "04-30", "05-15", "05-31", "06-15", "06-30", "07-15", "07-31", "08-15", "08-31", "09-15", "09-30", "10-15"];
      const periodStart = (md: string) => `2026-${md.slice(0, 2)}-${md.endsWith("15") ? "01" : "16"}`;
      under = ca.filter((w) => paydays.filter((d) => periodStart(d) >= w.start_date).length * Math.floor(w.amount_cents / 24) < 700_000).map((w) => w.id);
    }
    expect(under.sort()).toEqual(["wrk_0020", "wrk_0021", "wrk_0022"]);
    const hires = await weft.db.all<{ id: string; start_date: string; n: number }>(sql`SELECT w.id, w.start_date, (SELECT COUNT(*) FROM bank_accounts b WHERE b.worker_id = w.id) AS n FROM workers w WHERE w.id IN ('wrk_0020', 'wrk_0021', 'wrk_0022') ORDER BY w.id`);
    expect(hires).toEqual([{ id: "wrk_0020", start_date: "2026-10-01", n: 1 }, { id: "wrk_0021", start_date: "2026-10-01", n: 1 }, { id: "wrk_0022", start_date: "2026-10-19", n: 0 }]);
  });

  it("plants the NY offboarder, the TX hours and the named leads", async () => {
    const off = await weft.db.all<{ end_date: string; work_state: string }>(sql`SELECT end_date, work_state FROM workers WHERE end_date IS NOT NULL`);
    expect(off).toEqual([{ end_date: "2026-10-23", work_state: "NY" }]);
    const hours = await weft.db.all<{ worker_id: string; period_start: string; h: number }>(sql`SELECT worker_id, period_start, regular_hours_x100 + overtime_hours_x100 AS h FROM time_entries ORDER BY worker_id, period_start`);
    expect(hours.length).toBe(24);
    const spikes = hours.filter((r) => r.h !== 8667);
    expect(spikes).toEqual([{ worker_id: "wrk_0048", period_start: "2026-10-16", h: 12000 }]);
    const hourly = await weft.db.all<{ n: number; lo: number; hi: number }>(sql`SELECT COUNT(*) AS n, MIN(amount_cents) AS lo, MAX(amount_cents) AS hi FROM pay_rates WHERE kind = 'hourly'`);
    expect(hourly).toEqual([{ n: 6, lo: 2800, hi: 3600 }]);
    const leads = await weft.db.all<{ name: string; lead: string; title: string }>(sql`SELECT d.name, w.first_name || ' ' || w.last_name AS lead, w.title FROM departments d JOIN workers w ON w.id = d.lead_worker_id ORDER BY d.id`);
    expect(leads.length).toBe(6);
    expect(leads).toContainEqual({ name: "Hardware", lead: "Imani Ferreira", title: "Hardware Lead" });
    const big = await weft.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM pay_rates WHERE kind = 'salary' AND amount_cents > 20000000`);
    expect(big[0]!.n).toBe(2);
    const w4 = await weft.db.all<{ pre: number; s2: number; s3: number; s4: number }>(sql`SELECT SUM(w4_version = 'pre2020') AS pre, SUM(step2_checkbox) AS s2, SUM(step3_cents > 0) AS s3, SUM(step4a_cents + step4b_cents + step4c_cents > 0) AS s4 FROM tax_profiles`);
    expect(w4).toEqual([{ pre: 1, s2: 3, s3: 6, s4: 2 }]);
  });
});

describe("GET /v1/workers", () => {
  it("pages with afterId and filters by state and type", async () => {
    const a = Page(Worker).parse(await (await get("/v1/workers?limit=5")).json());
    expect(a).toMatchObject({ hasMore: true, count: 5 });
    const b = Page(Worker).parse(await (await get(`/v1/workers?limit=5&afterId=${a.data[4]!.id}`)).json());
    expect(b.data[0]!.id).toBe("wrk_0006");
    const tx = Page(Worker).parse(await (await get("/v1/workers?state=TX&limit=100")).json());
    expect(tx.count).toBe(12);
    const c = Page(Worker).parse(await (await get("/v1/workers?type=contractor")).json());
    expect(c.data.map((w) => w.currency)).toEqual(["EUR", "INR", "CAD"]);
  });

  it("detail masks the SSN and shows compensation to Dana", async () => {
    const res = await get("/v1/workers/wrk_0004");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.worker.displayName).toBe("Imani Ferreira (demo)");
    expect(body.worker.ssnMasked).toMatch(/^\*\*\*-\*\*-\d{4}$/);
    expect(JSON.stringify(body)).not.toMatch(/\b\d{3}-\d{2}-\d{4}\b/);
    expect(body.payRates[0].amount).toEqual({ amount: 23_200_000, currency: "USD", display: "$232,000.00" });
    expect((await get("/v1/workers/wrk_9999")).status).toBe(404);
  });

  it("onboarding checklist route answers for a worker", async () => {
    const res = await get("/v1/workers/wrk_0001/onboarding");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

describe("people and onboarding read commands", () => {
  it("people.search is concise, readable and never returns profile fields", async () => {
    const out = await runDirect("people.search", { state: "CA", response_format: null }, directCtx(weft.clock), deps());
    expect(out.data.total).toBe(22);
    expect(out.data.workers[0]).toEqual({ id: "wrk_0001", name: "Dana Whitfield (demo) (wrk_0001)", title: "Head of People", department: "People", work_state: "CA", status: "active", start_date: "2023-03-01" });
    expect(JSON.stringify(out)).not.toMatch(/preferred|personal_email|home_address/);
    const q = await runDirect("people.search", { query: "Ferreira" }, directCtx(weft.clock), deps());
    expect(q.data.workers.map((w: { id: string }) => w.id)).toEqual(["wrk_0004"]);
  });

  it("concise people.get and onboarding.get_checklist return no non-empty untrustedFields; detailed profile text taints", async () => {
    for (const id of ["wrk_0001", "wrk_0022", "wrk_0026", "wrk_0034", "wrk_0048"]) {
      const g = await runDirect("people.get", { worker_id: id }, directCtx(weft.clock), deps());
      expect(nonEmptyUntrusted(findCommand("people.get"), g.data), id).toEqual([]);
      const ch = await runDirect("onboarding.get_checklist", { worker_id: id }, directCtx(weft.clock), deps());
      expect(nonEmptyUntrusted(findCommand("onboarding.get_checklist"), ch.data), id).toEqual([]);
    }
    const tom = await runDirect("people.get", { worker_id: "wrk_0032", response_format: "detailed" }, directCtx(weft.clock), deps());
    expect(nonEmptyUntrusted(findCommand("people.get"), tom.data)).toEqual(["worker.preferred_name"]);
    const plain = await runDirect("people.get", { worker_id: "wrk_0001", response_format: "detailed" }, directCtx(weft.clock), deps());
    expect(nonEmptyUntrusted(findCommand("people.get"), plain.data)).toEqual([]);
  });

  it("people.get shows pay in cents with display and the missing bank account", async () => {
    const g = await runDirect("people.get", { worker_id: "wrk_0022" }, directCtx(weft.clock), deps());
    expect(g.data.worker.pay).toMatchObject({ kind: "salary", amount_cents: 10_400_000, amount_display: "$104,000.00" });
    expect(g.data.worker.bank_account).toEqual({ status: "missing" });
    await expect(runDirect("people.get", { worker_id: "wrk_9999" }, directCtx(weft.clock), deps())).rejects.toMatchObject({ code: "DOMAIN_NOT_FOUND" });
  });

  it("every t2 read command parses an all-null-optionals sample", () => {
    const samples: Record<string, unknown> = {
      "people.search": { query: null, state: null, status: null, department_id: null, limit: null, response_format: null },
      "people.get": { worker_id: "wrk_0001", response_format: null },
      "onboarding.get_checklist": { worker_id: "wrk_0001", response_format: null },
    };
    for (const [name, s] of Object.entries(samples)) {
      const def = findCommand(name);
      expect(def.input.safeParse(JSON.parse(JSON.stringify(s), (_k, v) => (v === null ? undefined : v))).success, name).toBe(true);
    }
  });
});

describe("seed actions (SPEC 5)", () => {
  it("the NY raise is an 18% pay rate effective 2026-10-16, closing the old rate on Oct 15", async () => {
    const rows = await weft.db.all<{ id: string; amount_cents: number; effective_from: string; effective_to: string | null }>(sql`SELECT id, amount_cents, effective_from, effective_to FROM pay_rates WHERE worker_id = 'wrk_0026' ORDER BY effective_from`);
    expect(rows.map((r) => [r.amount_cents, r.effective_from, r.effective_to])).toEqual([[11_800_000, "2024-03-04", "2026-10-15"], [13_924_000, "2026-10-16", null]]);
    const w = await weft.db.all<{ work_state: string }>(sql`SELECT work_state FROM workers WHERE id = 'wrk_0026'`);
    expect(w[0]!.work_state).toBe("NY");
  });
});
