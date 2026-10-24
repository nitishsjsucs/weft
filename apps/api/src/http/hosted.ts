// The hosted request layer (docs/cloudflare/design.md 4.5 and 6.1, track cf2-platform). It wraps the frozen app only
// when the platform has a facade meter (the durable platform), so Node's app is exactly buildApp(weft):
// - x-weft-tables: every GET response lists the tables it read (sorted, comma-separated);
// - x-weft-query: every GET response lists the query parameter names its route read (sorted, comma-separated), so the
//   front Worker's showcase memo keys a read by those only (design 4.5);
// - ETag/304: a polled GET's ETag is W/"<gen>.<hash(boot epoch, route, query, principal, clock, versions of the tables
//   it read)>", and a request whose If-None-Match matches a remembered ETag whose tables have not been written since
//   gets 304 without running the route, auth included, so it reads 0 rows. Table versions live in memory and restart
//   at 0 on every cold start (an eviction, a hibernation, a deploy) while gen changes only on a reset, so the hash
//   mixes in a random epoch minted once per boot: an ETag from an earlier boot never matches one minted in this one,
//   and the first poll after a restart is computed (design 4.5). The remembered entry was made by a request with
//   the same identity material that passed auth and read the auth tables, so an unchanged principals or api_keys
//   version is what keeps that identity valid. A route whose handler touched a source outside the company SQL
//   (SpendDO, KV, the environment) marks itself uncachable through markUncachable() and answers
//   `cache-control: no-store`, which the front Worker's showcase memo also honours; a polled route answers
//   `cache-control: private, no-cache`, so the browser revalidates with If-None-Match on every poll (cf5-web);
// - the read-only world guard: on the showcase (or kv_state world.readonly = "1") every mutation is refused with 409
//   WORLD_READ_ONLY, again in the Durable Object after the front Worker's LEASE_REQUIRED.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { HonoRequest } from "hono/request";
import type { SqlMeter } from "../../../../packages/contracts/src/ext/cf-db";
import { HOSTED_ERRORS, hostedEtag, QUERY_HEADER, TABLES_HEADER } from "../../../../packages/contracts/src/ext/cf-hosted";
import { SMALL_STATE_KEYS } from "../../../../packages/contracts/src/ext/cf-platform";
import type { Weft, WeftEnv } from "./context";
import { allowedHostsFor } from "./auth";

/**
 * The GET routes the web polls (refreshMs in apps/web/src/lib/api/hooks.ts users, plus the run trace's poll
 * fallback). Only these get an ETag; anything else still gets x-weft-tables.
 */
