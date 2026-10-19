// Manager read scope on the routes and reads the first privacy fix left open (docs/review-log.md, fix group
// manager-privacy, "Left"): payroll, offers, time off, offboarding, background checks, sync items, IT, training,
// documents and onboarding tasks; then (demo-perfect round 2) benefits, contractor payouts, the compliance calendar,
// hand-offs and the simulator state. Runs on the rich world, where each of these has rows about people outside Imani
// Ferreira (demo)'s reports. A manager (payroll: none, it: none) reads no pay run or paycheck at all, and for anyone
// outside her reporting chain no leave reason or balance, no offboarding case, no background check, no onboarding
// task, no document and no offer pay. Dana (admin) still reads everything. Scripted provider only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { type HumanSession, type ToolOutcome } from "@weft/contracts";
import { reportsUnder } from "@weft/core";
import { offers, workers } from "@weft/db";
import { seedWorldProfile } from "@weft/seed/profile";
import { registered } from "../src/agent/chat-allowlist";
import { createTestWeft, type TestWeft } from "../src/testing";

let weft: TestWeft;
let mine: Set<string>;          // Imani's own worker id and every direct and indirect report
let outsider: string;           // an active employee outside her chain
let managerOf: Map<string, string | null>;

const IMANI = "usr_imani";
const get = async (who: string, path: string) => weft.app.request(path, { headers: weft.uiHeaders(who) });
const json = async <T = unknown>(who: string, path: string): Promise<T> => {
  const res = await get(who, path);
  expect(res.status, `${who} ${path}`).toBe(200);
  return (await res.json()) as T;
};
const rowsOf = <T>(body: unknown): T[] => (Array.isArray(body) ? body : ((body as { data?: T[]; items?: T[] }).data ?? (body as { items?: T[] }).items ?? [])) as T[];
const MONEY = /\$\d[\d,]*\.\d\d|"(gross|net|amount)_?(cents)?":\s*\d/i;

// Every read command, so the agent path of each narrowed read is exercised (the chat allowlist is a subset).
const READS = ["payroll.get_run", "time_off.list_requests", "time_off.get_balance", "offboarding.list_cases", "offboarding.get_case", "screening.get_status", "onboarding.get_checklist", "onboarding.ready_check", "documents.list", "training.list_assignments"];
let n = 0;
async function chatAs(principalId: string) {
  const session = { principalId, companyId: "cmp_larkspur", via: "ui", keyScope: null } as HumanSession;
  const handle = await weft.executor.runs.openChatRun(session, { threadId: null, surface: "human_ui", allowlist: registered(weft.executor.registry, READS)! });
  return (command: string, args: unknown) => weft.executor.agent.exec(handle, { callId: `r${++n}`, command, args });
}
const data = <T = Record<string, unknown>>(o: ToolOutcome): T => {
  if (!(o.ok && o.status === "done")) throw new Error(JSON.stringify(o).slice(0, 400));
  return o.data as T;
};

beforeAll(async () => {
  weft = await createTestWeft({ seed: false });
  await seedWorldProfile(weft, "rich");
  await weft.clock.set("2026-10-26T15:30:00.000Z", 0);
  const ws = await weft.db.select({ id: workers.id, managerId: workers.managerId, first: workers.firstName, last: workers.lastName, status: workers.status, type: workers.type }).from(workers);
  const imani = ws.find((w) => w.first === "Imani" && w.last === "Ferreira")!;
  mine = new Set([imani.id, ...reportsUnder(ws, imani.id)]);
  managerOf = new Map(ws.map((w) => [w.id, w.managerId]));
  outsider = ws.find((w) => !mine.has(w.id) && w.type === "employee" && w.status === "active")!.id;
  expect(mine.size).toBeGreaterThan(1);
}, 120_000);
afterAll(async () => { await weft.close(); });

describe("payroll reads need payroll view", () => {
  it("a manager reads no pay run, total or paycheck on any route, and the agent's payroll reads refuse her too", async () => {
    const runs = rowsOf<{ id: string }>(await json("usr_dana", "/v1/payrolls?limit=100"));
    const draft = runs.find((r) => r.id === "pay_2026_10_30") ?? runs[0]!;
    const pcs = rowsOf<{ id: string; workerId: string }>(await json("usr_dana", `/v1/payrolls/${draft.id}/paychecks?limit=100`));
    expect(pcs.length).toBeGreaterThan(10);
    const foreign = pcs.find((p) => !mine.has(p.workerId))!;
    for (const path of ["/v1/payrolls?limit=100", `/v1/payrolls/${draft.id}`, `/v1/payrolls/${draft.id}/paychecks?limit=100`, `/v1/paychecks/${foreign.id}`]) {
      const res = await get(IMANI, path);
      expect(res.status, path).toBe(403);
      const body = await res.text();
      expect(body, path).toContain("NOT_PERMITTED");
      expect(body, path).not.toMatch(MONEY);
    }
    const exec = await chatAs(IMANI);
    const out = await exec("payroll.get_run", { run_id: draft.id });
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).not.toMatch(MONEY);
  });
});

