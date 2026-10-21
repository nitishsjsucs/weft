// The hosted request layer (docs/cloudflare/design.md 4.5 and 6.1, track cf2-platform). It wraps the frozen app only
// when the platform has a facade meter (the durable platform), so Node's app is exactly buildApp(weft):
// - x-weft-tables: every GET response lists the tables it read (sorted, comma-separated);
// - ETag/304: a polled GET's ETag is W/"<gen>.<hash(route, query, principal, clock, versions of the tables it read)>",
//   and a request whose If-None-Match matches a remembered ETag whose tables have not been written since gets 304
//   without running the route, auth included, so it reads 0 rows. The remembered entry was made by a request with
//   the same identity material that passed auth and read the auth tables, so an unchanged principals or api_keys
//   version is what keeps that identity valid. A route whose handler touched a source outside the company SQL
//   (SpendDO, KV, the environment) marks itself uncachable through markUncachable();
// - the read-only world guard: on the showcase (or kv_state world.readonly = "1") every mutation is refused with 409
//   WORLD_READ_ONLY, again in the Durable Object after the front Worker's LEASE_REQUIRED.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import type { SqlMeter } from "../../../../packages/contracts/src/ext/cf-db";
import { HOSTED_ERRORS, hostedEtag, TABLES_HEADER } from "../../../../packages/contracts/src/ext/cf-hosted";
import { SMALL_STATE_KEYS } from "../../../../packages/contracts/src/ext/cf-platform";
import type { Weft, WeftEnv } from "./context";
import { allowedHostsFor } from "./auth";

/**
 * The GET routes the web polls (refreshMs in apps/web/src/lib/api/hooks.ts users, plus the run trace's poll
 * fallback). Only these get an ETag; anything else still gets x-weft-tables.
 */
export const POLLED_GET_ROUTES: readonly string[] = [
  "/v1/proposals", "/v1/proposals/:id", "/v1/time-off/requests", "/v1/offboarding", "/v1/offboarding/:id", "/v1/offers", "/v1/agent/mentions",
  "/v1/expense-intake", "/v1/expenses", "/v1/training/assignments", "/v1/sim/chat", "/v1/sim/state", "/v1/agent/runs/:id", "/v1/agent/runs/:id/trace",
  "/v1/routine-gallery", "/v1/routines", "/v1/workers", "/v1/workers/:id", "/v1/workers/:id/documents", "/v1/workers/:id/onboarding", "/v1/it/accounts",
  "/v1/tax/accounts", "/v1/tax/rates", "/v1/notices", "/v1/contractors/payouts", "/v1/screening/orders", "/v1/compliance/calendar", "/v1/filings",
  "/v1/handoffs", "/v1/integrations", "/v1/sync-items", "/v1/ats/jobs", "/v1/integrations/greenhouse/imported", "/v1/integrations/workday/imported",
];
const POLLED = POLLED_GET_ROUTES.map((p) => new RegExp(`^${p.replace(/:[A-Za-z]+/g, "[^/]+")}$`));
export const isPolledRoute = (path: string): boolean => POLLED.some((re) => re.test(path));

const requestScope = new AsyncLocalStorage<{ uncachable: string | null }>();
/** Called by a platform adapter (the SpendDO client, a KV read) when the current request read a source the meter cannot see. */
export function markUncachable(reason: string): void {
  const s = requestScope.getStore();
  if (s && !s.uncachable) s.uncachable = reason;
}

interface Remembered { etag: string; tables: string[]; versions: Record<string, number> }
/** Remembered ETags per world, bounded; an evicted entry only costs one computed poll. */
export const ETAG_MEMO_MAX = 512;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function hostedError(code: keyof typeof HOSTED_ERRORS, message: string): Response {
  const e = HOSTED_ERRORS[code];
  return new Response(JSON.stringify({ _tag: e.tag, code, message }), { status: e.status, headers: { "content-type": "application/json" } });
}

/** True when this world refuses every mutation: the showcase, or the kv_state flag. */
export function worldReadOnly(weft: Weft): boolean {
  if (weft.platform.readOnly) return true;
  try { return weft.platform.state.get(SMALL_STATE_KEYS.readOnly) === "1"; } catch { return false; }
}

