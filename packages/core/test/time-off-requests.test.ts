// The time_off.list_requests N+1 fix (docs/cloudflare/design.md 4.5; track cf2-platform acceptance). The home tab polls
// /v1/time-off/requests every 10 s; per worker and policy the command called balanceFor and ledgerOf (two ledger reads
// each, 145 statements on the rich world). It now batch-loads workers, policies and every ledger row in one statement
// each. Pins: on the rich world the result is byte-identical to the per-worker implementation (kept below as the
// reference) for every filter, and the polled reads take at most 6 statements.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { ExecContext } from "@weft/contracts";
import { workers, type Db, type DbTx } from "@weft/db";
import { createTestWeft, type TestWeft } from "../../../apps/api/src/testing";
import { seedWorldProfile } from "../../seed/src/profile";
import { listRequestRows, holidaysNote, LEDGER_BATCH_IDS, ledgersByWorkerPolicy, requestDto, timeOffCommands } from "../src/commands/time-off";
import { balanceFor, displayName, ledgerOf, loadPolicies, type RequestRow } from "../src/time-off/store";
import { requestBalance, requestTotals, timeForms, workerRef, type REQUEST_TOTALS_BY } from "../src/time-off/forms";
import { inScope, outsideReports, readScopeOf, reportsAccess, type ReadScope } from "../src/people/scope";
import { ptDateOf } from "../src/demo/define";
import { eq } from "drizzle-orm";
import type { CommandDeps } from "../src/shared/deps";

type Input = { request_id?: string; status?: "pending" | "approved" | "denied" | "cancelled" | "taken"; worker_id?: string; department_id?: string; approver?: string; from?: string; to?: string; totals_by?: (typeof REQUEST_TOTALS_BY)[number][] };

/** The implementation before the fix, verbatim in its reads: balanceFor and ledgerOf per worker and policy. */
async function referenceListRequests(i: Input, ctx: ExecContext, tx: DbTx) {
  const requestVisible = (scope: ReadScope | null, r: { workerId: string; approverPrincipalId: string | null }) => !scope || inScope(scope, r.workerId) || r.approverPrincipalId === scope.viewerId;
  const scope = await readScopeOf(tx, ctx);
  const every = await listRequestRows(tx, ctx.companyId, i);
  const rows = every.filter((r) => requestVisible(scope, r));
  const withheld = every.length - rows.length;
  const ws = new Map((await tx.select().from(workers).where(eq(workers.companyId, ctx.companyId))).map((w) => [w.id, w]));
  const pols = new Map((await loadPolicies(tx, ctx.companyId)).map((p) => [p.id, p]));
  const today = ptDateOf(ctx.now);
  const ledgers = new Map<string, { available: number; rows: Awaited<ReturnType<typeof ledgerOf>> } | null>();
  const balanceAround = async (r: RequestRow) => {
    const key = `${r.workerId}:${r.policyId}`;
    if (!ledgers.has(key)) {
      const w = ws.get(r.workerId), p = pols.get(r.policyId);
      ledgers.set(key, w && p ? { available: (await balanceFor(tx, w, p, today)).availableMinutes, rows: await ledgerOf(tx, w.id, p.id) } : null);
    }
    const l = ledgers.get(key);
    if (!l) return requestBalance(null, 0);
    const counted = -l.rows.filter((x) => x.sourceRef === r.id && (x.kind === "hold" || x.kind === "hold_release" || x.kind === "use")).reduce((sum, x) => sum + x.minutes, 0);
    return requestBalance(l.available, counted);
  };
  const requests = [];
  for (const r of rows) {
    const w = ws.get(r.workerId);
    const dto = requestDto(r);
    requests.push({
      ...dto, workerName: w ? displayName(w) : r.workerId, departmentId: w?.departmentId ?? null, policyName: pols.get(r.policyId)?.name ?? r.policyId, typeKind: pols.get(r.policyId)?.typeKind ?? null, source: r.source, extRef: r.extRef,
      ...timeForms("requested", r.requestedMinutes), submitted_date: ptDateOf(r.createdAt), decided_date: r.decidedAt ? ptDateOf(r.decidedAt) : null, ...(await balanceAround(r)),
      ...(holidaysNote(dto.days) ? { holidays_note: holidaysNote(dto.days) } : {}),
    });
  }
  const totals = requestTotals(rows, i.totals_by ?? [], (id) => (ws.get(id) ? workerRef(ws.get(id)!) : id), (id) => pols.get(id)?.name ?? id);
  if (scope && i.request_id && withheld) throw outsideReports(scope, "time-off requests");
  const access = scope && withheld ? { access: reportsAccess(scope, "time-off requests", withheld) } : {};
  const withHolidays = requests.flatMap((r) => ("holidays_note" in r && r.holidays_note ? [`${r.workerName}: ${r.holidays_note}`] : [])).slice(0, 3);
  return { data: { count: requests.length, ...totals, requests, ...access }, summary: [`${requests.length} time-off requests${withheld ? `; ${withheld} outside your reports withheld` : ""}`, ...withHolidays].join("; ") };
}

