// Fixtures for the hosted Playwright checks (playwright.cf.config.ts), track cf7-integrate.
//
// - `target`: the project's origin, kind (local or deployed) and signers (auth.ts; tokens never leave it).
// - `operator`: the operator lease (POST /api/_admin/lease, design 6.2 step 7) taken through the browser context's own
//   request context, so the session and grant cookies land in the browser exactly as a Turnstile lease sets them.
//   Asking again returns the same slot with fresh cookies, so every test that uses it starts with a fresh grant. The
//   lease's world gets the scripted provider (PUT /api/_hosted/model) unless WEFT_CF_LIVE=1, so no check spends.
//   `operator.world` is a WorldApi over that same request context (Origin on mutations, the principal header, one
//   grant refresh on a 428), for reading figures back.
// - `consoleErrors`: console errors, page errors and failed responses, as the tour specs collect them.
// - `trackMutations` (automatic): the browser's own mutations go into world.ts's RL_MUTATE log.
import { test as base, expect, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { ADMIN_HEADER, signers, targetKind, tokensFile, type Signers, type TargetKind } from "./auth";
import { BaseWorld, HttpError, MUTATION, noteMutation, type RequestOptions, type WorldApi, type WorldResponse } from "./world";

export { expect };

export interface Target { origin: string; kind: TargetKind; sign: Signers; live: boolean }
export interface LeaseInfo { status: string; slot: string; gen: number; expiresAt: string; idleExpiresAt: string; resetsLeft: number; operator: string }

/** The operator lease name every spec shares, so a run holds one pool slot (WEFT_CF_OPERATOR overrides it). */
export const OPERATOR = process.env.WEFT_CF_OPERATOR ?? "e2e";
export const LIVE = process.env.WEFT_CF_LIVE === "1";

/** A WorldApi over Playwright's request context (it shares the browser context's cookies). */
export class PwWorld extends BaseWorld implements WorldApi {
  constructor(readonly api: APIRequestContext, readonly origin: string, private readonly sign: Signers, readonly label: string, private readonly operator: string | null) { super(); }

  protected async send<T>(method: string, path: string, body: unknown, o: RequestOptions): Promise<WorldResponse<T>> {
    const headers: Record<string, string> = { accept: "application/json", ...o.headers };
    if (o.principal !== null) headers["x-weft-principal"] = o.principal ?? "usr_dana";
    if (MUTATION.test(method)) headers.origin = this.origin;
    const res = await this.api.fetch(`${this.origin}${path}`, {
      method, headers, maxRedirects: 0, timeout: o.timeoutMs ?? 90_000,
      ...(body !== undefined && method !== "GET" ? { data: body as never } : {}),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    const h = res.headers();
    return { status: res.status(), body: parsed as T, header: (n) => h[n.toLowerCase()] ?? null, text };
  }

  protected override async refreshOn428(): Promise<boolean> {
    if (!this.operator) return false;
    await operatorGrant(this.api, this.origin, this.sign, this.operator);
    return true;
  }
}

async function admin(request: APIRequestContext, origin: string, sign: Signers, path: string, body: unknown) {
  const text = JSON.stringify(body);
  return request.fetch(`${origin}${path}`, { method: "POST", data: text, headers: { "content-type": "application/json", [ADMIN_HEADER]: await sign.admin("POST", path, text) }, maxRedirects: 0 });
}

/** POST /api/_admin/lease through `request` (the cookies land in its context). */
export async function operatorLease(request: APIRequestContext, origin: string, sign: Signers, name = OPERATOR): Promise<LeaseInfo> {
  const res = await admin(request, origin, sign, "/api/_admin/lease", { name });
  const body = (await res.json().catch(() => null)) as LeaseInfo | null;
  if (res.status() !== 200 || !body) throw new HttpError(res.status(), null, "POST", "/api/_admin/lease", JSON.stringify(body));
  if (body.status !== "leased") throw new Error(`the operator lease "${name}" was not granted: ${JSON.stringify(body)} (the pool is full, this address used its leases, or the day's budget closed leasing)`);
  return body;
}

/** POST /api/_admin/grant: a fresh human grant for the operator lease whose session cookie `request` holds. */
export async function operatorGrant(request: APIRequestContext, origin: string, sign: Signers, name = OPERATOR): Promise<void> {
  const res = await admin(request, origin, sign, "/api/_admin/grant", { name });
  if (res.status() !== 200) throw new HttpError(res.status(), null, "POST", "/api/_admin/grant", await res.text());
}

/** The provider for new runs in the lease's world: scripted unless WEFT_CF_LIVE=1 (then the default). */
export async function pinProvider(world: WorldApi): Promise<void> {
  await world.put("/api/_hosted/model", { provider: LIVE ? null : "scripted" });
  const s = await world.get<{ provider: { id: string; reason: string } }>("/api/_session");
  if (!LIVE && s.provider.id !== "scripted") throw new Error(`the lease's world reports provider ${s.provider.id} (${s.provider.reason}) after the switch to scripted`);
}

export function targetFor(baseURL: string | undefined): Target {
  if (!baseURL) throw new Error("the project has no baseURL (playwright.cf.config.ts)");
  const origin = baseURL.replace(/\/$/, "");
  const kind = targetKind(origin);
  return { origin, kind, sign: signers(tokensFile(kind)), live: LIVE };
}

export interface OperatorFixture { lease: LeaseInfo; world: PwWorld; context: BrowserContext }

/** Every mutation a browser context sends counts against RL_MUTATE too (world.ts mutationHeadroom). */
export function trackMutations(context: BrowserContext): void {
  context.on("request", (r) => { if (MUTATION.test(r.method()) && new URL(r.url()).pathname.startsWith("/api/")) noteMutation(); });
}

export const test = base.extend<{ target: Target; operator: OperatorFixture; consoleErrors: string[]; trackMutations: void }>({
  target: async ({ baseURL }, use) => { await use(targetFor(baseURL)); },
  operator: async ({ page, target }, use) => {
    const context = page.context();
    const lease = await operatorLease(context.request, target.origin, target.sign);
    const world = new PwWorld(context.request, target.origin, target.sign, `${lease.slot} (operator lease ${OPERATOR})`, OPERATOR);
    await pinProvider(world);
    await use({ lease, world, context });
  },
  trackMutations: [async ({ context }, use) => { trackMutations(context); await use(); }, { auto: true }],
  consoleErrors: async ({ page }, use) => {
    const errs: string[] = [];
    page.on("console", (m) => { if (m.type() === "error" && !/\/favicon\.ico$/.test(m.location().url)) errs.push(m.text()); });
    page.on("pageerror", (e) => errs.push(`pageerror: ${e.message}`));
    page.on("response", (r) => { const u = new URL(r.url()); if (r.status() >= 400 && u.pathname !== "/favicon.ico") errs.push(`response ${r.status()} ${r.request().method()} ${u.pathname}${u.search}`); });
    await use(errs);
  },
});

/** The world the tab reads once the hosted shell has read the session, from the banner's hidden marker (a leased
 * world shows no banner unless there is something to say). */
export async function bannerWorld(page: Page): Promise<string | null> {
  const marker = page.getByTestId("hosted-world");
  await expect(marker).toBeAttached({ timeout: 30_000 });
  return marker.getAttribute("data-world");
}
