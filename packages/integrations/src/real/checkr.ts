// Real checkr adapter (docs/wave3.md). Owner: w3-integrations-screening-esign. Built against the published Checkr API; refuses production unless WEFT_LIVE_CHECKR=1, never run live in wave 3.
// The only code in Weft that calls this vendor over HTTP. Credentials come from ./secrets readSecret, never logged.
// Written from the documented shapes (research/wave3/integrations-screening-esign.md 2): HTTP Basic with the secret key,
// Idempotency-Key on POST, the hosted invitation flow (Weft never collects SSN or date of birth), and the X-Checkr-Signature
// hex HMAC over the raw body. Staging is the default host; production needs CHECKR_ENV=production and WEFT_LIVE_CHECKR=1.
import { createHash } from "node:crypto";
import type { ConnectorStatus, ScreeningConnector, ScreeningSnapshot, ScreeningStatus, WebhookVerdict } from "@weft/contracts";
import { isTestEnv, LiveIntegrationInTest } from "../mode";
import { readSecret, type Env } from "../secrets";
import { constantTimeEqual, hmacSha256 } from "../webhook";

export const CHECKR_HOSTS = { staging: "https://api.checkr-staging.com/v1", production: "https://api.checkr.com/v1" } as const;
export class IntegrationRefused extends Error {
  constructor(readonly code: "INTEGRATION_LIVE_DISABLED" | "INTEGRATION_NOT_AVAILABLE" | "INTEGRATION_HTTP" | "INTEGRATION_RATE_GUARD", message: string) { super(`${code}: ${message}`); }
}
type Fetch = typeof fetch;
type Json = Record<string, unknown>;

/** Checkr report and invitation fields folded into Weft's normalized status (same mapping as the simulator). */
export function checkrStatus(inv: Json | null, rpt: Json | null): ScreeningStatus {
  if (rpt) {
    const s = rpt.status;
    if (s === "suspended") return "suspended";
    if (s === "dispute") return "disputed";
    if (s === "canceled") return "canceled";
    if (s === "complete") return rpt.result === "consider" || rpt.assessment === "review" || rpt.assessment === "escalated" ? "complete_review" : "complete_clear";
    return "in_progress";
  }
  if (inv?.status === "expired") return "expired";
  if (inv?.status === "deleted") return "canceled";
  if (inv?.status === "completed") return "consented";
  return "invited";
}
const ADJ: Record<string, ScreeningSnapshot["adjudication"]> = { engaged: "engaged", pre_adverse_action: "pre_adverse", post_adverse_action: "post_adverse" };
const lower = (h: Record<string, string>) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
const ptDate = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(iso));

export function parseCheckrEvent(raw: Uint8Array): { dedupeKey: string; vendorOrderId: string; kind: string }[] {
  try {
    const b = JSON.parse(Buffer.from(raw).toString("utf8")) as Json;
    const obj = ((b.data as { object?: Json } | undefined)?.object ?? {}) as Json;
    const ref = obj.object === "adverse_action" ? obj.report_id : obj.id;
    return typeof b.id === "string" && typeof b.type === "string" && typeof ref === "string" ? [{ dedupeKey: b.id, vendorOrderId: ref, kind: b.type }] : [];
  } catch { return []; }
}

export interface CheckrClientOptions { env: Env; fetch?: Fetch; now?: () => string }

