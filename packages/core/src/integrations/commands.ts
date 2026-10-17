// integrations.*, ats.* commands (docs/wave3.md, research/wave3/integrations-hr.md 3.6). Owner: w3-integrations-hr.
// Reads are R0 on every surface (candidate fields are untrusted). sync_now is R1 and only reads the vendor and emits
// id-only detection events. map_value is R2 and always a proposal. record_delivery and record_ats_hire are system
// records (svc_events, svc_scheduler). Resolving a sync item is human only.
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { IntegrationVendor, VENDOR_CATEGORY, type AtsHire } from "@weft/contracts";
import { departments, extLinks, integrationDeliveries, offers, payRates, syncItems, timeOffRequests, workers, workplaces } from "@weft/db";
import type { WeftCommand } from "../shared/deps";
import { DomainRefusal, notFound, readCommand, riskOf, writeCommand } from "../demo/define";
import { sha256Hex } from "../shared/hash";
import { canonicalJson } from "../shared/canonical-json";
import { allJobs, recordAtsHire } from "./ats";
import { applyHrisChange, changedWorkers, detectWorkday, WORKDAY_EPOCH } from "./hris";
import { getConnection, listSyncItems, settingsOf, toSyncItem, upsertConnection, type ConnectionSettings } from "./store";

const HrVendor = z.enum(["greenhouse", "workday"]);
const system = { tiers: { main: "unavailable" as const, task: "unavailable" as const }, mcp: "hidden" as const, access: "system_only" as const, risk: riskOf("R1"), approval: "never" as const, needs: "edit" as const, effect: "write" as const, reversible: false as const, preview: null, domain: "people" as const };

// ---- reads ---------------------------------------------------------------------------------------------------

const status = readCommand({
  name: "integrations.status", domain: "people",
  summary: "Connected HR systems: mode (simulated or real), health, last sync and open sync items.",
  description: "List the five integrations (Greenhouse, Workday, Checkr, HireRight, DocuSign): mode (simulated or real), health, last sync time and the count of open sync items each. Never returns credentials or secret values.",
  input: z.object({}),
  async run(_i, ctx, deps) {
    const open = await listSyncItems(deps.tx, ctx.companyId, { status: "open" });
    const out = [];
    for (const v of IntegrationVendor.options) {
      const s = await deps.sims.vendors[v].status();
      const c = await getConnection(deps.tx, ctx.companyId, v);
      out.push({ vendor: v, category: VENDOR_CATEGORY[v], mode: s.mode, health: c?.health ?? s.health, last_sync_at: c?.lastSyncAt ?? null, open_sync_items: open.filter((r) => r.vendor === v).length });
    }
    return { data: { integrations: out }, summary: out.map((x) => `${x.vendor} ${x.mode} ${x.health}, ${x.last_sync_at ? `last sync ${x.last_sync_at}` : "never synced"}, ${x.open_sync_items} open`).join("; ") };
  },
});