/** The identity and clock a remembered response depends on, besides the tables it read. */
function requestKey(weft: Weft, req: Request, url: URL): string {
  const q = [...url.searchParams.entries()].sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : x > y ? 1 : 0) : a < b ? -1 : 1));
  const h = (n: string) => req.headers.get(n);
  return JSON.stringify([
    url.pathname, q, h("host"), h("x-forwarded-host"), h("x-weft-principal"),
    h("x-weft-proxy") ? sha(h("x-weft-proxy")!) : null, h("x-api-key") ? sha(h("x-api-key")!) : null,
    weft.clock.now(), weft.clock.rate(),
  ]);
}

const etagMatches = (header: string | null, etag: string) => !!header && header.split(",").map((s) => s.trim()).some((t) => t === etag || t === "*");

export interface HostedAppStats { computed: number; notModified: number; remembered: number }

/** Wraps the app with the hosted layer; `meter` is the world's facade meter. */
export function hostedApp(inner: Hono<WeftEnv>, weft: Weft, meter: SqlMeter | null): Hono<WeftEnv> & { hostedStats: HostedAppStats } {
  const outer = new Hono<WeftEnv>() as Hono<WeftEnv> & { hostedStats: HostedAppStats };
  const memo = new Map<string, Remembered>();
  const stats: HostedAppStats = { computed: 0, notModified: 0, remembered: 0 };
  outer.hostedStats = stats;
  let commitSeq = 0;
  meter?.onCommit((c) => { commitSeq = c.seq; });
  const gen = () => weft.platform.world?.gen ?? 0;

  outer.all("*", async (c) => {
    const req = c.req.raw;
    const url = new URL(req.url);
    const method = req.method.toUpperCase();
    if (MUTATING.has(method) && url.pathname.startsWith("/v1/") && worldReadOnly(weft)) {
      return hostedError("WORLD_READ_ONLY", "This is the shared read-only demo company; start your own demo company to make changes");
    }
    if (method !== "GET" || !meter) return inner.fetch(req, c.env);

    const eligible = isPolledRoute(url.pathname) && !url.searchParams.has("wait");
    const key = eligible ? requestKey(weft, req, url) : null;
    const host = req.headers.get("host") ?? url.host;
    if (key && allowedHostsFor(weft).has(host)) {
      const r = memo.get(key);
      if (r && etagMatches(req.headers.get("if-none-match"), r.etag) && r.tables.every((t) => meter.version(t) === r.versions[t])) {
        stats.notModified++;
        memo.delete(key); memo.set(key, r);   // most recently used last
        return new Response(null, { status: 304, headers: { etag: r.etag, [TABLES_HEADER]: r.tables.join(",") } });
      }
    }

    const scope = { uncachable: null as string | null };
    const before = commitSeq;
    const { value: res, usage } = await requestScope.run(scope, () => meter.measure(async () => inner.fetch(req, c.env)));
    stats.computed++;
    const headers = new Headers(res.headers);
    headers.set(TABLES_HEADER, usage.tablesRead.join(","));
    // Remember only a clean read: a 200 that read company tables and wrote nothing, during which no commit landed (its
    // rows could predate it), and that touched nothing outside the company SQL.
    if (key && res.status === 200 && !scope.uncachable && commitSeq === before && usage.tablesWritten.length === 0 && usage.tablesRead.length > 0) {
      const versions = meter.versions(usage.tablesRead);
      const etag = hostedEtag(gen(), sha(JSON.stringify([key, versions])).slice(0, 32));
      memo.delete(key);
      memo.set(key, { etag, tables: [...usage.tablesRead], versions });
      while (memo.size > ETAG_MEMO_MAX) memo.delete(memo.keys().next().value!);
      stats.remembered++;
      headers.set("etag", etag);
      if (etagMatches(req.headers.get("if-none-match"), etag)) {
        stats.notModified++;
        return new Response(null, { status: 304, headers: { etag, [TABLES_HEADER]: usage.tablesRead.join(",") } });
      }
    }
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  });
  return outer;
}