let weft: TestWeft;
beforeAll(async () => {
  weft = await createTestWeft({ seed: false });
  await seedWorldProfile(weft, "rich");
  await weft.clock.set("2026-10-26T15:30:00.000Z", 0);
}, 240_000);
afterAll(async () => { await weft?.close(); });

/** Runs `fn` with a db whose client counts every statement (the command reads through deps.tx outside a transaction). */
async function counted<T>(fn: (db: Db) => Promise<T>): Promise<{ value: T; statements: number }> {
  const c = weft.db.$client as unknown as { execute: (...a: unknown[]) => Promise<unknown> };
  const orig = c.execute;
  let n = 0;
  c.execute = (...a: unknown[]) => { n++; return orig.apply(c, a); };
  try { return { value: await fn(weft.db), statements: n }; } finally { c.execute = orig; }
}

const cmd = timeOffCommands.find((c) => c.name === "time_off.list_requests")!;
const ctxFor = (principalId: string, role: string | null): ExecContext => ({
  companyId: "cmp_larkspur", principal: { id: principalId, kind: "human", role }, onBehalfOf: null, surface: "human_ui", agentKind: null,
  run: null, tainted: false, routineRunId: null, approvedProposalId: null, now: weft.clock.now(),
});
const deps = (db: Db) => ({ tx: db, sims: null, clock: weft.clock, newId: async () => { throw new Error("a read mints no id"); }, resolveCredential: async () => "" }) as unknown as CommandDeps;
const run = async (i: Input, ctx: ExecContext) => counted((db) => cmd.run(cmd.input.parse(i), ctx, deps(db)));

