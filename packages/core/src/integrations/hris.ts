// Workday worker and time-off sync into the native model (research/wave3/integrations-hr.md 3.2 F2, F3, 3.3, 3.4).
// Owner: w3-integrations-hr. integrations.apply_hris_change re-reads the changed workers through the connector (the
// Get_Workers transaction log window, never a request body) and:
// - links each Workday worker to the Weft worker with the same work email (ext_links, extType worker), or opens an
//   unmapped_value item when none matches;
// - applies a changed business title (a Workday-owned field) when the Weft value is unchanged since the last apply,
//   and opens a human-only sync_conflict when both sides changed;
// - never applies a pay-affecting change (base pay, frequency, work state, termination) silently: it opens a
//   sync_conflict and emits people.external_change, so the pre-payroll checks see it;
// - imports each approved time-off entry as one approved time_off_requests row with source workday and ext_ref the
//   entry WID, on the Weft policy of the mapped type (read-only: written only by this system record). No ledger rows:
//   when Workday owns time off, balances come from Workday.
// Then the connection cursor moves to the window end and ownership becomes Workday for people, compensation and time off.
import { and, eq, inArray } from "drizzle-orm";
import type { ExecContext, HrisTimeOffEntry, HrisWorker } from "@weft/contracts";
import { extLinks, payRates, timeOffAssignments, timeOffPolicies, timeOffRequests, timeOffTypes, workers } from "@weft/db";
import type { CommandDeps } from "../shared/deps";
import { findLink, getConnection, openSyncItem, readSnapshot, settingsOf, upsertConnection, valueHash, writeSnapshot } from "./store";

export const WORKDAY_EPOCH = "1970-01-01T00:00:00.000Z";
export const WORKDAY_OWNERSHIP = { people: "vendor", compensation: "vendor", time_off: "vendor" } as const;
/** Workday connection settings: absence type WID to Weft time-off type kind (seeded for the simulated tenant). */
export interface WorkdaySettings { time_off_types?: Record<string, string> }
const TIME_OFF_BACK_DAYS = 90, TIME_OFF_AHEAD_DAYS = 365;

type Ev = { type: string; subjectRef: string; payload: Record<string, string> };
export interface ApplyHrisResult {
  workers_seen: number; linked: string[]; applied: { worker_id: string; field: string; from: string | null; to: string | null }[];
  external_changes: string[]; time_off_imported: string[]; sync_item_ids: string[]; cursor: string; events: Ev[];
}

const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Every worker changed in the window, across Get_Workers pages. */
export async function changedWorkers(deps: CommandDeps, from: string, through: string): Promise<HrisWorker[]> {
  const out: HrisWorker[] = [];
  if (from > through) return out;
  for (let page = 1; page <= 50; page++) {
    const p = await deps.sims.vendors.workday.listChangedWorkers({ updatedFrom: from, updatedThrough: through, page });
    out.push(...p.items);
    if (!p.nextCursor) break;
  }
  return out;
}

async function currentPay(deps: CommandDeps, workerId: string): Promise<{ cents: number; kind: string } | null> {
  const rates = (await deps.tx.select().from(payRates).where(eq(payRates.workerId, workerId))).filter((r) => r.effectiveTo === null);
  const r = rates.sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
  return r ? { cents: r.amountCents, kind: r.kind } : null;
}

/** The Weft policy an imported entry lands on: the worker's assigned policy of that type, else one for the work state or US. */
export async function policyFor(deps: CommandDeps, companyId: string, workerId: string, kind: string, state: string | null): Promise<string | null> {
  const assigned = await deps.tx.select({ id: timeOffPolicies.id }).from(timeOffAssignments)
    .innerJoin(timeOffPolicies, eq(timeOffPolicies.id, timeOffAssignments.policyId)).innerJoin(timeOffTypes, eq(timeOffTypes.id, timeOffPolicies.typeId))
    .where(and(eq(timeOffAssignments.workerId, workerId), eq(timeOffTypes.kind, kind)));
  if (assigned[0]) return assigned[0].id;
  const any = await deps.tx.select({ id: timeOffPolicies.id, j: timeOffPolicies.jurisdiction }).from(timeOffPolicies)
    .innerJoin(timeOffTypes, eq(timeOffTypes.id, timeOffPolicies.typeId)).where(and(eq(timeOffPolicies.companyId, companyId), eq(timeOffTypes.kind, kind)));
  return (any.find((p) => p.j === state) ?? any.find((p) => p.j === "US") ?? null)?.id ?? null;
}

