// Simulated Workday (hris) for wave 3 (docs/wave3.md, research/wave3/integrations-hr.md section 2). Owner: w3-integrations-hr.
// Follows the published shapes from field names only (no vendored WSDL or OpenAPI file):
// - REST collections are { total, data }, paged with limit (default 20, at most 100) and offset.
// - Every reference is { id, descriptor, href } with a 32-character hex WID.
// - Incremental worker sync is the SOAP Get_Workers call with the transaction log window: a worker is returned when
//   Updated_From <= one of its transaction moments <= Updated_Through. The response carries Response_Results
//   (Total_Results, Total_Pages, Page_Results, Page) and Response_Data.Worker.
// - Time off follows the documented three steps: eligibleAbsenceTypes, then validTimeOffDates, then requestTimeOff,
//   which opens a business process event In Progress with Submitted entries; the manager's approval completes it
//   (Successfully Completed, entries Approved). A request also writes a transaction on the worker.
// Faults: workday.getWorkers and workday.requestTimeOff. Writes only sim_vendor_records; reads the seeded Weft people
// once, in seedLarkspur, to build the fictional tenant.
import { createHash } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { ConnectorStatus, FaultInjector, HrisBalance, HrisConnector, HrisOrg, HrisTimeOffEntry, HrisWorker, SimClock, SyncPage, W3IntegrationsHrHttpResponse, W3WorkdaySimControls } from "@weft/contracts";
import { departments, payRates, simVendorRecords, workers, type DbTx } from "@weft/db";
import { firstFault, SimFaultError } from "../faults";
import { mintId } from "../ids";

export const WORKDAY = "workday";
const HOST = "https://wd-impl.workday.example";
const TENANT = "larkspur_demo";
const REST_MAX_LIMIT = 100;
const SOAP_MAX_COUNT = 999;

export interface WdRef { id: string; descriptor: string; href: string }
export interface WdWorker {
  id: string; descriptor: string; href: string; workerId: string; firstName: string; lastName: string; primaryWorkEmail: string | null;
  businessTitle: string | null; primarySupervisoryOrganization: WdRef | null; manager: WdRef | null; location: (WdRef & { region: string | null }) | null;
  hireDate: string | null; terminationDate: string | null;
  compensation: { amount: number; currency: WdRef; frequency: WdRef } | null;
  transactionLog: { moment: string; type: string }[];
}
export interface WdOrg { id: string; descriptor: string; href: string; type: WdRef; code: string }
export interface WdAbsenceType { id: string; descriptor: string; href: string; unit: WdRef; category: WdRef }
export interface WdTimeOffEntry {
  id: string; date: string; quantity: number; unit: WdRef; timeOffType: WdRef; status: WdRef; reason: WdRef | null; comment: string | null;
  worker: WdRef; timeOffEventId: string;
}
export interface WdEvent { id: string; descriptor: string; href: string; status: WdRef; subject: WdRef; initiated: string; completed: string | null; entryIds: string[] }
export interface WdBalance { worker: WdRef; absencePlan: WdRef; quantity: number; unit: WdRef; effectiveDate: string }
type Kind = "worker" | "org" | "absence_type" | "time_off_entry" | "event" | "balance";
type Body<K extends Kind> = K extends "worker" ? WdWorker : K extends "org" ? WdOrg : K extends "absence_type" ? WdAbsenceType : K extends "time_off_entry" ? WdTimeOffEntry : K extends "event" ? WdEvent : WdBalance;

/** A 32-character hex Workday id, deterministic for the fictional tenant. */
export const wid = (key: string) => createHash("sha256").update(`workday-${key}`).digest("hex").slice(0, 32);
const ref = (kind: string, id: string, descriptor: string): WdRef => ({ id, descriptor, href: `${HOST}/api/${kind}/${id}` });
const HOURS = ref("units", wid("unit-hours"), "Hours");
export const WD_ABSENCE_TYPES = {
  vacation: { id: wid("absence-vacation"), descriptor: "Vacation" },
  sick: { id: wid("absence-sick"), descriptor: "Sick" },
} as const;
const STATUS = {
  submitted: ref("values/timeOff/status", wid("status-submitted"), "Submitted"),
  approved: ref("values/timeOff/status", wid("status-approved"), "Approved"),
  inProgress: ref("values/businessProcess/status", wid("bp-in-progress"), "In Progress"),
  complete: ref("values/businessProcess/status", wid("bp-complete"), "Successfully Completed"),
};
const VACATION_PLAN = ref("absencePlans", wid("plan-vacation"), "Larkspur Vacation Plan");
const SEED_BALANCE_HOURS = 80;
/** The worker a simulated change lands on unless the caller names one (a seeded Oakland engineer). */
export const WD_SIM_DEFAULT_INDEX = 1;

