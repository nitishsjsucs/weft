// How the hosted checks talk to one world (track cf7-integrate). The scenarios (scenarios.ts) and the smoke
// (scripts/cf/smoke.ts) only see WorldApi; two clients implement it over plain fetch:
//
// - SmokeWorld: every request carries a fresh x-weft-smoke signature, so it reaches slot-smoke (scripted provider,
//   never leased) and skips RL_API (design 6.3);
// - OperatorWorld: the operator lease (POST /api/_admin/lease, design 6.2 step 7) of a pool slot, with its session and
//   grant cookies in a jar, Origin on mutations as a browser sends it, and one grant refresh (POST /api/_admin/grant)
//   when a mutation answers 428. It never solves a Turnstile challenge.
//
// fixtures.ts builds the same WorldApi over Playwright's request context, so the browser and the API share cookies.
//
// Rate limits. Every check comes from one address, and RL_MUTATE allows 30 mutations per 60 s per IP hash (smoke
// visits included). Each client therefore records its mutations (and fixtures.ts the browser's) in one log per
// process; mutationHeadroom(n) waits until n more fit in the trailing 60 s, and a 429 RATE_LIMITED is retried after its
// retryAfterS (at most twice), as a person would wait.
import { HOSTED_RATE_LIMITS } from "../../packages/contracts/src/ext/cf-hosted";
import { ADMIN_HEADER, SMOKE_HEADER, type Signers } from "./auth";

export interface WorldResponse<T = unknown> { status: number; body: T; header(name: string): string | null; text: string }
export interface RequestOptions { principal?: string | null; headers?: Record<string, string>; timeoutMs?: number }

export interface WorldApi {
  /** For messages: "slot-smoke (smoke header)", "slot-1 (operator lease e2e)". */
  readonly label: string;
  readonly origin: string;
  request<T = unknown>(method: string, path: string, body?: unknown, o?: RequestOptions): Promise<WorldResponse<T>>;
  /** GET that throws on a status outside 2xx. */
  get<T = unknown>(path: string, o?: RequestOptions): Promise<T>;
  /** POST JSON that throws on a status outside 2xx. */
  post<T = unknown>(path: string, body?: unknown, o?: RequestOptions): Promise<T>;
  put<T = unknown>(path: string, body?: unknown, o?: RequestOptions): Promise<T>;
}

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string | null, readonly method: string, readonly path: string, text: string) {
    super(`${method} ${path} answered ${status}${code ? ` ${code}` : ""}: ${text.slice(0, 300)}`);
    this.name = "HttpError";
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const MUTATION = /^(POST|PUT|PATCH|DELETE)$/i;
const codeOf = (body: unknown): string | null => (body && typeof body === "object" && typeof (body as { code?: unknown }).code === "string" ? (body as { code: string }).code : null);

// ---- the mutation log ---------------------------------------------------------------------------------------------

const RL_MUTATE_MS = HOSTED_RATE_LIMITS.RL_MUTATE.period * 1000;
const mutations: number[] = [];
export function noteMutation(at = Date.now()): void {
  mutations.push(at);
  while (mutations.length && mutations[0]! < at - RL_MUTATE_MS) mutations.shift();
}
/** Waits until `n` more mutations fit under RL_MUTATE in the trailing window (this process's own count). */
export async function mutationHeadroom(n: number, limit: number = HOSTED_RATE_LIMITS.RL_MUTATE.limit): Promise<number> {
  const t0 = Date.now();
  for (;;) {
    const now = Date.now();
    while (mutations.length && mutations[0]! < now - RL_MUTATE_MS) mutations.shift();
    if (mutations.length + n <= limit) return now - t0;
    await sleep(Math.max(250, mutations[0]! + RL_MUTATE_MS - now + 250));
  }
}

// ---- clients ------------------------------------------------------------------------------------------------------

/** Shared by every WorldApi: the rate-limit handling and get, post and put on top of request. */
export abstract class BaseWorld {
  protected abstract send<T>(method: string, path: string, body: unknown, o: RequestOptions): Promise<WorldResponse<T>>;
  /** A 428 TURNSTILE_REQUIRED: refresh the grant and answer true to retry once (operator worlds only). */
  protected async refreshOn428(): Promise<boolean> { return false; }

  async request<T = unknown>(method: string, path: string, body?: unknown, o: RequestOptions = {}): Promise<WorldResponse<T>> {
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      if (MUTATION.test(method)) noteMutation();
      const r = await this.send<T>(method, path, body, o);
      const code = codeOf(r.body);
      if (r.status === 429 && code === "RATE_LIMITED" && attempt < 2) {
        const wait = Math.min(61, Number((r.body as { retryAfterS?: number }).retryAfterS ?? 60)) * 1000;
        await sleep(wait);
        continue;
      }
      if (r.status === 428 && code === "TURNSTILE_REQUIRED" && !refreshed && (await this.refreshOn428())) { refreshed = true; continue; }
      return r;
    }
  }
  private async ok<T>(method: string, path: string, body: unknown, o?: RequestOptions): Promise<T> {
    const r = await this.request<T>(method, path, body, o);
    if (r.status < 200 || r.status > 299) throw new HttpError(r.status, codeOf(r.body), method, path, r.text);
    return r.body;
  }
  get<T = unknown>(path: string, o?: RequestOptions): Promise<T> { return this.ok<T>("GET", path, undefined, o); }
  post<T = unknown>(path: string, body: unknown = {}, o?: RequestOptions): Promise<T> { return this.ok<T>("POST", path, body, o); }
  put<T = unknown>(path: string, body: unknown = {}, o?: RequestOptions): Promise<T> { return this.ok<T>("PUT", path, body, o); }
}