/** The Checkr connector over HTTP. Exported for tests, which pass a fake fetch; nothing here runs in a test without one. */
export function createCheckrClient(o: CheckrClientOptions): ScreeningConnector {
  const env = o.env;
  const production = env.CHECKR_ENV === "production";
  const base = production ? CHECKR_HOSTS.production : CHECKR_HOSTS.staging;
  const guard = () => {
    if (production && env.WEFT_LIVE_CHECKR !== "1") throw new IntegrationRefused("INTEGRATION_LIVE_DISABLED", "Checkr production needs WEFT_LIVE_CHECKR=1 (and Checkr's written view on automated access)");
    if (!o.fetch && isTestEnv(env)) throw new LiveIntegrationInTest("checkr");
  };
  const f: Fetch = o.fetch ?? ((...a) => fetch(...a));
  const call = async (method: string, path: string, body?: Json, idem?: string): Promise<Json> => {
    guard();
    const key = readSecret("CHECKR_API_KEY", env);
    const headers: Record<string, string> = { authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}`, accept: "application/json" };
    if (body) headers["content-type"] = "application/json";
    if (method === "POST" && idem) headers["idempotency-key"] = idem;
    const res = await f(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 429) throw new IntegrationRefused("INTEGRATION_RATE_GUARD", `Checkr rate limit (retry after ${res.headers.get("x-ratelimit-reset") ?? "a moment"})`);
    if (!res.ok) throw new IntegrationRefused("INTEGRATION_HTTP", `Checkr ${method} ${path.split("?")[0]} answered ${res.status}`);
    return res.status === 204 ? {} : ((await res.json()) as Json);
  };
  const idem = (...parts: string[]) => createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 40);
  return {
    async status(): Promise<ConnectorStatus> {
      return { vendor: "checkr", category: "screening", mode: "real", configured: true, lastSyncAt: null, cursor: null, health: production && env.WEFT_LIVE_CHECKR !== "1" ? "permission_gap" : "ok", detail: production ? "production" : "staging" };
    },
    async listPackages() {
      const r = await call("GET", "/packages");
      return ((r.data as Json[] | undefined) ?? []).map((p) => ({
        slug: String(p.slug), name: String(p.name), priceCents: Number(p.price ?? 0),
        screenings: ((p.screenings as Json[] | undefined) ?? []).map((s) => String(s.type)), phase: "full" as const,
      }));
    },
    async createOrder(i) {
      const wl = [{ country: i.workLocation.country, state: i.workLocation.state, ...(i.workLocation.city ? { city: i.workLocation.city } : {}) }];
      const cand = await call("POST", "/candidates", { first_name: i.candidate.first, last_name: i.candidate.last, email: i.candidate.email, work_locations: wl }, idem("cand", i.orderId));
      const inv = await call("POST", "/invitations", { candidate_id: cand.id, package: i.packageSlug, work_locations: wl }, idem("inv", i.orderId));
      return { vendorCandidateId: String(cand.id), vendorOrderId: String(inv.id), applyUrl: String(inv.invitation_url), status: checkrStatus(inv, null) };
    },
    async getOrder(id) {
      const inv = await call("GET", `/invitations/${encodeURIComponent(id)}`);
      const rpt = typeof inv.report_id === "string" ? await call("GET", `/reports/${encodeURIComponent(inv.report_id)}`) : null;
      const eta = rpt && rpt.status === "pending" && typeof rpt.estimated_completion_time === "string" ? ptDate(rpt.estimated_completion_time) : null;
      return { status: checkrStatus(inv, rpt), result: (rpt?.result as "clear" | "consider" | null | undefined) ?? null, adjudication: ADJ[String(rpt?.adjudication ?? "")] ?? "none", etaOn: eta, completedAt: (rpt?.completed_at as string | null | undefined) ?? null, vendorReportId: (rpt?.id as string | undefined) ?? null };
    },
    async cancelOrder(id) { await call("DELETE", `/invitations/${encodeURIComponent(id)}`); },
    async listAdverseItems(reportId) {
      const r = await call("GET", `/reports/${encodeURIComponent(reportId)}/adverse_items`);
      return ((r.data as Json[] | undefined) ?? []).map((a) => ({ id: String(a.id), text: String(a.text ?? "") }));
    },
    async startPreAdverse(reportId, itemIds, postNoticeAt) {
      const r = await call("POST", `/reports/${encodeURIComponent(reportId)}/adverse_actions`, { adverse_item_ids: itemIds, post_notice_scheduled_at: postNoticeAt }, idem("aa", reportId, ...itemIds));
      return { vendorAdverseId: String(r.id) };
    },
    async cancelAdverse(id) { await call("DELETE", `/adverse_actions/${encodeURIComponent(id)}`); },
    verifyWebhook(raw: Uint8Array, headers: Record<string, string>): WebhookVerdict {
      const got = lower(headers)["x-checkr-signature"];
      let key: string;
      try { key = readSecret("CHECKR_API_KEY", env); } catch { return { ok: false, dedupeKey: null }; }
      if (!got || !constantTimeEqual(hmacSha256(key, raw, "hex"), got.trim().toLowerCase())) return { ok: false, dedupeKey: null };
      return { ok: true, dedupeKey: parseCheckrEvent(raw)[0]?.dedupeKey ?? null };
    },
    parseWebhook: parseCheckrEvent,
  };
}

export function createRealCheckr(env: Env, _simulated: ScreeningConnector): ScreeningConnector | null {
  return createCheckrClient({ env });
}