const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);
const isWeekday = (date: string) => { const d = new Date(`${date}T12:00:00.000Z`).getUTCDay(); return d !== 0 && d !== 6; };
const lastMoment = (w: WdWorker) => w.transactionLog.reduce((m, t) => (t.moment > m ? t.moment : m), "");

export type WorkdaySim = HrisConnector & W3WorkdaySimControls;

export function createWorkdaySim(db: DbTx, clock: SimClock, faults: FaultInjector): WorkdaySim {
  async function all<K extends Kind>(kind: K): Promise<Body<K>[]> {
    const rows = await db.select().from(simVendorRecords).where(and(eq(simVendorRecords.vendor, WORKDAY), eq(simVendorRecords.kind, kind))).orderBy(asc(simVendorRecords.id));
    return rows.map((r) => JSON.parse(r.bodyJson) as Body<K>);
  }
  async function put<K extends Kind>(kind: K, extId: string, body: Body<K>): Promise<void> {
    const now = clock.now();
    const [have] = await db.select().from(simVendorRecords).where(and(eq(simVendorRecords.vendor, WORKDAY), eq(simVendorRecords.kind, kind), eq(simVendorRecords.extId, extId))).limit(1);
    if (have) await db.update(simVendorRecords).set({ bodyJson: JSON.stringify(body), version: have.version + 1, updatedAt: now }).where(eq(simVendorRecords.id, have.id));
    else await db.insert(simVendorRecords).values({ id: await mintId(db, "simx_"), vendor: WORKDAY, kind, extId, version: 1, bodyJson: JSON.stringify(body), createdAt: now, updatedAt: now });
  }
  async function workerByAnyId(id: string): Promise<WdWorker | null> {
    const key = id.startsWith("Employee_ID=") ? id.slice("Employee_ID=".length) : id;
    return (await all("worker")).find((w) => w.id === key || w.workerId === key) ?? null;
  }
  const ok = (body: unknown): W3IntegrationsHrHttpResponse => ({ status: 200, headers: { "content-type": "application/json" }, body });
  const bad = (status: number, error: string): W3IntegrationsHrHttpResponse => ({ status, headers: { "content-type": "application/json" }, body: { error, errors: [{ error }] } });
  function paged<T>(rows: T[], query: Record<string, string>): W3IntegrationsHrHttpResponse {
    const limit = query.limit === undefined ? 20 : Number(query.limit), offset = query.offset === undefined ? 0 : Number(query.offset);
    if (!Number.isInteger(limit) || limit < 1 || limit > REST_MAX_LIMIT) return bad(400, `limit must be 1 to ${REST_MAX_LIMIT}`);
    if (!Number.isInteger(offset) || offset < 0) return bad(400, "offset must be 0 or more");
    return ok({ total: rows.length, data: rows.slice(offset, offset + limit) });
  }
  const restWorker = (w: WdWorker) => ({ id: w.id, descriptor: w.descriptor, href: w.href, workerId: w.workerId, primaryWorkEmail: w.primaryWorkEmail, businessTitle: w.businessTitle, primarySupervisoryOrganization: w.primarySupervisoryOrganization, isManager: false });

  /** SOAP Get_Workers with Transaction_Log_Criteria_Data, answered as JSON with the WSDL's element names. */
  async function getWorkers(q: { Updated_From: string; Updated_Through: string; Page: number; Count: number }): Promise<W3IntegrationsHrHttpResponse> {
    if (await firstFault(faults, ["workday.getWorkers"])) return bad(500, "Processing error occurred. The service is temporarily unavailable.");
    if (!q.Updated_From || !q.Updated_Through || q.Updated_From > q.Updated_Through) return bad(400, "Updated_From must not be after Updated_Through");
    if (!Number.isInteger(q.Count) || q.Count < 1 || q.Count > SOAP_MAX_COUNT) return bad(400, `Count must be 1 to ${SOAP_MAX_COUNT}`);
    const changed = (await all("worker")).filter((w) => w.transactionLog.some((t) => t.moment >= q.Updated_From && t.moment <= q.Updated_Through));
    const pages = Math.max(1, Math.ceil(changed.length / q.Count));
    const page = changed.slice((q.Page - 1) * q.Count, q.Page * q.Count);
    return ok({ Response_Filter: { Page: q.Page, Count: q.Count }, Response_Results: { Total_Results: changed.length, Total_Pages: pages, Page_Results: page.length, Page: q.Page }, Response_Data: { Worker: page } });
  }

  async function rest(path: string, query: Record<string, string> = {}): Promise<W3IntegrationsHrHttpResponse> {
    if (path === "/ccx/service/Human_Resources/Get_Workers") {
      return getWorkers({ Updated_From: query.Updated_From ?? "", Updated_Through: query.Updated_Through ?? "", Page: Number(query.Page ?? 1), Count: Number(query.Count ?? 100) });
    }
    if (path === "/common/v1/workers") {
      let rows = await all("worker");
      if (query.includeTerminatedWorkers !== "true") rows = rows.filter((w) => !w.terminationDate || w.terminationDate > clock.now().slice(0, 10));
      if (query.search) rows = rows.filter((w) => w.descriptor.toLowerCase().includes(query.search!.toLowerCase()));
      return paged(rows.map(restWorker), query);
    }
    if (path === "/staffing/v7/supervisoryOrganizations") return paged(await all("org"), query);
    if (path === "/absenceManagement/v5/balances") {
      let rows = await all("balance");
      if (query.worker) { const w = await workerByAnyId(query.worker); rows = rows.filter((b) => b.worker.id === w?.id); }
      return paged(rows, query);
    }
    const m = /^\/absenceManagement\/v5\/workers\/([^/]+)\/(eligibleAbsenceTypes|validTimeOffDates|timeOffDetails)$/.exec(path);
    if (m) {
      const w = await workerByAnyId(decodeURIComponent(m[1]!));
      if (!w) return bad(404, "Invalid ID value");
      if (m[2] === "eligibleAbsenceTypes") return paged(await all("absence_type"), query);
      if (m[2] === "validTimeOffDates") {
        const dates = (query.date ?? "").split(",").filter(Boolean);
        const taken = new Set((await all("time_off_entry")).filter((e) => e.worker.id === w.id).map((e) => e.date));
        return paged(dates.map((date) => ({ date, valid: isWeekday(date) && !taken.has(date) })), query);
      }
      let rows = (await all("time_off_entry")).filter((e) => e.worker.id === w.id);
      if (query.fromDate) rows = rows.filter((e) => e.date >= query.fromDate!);
      if (query.toDate) rows = rows.filter((e) => e.date <= query.toDate!);
      const statuses = (query.status ?? "").split(",").filter(Boolean);
      if (statuses.length) rows = rows.filter((e) => statuses.includes(e.status.descriptor) || statuses.includes(e.status.id));
      rows.sort((a, b) => a.date.localeCompare(b.date));
      return paged(rows, query);
    }
    return bad(404, "Resource not found");
  }
  async function getOk<T>(path: string, query: Record<string, string>): Promise<T> {
    const res = await rest(path, query);
    if (res.status === 500) throw new SimFaultError("workday.getWorkers");
    if (res.status !== 200) throw new Error(`workday simulator ${path}: ${res.status}`);
    return res.body as T;
  }

  const toWorker = (w: WdWorker): HrisWorker => ({
    workerRef: w.id, employeeId: w.workerId, first: w.firstName, last: w.lastName, workEmail: w.primaryWorkEmail, title: w.businessTitle,
    orgRef: w.primarySupervisoryOrganization?.id ?? null, managerRef: w.manager?.id ?? null, locationState: w.location?.region ?? null,
    hireDate: w.hireDate, terminationDate: w.terminationDate, baseAmountMinor: w.compensation ? Math.round(w.compensation.amount * 100) : null,
    currency: w.compensation?.currency.descriptor ?? null, frequency: w.compensation?.frequency.descriptor ?? null, updatedAt: lastMoment(w),
  });
  const status = async (): Promise<ConnectorStatus> => ({ vendor: "workday", category: "hris", mode: "simulated", configured: false, lastSyncAt: null, cursor: null, health: "ok", detail: null });
  const touch = (w: WdWorker, type: string): WdWorker => ({ ...w, transactionLog: [...w.transactionLog, { moment: clock.now(), type }] });

  async function requestTimeOff(req: { workerRef: string; days: { date: string; minutes: number; typeRef: string }[]; credential: string }): Promise<{ eventRef: string; status: string }> {
    if (await firstFault(faults, ["workday.requestTimeOff"])) throw new SimFaultError("workday.requestTimeOff");
    const w = await workerByAnyId(req.workerRef);
    if (!w) throw new Error(`workday simulator: no worker ${req.workerRef}`);
    // Step 1 and 2 of the documented flow: the type must be eligible and every date valid.
    const types = (await getOk<{ data: WdAbsenceType[] }>(`/absenceManagement/v5/workers/${w.id}/eligibleAbsenceTypes`, { limit: "100" })).data;
    const valid = (await getOk<{ data: { date: string; valid: boolean }[] }>(`/absenceManagement/v5/workers/${w.id}/validTimeOffDates`, { date: req.days.map((d) => d.date).join(","), limit: "100" })).data;
    for (const d of req.days) {
      const t = types.find((x) => x.id === d.typeRef);
      if (!t) throw new Error(`workday simulator: time off type ${d.typeRef} is not eligible for ${w.workerId}`);
      if (!valid.find((v) => v.date === d.date)?.valid) throw new Error(`workday simulator: ${d.date} is not a valid time off date for ${w.workerId}`);
    }
    // Step 3: requestTimeOff opens the business process (In Progress) with Submitted entries.
    const seq = (await all("event")).length + 1;
    const eventId = wid(`event-${w.id}-${seq}`);
    const entryIds: string[] = [];
    for (const d of req.days) {
      const t = types.find((x) => x.id === d.typeRef)!;
      const id = wid(`entry-${eventId}-${d.date}`);
      entryIds.push(id);
      await put("time_off_entry", id, { id, date: d.date, quantity: d.minutes / 60, unit: HOURS, timeOffType: ref("absenceTypes", t.id, t.descriptor), status: STATUS.submitted, reason: null, comment: null, worker: ref("workers", w.id, w.descriptor), timeOffEventId: eventId });
    }
    await put("event", eventId, { id: eventId, descriptor: `Time Off Request: ${w.descriptor}`, href: `${HOST}/api/businessProcess/v1/events/${eventId}`, status: STATUS.inProgress, subject: ref("workers", w.id, w.descriptor), initiated: clock.now(), completed: null, entryIds });
    await put("worker", w.id, touch(w, "Request Time Off"));
    return { eventRef: eventId, status: STATUS.inProgress.descriptor };
  }

  /** The manager approves in Workday: the event completes, entries become Approved, the balance drops. */
  async function approveEvent(eventId: string): Promise<string[]> {
    const ev = (await all("event")).find((e) => e.id === eventId);
    if (!ev) throw new Error(`workday simulator: no event ${eventId}`);
    const entries = (await all("time_off_entry")).filter((e) => ev.entryIds.includes(e.id));
    for (const e of entries) await put("time_off_entry", e.id, { ...e, status: STATUS.approved });
    await put("event", ev.id, { ...ev, status: STATUS.complete, completed: clock.now() });
    const w = await workerByAnyId(ev.subject.id);
    if (w) {
      const bal = (await all("balance")).find((b) => b.worker.id === w.id);
      const used = entries.filter((e) => e.timeOffType.id === WD_ABSENCE_TYPES.vacation.id).reduce((s, e) => s + e.quantity, 0);
      if (bal) await put("balance", `${w.id}:${bal.absencePlan.id}`, { ...bal, quantity: bal.quantity - used, effectiveDate: clock.now().slice(0, 10) });
      await put("worker", w.id, touch(w, "Time Off Approved"));
    }
    return ev.entryIds;
  }

  async function target(employeeId?: string): Promise<WdWorker> {
    const list = await all("worker");
    const w = employeeId ? list.find((x) => x.workerId === employeeId) : list[WD_SIM_DEFAULT_INDEX] ?? list[0];
    if (!w) throw new Error("workday simulator: the fictional Larkspur tenant is empty (run the seed)");
    return w;
  }

  const controls: W3WorkdaySimControls = {
    rest,
    async seedLarkspur() { await seedWorkdaySim(db, clock.now()); },
    async simulate(kind, opts = {}) {
      const w = await target(opts.employeeId);
      if (kind === "worker_change") {
        // A promotion entered in Workday: a new business title and a 4 percent raise on the base pay plan.
        const title = w.businessTitle?.startsWith("Senior ") ? `Lead ${w.businessTitle.slice(7)}` : `Senior ${w.businessTitle ?? "Engineer"}`;
        const comp = w.compensation ? { ...w.compensation, amount: Math.round(w.compensation.amount * 1.04) } : null;
        await put("worker", w.id, touch({ ...w, businessTitle: title, compensation: comp }, "Change Job"));
        return { workerRef: w.id, entryRefs: [] };
      }
      // time_off: two vacation days a month out, requested and approved through the documented flow.
      let day = addDays(clock.now().slice(0, 10), 30);
      const taken = new Set((await all("time_off_entry")).filter((e) => e.worker.id === w.id).map((e) => e.date));
      const days: string[] = [];
      while (days.length < 2) { if (isWeekday(day) && !taken.has(day)) days.push(day); day = addDays(day, 1); }
      const r = await requestTimeOff({ workerRef: w.id, days: days.map((date) => ({ date, minutes: 480, typeRef: WD_ABSENCE_TYPES.vacation.id })), credential: "simulated" });
      const entryRefs = await approveEvent(r.eventRef);
      return { workerRef: w.id, entryRefs };
    },
  };

  return {
    ...controls,
    status,
    async testConnection() {
      const s = await status();
      await getOk("/common/v1/workers", { limit: "1" });
      return { ...s, detail: "read_one_worker", services: ["Human_Resources", "Staffing", "Absence_Management"] };
    },
    async listChangedWorkers(q): Promise<SyncPage<HrisWorker>> {
      const body = await getOk<{ Response_Results: { Total_Pages: number; Page: number }; Response_Data: { Worker: WdWorker[] } }>("/ccx/service/Human_Resources/Get_Workers", { Updated_From: q.updatedFrom, Updated_Through: q.updatedThrough, Page: String(q.page), Count: "100" });
      const more = body.Response_Results.Page < body.Response_Results.Total_Pages;
      return { items: body.Response_Data.Worker.map(toWorker), nextCursor: more ? String(q.page + 1) : null, rateLimit: { remaining: null, resetAt: null } };
    },
    async listOrganizations(q): Promise<SyncPage<HrisOrg>> {
      const offset = q.cursor ? Number(q.cursor) : 0;
      const body = await getOk<{ total: number; data: WdOrg[] }>("/staffing/v7/supervisoryOrganizations", { limit: String(REST_MAX_LIMIT), offset: String(offset) });
      const next = offset + body.data.length < body.total ? String(offset + body.data.length) : null;
      return { items: body.data.map((o) => ({ orgRef: o.id, name: o.descriptor, kind: o.type.descriptor })), nextCursor: next, rateLimit: { remaining: null, resetAt: null } };
    },
    async listTimeOff(q): Promise<SyncPage<HrisTimeOffEntry>> {
      const body = await getOk<{ total: number; data: WdTimeOffEntry[] }>(`/absenceManagement/v5/workers/${q.workerRef}/timeOffDetails`, { fromDate: q.from, toDate: q.to, ...(q.status === "approved" ? { status: "Approved" } : {}), limit: String(REST_MAX_LIMIT) });
      const items = body.data.map((e): HrisTimeOffEntry => ({ entryRef: e.id, workerRef: e.worker.id, date: e.date, quantityMinutes: Math.round(e.quantity * (e.unit.descriptor === "Days" ? 480 : 60)), typeRef: e.timeOffType.id, status: e.status.descriptor, comment: e.comment }));
      return { items, nextCursor: null, rateLimit: { remaining: null, resetAt: null } };
    },
    async listBalances(q): Promise<SyncPage<HrisBalance>> {
      const body = await getOk<{ total: number; data: WdBalance[] }>("/absenceManagement/v5/balances", { worker: q.workerRef, limit: String(REST_MAX_LIMIT) });
      return { items: body.data.map((b) => ({ workerRef: b.worker.id, planRef: b.absencePlan.id, asOf: b.effectiveDate, minutes: Math.round(b.quantity * 60) })), nextCursor: null, rateLimit: { remaining: null, resetAt: null } };
    },
    requestTimeOff,
  };
}