export class CookieJar {
  readonly cookies = new Map<string, string>();
  absorb(setCookies: string[]): void {
    for (const line of setCookies) {
      const [pair, ...attrs] = line.split(";");
      const i = pair!.indexOf("=");
      if (i < 0) continue;
      const name = pair!.slice(0, i).trim();
      const value = pair!.slice(i + 1).trim();
      const maxAge = attrs.map((a) => a.trim()).find((a) => a.toLowerCase().startsWith("max-age="));
      if ((maxAge && Number(maxAge.split("=")[1]) <= 0) || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header(): string { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "); }
  /** Values are never printed; the 428 check drops the grant. */
  drop(name: string): void { this.cookies.delete(name); }
}

async function parse<T>(res: Response): Promise<WorldResponse<T>> {
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: res.status, body: body as T, header: (n) => res.headers.get(n), text };
}

/** A request to the front Worker from Node: Origin on mutations, the principal header, a timeout. */
export async function frontFetch(origin: string, method: string, path: string, body: unknown, headers: Record<string, string>, o: RequestOptions = {}): Promise<Response> {
  const h: Record<string, string> = { accept: "application/json", ...headers, ...o.headers };
  if (o.principal !== null) h["x-weft-principal"] = o.principal ?? "usr_dana";
  if (MUTATION.test(method)) h.origin = origin;
  let payload: BodyInit | undefined;
  if (body !== undefined && method !== "GET") {
    if (body instanceof Uint8Array || typeof body === "string") payload = body as BodyInit;
    else { payload = JSON.stringify(body); h["content-type"] ??= "application/json"; }
  }
  return fetch(`${origin}${path}`, { method, headers: h, body: payload, redirect: "manual", signal: AbortSignal.timeout(o.timeoutMs ?? 90_000) });
}

/** An /api/_admin/* call signed with the admin token (method, path, timestamp and body). */
export async function adminFetch(origin: string, sign: Signers, method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Response> {
  const text = body === undefined ? "" : JSON.stringify(body);
  const headers: Record<string, string> = { [ADMIN_HEADER]: await sign.admin(method, path, text), ...extra };
  if (text) headers["content-type"] = "application/json";
  return fetch(`${origin}${path}`, { method, headers, body: text || undefined, redirect: "manual", signal: AbortSignal.timeout(60_000) });
}

export class SmokeWorld extends BaseWorld implements WorldApi {
  readonly label = "slot-smoke (smoke header)";
  constructor(readonly origin: string, private readonly sign: Signers) { super(); }
  protected async send<T>(method: string, path: string, body: unknown, o: RequestOptions): Promise<WorldResponse<T>> {
    return parse<T>(await frontFetch(this.origin, method, path, body, { [SMOKE_HEADER]: await this.sign.smoke() }, o));
  }
}

export interface OperatorLease { status: string; slot?: string; gen?: number; expiresAt?: string; resetsLeft?: number; operator?: string; position?: number; poolSize?: number }

export class OperatorWorld extends BaseWorld implements WorldApi {
  readonly jar = new CookieJar();
  lease: OperatorLease | null = null;
  label: string;
  /** False for the 428 check, which drops the grant on purpose. */
  refreshGrants = true;
  constructor(readonly origin: string, private readonly sign: Signers, readonly name: string) { super(); this.label = `no slot yet (operator lease ${name})`; }

  /** POST /api/_admin/lease { name }: the same slot and generation while the lease lasts, with fresh cookies. */
  async start(): Promise<OperatorLease> {
    const res = await adminFetch(this.origin, this.sign, "POST", "/api/_admin/lease", { name: this.name });
    this.jar.absorb(res.headers.getSetCookie());
    const r = await parse<OperatorLease>(res);
    if (r.status !== 200) throw new HttpError(r.status, codeOf(r.body), "POST", "/api/_admin/lease", r.text);
    this.lease = r.body;
    this.label = `${r.body.slot ?? "no slot"} (operator lease ${this.name})`;
    return r.body;
  }

  /** POST /api/_admin/grant { name } with the lease's session cookie: a fresh human grant only. */
  async refreshGrant(): Promise<void> {
    const res = await adminFetch(this.origin, this.sign, "POST", "/api/_admin/grant", { name: this.name }, { cookie: this.jar.header() });
    this.jar.absorb(res.headers.getSetCookie());
    if (res.status !== 200) { const r = await parse(res); throw new HttpError(r.status, codeOf(r.body), "POST", "/api/_admin/grant", r.text); }
  }

  protected override async refreshOn428(): Promise<boolean> {
    if (!this.refreshGrants) return false;
    await this.refreshGrant();
    return true;
  }

  protected async send<T>(method: string, path: string, body: unknown, o: RequestOptions): Promise<WorldResponse<T>> {
    const res = await frontFetch(this.origin, method, path, body, this.jar.cookies.size ? { cookie: this.jar.header() } : {}, o);
    this.jar.absorb(res.headers.getSetCookie());
    return parse<T>(res);
  }
}

/** A plain visitor with no lease (the showcase), from Node. */
export class AnonWorld extends BaseWorld implements WorldApi {
  readonly label = "showcase (no lease)";
  constructor(readonly origin: string) { super(); }
  protected async send<T>(method: string, path: string, body: unknown, o: RequestOptions): Promise<WorldResponse<T>> {
    return parse<T>(await frontFetch(this.origin, method, path, body, {}, o));
  }
}

/** Polls fn until ok(value), or throws with the last value after ms. */
export async function until<T>(what: string, fn: () => Promise<T>, ok: (v: T) => boolean, ms = 60_000, every = 500): Promise<T> {
  const t0 = Date.now();
  let last: T | undefined;
  for (;;) {
    last = await fn();
    if (ok(last)) return last;
    if (Date.now() - t0 > ms) throw new Error(`${what}: not met within ${Math.round(ms / 1000)} s; last ${JSON.stringify(last).slice(0, 400)}`);
    await sleep(every);
  }
}
