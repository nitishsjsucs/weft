// Simulated Greenhouse (ats) for wave 3 (docs/wave3.md, research/wave3/integrations-hr.md section 1). Owner: w3-integrations-hr.
// Follows the published Harvest v3 shapes from field names only (no vendored spec): bare JSON arrays, an opaque cursor
// in `Link: <...>; rel="next"` that must be the only query parameter (422 otherwise), X-RateLimit-* headers on a 30 s
// window with a 429 and Retry-After under the greenhouse.rateLimit fault, versioned offers with current_only, the
// salary custom field as { amount, unit } in major units, and signed hire_candidate deliveries (Signature:
// sha256 <hex> over the raw body, with <, > and & escaped the way the vendor does) queued in sim_webhook_outbox and
// retried on the sim clock (7 attempts). The greenhouse.offersHidden fault returns empty offer lists, the permission
// gap a Site Admin without offer access sees. Writes only sim_vendor_records and sim_webhook_outbox.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { and, asc, eq, lte } from "drizzle-orm";
import type { AtsConnector, AtsHire, AtsJob, ConnectorStatus, FaultInjector, SimClock, SyncPage, W3GreenhouseSimControls, W3IntegrationsHrHttpResponse, W3IntegrationsHrOutboxDelivery } from "@weft/contracts";
import { W3_GREENHOUSE_RETRY_MINUTES } from "@weft/contracts";
import { simVendorRecords, simWebhookOutbox, type DbTx } from "@weft/db";
import { firstFault, SimFaultError } from "../faults";
import { mintId, seqOf } from "../ids";

export const GREENHOUSE = "greenhouse";
/** The simulator's webhook signing key. A fixed demo value, not a credential: real mode reads WEFT_GREENHOUSE_WEBHOOK_SECRET. */
export const GREENHOUSE_SIM_SIGNING_KEY = "weft-sim-greenhouse-signing-key";
export const GREENHOUSE_RATE_LIMIT = 75;
const WINDOW_MS = 30_000;
const BASE = "https://harvest.greenhouse.example/v3";

type Rec = Record<string, unknown>;
export interface GhJob { id: number; name: string; requisition_id: string; status: "open" | "closed"; confidential: boolean; opened_at: string; closed_at: string | null; created_at: string; updated_at: string; departments: { id: number; name: string; external_id: string | null }[]; offices: { id: number; name: string; location: { name: string | null }; external_id: string | null }[]; custom_fields: Rec }
export interface GhCandidate { id: number; created_at: string; updated_at: string; first_name: string; last_name: string; preferred_name: string | null; company: string | null; title: string | null; last_activity_at: string; private: boolean; can_email: boolean; time_zone: string | null; tags: string[]; linked_user_ids: number[]; phone_numbers: { value: string; type: string }[]; addresses: { value: string; type: string }[]; email_addresses: { value: string; type: string }[]; website_addresses: { value: string; type: string }[]; social_media_addresses: { value: string }[]; custom_fields: Rec }
export interface GhApplication { id: number; created_at: string; updated_at: string; candidate_id: number; job_id: number | null; job_post_id: number | null; stage_id: number | null; job_interview_stage_id: number | null; stage_name: string; status: "rejected" | "hired" | "converted" | "in_process"; prospect: boolean; needs_decision: boolean; rejected_at: string | null; rejection_reason_id: number | null; last_activity_at: string; source_id: number | null; referrer_id: number | null; recruiter_id: number | null; coordinator_id: number | null; agency_note_id: number | null; location_address: string | null; answers: { question: string; answer: string }[]; prospective_job_ids: number[]; custom_fields: Rec }
export interface GhOffer { id: number; created_at: string; updated_at: string; version: number; application_id: number; job_id: number | null; candidate_id: number; opening_id: number | null; status: "Created" | "Accepted" | "Rejected" | "Deprecated"; starts_on: string | null; sent_on: string | null; resolved_at: string | null; custom_fields: { salary?: { amount: number; unit: string } } & Rec }
type Kind = "job" | "candidate" | "application" | "offer";
type Body<K extends Kind> = K extends "job" ? GhJob : K extends "candidate" ? GhCandidate : K extends "application" ? GhApplication : GhOffer;

