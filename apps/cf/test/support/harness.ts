// The Miniflare suite's harness (design 11.4): wrangler's createTestHarness running both Workers from the real
// wrangler configs, rewritten for a local run. The rewrite points weft-core at the test entry (fake engine) or the
// real one, swaps the bindings Miniflare does not emulate locally (Workers AI, Vectorize, Browser Run) for the fakes
// worker, uses Turnstile's published test secret against a local siteverify stub (siteverify-stub.ts, so the suite
// needs no network), a test origin and random secrets, and serves a small assets directory. Everything else (Durable
// Objects across scripts, the Workflow, queues, KV, D1, R2, the Rate Limiting bindings, the cron trigger and the
// service binding) is exactly what the configs declare.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { createTestHarness, type TestHarness, type WorkerHandle } from "wrangler";
import { signAdmin, signSmoke } from "../../src/shared/tokens";
import { SiteverifyStub } from "./siteverify-stub";
import { CF_DIR, REPO } from "./config-files";
import { writeLocalConfigs } from "../../../../scripts/cf/lib/configs";
import { applyLocalD1 } from "../../../../scripts/cf/lib/d1-local";
import type { CoreEnv } from "../../src/shared/env";

export { CF_DIR, REPO };

/** The test origin. The harness serves plain HTTP and rewrites https URLs (and Origin) to http, so the origin is http. */
export const ORIGIN = "http://weft.test";
/** Cloudflare's published Turnstile test secrets and the dummy token their test sitekeys produce. */
export const TURNSTILE = {
  passSecret: "1x0000000000000000000000000000000AA",
  failSecret: "2x0000000000000000000000000000000AA",
  passSitekey: "1x00000000000000000000AA",
  dummyToken: "XXXX.DUMMY.TOKEN.XXXX",
} as const;

export interface HarnessOptions {
  engine?: "fake" | "real";
  poolSize?: number;
  turnstileSecret?: string;
  coreVars?: Record<string, string>;
  frontVars?: Record<string, string>;
  assets?: Record<string, string>;
  /** Extra run_worker_first patterns (the [id] shell fallback case). */
  runWorkerFirst?: string[];
  /** Verify against Cloudflare's real siteverify instead of the local stub (the one opt-in network case). */
  realSiteverify?: boolean;
}

export interface Secrets { session: string; ctx: string; proxy: string; smoke: string; admin: string; vault: string }

let seq = 0;

export class CookieJar {
  readonly cookies = new Map<string, string>();
  absorb(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";");
      const i = pair!.indexOf("=");
      const name = pair!.slice(0, i).trim();
      const value = pair!.slice(i + 1).trim();
      const maxAge = attrs.map((a) => a.trim()).find((a) => a.toLowerCase().startsWith("max-age="));
      if (maxAge && Number(maxAge.split("=")[1]) <= 0) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

export interface RequestOpts { ip?: string; jar?: CookieJar; origin?: string | null; principal?: string }

export class Harness {
  front!: WorkerHandle;
  core!: WorkerHandle;
  private constructor(readonly server: TestHarness, readonly secrets: Secrets, readonly dir: string, readonly siteverify: SiteverifyStub | null) {}

  static async start(o: HarnessOptions = {}): Promise<Harness> {
    const id = `${process.pid}-${++seq}-${Date.now().toString(36)}`;
    const siteverify = o.realSiteverify ? null : await SiteverifyStub.start();
    const dir = join(REPO, ".scratch", "cf4-worker", "harness", id);
    mkdirSync(join(dir, "assets"), { recursive: true });
    const rand = () => randomBytes(32).toString("hex");
    const secrets: Secrets = { session: rand(), ctx: rand(), proxy: rand(), smoke: rand(), admin: rand(), vault: rand() };
    const assets = o.assets ?? { "index.html": "<!doctype html><title>Weft</title>home", "app/people/_/index.html": "people shell", "app/people/_/index.txt": "people rsc", "404.html": "not found" };
    for (const [p, body] of Object.entries(assets)) { mkdirSync(dirname(join(dir, "assets", p)), { recursive: true }); writeFileSync(join(dir, "assets", p), body); }

    const paths = writeLocalConfigs({
      dir, engine: o.engine ?? "fake", origin: ORIGIN, poolSize: o.poolSize, assetsDir: join(dir, "assets"),
      runWorkerFirst: o.runWorkerFirst, coreVars: o.coreVars, configMemoMs: 200,
      frontVars: { ...(siteverify ? { TURNSTILE_VERIFY_URL: siteverify.url } : {}), ...o.frontVars },
    });

    const shared = { WEFT_SESSION_SECRET: secrets.session, WEFT_CTX_SECRET: secrets.ctx, WEFT_PROXY_SECRET: secrets.proxy };
    const server = createTestHarness({
      root: dir,
      workers: [
        { configPath: paths.front, secrets: { ...shared, TURNSTILE_SECRET: o.turnstileSecret ?? TURNSTILE.passSecret, WEFT_SMOKE_TOKEN: secrets.smoke, WEFT_ADMIN_TOKEN: secrets.admin } },
        { configPath: paths.core, secrets: { ...shared, WEFT_VAULT_KEY: secrets.vault } },
        { configPath: paths.fakes },
      ],
    });
    await server.listen();
    const h = new Harness(server, secrets, dir, siteverify);
    h.front = server.getWorker("weft");
    h.core = server.getWorker("weft-core");
    // weft-ops: Miniflare creates the D1 database empty (the extras' job ledger and run catalog live there).
    await applyLocalD1((await h.coreEnv()).OPS as never);
    return h;
  }

