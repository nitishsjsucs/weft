// Empty reads say what they cover (docs/evals/round1-analysis.md R5). benefits.list_findings reads stored rows only, and
// only benefits.reconcile writes them, so an empty list for a month never reconciled used to read as "no overbilling".
// integrations.list_sync_items had the same gap for a vendor that never synced. Both now report the state of the job
// that writes their rows, and benefits.list_findings shows a labeled, non-storing preview when the carrier offers one.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { formatCents, type ExecContext, type SimClock, type Simulators } from "@weft/contracts";
import { actions, benefitEnrollments, benefitPlans, benefitReconFindings, integrationConnections, simCarrierInvoices, syncItems, type Db } from "@weft/db";
import { idMinter } from "../src/shared/ids";
import { benefitsCommands } from "../src/commands/benefits";
import { hrIntegrationCommands } from "../src/integrations/commands";
import { computeFindings, type ReconInvoice } from "../src/benefits/recon";
import type { CommandDeps } from "../src/shared/deps";
import { buildFixtureWorld, CO, fakeBank, openTempDb, TS } from "./payroll/fixture-world";

let db: Db;
let close: () => Promise<void>;
const clock: SimClock = { now: () => TS, rate: () => 0, advance: async () => {}, set: async () => {} };
const MONTH = TS.slice(0, 7);
const CARRIER = "Juniper Mutual (sim)";

beforeAll(async () => {
  const t = await openTempDb();
  db = t.db; close = t.close;
  await buildFixtureWorld(db);
});
afterAll(async () => { await close(); });

/** The carrier's bill for a month, built from enrollments with one planted error (the first medical line billed at family). */
async function bill(month: string): Promise<ReconInvoice> {
  const plans = new Map((await db.select().from(benefitPlans).where(eq(benefitPlans.carrier, CARRIER))).filter((p) => p.type !== "401k").map((p) => [p.id, p]));
  const enr = (await db.select().from(benefitEnrollments)).filter((e) => plans.has(e.planId) && e.status === "active" && e.effectiveFrom <= `${month}-01`).sort((a, b) => (a.id < b.id ? -1 : 1));
  let planted = false;
  const lines = enr.map((e) => {
    const plan = plans.get(e.planId)!;
    const tier = !planted && plan.type === "medical" ? ((planted = true), "family") : (e.tier ?? "ee");
    return { workerId: e.workerId, planId: e.planId, tier, periods: 2, amountCents: (JSON.parse(plan.pricesJson) as Record<string, number>)[tier]! * 2 };
  });
  return { month, carrier: CARRIER, lines, totalCents: lines.reduce((s, l) => s + l.amountCents, 0) };
}
/** invoice() stores on first call, like the simulator; peekInvoice() never writes. */
function carrier(withPeek: boolean) {
  const c = {
    invoice: vi.fn(async (month: string) => {
      const inv = await bill(month);
      const [have] = await db.select().from(simCarrierInvoices).where(and(eq(simCarrierInvoices.month, month), eq(simCarrierInvoices.carrier, CARRIER)));
      if (!have) await db.insert(simCarrierInvoices).values({ id: "simv_0001", month, carrier: CARRIER, linesJson: JSON.stringify(inv.lines), totalCents: inv.totalCents });
      return { ...inv, id: "simv_0001" };
    }),
    peekInvoice: vi.fn(async (month: string) => bill(month)),
  };
  if (!withPeek) delete (c as { peekInvoice?: unknown }).peekInvoice;
  return c;
}
const vendorSims = Object.fromEntries(["greenhouse", "workday", "checkr", "hireright", "docusign"].map((v) => [v, { status: async () => ({ mode: "simulated", health: "ok" }) }]));
const deps = (c = carrier(true)): CommandDeps => ({ tx: db, sims: { bank: fakeBank().bank, carrier: c, vendors: vendorSims } as unknown as Simulators, clock, newId: idMinter(db), resolveCredential: async (ref) => `secret-for-${ref}` });
const ctx = (): ExecContext => ({ companyId: CO, principal: { id: "usr_theo", kind: "human", role: "payroll_admin" }, onBehalfOf: null, surface: "human_ui", agentKind: null, run: null, tainted: false, routineRunId: null, approvedProposalId: null, now: TS });
const all = [...benefitsCommands, ...hrIntegrationCommands];
async function exec<T = Record<string, unknown>>(name: string, args: unknown, d = deps()): Promise<{ data: T; summary: string }> {
  const def = all.find((c) => c.name === name)!;
  const out = await def.run(def.input.parse(args) as never, ctx(), d);
  return { data: out.data as T, summary: out.summary };
}
const count = async (t: typeof simCarrierInvoices | typeof benefitReconFindings) => Number((await db.all<{ c: number }>(sql`SELECT count(*) AS c FROM ${t}`))[0]!.c);