describe("time_off.list_requests on the rich world", () => {
  const viewers: [string, string | null][] = [["usr_dana", "admin"], ["usr_imani", "manager"]];
  const inputs = async (): Promise<Input[]> => {
    const [anyReq] = await weft.db.all<{ id: string; worker_id: string; approver_principal_id: string | null }>(sql`SELECT id, worker_id, approver_principal_id FROM time_off_requests ORDER BY id LIMIT 1`);
    const [dept] = await weft.db.all<{ id: string }>(sql`SELECT department_id AS id FROM workers WHERE department_id IS NOT NULL ORDER BY id LIMIT 1`);
    return [
      {}, { from: "2026-10-26" }, { from: "2026-09-01", to: "2026-10-26" }, { status: "pending" }, { status: "approved", totals_by: ["worker", "policy"] },
      { worker_id: anyReq!.worker_id }, { department_id: dept!.id }, { approver: anyReq!.approver_principal_id ?? "usr_dana" }, { request_id: anyReq!.id }, { totals_by: ["policy"] },
    ];
  };

  it("has enough requests across enough workers to show the N+1", async () => {
    const [n] = await weft.db.all<{ requests: number; workers: number }>(sql`SELECT count(*) AS requests, count(DISTINCT worker_id) AS workers FROM time_off_requests`);
    expect(n!.requests).toBeGreaterThan(20);
    expect(n!.workers).toBeGreaterThan(10);
  });

  it("is byte-identical to the per-worker implementation for every filter and viewer", async () => {
    for (const [who, role] of viewers) {
      for (const i of await inputs()) {
        const ctx = ctxFor(who, role);
        const ref = await referenceListRequests(i, ctx, weft.db).then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, v: String(e) }));
        const now = await run(i, ctx).then((r) => ({ ok: true as const, v: r.value }), (e: unknown) => ({ ok: false as const, v: String(e) }));
        expect(JSON.stringify(now), `${who} ${JSON.stringify(i)}`).toBe(JSON.stringify(ref));
      }
    }
  });

  it("takes at most 6 statements for the polled reads, against two ledger reads per worker and policy before", async () => {
    for (const [who, role] of viewers) {
      for (const i of [{}, { from: "2026-10-26" }, { from: "2026-09-01", to: "2026-10-26" }, { status: "pending" as const }]) {
        const { statements } = await run(i, ctxFor(who, role));
        expect(statements, `${who} ${JSON.stringify(i)}`).toBeLessThanOrEqual(6);
      }
    }
    const before = await counted((db) => referenceListRequests({}, ctxFor("usr_dana", "admin"), db));
    const after = await run({}, ctxFor("usr_dana", "admin"));
    expect(before.statements).toBeGreaterThan(40);
    expect(after.statements).toBe(5);
  });

  it("groups ledger rows per worker and policy in ledgerOf's order, also past the inArray batch size", async () => {
    const ids = (await weft.db.all<{ id: string }>(sql`SELECT DISTINCT worker_id AS id FROM time_off_ledger ORDER BY worker_id`)).map((r) => r.id);
    expect(ids.length).toBeGreaterThan(5);
    const viaIds = await ledgersByWorkerPolicy(weft.db, "cmp_larkspur", ids.slice(0, 5));
    for (const [key, rows] of viaIds) {
      const [w, p] = key.split(":");
      expect(rows.map((r) => r.id)).toEqual((await ledgerOf(weft.db, w!, p)).map((r) => r.id));
    }
    const many = [...ids, ...Array.from({ length: LEDGER_BATCH_IDS + 5 }, (_, n) => `wrk_9${String(n).padStart(3, "0")}`)];
    const viaCompany = await counted((db) => ledgersByWorkerPolicy(db, "cmp_larkspur", many));
    expect(viaCompany.statements).toBe(1);
    const viaSmall = await ledgersByWorkerPolicy(weft.db, "cmp_larkspur", ids);
    const flat = (m: Map<string, { id: string }[]>) => [...m.entries()].map(([k, v]) => [k, v.map((r) => r.id)] as const).sort(([a], [b]) => (a < b ? -1 : 1));
    expect(flat(viaCompany.value)).toEqual(flat(viaSmall));
    expect((await ledgersByWorkerPolicy(weft.db, "cmp_larkspur", [])).size).toBe(0);
  });

  it("answers /v1/time-off/requests through the API with the same requests", async () => {
    const res = await weft.app.request("/v1/time-off/requests?limit=100&from=2026-10-26", { headers: weft.uiHeaders("usr_dana") });
    expect(res.status).toBe(200);
    const page = (await res.json()) as { data: { id: string; balance_now: unknown }[] };
    const ref = await referenceListRequests({ from: "2026-10-26" }, ctxFor("usr_dana", "admin"), weft.db);
    const byId = new Map(ref.data.requests.map((r) => [r.id, r]));
    expect(page.data.length).toBeGreaterThan(0);
    for (const r of page.data) expect(JSON.parse(JSON.stringify(byId.get(r.id)))).toEqual(r);
  });
});