const OWNED = ["title", "base_cents", "work_state", "termination_date"] as const;
const incomingOf = (wd: HrisWorker) => ({ title: wd.title, base_cents: wd.baseAmountMinor === null ? null : String(wd.baseAmountMinor), work_state: wd.locationState, termination_date: wd.terminationDate });
const timeOffRange = (now: string) => { const today = now.slice(0, 10); return { from: addDays(today, -TIME_OFF_BACK_DAYS), to: addDays(today, TIME_OFF_AHEAD_DAYS) }; };

async function unimportedEntries(deps: CommandDeps, workerId: string, workerRef: string, now: string): Promise<HrisTimeOffEntry[]> {
  const entries = (await deps.sims.vendors.workday.listTimeOff({ workerRef, ...timeOffRange(now), status: "approved" })).items.filter((e) => e.status === "Approved");
  if (!entries.length) return [];
  const have = new Set((await deps.tx.select({ ext: timeOffRequests.extRef }).from(timeOffRequests).where(and(eq(timeOffRequests.workerId, workerId), eq(timeOffRequests.source, "workday"), inArray(timeOffRequests.extRef, entries.map((e) => e.entryRef))))).map((r) => r.ext));
  return entries.filter((e) => !have.has(e.entryRef));
}

/**
 * Detection for integrations.sync_now: the workers in the transaction log window (inclusive, so a frozen sim clock
 * misses nothing) that are new to Weft or whose Workday-owned values differ from the last snapshot, plus linked
 * workers with approved time off Weft has not imported. Reads only.
 */
export async function detectWorkday(deps: CommandDeps, from: string, through: string): Promise<string[]> {
  const out = new Set<string>();
  for (const wd of await changedWorkers(deps, from, through)) {
    const link = await findLink(deps.tx, "workday", "worker", wd.workerRef);
    if (!link) { out.add(wd.workerRef); continue; }
    const snap = await readSnapshot(deps.tx, "workday", "worker", wd.workerRef), inc = incomingOf(wd);
    if (OWNED.some((f) => snap[f] !== valueHash(inc[f]))) out.add(wd.workerRef);
  }
  const links = await deps.tx.select().from(extLinks).where(and(eq(extLinks.vendor, "workday"), eq(extLinks.extType, "worker"), eq(extLinks.status, "linked")));
  for (const l of links) if (!out.has(l.extId) && (await unimportedEntries(deps, l.weftId, l.extId, through)).length) out.add(l.extId);
  return [...out];
}

