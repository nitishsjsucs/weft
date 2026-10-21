// The hosted checks' stand-ins (owner: cf5-web): every /api call answered from the mock world (src/lib/api/mocks) plus
// the hosted session routes, the /api/_live socket played by the test, and a Turnstile stub. Each response lists
// `x-weft-tables` as the slot would, so the change feed's table matching is exercised.
import type { Page, Request, Route, WebSocketRoute } from "@playwright/test";
import { mockFetch, resetMockWorld } from "../src/lib/api/mocks";
import type { LeaseInfo, SessionStatus } from "../../../packages/contracts/src/ext/cf-hosted";

/** The tables each mocked GET reads (the slot's x-weft-tables). Unlisted paths send no header (matched by every commit). */
export function tablesFor(path: string): string | null {
  if (/^\/v1\/proposals/.test(path)) return "proposals";
  if (/^\/v1\/(sim\/clock|health)$/.test(path)) return "settings";
  if (/^\/v1\/time-off\//.test(path)) return "time_off_policies,time_off_requests,workers";
  if (/^\/v1\/agent\/runs/.test(path)) return "agent_runs,run_steps";
  if (/^\/v1\/workers/.test(path)) return "workers";
  if (/^\/v1\/offers/.test(path)) return "offers";
  if (/^\/v1\/settings\/permissions/.test(path)) return "settings";
  if (/^\/v1\/routines/.test(path)) return "routine_defs,routine_runs";
  return null;
}

export const LEASE: LeaseInfo = { slot: "slot-1", gen: 4, expiresAt: new Date(Date.now() + 3 * 3600_000).toISOString(), idleExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), resetsLeft: 3 };
export const status = (p: Partial<SessionStatus> = {}): SessionStatus => ({
  world: "slot", lease: LEASE, grantExpiresAt: null, level: 0, pool: { size: 2, free: 1, waitlist: 0 }, provider: { id: "openai", reason: "default" }, agentEnabled: true, ...p,
});

export interface Hosted {
  /** Every /api HTTP request (not the socket), in order. */
  api: { method: string; path: string; at: number }[];
  /** Every /api/_live connection attempt. */
  sockets: WebSocketRoute[];
  /** Console errors and page errors that are not a failed mock request (a hydration mismatch would land here). */
  errors: string[];
  session: SessionStatus;
  /** Answer the next requests for `method path` with these responses first (then the mock world). */
  queue: (key: string, ...answers: { status: number; body: unknown }[]) => void;
  /** Answer every request for `method path` with this response (after the queue). */
  override: (key: string, answer: { status: number; body: unknown; contentType?: string }) => void;
  /** Sends a frame on the newest socket. */
  frame: (msg: unknown) => void;
  /** The socket accepts and answers pings (default), or closes at once. */
  acceptSockets: boolean;
  since: (t: number) => { method: string; path: string; at: number }[];
}

const TURNSTILE_STUB = `window.turnstile = { render: function (el, o) { var id = "w" + Math.random().toString(36).slice(2); el.setAttribute("data-stub", id); setTimeout(function () { o.callback("XXXX.DUMMY.TOKEN.XXXX"); }, 30); return id; }, remove: function () {} };`;

export async function installHosted(page: Page, opts: { session?: SessionStatus; acceptSockets?: boolean } = {}): Promise<Hosted> {
  resetMockWorld();
  const queued = new Map<string, { status: number; body: unknown }[]>();
  const overrides = new Map<string, { status: number; body: unknown; contentType?: string }>();
  const h: Hosted = {
    api: [], sockets: [], errors: [], session: opts.session ?? status(), acceptSockets: opts.acceptSockets ?? true,
    queue: (key, ...answers) => { queued.set(key, [...(queued.get(key) ?? []), ...answers]); },
    override: (key, answer) => { overrides.set(key, answer); },
    frame: (msg) => { const ws = h.sockets.at(-1); if (ws) ws.send(JSON.stringify(msg)); },
    since: (t) => h.api.filter((r) => r.at >= t),
  };
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) h.errors.push(m.text()); });
  page.on("pageerror", (e) => h.errors.push(e.message));
  page.on("request", (r: Request) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith("/api/") && u.pathname !== "/api/_live") h.api.push({ method: r.method(), path: `${u.pathname}${u.search}`, at: Date.now() });
  });
  await page.addInitScript(() => {
    (window as unknown as { __cspViolations: string[] }).__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) => (window as unknown as { __cspViolations: string[] }).__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  await page.route("https://challenges.cloudflare.com/**", (route) => route.fulfill({ status: 200, contentType: "application/javascript", body: TURNSTILE_STUB }));
  await page.routeWebSocket(/\/api\/_live$/, (ws) => {
    h.sockets.push(ws);
    if (!h.acceptSockets) { void ws.close({ code: 1011, reason: "test refuses" }); return; }
    ws.onMessage((m) => { if (m === "ping") ws.send("pong"); });
  });
  await page.route("**/api/**", async (route: Route) => {
    const req = route.request();
    const u = new URL(req.url());
    const method = req.method();
    const key = `${method} ${u.pathname}`;
    const q = queued.get(key);
    if (q?.length) { const a = q.shift()!; return route.fulfill({ status: a.status, contentType: "application/json", body: JSON.stringify(a.body) }); }
    const o = overrides.get(key);
    if (o) return route.fulfill({ status: o.status, contentType: o.contentType ?? "application/json", body: typeof o.body === "string" || Buffer.isBuffer(o.body) ? (o.body as string | Buffer) : JSON.stringify(o.body) });
    if (u.pathname === "/api/_session" && method === "GET") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(h.session) });
    if (u.pathname === "/api/_session/lease" && method === "POST") {
      h.session = status();
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "leased", ...LEASE }) });
    }
    if (u.pathname === "/api/_hosted/model" && method === "PUT") {
      // The slot writes the per-world setting; the next session read reports it (reason "world").
      const provider = (JSON.parse(req.postData() ?? "{}") as { provider?: string | null }).provider ?? null;
      h.session = { ...h.session, provider: provider ? { id: provider as SessionStatus["provider"]["id"], reason: "world" } : { id: "openai", reason: "default" } };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    }
    if (u.pathname === "/api/_session/verify" && method === "POST") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, grantExpiresAt: new Date(Date.now() + 600_000).toISOString() }) });
    const path = u.pathname.replace(/^\/api/, "");
    const res = await mockFetch(`${u.pathname}${u.search}`, { method, headers: req.headers(), body: req.postData() ?? undefined });
    const headers: Record<string, string> = { "content-type": res.headers.get("content-type") ?? "application/json" };
    const t = method === "GET" ? tablesFor(path) : null;
    if (t) headers["x-weft-tables"] = t;
    return route.fulfill({ status: res.status, headers, body: await res.text() });
  });
  return h;
}

/** Waits until no /api request has started for `quietMs`. */
export async function settle(page: Page, h: Hosted, quietMs = 2_500, maxMs = 30_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const last = h.api.at(-1)?.at ?? start;
    if (Date.now() - last >= quietMs) return;
    if (Date.now() - start > maxMs) throw new Error("the page never went quiet");
    await page.waitForTimeout(250);
  }
}

export async function cspViolations(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations);
}

/** Marks the page hidden, as a background tab is. */
export async function hide(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
}