export const POLLED_GET_ROUTES: readonly string[] = [
  "/v1/proposals", "/v1/proposals/:id", "/v1/time-off/requests", "/v1/offboarding", "/v1/offboarding/:id", "/v1/offers", "/v1/agent/mentions",
  "/v1/expense-intake", "/v1/expenses", "/v1/training/assignments", "/v1/sim/chat", "/v1/sim/state", "/v1/agent/runs", "/v1/agent/runs/:id", "/v1/agent/runs/:id/trace",
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

/** The query parameter names the running hosted GET's route has read. */
const queryReads = new AsyncLocalStorage<Set<string>>();
let trackingQueries = false;
/**
 * Records each query parameter a route reads (HonoRequest's query and queries; "*" when it asks for all of them)
 * while a hosted GET runs. Installed once per isolate, the first time a hosted app is built (so never on Node's own
 * app); outside a hosted GET it only delegates.
 */
function trackQueryReads(): void {
  if (trackingQueries) return;
  trackingQueries = true;
  const proto = HonoRequest.prototype as unknown as { query(key?: string): unknown; queries(key?: string): unknown };
  const query = proto.query, queries = proto.queries;
  proto.query = function (this: unknown, key?: string) { queryReads.getStore()?.add(key ?? "*"); return query.call(this, key); };
  proto.queries = function (this: unknown, key?: string) { queryReads.getStore()?.add(key ?? "*"); return queries.call(this, key); };
}

interface Remembered { etag: string; tables: string[]; versions: Record<string, number> }
/** Remembered ETags per world, bounded; an evicted entry only costs one computed poll. */
export const ETAG_MEMO_MAX = 512;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
/** 16 random hex digits, from Web Crypto (Node and workerd alike). Minted inside a request, never at module scope. */
const randomEpoch = (): string => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** A polled response the browser keeps but revalidates on every use (the If-None-Match round trip the web relies on). */
const REVALIDATE = "private, no-cache";

function hostedError(code: keyof typeof HOSTED_ERRORS, message: string): Response {
  const e = HOSTED_ERRORS[code];
  return new Response(JSON.stringify({ _tag: e.tag, code, message }), { status: e.status, headers: { "content-type": "application/json" } });
}

/**
 * True when this world refuses every mutation: the showcase, or the kv_state flag. Fails closed: a flag that cannot
 * be read refuses the mutation rather than letting it through.
 */
export function worldReadOnly(weft: Pick<Weft, "platform">): boolean {
  if (weft.platform.readOnly) return true;
  try { return weft.platform.state.get(SMALL_STATE_KEYS.readOnly) === "1"; } catch { return true; }
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
  trackQueryReads();
  const memo = new Map<string, Remembered>();
  const stats: HostedAppStats = { computed: 0, notModified: 0, remembered: 0 };
  outer.hostedStats = stats;
  let commitSeq = 0;
  meter?.onCommit((c) => { commitSeq = c.seq; });
  const gen = () => weft.platform.world?.gen ?? 0;
  // One epoch per boot (hostedApp runs once per assembled world), minted lazily at the first remembered response.
  let epoch: string | null = null;
  const bootEpoch = () => (epoch ??= randomEpoch());

  outer.all("*", async (c) => {
    const req = c.req.raw;
    const url = new URL(req.url);
    const method = req.method.toUpperCase();
    if (MUTATING.has(method) && url.pathname.startsWith("/v1/") && worldReadOnly(weft)) {
      return hostedError("WORLD_READ_ONLY", "This is the shared read-only workspace; open your own workspace to make changes");
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
        return new Response(null, { status: 304, headers: { etag: r.etag, [TABLES_HEADER]: r.tables.join(","), "cache-control": REVALIDATE } });
      }
    }

    const scope = { uncachable: null as string | null };
    const before = commitSeq;
    const reads = new Set<string>();
    const { value: res, usage } = await queryReads.run(reads, () => requestScope.run(scope, () => meter.measure(async () => inner.fetch(req, c.env))));
    stats.computed++;
    const headers = new Headers(res.headers);
    headers.set(TABLES_HEADER, usage.tablesRead.join(","));
    headers.set(QUERY_HEADER, reads.has("*") ? "*" : [...reads].sort().join(","));
    if (scope.uncachable) headers.set("cache-control", "no-store");
    else if (key && !headers.has("cache-control")) headers.set("cache-control", REVALIDATE);
    // Remember only a clean read: a 200 that read company tables and wrote nothing, during which no commit landed (its
    // rows could predate it), and that touched nothing outside the company SQL.
    if (key && res.status === 200 && !scope.uncachable && commitSeq === before && usage.tablesWritten.length === 0 && usage.tablesRead.length > 0) {
      const versions = meter.versions(usage.tablesRead);
      const etag = hostedEtag(gen(), sha(JSON.stringify([bootEpoch(), key, versions])).slice(0, 32));
      memo.delete(key);
      memo.set(key, { etag, tables: [...usage.tablesRead], versions });
      while (memo.size > ETAG_MEMO_MAX) memo.delete(memo.keys().next().value!);
      stats.remembered++;
      headers.set("etag", etag);
      // Only an ETag minted in this boot can match here (the epoch is in its hash), so an unchanged computed poll
      // still answers 304 without its body.
      if (etagMatches(req.headers.get("if-none-match"), etag)) {
        stats.notModified++;
        return new Response(null, { status: 304, headers: { etag, [TABLES_HEADER]: usage.tablesRead.join(","), "cache-control": REVALIDATE } });
      }
    }
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  });
  return outer;
}