type Findings = { count: number; findings: { kind: string; billed_display: string }[]; reconciled: boolean; reconciled_month: string; last_reconciled_at: string | null; preview: { label: string; month: string; count: number; findings: { id: null; kind: string; billed_display: string }[] } | null };

describe("benefits.list_findings for a month never reconciled", () => {
  it("says the month was never reconciled, and an empty list is not a clean bill (no carrier preview)", async () => {
    const c = carrier(false);
    const out = await exec<Findings>("benefits.list_findings", { month: MONTH }, deps(c));
    expect(out.data).toMatchObject({ count: 0, reconciled: false, reconciled_month: MONTH, last_reconciled_at: null, preview: null });
    expect(out.summary).toBe(`No stored findings for ${MONTH}; ${MONTH} has never been reconciled, so no findings are stored for it and an empty list is not a clean bill`);
    // A read never takes the storing path.
    expect(c.invoice).not.toHaveBeenCalled();
    expect(await count(simCarrierInvoices)).toBe(0);
  });

  it("with a non-storing carrier read, returns a labeled preview and stores nothing", async () => {
    const c = carrier(true);
    const out = await exec<Findings>("benefits.list_findings", { month: MONTH }, deps(c));
    const expected = await computeFindings(db, CO, await bill(MONTH));
    expect(expected.length).toBeGreaterThan(0);
    expect(out.data.reconciled).toBe(false);
    expect(out.data.preview).toMatchObject({ month: MONTH, count: expected.length });
    expect(out.data.preview!.label).toMatch(/^preview: .*not stored/);
    expect(out.data.preview!.findings.map((f) => [f.kind, f.billed_display])).toEqual(expected.map((d) => [d.kind, formatCents(d.billedCents)]));
    // Preview rows carry no id: there is nothing stored to dispute or cite.
    expect(out.data.preview!.findings.every((f) => f.id === null)).toBe(true);
    expect(out.summary).toContain(`preview (not stored): ${expected.length} possible findings`);
    expect(c.invoice).not.toHaveBeenCalled();
    expect(c.peekInvoice).toHaveBeenCalledWith(MONTH);
    expect([await count(simCarrierInvoices), await count(benefitReconFindings)]).toEqual([0, 0]);
  });
});