describe("offers", () => {
  it("offer pay only when she or a report is the hiring manager; every offer still lists for the persona menu", async () => {
    const all = rowsOf<{ id: string; managerId: string | null; base: { display: string } | null; baseCents: number | null; access?: { scope: string; reason: string } }>(await json(IMANI, "/v1/offers?limit=100"));
    const dana = rowsOf<{ id: string }>(await json("usr_dana", "/v1/offers?limit=100"));
    expect(all.length).toBe(dana.length);
    const outside = all.filter((o) => !o.managerId || !mine.has(o.managerId));
    expect(outside.length).toBeGreaterThan(0);
    for (const o of outside) {
      expect(o.base, o.id).toBeNull();
      expect(o.baseCents, o.id).toBeNull();
      expect(o.access?.reason).toContain("cannot share");
    }
    for (const o of all.filter((x) => x.managerId && mine.has(x.managerId))) expect(o.base?.display, o.id).toMatch(/^\$/);
    const one = outside[0]!;
    expect(((await json<{ baseCents: number | null }>(IMANI, `/v1/offers/${one.id}`)).baseCents)).toBeNull();
    expect(((await json<{ baseCents: number | null }>("usr_dana", `/v1/offers/${one.id}`)).baseCents)).toBeGreaterThan(0);
    // Mark accepted needs people edit: her grant is view, so the command refuses whatever the UI shows.
    const [sent] = await weft.db.select().from(offers).where(eq(offers.status, "sent")).limit(1);
    if (sent) {
      const res = await weft.app.request(`/v1/offers/${sent.id}/accept`, { method: "POST", headers: weft.uiHeaders(IMANI) });
      expect(JSON.stringify(await res.json())).toContain("NOT_PERMITTED");
    }
  });
});

describe("time off", () => {
  it("requests: only her reports' and those routed to her, with the reason; the rest are counted in access", async () => {
    const reqs = rowsOf<{ workerId: string; approverPrincipalId: string | null }>(await json(IMANI, "/v1/time-off/requests?limit=100"));
    const every = rowsOf<{ workerId: string; reason: string | null }>(await json("usr_dana", "/v1/time-off/requests?limit=100"));
    expect(every.some((r) => !mine.has(r.workerId))).toBe(true);
    expect(reqs.length).toBeGreaterThan(0);
    for (const r of reqs) expect(mine.has(r.workerId) || r.approverPrincipalId === IMANI, r.workerId).toBe(true);
    const exec = await chatAs(IMANI);
    // A long result reaches the model as a preview with the summary, so the summary says what was withheld.
    const out = await exec("time_off.list_requests", {});
    const listed = data<{ requests?: { workerId: string }[]; preview?: { workerId: string }[] }>(out);
    for (const r of listed.requests ?? listed.preview ?? []) expect(mine.has(r.workerId) || (r as { approverPrincipalId?: string }).approverPrincipalId === IMANI).toBe(true);
    expect(out.ok && out.status === "done" && out.summary).toMatch(/\d+ outside your reports withheld/);
    const foreign = every.find((r) => !mine.has(r.workerId))!;
    const one = await exec("time_off.list_requests", { request_id: (foreign as unknown as { id: string }).id });
    expect(one.ok ? "" : one.refusal.code).toBe("DOMAIN_OUTSIDE_REPORTS");
  });

  it("balances: only her reports; an outsider's balance and ledger are refused", async () => {
    const bal = rowsOf<{ workerId: string }>(await json(IMANI, "/v1/time-off/balances"));
    expect(bal.length).toBeGreaterThan(0);
    for (const b of bal) expect(mine.has(b.workerId), b.workerId).toBe(true);
    expect(rowsOf<{ workerId: string }>(await json("usr_dana", "/v1/time-off/balances")).some((b) => !mine.has(b.workerId))).toBe(true);
    for (const path of [`/v1/time-off/balances?workerId=${outsider}`, `/v1/time-off/ledger?workerId=${outsider}`]) {
      const res = await get(IMANI, path);
      expect(res.status, path).toBe(422);
      expect(await res.text()).toContain("DOMAIN_OUTSIDE_REPORTS");
    }
  });
});