/** Fictional hires the "Simulate a hire" control cycles through (every name is visibly demo data). */
export const SIM_HIRES = [
  { first: "Marisol", last: "Quint", email: "marisol.quint@candidate.example" },
  { first: "Ilya", last: "Brandt", email: "ilya.brandt@candidate.example" },
  { first: "Wren", last: "Achebe", email: "wren.achebe@candidate.example" },
  { first: "Tomas", last: "Varga", email: "tomas.varga@candidate.example" },
] as const;
/** The job a simulated hire lands in: Hardware, at an office Weft has not mapped yet (Boulder, CO). */
export const SIM_HIRE_JOB_ID = 4_400_103;
export const SIM_SALARY_MAJOR = 132_000;

/** Greenhouse escapes these before signing, so a re-serialized body no longer matches the signature. */
export function ghSerialize(body: unknown): string {
  return JSON.stringify(body).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}
export function ghSign(key: string, raw: string | Uint8Array): string {
  return `sha256 ${createHmac("sha256", key).update(raw).digest("hex")}`;
}
const eventId = (seq: number) => {
  const h = createHash("sha256").update(`greenhouse-event-${seq}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const addMinutes = (iso: string, m: number) => new Date(Date.parse(iso) + m * 60_000).toISOString();
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);
const encCursor = (o: Rec) => Buffer.from(JSON.stringify(o)).toString("base64url");
const decCursor = (s: string): Rec | null => { try { const v = JSON.parse(Buffer.from(s, "base64url").toString("utf8")); return v && typeof v === "object" ? v as Rec : null; } catch { return null; } };

export type GreenhouseSim = AtsConnector & W3GreenhouseSimControls;

export function createGreenhouseSim(db: DbTx, clock: SimClock, faults: FaultInjector): GreenhouseSim {
  async function all<K extends Kind>(kind: K): Promise<Body<K>[]> {
    const rows = await db.select().from(simVendorRecords).where(and(eq(simVendorRecords.vendor, GREENHOUSE), eq(simVendorRecords.kind, kind)));
    return rows.map((r) => JSON.parse(r.bodyJson) as Body<K>);
  }
  async function put<K extends Kind>(kind: K, body: Body<K>): Promise<void> {
    const now = clock.now();
    const extId = String(body.id);
    const [have] = await db.select().from(simVendorRecords).where(and(eq(simVendorRecords.vendor, GREENHOUSE), eq(simVendorRecords.kind, kind), eq(simVendorRecords.extId, extId))).limit(1);
    if (have) await db.update(simVendorRecords).set({ bodyJson: JSON.stringify(body), version: have.version + 1, updatedAt: now }).where(eq(simVendorRecords.id, have.id));
    else await db.insert(simVendorRecords).values({ id: await mintId(db, "simx_"), vendor: GREENHOUSE, kind, extId, version: 1, bodyJson: JSON.stringify(body), createdAt: now, updatedAt: now });
  }
  async function nextExtId(kind: Kind, base: number): Promise<number> {
    const ids = (await all(kind)).map((b) => b.id);
    return Math.max(base, ...ids) + 1;
  }

  // ---- Harvest v3 over the store -------------------------------------------------------------------------
  const FILTERS: Record<string, readonly string[]> = {
    applications: ["per_page", "ids", "status", "candidate_ids", "job_ids", "updated_at[gt]", "updated_at[gte]"],
    offers: ["per_page", "ids", "application_ids", "current_only", "status", "updated_at[gt]", "updated_at[gte]"],
    candidates: ["per_page", "ids", "email", "updated_at[gt]"],
    jobs: ["per_page", "ids", "status"],
  };
  const KIND_OF: Record<string, Kind> = { applications: "application", offers: "offer", candidates: "candidate", jobs: "job" };
  function rateHeaders(nowIso: string, remaining: number): Record<string, string> {
    const reset = Math.floor((Math.floor(Date.parse(nowIso) / WINDOW_MS) + 1) * WINDOW_MS / 1000);
    return { "x-ratelimit-limit": String(GREENHOUSE_RATE_LIMIT), "x-ratelimit-remaining": String(remaining), "x-ratelimit-reset": String(reset) };
  }
  async function harvest(path: string, query: Record<string, string> = {}): Promise<W3IntegrationsHrHttpResponse> {
    const now = clock.now();
    const m = /^\/v3\/(applications|offers|candidates|jobs)$/.exec(path);
    if (!m) return { status: 404, headers: rateHeaders(now, GREENHOUSE_RATE_LIMIT - 1), body: { message: "Not found" } };
    if (await firstFault(faults, ["greenhouse.rateLimit"])) return { status: 429, headers: { ...rateHeaders(now, 0), "retry-after": "3" }, body: { message: "Rate limit exceeded" } };
    const resource = m[1]!;
    let q: Record<string, string> = query;
    let offset = 0;
    if ("cursor" in query) {
      if (Object.keys(query).length !== 1) return { status: 422, headers: rateHeaders(now, GREENHOUSE_RATE_LIMIT - 1), body: { message: "cursor must be the only query parameter" } };
      const c = decCursor(query.cursor!);
      if (!c || c.r !== resource || typeof c.o !== "number") return { status: 422, headers: rateHeaders(now, GREENHOUSE_RATE_LIMIT - 1), body: { message: "Malformed cursor" } };
      q = (c.q ?? {}) as Record<string, string>;
      offset = c.o;
    }
    for (const k of Object.keys(q)) if (!FILTERS[resource]!.includes(k)) return { status: 422, headers: rateHeaders(now, GREENHOUSE_RATE_LIMIT - 1), body: { message: `Unknown filter ${k}` } };
    const perPage = q.per_page ? Number(q.per_page) : 100;
    if (!Number.isInteger(perPage) || perPage < 1 || perPage > 500) return { status: 422, headers: rateHeaders(now, GREENHOUSE_RATE_LIMIT - 1), body: { message: "per_page must be 1 to 500" } };
    let rows = (await all(KIND_OF[resource]!)) as unknown as Rec[];
    const list = (k: string) => (q[k] ? q[k]!.split(",").map((x) => x.trim()) : null);
    const ids = list("ids");
    if (ids) rows = rows.filter((r) => ids.includes(String(r.id)));
    if (q.status) rows = rows.filter((r) => (q.status === "active" ? r.status === "in_process" : r.status === q.status));
    const cand = list("candidate_ids"); if (cand) rows = rows.filter((r) => cand.includes(String(r.candidate_id)));
    const jobs = list("job_ids"); if (jobs) rows = rows.filter((r) => jobs.includes(String(r.job_id)));
    const apps = list("application_ids"); if (apps) rows = rows.filter((r) => apps.includes(String(r.application_id)));
    if (q.email) rows = rows.filter((r) => ((r.email_addresses ?? []) as { value: string }[]).some((e) => e.value.toLowerCase() === q.email!.toLowerCase()));
    if (q["updated_at[gt]"]) rows = rows.filter((r) => String(r.updated_at) > q["updated_at[gt]"]!);
    if (q["updated_at[gte]"]) rows = rows.filter((r) => String(r.updated_at) >= q["updated_at[gte]"]!);
    if (resource === "offers" && q.current_only === "true") rows = rows.filter((r) => r.status !== "Deprecated");
    if (resource === "offers" && (await firstFault(faults, ["greenhouse.offersHidden"]))) rows = [];
    rows.sort((a, b) => Number(b.id) - Number(a.id));   // id descending, as documented
    const page = rows.slice(offset, offset + perPage);
    const headers: Record<string, string> = { "content-type": "application/json", ...rateHeaders(now, GREENHOUSE_RATE_LIMIT - 1) };
    if (offset + perPage < rows.length) headers.link = `<${BASE}/${resource}?cursor=${encCursor({ r: resource, o: offset + perPage, q })}>; rel="next"`;
    return { status: 200, headers, body: page };
  }
  const nextCursorOf = (h: Record<string, string>) => (h.link ? /[?&]cursor=([^>&]+)>; rel="next"/.exec(h.link)?.[1] ?? null : null);
  async function get<T>(path: string, query: Record<string, string>): Promise<{ items: T[]; res: W3IntegrationsHrHttpResponse }> {
    const res = await harvest(path, query);
    if (res.status === 429) throw new SimFaultError("greenhouse.rateLimit");
    if (res.status !== 200) throw new Error(`greenhouse simulator ${path}: ${res.status}`);
    return { items: res.body as T[], res };
  }
  const pageMeta = (res: W3IntegrationsHrHttpResponse) => ({ remaining: Number(res.headers["x-ratelimit-remaining"] ?? 0), resetAt: res.headers["x-ratelimit-reset"] ? new Date(Number(res.headers["x-ratelimit-reset"]) * 1000).toISOString() : null });

  async function hireOf(app: GhApplication): Promise<AtsHire | null> {
    if (app.status !== "hired") return null;
    const offers = (await get<GhOffer>("/v3/offers", { application_ids: String(app.id), current_only: "true" })).items;
    const offer = offers.find((o) => o.status === "Accepted") ?? offers[0];
    if (!offer) return null;   // the permission gap: offers hidden, or none yet
    const [cand] = (await get<GhCandidate>("/v3/candidates", { ids: String(app.candidate_id) })).items;
    const [job] = app.job_id ? (await get<GhJob>("/v3/jobs", { ids: String(app.job_id) })).items : [];
    if (!cand) return null;
    const email = cand.email_addresses.find((e) => e.type === "personal")?.value ?? cand.email_addresses[0]?.value ?? "";
    const sal = offer.custom_fields.salary;
    return {
      applicationId: String(app.id), candidateId: String(cand.id), offerId: String(offer.id), offerVersion: offer.version,
      first: cand.first_name, last: cand.last_name, email, jobName: job?.name ?? "",
      departmentExtId: job?.departments[0] ? String(job.departments[0].id) : null, officeExtId: job?.offices[0] ? String(job.offices[0].id) : null,
      startDate: offer.starts_on, salary: sal ? { amountMinor: Math.round(sal.amount * 100), currency: sal.unit } : null, hiredAt: offer.resolved_at ?? app.updated_at,
    };
  }
  const toJob = (j: GhJob, source: "board" | "harvest"): AtsJob => ({
    id: String(j.id), name: j.name, departmentName: j.departments[0]?.name ?? null, officeName: j.offices[0]?.name ?? null, location: j.offices[0]?.location.name ?? null,
    updatedAt: j.updated_at, url: source === "board" ? `https://boards.greenhouse.example/larkspur/jobs/${j.id}` : null,
  });
  async function status(): Promise<ConnectorStatus> {
    return { vendor: "greenhouse", category: "ats", mode: "simulated", configured: false, lastSyncAt: null, cursor: null, health: "ok", detail: null };
  }

  // ---- webhook deliveries ---------------------------------------------------------------------------------
  async function enqueue(action: string, payload: Rec): Promise<string> {
    const id = await mintId(db, "simo_");
    const key = eventId(seqOf(id));
    const raw = ghSerialize({ action, payload });
    await db.insert(simWebhookOutbox).values({ id, vendor: GREENHOUSE, dedupeKey: key, bodyJson: raw, signature: ghSign(GREENHOUSE_SIM_SIGNING_KEY, raw), attempt: 0, nextAt: clock.now(), status: "pending", deliveredAt: null });
    return key;
  }
  async function hirePayload(app: GhApplication, offer: GhOffer): Promise<Rec> {
    const [cand] = (await all("candidate")).filter((c) => c.id === app.candidate_id);
    const [job] = (await all("job")).filter((j) => j.id === app.job_id);
    return {
      application: {
        id: app.id, opening: null, credited_to: null, source: null, url: `https://larkspur.greenhouse.example/people/${app.candidate_id}?application_id=${app.id}&src=sim`,
        candidate: cand ? { id: cand.id, first_name: cand.first_name, last_name: cand.last_name, title: cand.title, external_id: null, is_private: false, can_email: true, phone_numbers: [], email_addresses: cand.email_addresses, addresses: [], educations: [], employments: [], recruiter: null, coordinator: null, attachments: [], custom_fields: {} } : null,
        jobs: job ? [{ id: job.id, name: job.name, requisition_id: job.requisition_id, confidential: job.confidential, opened_at: job.opened_at, closed_at: job.closed_at, departments: job.departments, offices: job.offices, custom_fields: job.custom_fields }] : [],
        custom_fields: {},
        offer: { id: offer.id, version: offer.version, created_at: offer.created_at, sent_at: offer.sent_on, resolved_at: offer.resolved_at, starts_at: offer.starts_on, custom_fields: offer.custom_fields.salary ? { salary: { name: "Salary", type: "currency", value: offer.custom_fields.salary } } : {} },
      },
    };
  }

  const controls: W3GreenhouseSimControls = {
    harvest,
    async seedLarkspur() { await seedGreenhouseSim(db, clock.now()); },
    async simulate(kind, opts = {}) {
      const now = clock.now();
      if (kind === "redeliver") {
        const rows = await db.select().from(simWebhookOutbox).where(eq(simWebhookOutbox.vendor, GREENHOUSE)).orderBy(asc(simWebhookOutbox.id));
        const row = rows[rows.length - 1];
        if (!row) throw new Error("greenhouse simulator: nothing to redeliver yet");
        await db.update(simWebhookOutbox).set({ status: "pending", nextAt: now }).where(eq(simWebhookOutbox.id, row.id));
        const body = JSON.parse(row.bodyJson) as { payload: { application?: { id: number; offer?: { id: number; version: number } }; offer?: { id: number; application_id: number; version: number } } };
        const a = body.payload.application, o = body.payload.offer;
        return { applicationId: String(a?.id ?? o?.application_id ?? ""), offerId: String(a?.offer?.id ?? o?.id ?? ""), offerVersion: a?.offer?.version ?? o?.version ?? 1, deliveryKey: row.dedupeKey };
      }
      if (kind === "start_date_change") {
        const hired = (await all("application")).filter((a) => a.status === "hired").sort((a, b) => b.id - a.id);
        const app = opts.applicationId ? hired.find((a) => String(a.id) === opts.applicationId) : hired[0];
        if (!app) throw new Error("greenhouse simulator: no hired application to change");
        const current = (await all("offer")).filter((o) => o.application_id === app.id && o.status !== "Deprecated").sort((a, b) => b.version - a.version)[0];
        if (!current) throw new Error("greenhouse simulator: the application has no current offer");
        await put("offer", { ...current, status: "Deprecated", updated_at: now });
        const next: GhOffer = { ...current, id: await nextExtId("offer", 7_700_100), version: current.version + 1, created_at: now, updated_at: now, starts_on: current.starts_on ? addDays(current.starts_on, 14) : null };
        await put("offer", next);
        await put("application", { ...app, updated_at: now, last_activity_at: now });
        const key = await enqueue("offer_updated", { offer: { id: next.id, application_id: app.id, version: next.version, starts_on: next.starts_on, status: next.status } });
        return { applicationId: String(app.id), offerId: String(next.id), offerVersion: next.version, deliveryKey: key };
      }
      // hire: a new fictional candidate accepts an offer for the Hardware role at the unmapped Boulder office.
      const [job] = (await all("job")).filter((j) => j.id === SIM_HIRE_JOB_ID);
      if (!job) throw new Error("greenhouse simulator: the seeded Larkspur jobs are missing (run the seed)");
      const n = (await all("application")).filter((a) => a.status === "hired").length;
      const who = SIM_HIRES[n % SIM_HIRES.length]!;
      const suffix = n >= SIM_HIRES.length ? String(Math.floor(n / SIM_HIRES.length) + 1) : "";
      const candId = await nextExtId("candidate", 5_500_100), appId = await nextExtId("application", 6_600_100), offerId = await nextExtId("offer", 7_700_100);
      await put("candidate", { id: candId, created_at: now, updated_at: now, first_name: who.first, last_name: who.last, preferred_name: null, company: null, title: null, last_activity_at: now, private: false, can_email: true, time_zone: null, tags: [], linked_user_ids: [], phone_numbers: [], addresses: [], email_addresses: [{ value: suffix ? who.email.replace("@", `${suffix}@`) : who.email, type: "personal" }], website_addresses: [], social_media_addresses: [], custom_fields: {} });
      const app: GhApplication = { id: appId, created_at: now, updated_at: now, candidate_id: candId, job_id: job.id, job_post_id: null, stage_id: null, job_interview_stage_id: null, stage_name: "Offer", status: "hired", prospect: false, needs_decision: false, rejected_at: null, rejection_reason_id: null, last_activity_at: now, source_id: null, referrer_id: null, recruiter_id: null, coordinator_id: null, agency_note_id: null, location_address: null, answers: [], prospective_job_ids: [], custom_fields: {} };
      await put("application", app);
      const startsOn = addDays(now.slice(0, 10), 21);
      const offer: GhOffer = { id: offerId, created_at: now, updated_at: now, version: 1, application_id: appId, job_id: job.id, candidate_id: candId, opening_id: null, status: "Accepted", starts_on: startsOn, sent_on: now.slice(0, 10), resolved_at: now, custom_fields: { salary: { amount: SIM_SALARY_MAJOR, unit: "USD" } } };
      await put("offer", offer);
      const key = await enqueue("hire_candidate", await hirePayload(app, offer));
      return { applicationId: String(appId), offerId: String(offerId), offerVersion: 1, deliveryKey: key };
    },
    async dueDeliveries(now) {
      const rows = await db.select().from(simWebhookOutbox).where(and(eq(simWebhookOutbox.vendor, GREENHOUSE), eq(simWebhookOutbox.status, "pending"), lte(simWebhookOutbox.nextAt, now))).orderBy(asc(simWebhookOutbox.id));
      return rows.map((r): W3IntegrationsHrOutboxDelivery => ({
        id: r.id, vendor: GREENHOUSE, dedupeKey: r.dedupeKey, raw: r.bodyJson, attempt: r.attempt,
        headers: { "content-type": "application/json", "greenhouse-event-id": r.dedupeKey, signature: r.signature, "user-agent": "Greenhouse-Sim" },
      }));
    },
    async recordAttempt(id, ok, now) {
      const [r] = await db.select().from(simWebhookOutbox).where(eq(simWebhookOutbox.id, id)).limit(1);
      if (!r) throw new Error(`greenhouse simulator: no outbox row ${id}`);
      const attempt = r.attempt + 1;
      if (ok) { await db.update(simWebhookOutbox).set({ attempt, status: "delivered", deliveredAt: now }).where(eq(simWebhookOutbox.id, id)); return { status: "delivered", attempt, nextAt: null }; }
      if (attempt >= W3_GREENHOUSE_RETRY_MINUTES.length) { await db.update(simWebhookOutbox).set({ attempt, status: "failed" }).where(eq(simWebhookOutbox.id, id)); return { status: "failed", attempt, nextAt: null }; }
      // The schedule counts from the first attempt: cumulative 0, 1, 16, 76, 196, 436, 916 minutes.
      const first = r.attempt === 0 ? now : addMinutes(r.nextAt, -W3_GREENHOUSE_RETRY_MINUTES[r.attempt]!);
      const nextAt = addMinutes(first, W3_GREENHOUSE_RETRY_MINUTES[attempt]!);
      await db.update(simWebhookOutbox).set({ attempt, nextAt }).where(eq(simWebhookOutbox.id, id));
      return { status: "pending", attempt, nextAt };
    },
  };

  return {
    ...controls,
    status,
    async testConnection() {
      const s = await status();
      const apps = (await get<GhApplication>("/v3/applications", { per_page: "1" })).items;
      const offers = (await get<GhOffer>("/v3/offers", { per_page: "1" })).items;
      if (apps.length > 0 && offers.length === 0 && (await all("offer")).length > 0) return { ...s, health: "permission_gap", detail: "offers_hidden_by_permissions" };
      return { ...s, lastSyncAt: null, detail: "read_one_application_and_offer" };
    },
    async listHires(q): Promise<SyncPage<AtsHire>> {
      const { items, res } = q.cursor ? await get<GhApplication>("/v3/applications", { cursor: q.cursor }) : await get<GhApplication>("/v3/applications", { status: "hired", per_page: "100", ...(q.updatedAfter ? { "updated_at[gt]": q.updatedAfter } : {}) });
      const hires: AtsHire[] = [];
      for (const a of items) { const h = await hireOf(a); if (h) hires.push(h); }
      return { items: hires, nextCursor: nextCursorOf(res.headers), rateLimit: pageMeta(res) };
    },
    async getHire(applicationId) {
      const [app] = (await get<GhApplication>("/v3/applications", { ids: applicationId })).items;
      return app ? hireOf(app) : null;
    },
    async listJobs(q): Promise<SyncPage<AtsJob>> {
      const { items, res } = q.cursor ? await get<GhJob>("/v3/jobs", { cursor: q.cursor }) : await get<GhJob>("/v3/jobs", { per_page: "100", ...(q.source === "board" ? { status: "open" } : {}) });
      return { items: items.map((j) => toJob(j, q.source)), nextCursor: nextCursorOf(res.headers), rateLimit: pageMeta(res) };
    },
    verifyWebhook(raw, headers) {
      const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
      const key = h["greenhouse-event-id"] ?? null;
      const sig = /^sha256 ([0-9a-f]{64})$/.exec(h.signature ?? "");
      if (!sig) return { ok: false, dedupeKey: key };
      const want = Buffer.from(ghSign(GREENHOUSE_SIM_SIGNING_KEY, raw).slice(7), "hex"), got = Buffer.from(sig[1]!, "hex");
      return { ok: !!key && want.length === got.length && timingSafeEqual(want, got), dedupeKey: key };
    },
    parseWebhook(raw) {
      try {
        const b = JSON.parse(new TextDecoder().decode(raw)) as { action?: unknown; payload?: { application?: { id?: unknown }; offer?: { application_id?: unknown } } };
        if (typeof b.action !== "string") return null;
        const id = b.payload?.application?.id ?? b.payload?.offer?.application_id ?? null;
        return { action: b.action, applicationId: id === null || id === undefined ? null : String(id) };
      } catch { return null; }
    },
    async markHired(req) {
      const [app] = (await all("application")).filter((a) => String(a.id) === req.applicationId);
      if (!app) throw new Error(`greenhouse simulator: no application ${req.applicationId}`);
      await put("application", { ...app, status: "hired", updated_at: clock.now() });
      return { ok: true };
    },
  };
}