  /** weft-core's bindings, proxied into the test process (Durable Object RPC, KV, queues). */
  async coreEnv(): Promise<CoreEnv> {
    return (await this.core.getEnv()) as unknown as CoreEnv;
  }

  async close(): Promise<void> {
    try { await this.server.close(); } finally {
      rmSync(this.dir, { recursive: true, force: true });
      await this.siteverify?.close();
    }
  }

  /** A request to the front Worker as a browser would send it (Origin set on mutations, the jar's cookies). */
  async fetch(path: string, init: RequestInit = {}, o: RequestOpts = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("cf-connecting-ip", o.ip ?? "203.0.113.10");
    const method = (init.method ?? "GET").toUpperCase();
    if (o.origin !== null && method !== "GET" && method !== "HEAD") headers.set("origin", o.origin ?? ORIGIN);
    if (o.jar?.cookies.size) headers.set("cookie", o.jar.header());
    if (o.principal) headers.set("x-weft-principal", o.principal);
    if (init.body && !headers.has("content-type") && typeof init.body === "string") headers.set("content-type", "application/json");
    const res = await this.server.fetch(`${ORIGIN}${path}`, { ...init, headers, redirect: "manual" } as never) as unknown as Response;
    o.jar?.absorb(res);
    return res;
  }

  async admin(method: string, path: string, body?: unknown): Promise<Response> {
    const text = body === undefined ? "" : JSON.stringify(body);
    const sig = await signAdmin({ token: this.secrets.admin, method, path, body: text });
    return this.fetch(path, { method, body: text || undefined, headers: { "x-weft-admin": sig, ...(text ? { "content-type": "application/json" } : {}) } }, { origin: null });
  }

  async smokeHeaders(): Promise<Record<string, string>> {
    return { "x-weft-smoke": await signSmoke(this.secrets.smoke) };
  }

  /** POST /api/_admin/provision and wait until every world is ready (the fake engine restores in a second). */
  async provision(timeoutMs = 60_000): Promise<OpsSlots> {
    const r = await this.admin("POST", "/api/_admin/provision", {});
    if (r.status !== 200) throw new Error(`provision answered ${r.status}: ${await r.text()}`);
    return this.waitReady(timeoutMs);
  }

  async ops(): Promise<{ lobby: { slots: OpsSlots; leases: { slot: string; gen: number }[]; usage: Record<string, number>; readout: { level: number; leases: { active: number } } }; spend: unknown }> {
    const r = await this.admin("GET", "/api/_admin/ops");
    if (r.status !== 200) throw new Error(`ops answered ${r.status}`);
    return r.json() as never;
  }

  async waitReady(timeoutMs = 60_000, names?: string[]): Promise<OpsSlots> {
    const t0 = Date.now();
    for (;;) {
      const { lobby } = await this.ops();
      const want = names ? lobby.slots.filter((s) => names.includes(s.name)) : lobby.slots;
      if (want.length && want.every((s) => s.state === "ready")) return lobby.slots;
      if (want.some((s) => s.state === "failed")) throw new Error(`a world failed to restore: ${JSON.stringify(want)}`);
      if (Date.now() - t0 > timeoutMs) throw new Error(`worlds not ready after ${timeoutMs} ms: ${JSON.stringify(want)}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /** A visitor with its own cookie jar and IP. */
  visitor(ip = `198.51.100.${Math.floor(Math.random() * 200) + 20}`): Visitor {
    return new Visitor(this, ip);
  }
}

export type OpsSlots = { name: string; mode: string; gen: number; state: string; snapshot: string | null; error: string | null }[];

export class Visitor {
  readonly jar = new CookieJar();
  constructor(readonly h: Harness, readonly ip: string) {}
  fetch(path: string, init: RequestInit = {}, o: Omit<RequestOpts, "jar" | "ip"> = {}): Promise<Response> {
    return this.h.fetch(path, init, { ...o, ip: this.ip, jar: this.jar });
  }
  /** POST /api/_session/lease with the dummy token. A refusal (a failed siteverify above all) fails the case here. */
  async lease(): Promise<{ status: string; slot?: string; gen?: number; position?: number }> {
    const r = await this.fetch("/api/_session/lease", { method: "POST", body: JSON.stringify({ token: TURNSTILE.dummyToken }) });
    if (!r.ok) {
      const text = await r.text();
      const via = this.h.siteverify ? `the siteverify stub (${this.h.siteverify.calls.at(-1)?.secretKind ?? "not called"})` : "Cloudflare's siteverify";
      throw new Error(`lease answered ${r.status} ${text.slice(0, 200)}; Turnstile was checked against ${via}`);
    }
    return r.json() as never;
  }
  json<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T; res: Response }> {
    return this.fetch(path, init).then(async (res) => ({ status: res.status, body: (await res.json().catch(() => null)) as T, res }));
  }
}