export async function applyHrisChange(deps: CommandDeps, ctx: ExecContext, i: { worker_refs: string[]; through: string }): Promise<ApplyHrisResult> {
  const now = ctx.now, tx = deps.tx;
  const conn = await getConnection(tx, ctx.companyId, "workday");
  const from = conn?.cursor ?? WORKDAY_EPOCH;
  const through = i.through > from ? i.through : now;
  const wanted = new Set(i.worker_refs);
  // Named workers are re-read whatever their last transaction (time off can be detected without one); otherwise the window.
  const changed = (await changedWorkers(deps, wanted.size ? WORKDAY_EPOCH : from, through)).filter((w) => wanted.size === 0 || wanted.has(w.workerRef));
  const typeMap: Record<string, string> = (settingsOf(conn) as WorkdaySettings).time_off_types ?? {};
  const res: ApplyHrisResult = { workers_seen: changed.length, linked: [], applied: [], external_changes: [], time_off_imported: [], sync_item_ids: [], cursor: through, events: [] };
  const open = async (kind: "sync_conflict" | "unmapped_value", subjectRef: string, detail: Record<string, string>, key: string) => {
    const r = await openSyncItem(deps, ctx.companyId, now, { vendor: "workday", kind, subjectRef, detail, key });
    if (r.created) { res.sync_item_ids.push(r.id); res.events.push({ type: "integration.sync_item_opened", subjectRef, payload: { sync_item_id: r.id } }); }
  };

  for (const wd of changed) {
    let link = await findLink(tx, "workday", "worker", wd.workerRef);
    if (!link) {
      const email = (wd.workEmail ?? "").toLowerCase();
      const [w] = email ? (await tx.select().from(workers).where(eq(workers.companyId, ctx.companyId))).filter((x) => x.workEmail.toLowerCase() === email) : [];
      if (!w) { await open("unmapped_value", `workday:worker:${wd.workerRef}`, { field: "worker", ext_id: wd.employeeId, ext_name: "Workday worker with no Weft match on work email", fallback: "" }, `worker:${wd.workerRef}`); continue; }
      const id = await deps.newId("extl_");
      await tx.insert(extLinks).values({ id, companyId: ctx.companyId, vendor: "workday", extType: "worker", extId: wd.workerRef, weftType: "worker", weftId: w.id, extVersion: null, status: "linked", createdAt: now, updatedAt: now });
      link = { id, companyId: ctx.companyId, vendor: "workday", extType: "worker", extId: wd.workerRef, weftType: "worker", weftId: w.id, extVersion: null, status: "linked", createdAt: now, updatedAt: now };
      res.linked.push(w.id);
    }
    const [w] = await tx.select().from(workers).where(eq(workers.id, link.weftId)).limit(1);
    if (!w) continue;
    const snap = await readSnapshot(tx, "workday", "worker", wd.workerRef);
    const pay = await currentPay(deps, w.id);
    const incoming = incomingOf(wd);
    const local = { title: w.title, base_cents: pay ? String(pay.cents) : null, work_state: w.workState, termination_date: w.endDate };
    const seen: Record<string, unknown> = {};
    let payChanged = false;
    for (const field of Object.keys(incoming) as (keyof typeof incoming)[]) {
      const vin = incoming[field], vloc = local[field];
      if (snap[field] === valueHash(vin)) continue;          // Workday did not change it since the last sync
      seen[field] = vin;
      if (vin === vloc) continue;                             // already equal: snapshot only
      const localUnchanged = snap[field] === undefined || snap[field] === valueHash(vloc);
      if (field === "title" && localUnchanged && vin) {
        await tx.update(workers).set({ title: vin, updatedAt: now }).where(eq(workers.id, w.id));
        res.applied.push({ worker_id: w.id, field, from: vloc, to: vin });
        continue;
      }
      if (field !== "title") payChanged = true;
      await open("sync_conflict", w.id, { field, weft_value: vloc ?? "", vendor_value: vin ?? "", vendor_label: "Workday", reason: field === "title" ? "changed_in_both" : "pay_affecting" }, `${field}:${valueHash(vin).slice(0, 12)}`);
    }
    await writeSnapshot(tx, "workday", "worker", wd.workerRef, seen, now);
    if (payChanged) { res.external_changes.push(w.id); res.events.push({ type: "people.external_change", subjectRef: w.id, payload: { worker_id: w.id, vendor: "workday" } }); }

    // Approved time off for this worker, read again from Workday.
    for (const e of await unimportedEntries(deps, w.id, wd.workerRef, now)) {
      const kind = typeMap[e.typeRef];
      const policyId = kind ? await policyFor(deps, ctx.companyId, w.id, kind, w.workState) : null;
      if (!policyId) { await open("unmapped_value", `workday:time_off_type:${e.typeRef}`, { field: "time_off_type", ext_id: e.typeRef, ext_name: kind ? `No Weft ${kind} policy for ${w.workState ?? "this state"}` : "Unmapped Workday absence type", fallback: "" }, `type:${e.typeRef}:${w.workState ?? ""}`); continue; }
      const id = await deps.newId("tor_");
      await tx.insert(timeOffRequests).values({
        id, companyId: ctx.companyId, workerId: w.id, policyId, status: "approved", startAt: e.date, endAt: e.date, rangeType: "date", timeZone: w.timezone,
        requestedMinutes: e.quantityMinutes, daysJson: JSON.stringify([{ date: e.date, minutes: e.quantityMinutes, holiday: false }]), reason: "",
        approverPrincipalId: null, routingJson: "[]", checksJson: "[]", decidedBy: null, decidedAt: now, decisionNote: "Approved in Workday",
        payrollRunId: null, actionSeq: null, source: "workday", extRef: e.entryRef, createdAt: now,
      });
      res.time_off_imported.push(id);
    }
  }
  await upsertConnection(tx, ctx.companyId, "workday", now, { cursor: through, lastSyncAt: now, health: "ok", ownershipJson: JSON.stringify(WORKDAY_OWNERSHIP) });
  return res;
}