describe("offboarding, background checks, onboarding, documents, training, IT and sync items", () => {
  it("offboarding cases: only her reports' (no kind for anyone else); an outsider's case is a 404 and the agent read refuses", async () => {
    const all = rowsOf<{ id: string; workerId: string }>(await json("usr_dana", "/v1/offboarding"));
    const foreign = all.filter((x) => !mine.has(x.workerId));
    expect(foreign.length).toBeGreaterThan(0);
    const hers = rowsOf<{ workerId: string }>(await json(IMANI, "/v1/offboarding"));
    for (const x of hers) expect(mine.has(x.workerId)).toBe(true);
    expect((await get(IMANI, `/v1/offboarding/${foreign[0]!.id}`)).status).toBe(404);
    const exec = await chatAs(IMANI);
    const one = await exec("offboarding.get_case", { case_id: foreign[0]!.id });
    expect(one.ok ? "" : one.refusal.code).toBe("DOMAIN_OUTSIDE_REPORTS");
    const listed = data<{ cases: { worker_id?: string; workerId?: string }[]; access?: { withheld_rows: number } }>(await exec("offboarding.list_cases", {}));
    expect(listed.access?.withheld_rows).toBe(foreign.length);
  });

  it("background checks: only her own and her reports' hires", async () => {
    const all = rowsOf<{ id: string; offerId: string; workerId: string | null }>(await json("usr_dana", "/v1/screening/orders?limit=100"));
    const offerManagers = new Map((await weft.db.select({ id: offers.id, managerId: offers.managerId }).from(offers)).map((o) => [o.id, o.managerId]));
    const ok = (x: { offerId: string; workerId: string | null }) => (x.workerId && mine.has(x.workerId)) || mine.has(offerManagers.get(x.offerId) ?? "");
    const foreign = all.filter((x) => !ok(x));
    expect(foreign.length).toBeGreaterThan(0);
    const hers = rowsOf<{ offerId: string; workerId: string | null }>(await json(IMANI, "/v1/screening/orders?limit=100"));
    for (const x of hers) expect(ok(x)).toBe(true);
    expect(hers.length).toBe(all.length - foreign.length);
    expect((await get(IMANI, `/v1/screening/orders/${foreign[0]!.id}`)).status).toBe(404);
    const exec = await chatAs(IMANI);
    const st = await exec("screening.get_status", { order_id: foreign[0]!.id });
    expect(st.ok ? "" : st.refusal.code).toBe("DOMAIN_OUTSIDE_REPORTS");
  });

  it("onboarding tasks, documents and the agent's checklist and readiness reads stop at her reports", async () => {
    expect(rowsOf(await json(IMANI, `/v1/workers/${outsider}/onboarding`))).toEqual([]);
    expect(rowsOf(await json(IMANI, `/v1/workers/${outsider}/documents`))).toEqual([]);
    const docs = rowsOf<{ id: string }>(await json("usr_dana", `/v1/workers/${outsider}/documents`));
    if (docs[0]) expect((await get(IMANI, `/v1/documents/${docs[0].id}`)).status).toBe(404);
    const exec = await chatAs(IMANI);
    for (const [cmd, args] of [["onboarding.get_checklist", { worker_id: outsider }], ["documents.list", { worker_id: outsider }]] as const) {
      const o = await exec(cmd, args);
      expect(o.ok ? "" : o.refusal.code, cmd).toBe("DOMAIN_OUTSIDE_REPORTS");
    }
    const ready = data<{ hires: { worker_id: string }[] }>(await exec("onboarding.ready_check", { business_days: 10 }));
    for (const h of ready.hires) expect(mine.has(h.worker_id)).toBe(true);
  });

  it("training assignments: only her reports'", async () => {
    const all = rowsOf<{ workerId: string }>(await json("usr_dana", "/v1/training/assignments?limit=100"));
    const hers = rowsOf<{ workerId: string }>(await json(IMANI, "/v1/training/assignments?limit=100"));
    for (const a of hers) expect(mine.has(a.workerId)).toBe(true);
    if (all.some((a) => !mine.has(a.workerId))) expect(hers.length).toBeLessThan(all.length);
    const exec = await chatAs(IMANI);
    const listed = data<{ assignments: { worker_id: string }[]; needs_assignment: { worker_id: string }[] }>(await exec("training.list_assignments", {}));
    for (const a of [...listed.assignments, ...listed.needs_assignment]) expect(mine.has(a.worker_id)).toBe(true);
  });

  it("IT accounts and devices: closed by her grants (it: none), open to Dana", async () => {
    for (const path of ["/v1/it/accounts?limit=100", "/v1/it/devices?limit=100"]) {
      expect((await get(IMANI, path)).status, path).toBe(403);
      expect((await get("usr_dana", path)).status, path).toBe(200);
    }
  });

  it("sync items about someone outside her chain keep the field, never the values", async () => {
    const all = await json<{ id: string; subjectRef: string; detail: Record<string, unknown> }[]>("usr_dana", "/v1/sync-items?status=all");
    const hers = await json<{ id: string; subjectRef: string; detail: Record<string, unknown> }[]>(IMANI, "/v1/sync-items?status=all");
    expect(hers.length).toBe(all.length);
    for (const s of hers) {
      if (!s.subjectRef.startsWith("wrk_") || mine.has(s.subjectRef)) continue;
      expect(s.detail.weft_value, s.id).toBeUndefined();
      expect(s.detail.vendor_value, s.id).toBeUndefined();
      expect(s.detail.withheld).toEqual(["weft_value", "vendor_value"]);
    }
  });

  it("agent runs: a manager reads only the runs that acted for her, never Dana's chat answers or traces", async () => {
    const started = await weft.app.request("/v1/agent/runs", { method: "POST", headers: { ...weft.uiHeaders(IMANI), "content-type": "application/json" }, body: JSON.stringify({ text: "Who is out next week?" }) });
    expect(started.status).toBe(202);
    const all = rowsOf<{ id: string; summary: string | null }>(await json("usr_dana", "/v1/agent/runs?limit=100"));
    const hers = rowsOf<{ id: string }>(await json(IMANI, "/v1/agent/runs?limit=100"));
    expect(hers.length).toBeGreaterThan(0);
    expect(hers.length).toBeLessThan(all.length);
    const herIds = new Set(hers.map((x) => x.id));
    const foreign = all.find((x) => !herIds.has(x.id))!;
    for (const path of [`/v1/agent/runs/${foreign.id}`, `/v1/agent/runs/${foreign.id}/trace`]) expect((await get(IMANI, path)).status, path).toBe(404);
    expect((await get(IMANI, `/v1/agent/runs/${hers[0]!.id}/trace`)).status).toBe(200);
    expect((await get("usr_dana", `/v1/agent/runs/${foreign.id}/trace`)).status).toBe(200);
  });

  it("benefits elections, premiums and open enrollment: closed by her grants (benefits: none); the plan catalog stays", async () => {
    for (const path of ["/v1/benefits/enrollments?limit=100", `/v1/benefits/enrollments?workerId=${outsider}`, "/v1/benefits/reconciliation", "/v1/benefits/reconciliation?month=2026-09", "/v1/benefits/open-enrollment"]) {
      const res = await get(IMANI, path);
      expect(res.status, path).toBe(403);
      const body = await res.text();
      expect(body, path).toContain("NOT_PERMITTED");
      expect(body, path).not.toMatch(/Cents"|wrk_\d/);
      expect((await get("usr_dana", path)).status, path).toBe(200);
    }
    expect(rowsOf(await json(IMANI, "/v1/benefits/plans")).length).toBeGreaterThan(0);
    // Dana's reads hold rows about people outside Imani's chain, so the 403 is what keeps them from her.
    const findings = rowsOf<{ workerId: string | null }>(await json("usr_dana", "/v1/benefits/reconciliation"));
    expect(findings.some((f) => f.workerId && !mine.has(f.workerId))).toBe(true);
    expect(rowsOf<{ workerId: string }>(await json("usr_dana", "/v1/benefits/open-enrollment")).some((r) => !mine.has(r.workerId))).toBe(true);
  });

  it("contractor payouts: closed by her grants (payroll: none), open to Dana and Theo", async () => {
    const res = await get(IMANI, "/v1/contractors/payouts?limit=100");
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toContain("NOT_PERMITTED");
    expect(body).not.toMatch(/usdCents|amountMinor/);
    for (const who of ["usr_dana", "usr_theo"]) expect(rowsOf(await json(who, "/v1/contractors/payouts?limit=100")).length, who).toBeGreaterThan(0);
  });

  it("compliance calendar: training only for her own record and reports, no contractor forms; company deadlines stay", async () => {
    type Row = { id: string; kind: string; title: string; subjectRef: string | null };
    const all = await json<Row[]>("usr_dana", "/v1/compliance/calendar");
    const hers = await json<Row[]>(IMANI, "/v1/compliance/calendar");
    const assignments = rowsOf<{ id: string; workerId: string }>(await json("usr_dana", "/v1/training/assignments?limit=100"));
    const trainee = new Map(assignments.map((a) => [a.id, a.workerId]));
    const foreign = all.filter((r) => r.kind === "training_due" && !mine.has(trainee.get(r.subjectRef ?? "") ?? ""));
    expect(foreign.length, "training rows outside her chain").toBeGreaterThan(0);
    const herIds = new Set(hers.map((r) => r.id));
    for (const r of foreign) expect(herIds.has(r.id), r.title).toBe(false);
    for (const r of hers.filter((x) => x.kind === "training_due")) expect(mine.has(trainee.get(r.subjectRef ?? "") ?? ""), r.title).toBe(true);
    expect(hers.some((r) => r.kind === "contractor_form_expiry")).toBe(false);
    const company = all.filter((r) => r.kind === "filing" || r.kind === "deposit" || r.kind === "notice_response");
    expect(company.length).toBeGreaterThan(0);
    for (const r of company) expect(herIds.has(r.id), r.title).toBe(true);
    const names = foreign.map((r) => r.title.split(" for ").at(-1)!);
    const text = JSON.stringify(hers);
    for (const n of names) expect(text, n).not.toContain(`for ${n}`);
  });

  it("hand-offs about someone outside her chain are not listed and read as not found; company cases stay", async () => {
    type Case = { id: string; subjectRef: string | null; workerId: string | null };
    const all = rowsOf<Case>(await json("usr_dana", "/v1/handoffs?limit=100"));
    const offerManagers = new Map((await weft.db.select({ id: offers.id, managerId: offers.managerId }).from(offers)).map((o) => [o.id, o.managerId]));
    const about = (h: Case) => [h.workerId, h.subjectRef].filter((r): r is string => !!r && (r.startsWith("wrk_") || r.startsWith("offr_")));
    const ok = (h: Case) => about(h).every((r) => (r.startsWith("wrk_") ? mine.has(r) : mine.has(offerManagers.get(r) ?? "")));
    const foreign = all.filter((h) => !ok(h));
    expect(foreign.length, "cases about people outside her chain").toBeGreaterThan(0);
    const hers = rowsOf<Case>(await json(IMANI, "/v1/handoffs?limit=100"));
    expect(hers.length).toBe(all.length - foreign.length);
    for (const h of hers) expect(ok(h), h.id).toBe(true);
    expect(hers.some((h) => about(h).length === 0)).toBe(true);
    expect((await get(IMANI, `/v1/handoffs/${foreign[0]!.id}`)).status).toBe(404);
    expect((await get("usr_dana", `/v1/handoffs/${foreign[0]!.id}`)).status).toBe(200);
  });

  it("the simulator state leaves out pay run totals and device orders for her, and names what it left out", async () => {
    const dana = await json<{ bankBatches: unknown[]; deviceOrders: unknown[]; withheld?: string[] }>("usr_dana", "/v1/sim/state");
    expect(dana.bankBatches.length).toBeGreaterThan(0);
    expect(dana.withheld).toBeUndefined();
    const hers = await json<{ bankBatches: unknown[]; deviceOrders: unknown[]; withheld?: string[]; registrations: unknown[] }>(IMANI, "/v1/sim/state");
    expect(hers.bankBatches).toEqual([]);
    expect(hers.deviceOrders).toEqual([]);
    expect(hers.withheld).toEqual(["bankBatches", "deviceOrders"]);
    expect(hers.registrations.length).toBeGreaterThan(0);
  });

  it("the People and payroll roles still read every row", async () => {
    for (const who of ["usr_dana", "usr_sam"]) {
      const all = rowsOf<{ workerId: string }>(await json(who, "/v1/offboarding"));
      expect(all.some((x) => !mine.has(x.workerId)), who).toBe(true);
    }
    expect(rowsOf<{ workerId: string }>(await json("usr_theo", "/v1/time-off/balances")).some((b) => !mine.has(b.workerId))).toBe(true);
    expect(managerOf.size).toBeGreaterThan(40);
  });
});