const ListSyncInput = z.object({ status: z.enum(["open", "resolved", "dismissed", "all"]).optional(), vendor: IntegrationVendor.optional(), subject_ref: z.string().optional() });
const listSync = readCommand({
  name: "integrations.list_sync_items", domain: "people",
  summary: "Open integration sync items: conflicts and values Weft could not map.",
  description: "List sync items: kind (sync_conflict, unmapped_value, orphaned, permission_gap), vendor, subject, status and detail (field, Weft value, vendor value, fallback). Default status open. Rows come only from syncs, so each vendor's last_sync_at is returned: null means it never synced, and an empty list is then no proof of being in sync. Resolving an item is a human decision in the Integrations screen.",
  input: ListSyncInput, untrustedFields: ["items.*.detail.ext_name", "items.*.detail.vendor_value"],
  async run(i, ctx, deps) {
    const status = i.status ?? "open";
    const rows = await listSyncItems(deps.tx, ctx.companyId, { status, vendor: i.vendor, subjectRef: i.subject_ref });
    const items = rows.map(toSyncItem).map((s) => ({ id: s.id, vendor: s.vendor, kind: s.kind, subject_ref: s.subjectRef, status: s.status, detail: s.detail, created_at: s.createdAt }));
    // What the list covers (round 1 R5): the rows come from syncs, so a vendor that never synced has none to list.
    const vendors = [];
    for (const v of i.vendor ? [i.vendor] : IntegrationVendor.options) vendors.push({ vendor: v, last_sync_at: (await getConnection(deps.tx, ctx.companyId, v))?.lastSyncAt ?? null });
    const never = vendors.filter((v) => v.last_sync_at === null).map((v) => v.vendor);
    const scope = `${status === "all" ? "" : `${status} `}sync item(s)${i.vendor ? ` for ${i.vendor}` : ""}${i.subject_ref ? ` on ${i.subject_ref}` : ""}`;
    const synced = vendors.filter((v) => v.last_sync_at !== null).map((v) => `${v.vendor} last synced ${v.last_sync_at}`);
    const state = [...synced, ...(never.length ? [`never synced: ${never.join(", ")}${items.length === 0 ? ", so an empty list is not proof of being in sync" : ""}`] : [])].join("; ");
    return { data: { count: items.length, items, status_filter: status, vendors }, summary: `${items.length === 0 ? "No" : items.length} ${scope}; ${state}` };
  },
});

const hireDto = (h: AtsHire) => ({
  application_ref: h.applicationId, candidate_ref: h.candidateId, offer_ref: h.offerId, offer_version: h.offerVersion, first: h.first, last: h.last, email: h.email,
  job_name: h.jobName, department_ext_id: h.departmentExtId, office_ext_id: h.officeExtId, start_date: h.startDate,
  salary_cents: h.salary?.currency === "USD" ? h.salary.amountMinor : null, salary_currency: h.salary?.currency ?? null, hired_at: h.hiredAt,
});
const getHire = readCommand({
  name: "ats.get_hire", domain: "people",
  summary: "One hire from the applicant tracking system, with the Weft offer it is linked to.",
  description: "Read a hired application from Greenhouse (simulated unless connected): candidate name and email (candidate-entered, untrusted), job, department and office ids, start date, salary in cents and the current offer version, plus the linked Weft offer id. Takes application_ref.",
  input: z.object({ application_ref: z.string().min(1).max(40) }),
  untrustedFields: ["hire.first", "hire.last", "hire.email", "hire.job_name"],
  async run(i, _ctx, deps) {
    const h = await deps.sims.vendors.greenhouse.getHire(i.application_ref);
    if (!h) throw notFound("Greenhouse hire", i.application_ref);
    const [link] = await deps.tx.select().from(extLinks).where(and(eq(extLinks.vendor, "greenhouse"), eq(extLinks.extType, "application"), eq(extLinks.extId, h.applicationId))).limit(1);
    return { data: { hire: hireDto(h), weft_offer_id: link?.weftId ?? null, linked_version: link?.extVersion ?? null }, summary: `Greenhouse application ${h.applicationId}, offer version ${h.offerVersion}` };
  },
});

const listJobs = readCommand({
  name: "ats.list_jobs", domain: "people",
  summary: "Open roles from the applicant tracking system or its public job board.",
  description: "List jobs from Greenhouse (simulated unless connected): id, name, department, office, location, last update and the public board link. source board (open roles, default) or harvest (all jobs).",
  input: z.object({ source: z.enum(["board", "harvest"]).optional() }), untrustedFields: ["jobs.*.name", "jobs.*.department", "jobs.*.office", "jobs.*.location"],
  async run(i, _ctx, deps) {
    const page = await deps.sims.vendors.greenhouse.listJobs({ cursor: null, source: i.source ?? "board" });
    const jobs = page.items.map((j) => ({ id: j.id, name: j.name, department: j.departmentName, office: j.officeName, location: j.location, updated_at: j.updatedAt, url: j.url }));
    return { data: { count: jobs.length, jobs }, summary: `${jobs.length} job(s)` };
  },
});