/**
 * Seeds the fictional Larkspur Workday tenant from the seeded Weft people: one worker per active employee with the
 * same work email, title, department, work state and base pay (so a first sync links everyone with no conflict),
 * the supervisory organizations, the eligible absence types and an 80-hour vacation balance each. No time off.
 */
export async function seedWorkdaySim(db: DbTx, now: string): Promise<void> {
  const ins = async (kind: Kind, extId: string, body: unknown) =>
    db.insert(simVendorRecords).values({ id: await mintId(db, "simx_"), vendor: WORKDAY, kind, extId, version: 1, bodyJson: JSON.stringify(body), createdAt: now, updatedAt: now }).onConflictDoNothing();
  const [have] = await db.select().from(simVendorRecords).where(and(eq(simVendorRecords.vendor, WORKDAY), eq(simVendorRecords.kind, "worker"))).limit(1);
  if (have) return;
  const orgs = new Map<string, WdOrg>();
  for (const d of await db.select().from(departments).orderBy(asc(departments.id))) {
    const o: WdOrg = { id: wid(`org-${d.id}`), descriptor: d.name, href: `${HOST}/api/staffing/v7/supervisoryOrganizations/${wid(`org-${d.id}`)}`, type: ref("organizationTypes", wid("org-type-supervisory"), "Supervisory"), code: `SUP-${d.id.slice(4).toUpperCase()}` };
    orgs.set(d.id, o);
    await ins("org", o.id, o);
  }
  for (const t of Object.values(WD_ABSENCE_TYPES)) await ins("absence_type", t.id, { ...ref("absenceTypes", t.id, t.descriptor), unit: HOURS, category: ref("absenceCategories", wid("category-time-off"), "Time Off") } satisfies WdAbsenceType);
  const people = (await db.select().from(workers).orderBy(asc(workers.id))).filter((w) => w.type === "employee" && w.status === "active");
  const rates = await db.select().from(payRates).where(isNull(payRates.effectiveTo));
  let n = 0;
  for (const p of people) {
    n++;
    const id = wid(`worker-${p.id}`);
    const rate = rates.filter((r) => r.workerId === p.id).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
    const org = p.departmentId ? orgs.get(p.departmentId) ?? null : null;
    const name = `${p.preferredName ?? p.firstName} ${p.lastName}`;
    const mgr = p.managerId ? people.find((x) => x.id === p.managerId) ?? null : null;
    const w: WdWorker = {
      id, descriptor: name, href: `${HOST}/api/common/v1/${TENANT}/workers/${id}`, workerId: String(21_000 + n), firstName: p.firstName, lastName: p.lastName,
      primaryWorkEmail: p.workEmail, businessTitle: p.title, primarySupervisoryOrganization: org ? ref("supervisoryOrganizations", org.id, org.descriptor) : null, manager: mgr ? ref("workers", wid(`worker-${mgr.id}`), `${mgr.preferredName ?? mgr.firstName} ${mgr.lastName}`) : null,
      location: p.workState ? { ...ref("locations", wid(`location-${p.workplaceId ?? p.workState}`), p.workplaceId ?? p.workState), region: p.workState } : null,
      hireDate: p.startDate, terminationDate: p.endDate,
      compensation: rate ? { amount: rate.amountCents / 100, currency: ref("currencies", wid("currency-usd"), rate.currency), frequency: ref("frequencies", wid(`frequency-${rate.kind}`), rate.kind === "hourly" ? "Hourly" : "Annual") } : null,
      transactionLog: [{ moment: now, type: "Hire" }],
    };
    await ins("worker", id, w);
    await ins("balance", `${id}:${VACATION_PLAN.id}`, { worker: ref("workers", id, name), absencePlan: VACATION_PLAN, quantity: SEED_BALANCE_HOURS, unit: HOURS, effectiveDate: now.slice(0, 10) } satisfies WdBalance);
  }
}