describe("benefits.list_findings after a reconciliation", () => {
  it("reports reconciled with last_reconciled_at and no preview; the stored findings match what the preview showed", async () => {
    const before = (await exec<Findings>("benefits.list_findings", { month: MONTH })).data.preview!;
    const c = carrier(true);
    await exec("benefits.reconcile", { month: MONTH }, deps(c));
    expect(c.invoice).toHaveBeenCalledTimes(1);
    const out = await exec<Findings>("benefits.list_findings", { month: MONTH }, deps(c));
    expect(out.data).toMatchObject({ reconciled: true, last_reconciled_at: TS, preview: null, count: before.count });
    expect(out.data.findings.map((f) => [f.kind, f.billed_display])).toEqual(before.findings.map((f) => [f.kind, f.billed_display]));
    expect(out.summary).toBe(`${before.count} stored findings for ${MONTH}; ${MONTH} was reconciled at ${TS}`);
    expect(c.peekInvoice).not.toHaveBeenCalled();
  });

  it("last_reconciled_at prefers the latest benefits.reconcile in the action log, reading an omitted month as the month of the call", async () => {
    const later = "2026-10-27T09:00:00.000Z";
    const row = { actorKind: "human", actorId: "usr_theo", command: "benefits.reconcile", argsHash: "x", summary: "Reconciled", reversible: "no", prevHash: "x", hash: "x" };
    await db.insert(actions).values([
      { ...row, seq: 900, actionId: "act_t900", ts: later, argsJson: JSON.stringify({}) },
      { ...row, seq: 901, actionId: "act_t901", ts: "2026-10-28T09:00:00.000Z", argsJson: JSON.stringify({ month: "2026-09" }) },
    ]);
    const out = await exec<Findings>("benefits.list_findings", { month: MONTH });
    expect(out.data.last_reconciled_at).toBe(later);
    // No month argument: the stored findings of every month, with the reconciliation state of the current month.
    const any = await exec<Findings & { month: string | null }>("benefits.list_findings", {});
    expect(any.data).toMatchObject({ month: null, reconciled_month: MONTH, reconciled: true });
    expect(any.summary).toContain("stored findings across all months");
  });
});

type Sync = { count: number; status_filter: string; vendors: { vendor: string; last_sync_at: string | null }[] };

describe("integrations.list_sync_items says which vendors ever synced", () => {
  it("an empty list for a vendor that never synced says so instead of reading as in sync", async () => {
    const out = await exec<Sync>("integrations.list_sync_items", { status: "all", vendor: "workday" });
    expect(out.data).toMatchObject({ count: 0, status_filter: "all", vendors: [{ vendor: "workday", last_sync_at: null }] });
    expect(out.summary).toBe("No sync item(s) for workday; never synced: workday, so an empty list is not proof of being in sync");
  });

  it("a vendor that synced reports its last sync, and every vendor is listed when none is named", async () => {
    const at = "2026-10-25T12:00:00.000Z";
    await db.insert(integrationConnections).values({ id: "icn_0001", companyId: CO, vendor: "greenhouse", mode: "simulated", lastSyncAt: at, health: "ok", settingsJson: "{}", updatedAt: at });
    await db.insert(syncItems).values({ id: "syn_0001", companyId: CO, vendor: "greenhouse", kind: "unmapped_value", subjectRef: "gh_dept_1", status: "open", detailJson: JSON.stringify({ field: "department" }), createdAt: at });
    const gh = await exec<Sync>("integrations.list_sync_items", { vendor: "greenhouse" });
    expect(gh.data).toMatchObject({ count: 1, status_filter: "open", vendors: [{ vendor: "greenhouse", last_sync_at: at }] });
    expect(gh.summary).toBe(`1 open sync item(s) for greenhouse; greenhouse last synced ${at}`);
    const every = await exec<Sync>("integrations.list_sync_items", {});
    expect(every.data.vendors.map((v) => v.vendor)).toEqual(["greenhouse", "workday", "checkr", "hireright", "docusign"]);
    expect(every.data.vendors.filter((v) => v.last_sync_at).map((v) => v.vendor)).toEqual(["greenhouse"]);
    // Items exist, so the never-synced note does not claim the list is empty.
    expect(every.summary).toBe(`1 open sync item(s); greenhouse last synced ${at}; never synced: workday, checkr, hireright, docusign`);
  });

  it("integrations.status names health, last sync and open items per vendor in its summary", async () => {
    const out = await exec<{ integrations: { vendor: string; last_sync_at: string | null; open_sync_items: number }[] }>("integrations.status", {});
    expect(out.data.integrations.find((x) => x.vendor === "greenhouse")).toMatchObject({ last_sync_at: "2026-10-25T12:00:00.000Z", open_sync_items: 1 });
    expect(out.summary).toContain("greenhouse simulated ok, last sync 2026-10-25T12:00:00.000Z, 1 open");
    expect(out.summary).toContain("workday simulated ok, never synced, 0 open");
  });
});
