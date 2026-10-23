// The hosted checks' stand-ins (owner: cf5-web): every /api call answered from the mock world (src/lib/api/mocks) plus
// the hosted session routes, the /api/_live socket played by the test, and a Turnstile stub. Each response lists
// `x-weft-tables` as the slot would, so the change feed's table matching is exercised. The hosted routes answer as
// the real ones do, so a client that the real backend would refuse fails here too: dictation runs the extras' own
// dictation (packages/cf-extras/src/dictation.ts, which refuses anything but 16-bit PCM WAV) over a stand-in model,
// a PDF answers 202 while it renders and only takes a document id, and the session's provider follows the world's
// model switch the way the front computes it.
import type { Page, Request, Route, WebSocketRoute } from "@playwright/test";
import { mockFetch, resetMockWorld } from "../src/lib/api/mocks";
import type { HostedProviderId } from "../../../packages/contracts/src/ext/cf-agent";
import type { LeaseInfo, SessionStatus } from "../../../packages/contracts/src/ext/cf-hosted";
import type { DictationResult } from "../../../packages/contracts/src/ext/cf-extras";
import { createDictation } from "../../../packages/cf-extras/src/dictation";
import { memoryNeuronBudget } from "../../../packages/cf-extras/src/neurons";
import { pcmWavInfo } from "../../../packages/cf-extras/src/wav";

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
  /** What GET /api/_session reports, before the world's model switch (`worldProvider`) is applied as the front does. */
  session: SessionStatus;
  /** The leased world's model switch (its WORLD_MODEL_SETTING row), written by PUT /api/_hosted/model. */
  worldProvider: HostedProviderId | null;
  /** What the stand-in model hears in a clip dictation accepts. */
  transcript: string;
  /** Every clip posted to /api/_hosted/dictate, with its content type and what dictation answered. */
  dictated: { contentType: string; bytes: Buffer; result: DictationResult }[];
  /** How many 202s a PDF answers before it is rendered (the route answers 202 until its render job has run). */
  pdfRenderPolls: number;
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

const json = (route: Route, status: number, body: unknown, headers: Record<string, string> = {}) =>
  route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(body) });

/** The provider GET /api/_session reports (apps/cf/src/front/session.ts): a leased world's model switch wins over the
 * default unless the agent is paused, with the reason "world". The budget and neuron fallbacks are not played here. */
export function sessionRead(h: Pick<Hosted, "session" | "worldProvider">): SessionStatus {
  const s = h.session;
  if (!s.lease || !s.agentEnabled || h.worldProvider === null) return s;
  return { ...s, provider: { id: h.worldProvider, reason: "world" } };
}

/** The subject prefix each PDF kind takes (apps/cf/src/extras/slot/pdf-route.ts pdfDataFor): a paycheck or a document. */
const PDF_SUBJECT = /^\/api\/_hosted\/pdf\/(offer_letter|signed_agreement|pay_stub)\/([A-Za-z0-9_]{3,64})\/?$/;

const TURNSTILE_STUB = `window.turnstile = { render: function (el, o) { var id = "w" + Math.random().toString(36).slice(2); el.setAttribute("data-stub", id); setTimeout(function () { o.callback("XXXX.DUMMY.TOKEN.XXXX"); }, 30); return id; }, remove: function () {} };`;

export async function installHosted(page: Page, opts: { session?: SessionStatus; acceptSockets?: boolean } = {}): Promise<Hosted> {
  resetMockWorld();
  const queued = new Map<string, { status: number; body: unknown }[]>();
  const overrides = new Map<string, { status: number; body: unknown; contentType?: string }>();
  const renders = new Map<string, number>();
  const h: Hosted = {
    api: [], sockets: [], errors: [], session: opts.session ?? status(), acceptSockets: opts.acceptSockets ?? true,
    worldProvider: null, transcript: "when do we pay salaries", dictated: [], pdfRenderPolls: 1,
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
    if (u.pathname === "/api/_session" && method === "GET") return json(route, 200, sessionRead(h));
    if (u.pathname === "/api/_session/lease" && method === "POST") {
      h.session = status();
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "leased", ...LEASE }) });
    }
    if (u.pathname === "/api/_hosted/model" && method === "PUT") {
      // The slot writes its WORLD_MODEL_SETTING row and answers as CompanyDO does; the session read derives the rest.
      const provider = (JSON.parse(req.postData() ?? "{}") as { provider?: HostedProviderId | null }).provider ?? null;
      h.worldProvider = provider;
      return json(route, 200, { ok: true, provider });
    }
    if (u.pathname === "/api/_hosted/dictate" && method === "POST") {
      // HostedExtras answers every DictationResult with 200 (apps/cf/src/extras/http.ts); a refusal is `ok: false`.
      const bytes = req.postDataBuffer() ?? Buffer.alloc(0);
      const contentType = req.headers()["content-type"] ?? "";
      const model = { run: async () => ({ text: h.transcript, transcription_info: { duration: pcmWavInfo(bytes)?.seconds ?? 0 } }) };
      const result = await createDictation({ ai: model, neurons: memoryNeuronBudget(), enabled: () => true }).transcribe({ audio: new Uint8Array(bytes), contentType });
      h.dictated.push({ contentType, bytes, result });
      return json(route, 200, result);
    }
    const pdf = method === "GET" ? PDF_SUBJECT.exec(u.pathname) : null;
    if (pdf) {
      // The slot's PDF route: a subject of the wrong kind is a 404, a miss enqueues the render and answers 202 until
      // the render has run, then the PDF comes from R2.
      const kind = pdf[1]!, id = pdf[2]!;
      if (kind === "pay_stub" ? !id.startsWith("pyc_") : !id.startsWith("doc_")) return json(route, 404, { _tag: "NotFound", message: `No ${kind === "pay_stub" ? "paycheck" : "document"} ${id}` });
      const polls = renders.get(u.pathname) ?? 0;
      renders.set(u.pathname, polls + 1);
      if (polls < h.pdfRenderPolls) return json(route, 202, { status: "rendering", retryAfterS: 5 }, { "retry-after": "5", "cache-control": "no-store" });
      return route.fulfill({ status: 200, headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${kind}-${id}.pdf"`, "x-weft-pdf": "cached" }, body: Buffer.from("%PDF-1.4\n%stand-in\n") });
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
