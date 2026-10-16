// Real Greenhouse adapter (docs/wave3.md, research/wave3/integrations-hr.md 1.2 to 1.6). Owner: w3-integrations-hr.
// Harvest v3 only, read-only:
// - OAuth 2.0 client credentials: POST https://auth.greenhouse.io/token with HTTP Basic client_id:client_secret and
//   grant_type=client_credentials. The token is cached until 60 seconds before expires_in; a 401 refreshes it once.
// - GET https://harvest.greenhouse.io/v3/... with the bearer token. Paging follows the opaque Link rel="next" cursor,
//   which is sent as the only query parameter. A 429 waits Retry-After seconds and retries, up to 3 times.
// - testConnection reads one application and one offer: offers hidden while applications show is the permission gap.
// - Webhooks verify `Signature: sha256 <hex>` over the raw bytes with WEFT_GREENHOUSE_WEBHOOK_SECRET in constant time.
// - The public board (listJobs source board) reads WEFT_GREENHOUSE_BOARD_TOKEN through fetchBoardJobs, no key needed.
// - markHired is a write: this adapter refuses it (write-back is a separate, opt-in scope).
// The only code in Weft that calls this vendor over HTTP. Credentials come from ./secrets readSecret, are never logged,
// and never appear in an error message. Runs only when integrationMode() says real (WEFT_INTEGRATIONS_REAL=1 and the
// secrets present); tests drive it through a fake transport.
import type { AtsConnector, AtsHire, AtsJob, ConnectorHealth, ConnectorStatus, SyncPage } from "@weft/contracts";
import { fetchBoardJobs } from "../board";
import { readSecret, secretPresence, type Env } from "../secrets";
import { constantTimeEqual, hmacSha256 } from "../webhook";

export const GREENHOUSE_TOKEN_URL = "https://auth.greenhouse.io/token";
export const HARVEST_BASE = "https://harvest.greenhouse.io";
const MAX_429_RETRIES = 3;

export interface HttpResponse { status: number; headers: Record<string, string>; text: string }
export type Transport = (url: string, init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string }) => Promise<HttpResponse>;
export interface RealGreenhouseOptions { transport?: Transport; sleep?: (ms: number) => Promise<void>; nowMs?: () => number; fetchImpl?: typeof fetch }

export class GreenhouseHttpError extends Error {
  constructor(readonly status: number, readonly health: ConnectorHealth, path: string) { super(`greenhouse ${path}: HTTP ${status}`); }
}

const fetchTransport = (f: typeof fetch): Transport => async (url, init) => {
  const res = await f(url, { method: init.method, headers: init.headers, body: init.body });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  return { status: res.status, headers, text: await res.text() };
};
const healthOf = (status: number): ConnectorHealth => (status === 401 || status === 403 ? "auth_failed" : status === 429 ? "rate_limited" : "unreachable");
export const nextCursorOf = (link: string | undefined): string | null => (link ? /<[^>]*[?&]cursor=([^&>]+)[^>]*>;\s*rel="next"/.exec(link)?.[1] ?? null : null);

type Rec = Record<string, unknown>;
interface GhApp { id: number; candidate_id: number; job_id: number | null; status: string; updated_at: string }
interface GhOffer { id: number; version: number; status: string; starts_on: string | null; resolved_at: string | null; custom_fields?: { salary?: { amount: number; unit: string } } & Rec }
interface GhCand { id: number; first_name: string; last_name: string; email_addresses: { value: string; type: string }[] }
interface GhJob { id: number; name: string; updated_at: string; departments: { id: number; name: string }[]; offices: { id: number; name: string; location?: { name: string | null } | null }[] }