// ---- sync_now: read the vendor, emit id-only detection events --------------------------------------------------

const syncNow = writeCommand({
  name: "integrations.sync_now", summary: "Poll an HR integration now for new or changed records.",
  description: "Poll Greenhouse or Workday now: reads hires (or workers) changed since the last sync; each is then applied by a system record after a re-read. Writes only the sync time. R1: no approval.",
  input: z.object({ vendor: HrVendor }), domain: "people", needs: "edit", effect: "write", risk: riskOf("R1"), approval: "never", reversible: false, preview: null,
  lease: (i) => `integration:${i.vendor}`,
  async run(i, ctx, deps) {
    const now = ctx.now;
    if (i.vendor === "workday") {
      // Detection only: the Get_Workers transaction log window from the cursor to now. The cursor moves when
      // integrations.apply_hris_change has re-read and applied the same window.
      const conn = await getConnection(deps.tx, ctx.companyId, "workday");
      const detected = await detectWorkday(deps, conn?.cursor ?? WORKDAY_EPOCH, now);
      const status = await deps.sims.vendors.workday.status();
      await upsertConnection(deps.tx, ctx.companyId, "workday", now, { lastSyncAt: now, mode: status.mode, health: "ok" });
      return { data: { vendor: "workday", detected, through: now, last_sync_at: now }, summary: detected.length ? `Workday sync: ${detected.length} changed worker(s) to apply` : "Workday sync: nothing new" };
    }
    const conn = await getConnection(deps.tx, ctx.companyId, "greenhouse");
    const since = conn?.cursor ?? null;
    const detected: string[] = [];
    let cursor: string | null = null, watermark = since;
    for (let p = 0; p < 20; p++) {
      const page = await deps.sims.vendors.greenhouse.listHires({ updatedAfter: cursor ? null : since, cursor });
      for (const h of page.items) {
        const [link] = await deps.tx.select().from(extLinks).where(and(eq(extLinks.vendor, "greenhouse"), eq(extLinks.extType, "application"), eq(extLinks.extId, h.applicationId))).limit(1);
        if (!link || (link.extVersion ?? 0) < h.offerVersion) detected.push(h.applicationId);
        if (!watermark || h.hiredAt > watermark) watermark = h.hiredAt;
      }
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    const status = await deps.sims.vendors.greenhouse.status();
    await upsertConnection(deps.tx, ctx.companyId, "greenhouse", now, { lastSyncAt: now, mode: status.mode, health: "ok" });
    return {
      data: { vendor: "greenhouse", detected, last_sync_at: now },
      summary: detected.length ? `Greenhouse sync: ${detected.length} hire(s) to apply` : "Greenhouse sync: nothing new",
      events: detected.map((a) => ({ type: "integration.ats_hire_detected", subjectRef: `greenhouse:application:${a}`, payload: { vendor: "greenhouse", application_ref: a } })),
    };
  },
});

// ---- map_value: a proposal (a wrong map misroutes taxes) -----------------------------------------------------------

const MapInput = z.object({ vendor: z.literal("greenhouse"), field: z.enum(["department", "office"]), ext_id: z.string().min(1).max(40), weft_id: z.string().min(3).max(40) });
type MapInput = z.infer<typeof MapInput>;
async function mapTarget(deps: Parameters<WeftCommand["run"]>[2], companyId: string, i: MapInput) {
  if (i.field === "department") {
    const [d] = await deps.tx.select().from(departments).where(and(eq(departments.companyId, companyId), eq(departments.id, i.weft_id))).limit(1);
    if (!d) throw notFound("department", i.weft_id);
    return { name: d.name, state: null as string | null };
  }
  const [w] = await deps.tx.select().from(workplaces).where(and(eq(workplaces.companyId, companyId), eq(workplaces.id, i.weft_id))).limit(1);
  if (!w) throw notFound("workplace", i.weft_id);
  return { name: w.name, state: w.state };
}
const mapValue = writeCommand({
  name: "integrations.map_value", summary: "Map a Greenhouse department or office to a Weft department or workplace.",
  description: "Map a Greenhouse department (to a Weft department_id) or office (to a Weft workplace_id) so later hires import with it, and resolve the open unmapped-value items it answers. Draft offers still on the fallback take the mapped workplace. R2: always needs a human approval.",
  input: MapInput, domain: "people", needs: "edit", effect: "write", risk: riskOf("R2"), approval: "always", reversible: false,
  lease: (i) => `integration:${i.vendor}`,
  async preview(i, ctx, deps) {
    const t = await mapTarget(deps, ctx.companyId, i);
    const before = settingsOf(await getConnection(deps.tx, ctx.companyId, "greenhouse"))[i.field === "department" ? "departments" : "offices"]?.[i.ext_id] ?? "unmapped";
    return { title: `Map Greenhouse ${i.field} ${i.ext_id} to ${t.name} (${i.weft_id})`, diff: [{ label: `Greenhouse ${i.field} ${i.ext_id}`, before, after: i.weft_id }], content: [], moneyCents: null, subjectRef: `greenhouse:${i.field}:${i.ext_id}`, subjectHash: sha256Hex(canonicalJson({ field: i.field, ext: i.ext_id, before })), evidence: [] };
  },
  async run(i, ctx, deps) {
    const t = await mapTarget(deps, ctx.companyId, i);
    const conn = await getConnection(deps.tx, ctx.companyId, "greenhouse");
    const s: ConnectionSettings = settingsOf(conn);
    const key = i.field === "department" ? "departments" : "offices";
    s[key] = { ...(s[key] ?? {}), [i.ext_id]: i.weft_id };
    await upsertConnection(deps.tx, ctx.companyId, "greenhouse", ctx.now, { settingsJson: JSON.stringify(s) });
    const open = (await listSyncItems(deps.tx, ctx.companyId, { status: "open", vendor: "greenhouse" })).filter((r) => r.kind === "unmapped_value" && (JSON.parse(r.detailJson) as Record<string, string>).field === i.field && (JSON.parse(r.detailJson) as Record<string, string>).ext_id === i.ext_id);
    const updatedOffers: string[] = [];
    for (const r of open) {
      await deps.tx.update(syncItems).set({ status: "resolved", resolvedAt: ctx.now, resolvedBy: ctx.principal.id }).where(eq(syncItems.id, r.id));
      if (i.field === "office" && r.subjectRef.startsWith("offr_") && t.state) {
        const [o] = await deps.tx.select().from(offers).where(eq(offers.id, r.subjectRef)).limit(1);
        if (o && o.status === "draft" && o.workState === t.state) { await deps.tx.update(offers).set({ workplaceId: i.weft_id }).where(eq(offers.id, o.id)); updatedOffers.push(o.id); }
      }
    }
    return { data: { field: i.field, ext_id: i.ext_id, weft_id: i.weft_id, resolved_sync_items: open.map((r) => r.id), updated_offers: updatedOffers }, summary: `Mapped Greenhouse ${i.field} ${i.ext_id} to ${t.name}; resolved ${open.length} item(s)` };
  },
});

// ---- system records ------------------------------------------------------------------------------------------------

const RecordDeliveryInput = z.object({ vendor: IntegrationVendor, dedupe_key: z.string().min(1).max(120), action: z.string().max(60).nullable().optional(), raw_sha256: z.string().regex(/^[0-9a-f]{64}$/), application_ref: z.string().max(40).nullable().optional() });
const recordDelivery = writeCommand({
  ...system,
  name: "integrations.record_delivery", summary: "Store a verified vendor webhook delivery (ids only).",
  description: "System record: store one verified webhook delivery in integration_deliveries (vendor, delivery id, action, sha256 of the raw body, never the body). A duplicate delivery id is a no-op. A Greenhouse hire or offer update emits a detection event so the hire is re-read and applied.",
  input: RecordDeliveryInput,
  async run(i, ctx, deps) {
    const [dup] = await deps.tx.select().from(integrationDeliveries).where(and(eq(integrationDeliveries.vendor, i.vendor), eq(integrationDeliveries.dedupeKey, i.dedupe_key))).limit(1);
    if (dup) return { data: { delivery_id: dup.id, duplicate: true }, summary: `Duplicate ${i.vendor} delivery ${i.dedupe_key}: ignored` };
    const id = await deps.newId("dlv_");
    await deps.tx.insert(integrationDeliveries).values({ id, vendor: i.vendor, dedupeKey: i.dedupe_key, action: i.action ?? null, receivedAt: ctx.now, verified: true, rawSha256: i.raw_sha256, appliedAt: null, error: null });
    const detect = i.vendor === "greenhouse" && !!i.application_ref && ["hire_candidate", "offer_updated", "offer_approved", "offer_created"].includes(i.action ?? "");
    if (i.vendor === "greenhouse" && !detect) await deps.tx.update(integrationDeliveries).set({ appliedAt: ctx.now }).where(eq(integrationDeliveries.id, id));   // pings and actions Weft ignores
    return {
      data: { delivery_id: id, duplicate: false, detected: detect },
      summary: `Stored ${i.vendor} delivery ${id} (${i.action ?? "no action"})`,
      events: detect ? [{ type: "integration.ats_hire_detected", subjectRef: id, payload: { vendor: "greenhouse", application_ref: i.application_ref! } }] : [],
    };
  },
});

const recordHire = writeCommand({
  ...system,
  name: "integrations.record_ats_hire", summary: "Apply a Greenhouse hire after re-reading it: one draft offer per application.",
  description: "System record: re-read the hire from Greenhouse, then create one draft Weft offer linked in ext_links (offer.imported), or, for a later offer version, open a human-only sync conflict for a changed start date or salary. Unmapped values open sync items. Never overwrites a Weft value.",
  input: z.object({ vendor: z.literal("greenhouse"), application_ref: z.string().min(1).max(40), delivery_id: z.string().max(20).optional() }),
  lease: (i) => `ats:${i.application_ref}`,
  async run(i, ctx, deps) {
    const r = await recordAtsHire(deps, ctx, i.vendor, i.application_ref, i.delivery_id);
    const { events, ...data } = r;
    return { data, summary: `Greenhouse application ${r.application_ref}: ${r.outcome}${r.offer_id ? ` (offer ${r.offer_id})` : ""}`, events };
  },
});

const applyHris = writeCommand({
  ...system,
  name: "integrations.apply_hris_change", summary: "Apply Workday worker and time-off changes after re-reading them.",
  description: "System record: re-read the Workday workers changed in the window (ids only in, never a body), link them by work email, apply a changed title, open sync items for pay-affecting changes (people.external_change) and import approved time off as read-only requests with source workday.",
  input: z.object({ vendor: z.literal("workday"), worker_refs: z.array(z.string().regex(/^[0-9a-f]{32}$/)).max(500), through: z.string().datetime() }),
  lease: () => "hris:workday:apply",
  async run(i, ctx, deps) {
    const r = await applyHrisChange(deps, ctx, i);
    const { events, ...data } = r;
    return { data, summary: `Workday: ${r.workers_seen} worker(s), ${r.applied.length} change(s) applied, ${r.time_off_imported.length} time-off entr${r.time_off_imported.length === 1 ? "y" : "ies"} imported, ${r.sync_item_ids.length} sync item(s)`, events };
  },
});

async function workdayRefOf(deps: Parameters<WeftCommand["run"]>[2], workerId: string): Promise<string> {
  const [l] = await deps.tx.select().from(extLinks).where(and(eq(extLinks.vendor, "workday"), eq(extLinks.extType, "worker"), eq(extLinks.weftId, workerId))).limit(1);
  if (!l) throw new DomainRefusal("DOMAIN_NOT_LINKED", `${workerId} is not linked to a Workday worker yet`, "Run integrations.sync_now for workday first", null);
  return l.extId;
}
const getWorkerExternal = readCommand({
  name: "hris.get_worker_external", domain: "people",
  summary: "Compare a worker's Weft record with Workday (simulated unless connected).",
  description: "Read the linked Workday worker for worker_id and compare title, work state, base pay (cents) and termination date with Weft, field by field. Takes worker_id.",
  input: z.object({ worker_id: z.string().startsWith("wrk_") }), untrustedFields: ["fields.*.workday"],
  async run(i, ctx, deps) {
    const ref = await workdayRefOf(deps, i.worker_id);
    const [w] = await deps.tx.select().from(workers).where(and(eq(workers.companyId, ctx.companyId), eq(workers.id, i.worker_id))).limit(1);
    if (!w) throw notFound("worker", i.worker_id);
    const wd = (await changedWorkers(deps, WORKDAY_EPOCH, ctx.now)).find((x) => x.workerRef === ref) ?? null;
    if (!wd) throw notFound("Workday worker", ref);
    const rate = (await deps.tx.select().from(payRates).where(eq(payRates.workerId, w.id))).filter((r) => r.effectiveTo === null).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
    const pairs: [string, string | number | null, string | number | null][] = [["title", w.title, wd.title], ["work_state", w.workState, wd.locationState], ["base_cents", rate?.amountCents ?? null, wd.baseAmountMinor], ["termination_date", w.endDate, wd.terminationDate]];
    const fields = pairs.map(([field, weft, workday]) => ({ field, weft, workday, same: weft === workday }));
    return { data: { worker_id: w.id, workday_ref: ref, employee_id: wd.employeeId, fields }, summary: `${fields.filter((f) => !f.same).length} field(s) differ from Workday` };
  },
});
const listTimeOffExt = readCommand({
  name: "hris.list_time_off", domain: "people",
  summary: "Time off for a worker as Workday holds it (simulated unless connected).",
  description: "List the Workday time-off entries for worker_id (date, minutes, type, status and the employee's comment, which is untrusted) from from to to (YYYY-MM-DD), and which ones Weft imported as read-only requests. status approved (default) or all.",
  input: z.object({ worker_id: z.string().startsWith("wrk_"), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), status: z.enum(["approved", "all"]).optional() }),
  untrustedFields: ["entries.*.comment"],
  async run(i, _ctx, deps) {
    const ref = await workdayRefOf(deps, i.worker_id);
    const page = await deps.sims.vendors.workday.listTimeOff({ workerRef: ref, from: i.from, to: i.to, status: i.status ?? "approved" });
    const imported = new Map((await deps.tx.select().from(timeOffRequests).where(and(eq(timeOffRequests.workerId, i.worker_id), eq(timeOffRequests.source, "workday")))).map((r) => [r.extRef, r.id]));
    const entries = page.items.map((e) => ({ entry_ref: e.entryRef, date: e.date, minutes: e.quantityMinutes, type_ref: e.typeRef, status: e.status, comment: e.comment, weft_request_id: imported.get(e.entryRef) ?? null }));
    return { data: { worker_id: i.worker_id, count: entries.length, entries }, summary: `${entries.length} Workday time-off entr${entries.length === 1 ? "y" : "ies"}` };
  },
});