/** Seeds the fictional Larkspur Greenhouse account: three open jobs and two candidates still in process (no hires). */
export async function seedGreenhouseSim(db: DbTx, now: string): Promise<void> {
  const dept = (id: number, name: string) => ({ id, name, external_id: null });
  const office = (id: number, name: string, location: string) => ({ id, name, location: { name: location }, external_id: null });
  const job = (id: number, name: string, d: ReturnType<typeof dept>, o: ReturnType<typeof office>): GhJob => ({
    id, name, requisition_id: `LR-${id % 1000}`, status: "open", confidential: false, opened_at: "2026-09-01T16:00:00.000Z", closed_at: null,
    created_at: "2026-09-01T16:00:00.000Z", updated_at: "2026-10-20T16:00:00.000Z", departments: [d], offices: [o], custom_fields: { employment_type: "Full-time" },
  });
  const jobs = [
    job(4_400_101, "Controls Engineer", dept(3_300_101, "Engineering"), office(2_200_101, "Oakland HQ", "Oakland, CA")),
    job(4_400_102, "Field Operations Lead", dept(3_300_103, "Operations"), office(2_200_102, "Austin Yard", "Austin, TX")),
    job(SIM_HIRE_JOB_ID, "Firmware Test Engineer", dept(3_300_102, "Hardware"), office(2_200_109, "Boulder Field Office", "Boulder, CO")),
  ];
  const rows: { kind: Kind; body: Rec }[] = jobs.map((body) => ({ kind: "job" as const, body: body as unknown as Rec }));
  const people = [{ id: 5_500_051, first: "Odile", last: "Ferrante", email: "odile.ferrante@candidate.example", job: 4_400_101, app: 6_600_051 }, { id: 5_500_052, first: "Kofi", last: "Lindqvist", email: "kofi.lindqvist@candidate.example", job: 4_400_102, app: 6_600_052 }];
  for (const p of people) {
    rows.push({ kind: "candidate", body: { id: p.id, created_at: "2026-10-05T16:00:00.000Z", updated_at: "2026-10-05T16:00:00.000Z", first_name: p.first, last_name: p.last, preferred_name: null, company: null, title: null, last_activity_at: "2026-10-05T16:00:00.000Z", private: false, can_email: true, time_zone: null, tags: [], linked_user_ids: [], phone_numbers: [], addresses: [], email_addresses: [{ value: p.email, type: "personal" }], website_addresses: [], social_media_addresses: [], custom_fields: {} } });
    rows.push({ kind: "application", body: { id: p.app, created_at: "2026-10-05T16:00:00.000Z", updated_at: "2026-10-19T16:00:00.000Z", candidate_id: p.id, job_id: p.job, job_post_id: null, stage_id: null, job_interview_stage_id: null, stage_name: "Onsite", status: "in_process", prospect: false, needs_decision: false, rejected_at: null, rejection_reason_id: null, last_activity_at: "2026-10-19T16:00:00.000Z", source_id: null, referrer_id: null, recruiter_id: null, coordinator_id: null, agency_note_id: null, location_address: null, answers: [], prospective_job_ids: [], custom_fields: {} } });
  }
  for (const r of rows) {
    await db.insert(simVendorRecords).values({ id: await mintId(db, "simx_"), vendor: GREENHOUSE, kind: r.kind, extId: String(r.body.id), version: 1, bodyJson: JSON.stringify(r.body), createdAt: now, updatedAt: now }).onConflictDoNothing();
  }
}