export function createRealGreenhouse(env: Env, _simulated: AtsConnector, opts: RealGreenhouseOptions = {}): AtsConnector | null {
  const present = secretPresence(["WEFT_GREENHOUSE_CLIENT_ID", "WEFT_GREENHOUSE_CLIENT_SECRET"], env);
  if (!present.WEFT_GREENHOUSE_CLIENT_ID || !present.WEFT_GREENHOUSE_CLIENT_SECRET) return null;
  const transport = opts.transport ?? fetchTransport(opts.fetchImpl ?? fetch);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const nowMs = opts.nowMs ?? Date.now;
  let token: { value: string; expiresAt: number } | null = null;
  let lastSyncAt: string | null = null;

  async function accessToken(force = false): Promise<string> {
    if (!force && token && nowMs() < token.expiresAt) return token.value;
    const basic = Buffer.from(`${readSecret("WEFT_GREENHOUSE_CLIENT_ID", env)}:${readSecret("WEFT_GREENHOUSE_CLIENT_SECRET", env)}`).toString("base64");
    const res = await transport(GREENHOUSE_TOKEN_URL, { method: "POST", headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: "grant_type=client_credentials" });
    if (res.status !== 200) throw new GreenhouseHttpError(res.status, res.status === 400 || res.status === 401 ? "auth_failed" : healthOf(res.status), "/token");
    const b = JSON.parse(res.text) as { access_token?: unknown; expires_in?: unknown };
    if (typeof b.access_token !== "string") throw new GreenhouseHttpError(502, "auth_failed", "/token");
    const ttl = typeof b.expires_in === "number" ? b.expires_in : 3600;
    token = { value: b.access_token, expiresAt: nowMs() + Math.max(0, ttl - 60) * 1000 };
    return token.value;
  }

  async function get<T>(path: string, query: Record<string, string>): Promise<{ items: T; headers: Record<string, string> }> {
    const qs = new URLSearchParams(query).toString();
    const url = `${HARVEST_BASE}${path}${qs ? `?${qs}` : ""}`;
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const res = await transport(url, { method: "GET", headers: { authorization: `Bearer ${await accessToken()}`, accept: "application/json" } });
      if (res.status === 401 && !refreshed) { refreshed = true; await accessToken(true); continue; }
      if (res.status === 429 && attempt < MAX_429_RETRIES) { await sleep(Math.max(1, Number(res.headers["retry-after"] ?? "1")) * 1000); continue; }
      if (res.status !== 200) throw new GreenhouseHttpError(res.status, healthOf(res.status), path);
      return { items: JSON.parse(res.text) as T, headers: res.headers };
    }
  }
  const pageMeta = (h: Record<string, string>) => ({ remaining: h["x-ratelimit-remaining"] ? Number(h["x-ratelimit-remaining"]) : null, resetAt: h["x-ratelimit-reset"] ? new Date(Number(h["x-ratelimit-reset"]) * 1000).toISOString() : null });

  async function hireOf(app: GhApp): Promise<AtsHire | null> {
    if (app.status !== "hired") return null;
    const offers = (await get<GhOffer[]>("/v3/offers", { application_ids: String(app.id), current_only: "true" })).items;
    const offer = offers.find((o) => o.status === "Accepted") ?? offers[0];
    if (!offer) return null;   // the permission gap, or no offer yet
    const [cand] = (await get<GhCand[]>("/v3/candidates", { ids: String(app.candidate_id) })).items;
    const [job] = app.job_id ? (await get<GhJob[]>("/v3/jobs", { ids: String(app.job_id) })).items : [];
    if (!cand) return null;
    const email = cand.email_addresses.find((e) => e.type === "personal")?.value ?? cand.email_addresses[0]?.value ?? "";
    const sal = offer.custom_fields?.salary;
    return {
      applicationId: String(app.id), candidateId: String(cand.id), offerId: String(offer.id), offerVersion: offer.version, first: cand.first_name, last: cand.last_name, email,
      jobName: job?.name ?? "", departmentExtId: job?.departments[0] ? String(job.departments[0].id) : null, officeExtId: job?.offices[0] ? String(job.offices[0].id) : null,
      startDate: offer.starts_on, salary: sal ? { amountMinor: Math.round(sal.amount * 100), currency: sal.unit } : null, hiredAt: offer.resolved_at ?? app.updated_at,
    };
  }
  const toJob = (j: GhJob): AtsJob => ({ id: String(j.id), name: j.name, departmentName: j.departments[0]?.name ?? null, officeName: j.offices[0]?.name ?? null, location: j.offices[0]?.location?.name ?? null, updatedAt: j.updated_at, url: null });
  const status = async (): Promise<ConnectorStatus> => ({ vendor: "greenhouse", category: "ats", mode: "real", configured: true, lastSyncAt, cursor: null, health: "ok", detail: null });

  return {
    status,
    async testConnection() {
      const s = await status();
      try {
        const apps = (await get<GhApp[]>("/v3/applications", { per_page: "1" })).items;
        const offers = (await get<GhOffer[]>("/v3/offers", { per_page: "1" })).items;
        if (apps.length > 0 && offers.length === 0) return { ...s, health: "permission_gap", detail: "offers_hidden_by_permissions" };
        return { ...s, detail: "read_one_application_and_offer" };
      } catch (e) {
        return { ...s, health: e instanceof GreenhouseHttpError ? e.health : "unreachable", detail: e instanceof GreenhouseHttpError ? `http_${e.status}` : "network_error" };
      }
    },
    async listHires(q): Promise<SyncPage<AtsHire>> {
      const { items, headers } = q.cursor ? await get<GhApp[]>("/v3/applications", { cursor: q.cursor }) : await get<GhApp[]>("/v3/applications", { status: "hired", per_page: "100", ...(q.updatedAfter ? { "updated_at[gt]": q.updatedAfter } : {}) });
      const hires: AtsHire[] = [];
      for (const a of items) { const h = await hireOf(a); if (h) hires.push(h); }
      lastSyncAt = new Date(nowMs()).toISOString();
      return { items: hires, nextCursor: nextCursorOf(headers.link), rateLimit: pageMeta(headers) };
    },
    async getHire(applicationId) {
      const [app] = (await get<GhApp[]>("/v3/applications", { ids: applicationId })).items;
      return app ? hireOf(app) : null;
    },
    async listJobs(q): Promise<SyncPage<AtsJob>> {
      if (q.source === "board" && secretPresence(["WEFT_GREENHOUSE_BOARD_TOKEN"], env).WEFT_GREENHOUSE_BOARD_TOKEN) {
        const b = await fetchBoardJobs(readSecret("WEFT_GREENHOUSE_BOARD_TOKEN", env), opts.fetchImpl ?? fetch);
        return { items: b.jobs, nextCursor: null, rateLimit: { remaining: null, resetAt: null } };
      }
      const { items, headers } = q.cursor ? await get<GhJob[]>("/v3/jobs", { cursor: q.cursor }) : await get<GhJob[]>("/v3/jobs", { per_page: "100", ...(q.source === "board" ? { status: "open" } : {}) });
      return { items: items.map(toJob), nextCursor: nextCursorOf(headers.link), rateLimit: pageMeta(headers) };
    },
    verifyWebhook(raw, headers) {
      const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
      const key = h["greenhouse-event-id"] ?? null;
      if (!secretPresence(["WEFT_GREENHOUSE_WEBHOOK_SECRET"], env).WEFT_GREENHOUSE_WEBHOOK_SECRET) return { ok: false, dedupeKey: key };
      const sig = /^sha256 ([0-9a-f]{64})$/.exec(h.signature ?? "");
      if (!sig || !key) return { ok: false, dedupeKey: key };
      return { ok: constantTimeEqual(hmacSha256(readSecret("WEFT_GREENHOUSE_WEBHOOK_SECRET", env), raw, "hex"), sig[1]!), dedupeKey: key };
    },
    parseWebhook(raw) {
      try {
        const b = JSON.parse(new TextDecoder().decode(raw)) as { action?: unknown; payload?: { application?: { id?: unknown }; offer?: { application_id?: unknown } } };
        if (typeof b.action !== "string") return null;
        const id = b.payload?.application?.id ?? b.payload?.offer?.application_id ?? null;
        return { action: b.action, applicationId: id === null || id === undefined ? null : String(id) };
      } catch { return null; }
    },
    async markHired() {
      throw new Error("greenhouse: the real adapter is read-only; marking a hire needs the opt-in write scope");
    },
  };
}