// ---- human only: resolve a sync item -------------------------------------------------------------------------------

const resolveSync = writeCommand({
  name: "integrations.resolve_sync_item", summary: "Resolve a sync item: keep the Weft value or take the vendor value.",
  description: "Human only, in the Integrations screen: resolve sync_item_id. take weft keeps Weft as it is; take vendor applies the vendor value (start date or base salary) to a draft offer, or a Workday title to the worker. A sent offer and a pay change are refused.",
  input: z.object({ sync_item_id: z.string().startsWith("syn_"), take: z.enum(["weft", "vendor"]) }), domain: "people", needs: "edit", effect: "write", risk: riskOf("R2"), approval: "never", access: "human_only", reversible: false, preview: null,
  async run(i, ctx, deps) {
    const [r] = await deps.tx.select().from(syncItems).where(and(eq(syncItems.companyId, ctx.companyId), eq(syncItems.id, i.sync_item_id), isNull(syncItems.resolvedAt))).limit(1);
    if (!r || r.status !== "open") throw new DomainRefusal("DOMAIN_SYNC_ITEM_CLOSED", `Sync item ${i.sync_item_id} is not open`, "List open items with integrations.list_sync_items", null);
    const d = JSON.parse(r.detailJson) as Record<string, string>;
    let applied: string | null = null;
    if (i.take === "vendor") {
      if (r.kind !== "sync_conflict") throw new DomainRefusal("DOMAIN_NOTHING_TO_TAKE", `${r.kind} has no vendor value to apply`, "Map the value with integrations.map_value, or keep the Weft value", null);
      if (r.subjectRef.startsWith("wrk_")) {
        if (d.field !== "title") throw new DomainRefusal("DOMAIN_PAY_CHANGE_IN_PEOPLE", `A Workday ${d.field} change affects pay; apply it from the person's pay settings so payroll previews it`, "Keep the Weft value here once the change is applied in People", null);
        const [w] = await deps.tx.select().from(workers).where(and(eq(workers.companyId, ctx.companyId), eq(workers.id, r.subjectRef))).limit(1);
        if (!w) throw notFound("worker", r.subjectRef);
        await deps.tx.update(workers).set({ title: d.vendor_value!, updatedAt: ctx.now }).where(eq(workers.id, w.id));
        applied = `title ${w.title} to ${d.vendor_value}`;
        await deps.tx.update(syncItems).set({ status: "resolved", resolvedAt: ctx.now, resolvedBy: ctx.principal.id, detailJson: JSON.stringify({ ...d, resolution: i.take }) }).where(eq(syncItems.id, r.id));
        return { data: { sync_item_id: r.id, take: i.take, applied, subject_ref: r.subjectRef }, summary: `Resolved ${r.id}: took the Workday value (${applied})` };
      }
      const [o] = await deps.tx.select().from(offers).where(eq(offers.id, r.subjectRef)).limit(1);
      if (!o) throw notFound("offer", r.subjectRef);
      if (o.status !== "draft") throw new DomainRefusal("DOMAIN_OFFER_NOT_DRAFT", `Offer ${o.id} is ${o.status}; only a draft takes a vendor change`, "Keep the Weft value, or void the offer and import it again", null);
      if (d.field === "start_date") { await deps.tx.update(offers).set({ startDate: d.vendor_value! }).where(eq(offers.id, o.id)); applied = `start_date ${o.startDate} to ${d.vendor_value}`; }
      else if (d.field === "base_cents") { await deps.tx.update(offers).set({ baseCents: Number(d.vendor_value) }).where(eq(offers.id, o.id)); applied = `base_cents ${o.baseCents} to ${d.vendor_value}`; }
    }
    await deps.tx.update(syncItems).set({ status: "resolved", resolvedAt: ctx.now, resolvedBy: ctx.principal.id, detailJson: JSON.stringify({ ...d, resolution: i.take }) }).where(eq(syncItems.id, r.id));
    return { data: { sync_item_id: r.id, take: i.take, applied, subject_ref: r.subjectRef }, summary: `Resolved ${r.id}: ${i.take === "vendor" ? `took the vendor value (${applied ?? "nothing to apply"})` : "kept the Weft value"}` };
  },
});

export const hrIntegrationCommands: WeftCommand[] = [status, listSync, getHire, listJobs, getWorkerExternal, listTimeOffExt, syncNow, mapValue, recordDelivery, recordHire, applyHris, resolveSync];
export { allJobs };
