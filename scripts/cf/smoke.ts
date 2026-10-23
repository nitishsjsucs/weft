// pnpm cf:smoke (docs/cloudflare/design.md 11.6; track cf7-integrate): the deployed smoke list against one origin.
//
//   pnpm cf:smoke --url https://weft.nitish-ratakonda.workers.dev [--live] [--no-tour] [--only <id or prefix,...>]
//                 [--tokens <file>] [--operator <lease name, default smoke>]
//   pnpm cf:smoke --url http://localhost:5800          (the local stack, e2e/cf/local-stack.ts; through the e2e lock)
//
// Every check prints one line: PASS, FAIL, SKIPPED (cannot run on this target, with the reason) or DELEGATED (the smoke
// cannot measure it from outside; pnpm cf:budget's GraphQL query does: invocation counts, CPU, rows written, the
// gateway's cache; and the Workers Logs secret grep, which no script does yet, contract request cf7 item 5). The exit
// code is 1 when any gating check fails. The limiter burst is recorded but not gating (design 6.3: the Rate Limiting
// binding is per location and loose); a miss prints FAIL*.
//
// How it reaches the worlds. Smoke calls carry the x-weft-smoke HMAC (WEFT_SMOKE_TOKEN), so they reach slot-smoke with
// the provider forced to scripted, spend $0 and skip RL_API. What needs a leased pool slot (the 428 check, scenario 8's
// MCP key, the guided tour) takes the operator lease "smoke" (POST /api/_admin/lease, WEFT_ADMIN_TOKEN), never a
// Turnstile challenge, with the scripted provider pinned on its world. The checks that must look like a stranger (an
// unleased mutation, the showcase isolation and GET sweep, the limiter burst) are unsigned, and the burst (RL_API's
// limit plus 100 GETs to /api/_no_such_route) runs last. The tokens are read with awk from the cf secrets file
// (deployed) or the local stack's state dir (localhost), or --tokens; they are never printed (e2e/cf/auth.ts).
//
// The guided tour runs in a browser: the smoke runs Playwright's `deployed` project (playwright.cf.config.ts) on
// e2e/cf/cf-tour.spec.ts against the same origin and reads the measured time back. `--live` (Nitish's opt-in) runs that
// one tour on the demo's default provider (Luna through AI Gateway, $0.003 to $0.005 inside the caps); everything else
// stays scripted.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HOSTED_RATE_LIMITS } from "../../packages/contracts/src/ext/cf-hosted";
import { ROUTES } from "../../packages/contracts/src/api";
import { LOCAL, REPO_ROOT, signers, targetKind, tokensFile, type Signers, type TargetKind } from "../../e2e/cf/auth";
import { pending, resetWorld, SCENARIOS, type ScenarioContext } from "../../e2e/cf/scenarios";
import { adminFetch, AnonWorld, OperatorWorld, SmokeWorld, sleep, until, type WorldApi } from "../../e2e/cf/world";

export type Status = "pass" | "fail" | "skipped" | "delegated";
export interface Result { id: string; status: Status; detail: string; gating: boolean; ms: number }

export interface SmokeOptions { url: string; live: boolean; tour: boolean; only: Set<string> | null; tokens: string | null; operator: string }

export function parseArgs(argv: string[]): SmokeOptions {
  const arg = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] ?? null : null; };
  const url = (arg("--url") ?? process.env.WEFT_CF_URL ?? "").replace(/\/$/, "");
  if (!/^https?:\/\/[^/]+$/.test(url)) throw new Error("--url takes the origin to check, for example https://weft.nitish-ratakonda.workers.dev or http://localhost:5800");
  const only = arg("--only");
  return { url, live: argv.includes("--live"), tour: !argv.includes("--no-tour"), only: only ? new Set(only.split(",").map((s) => s.trim()).filter(Boolean)) : null, tokens: arg("--tokens"), operator: arg("--operator") ?? "smoke" };
}

/** One line per result, as printed. */
export function formatResult(r: Result): string {
  const tag = r.status === "fail" && !r.gating ? "FAIL*" : r.status.toUpperCase();
  return `${tag.padEnd(10)}${r.id.padEnd(30)}${r.detail} (${(r.ms / 1000).toFixed(1)} s)`;
}

export function summarize(results: Result[]): { line: string; failed: boolean } {
  const n = (s: Status) => results.filter((r) => r.status === s).length;
  const ungated = results.filter((r) => r.status === "fail" && !r.gating).length;
  const failed = results.some((r) => r.status === "fail" && r.gating);
  return { line: `cf:smoke: ${n("pass")} pass, ${n("fail")} fail${ungated ? ` (${ungated} not gating, marked FAIL*)` : ""}, ${n("skipped")} skipped, ${n("delegated")} delegated`, failed };
}

class Skip extends Error {}
class Delegate extends Error {}
const skip = (why: string): never => { throw new Skip(why); };
const delegate = (why: string): never => { throw new Delegate(why); };
const ensure = (ok: unknown, message: string): void => { if (!ok) throw new Error(message); };

interface Env {
  o: SmokeOptions; kind: TargetKind; sign: Signers;
  smoke: SmokeWorld; anon: AnonWorld; op: OperatorWorld;
}

type Check = { id: string; gating?: boolean; run(e: Env): Promise<string> };

const BUDGET = "pnpm cf:budget (scripts/cf/with-cf.sh pnpm cf:budget --url <origin>)";

async function admin<T>(e: Env, method: string, path: string, body?: unknown): Promise<T> {
  const res = await adminFetch(e.o.url, e.sign, method, path, body);
  const text = await res.text();
  if (res.status !== 200) throw new Error(`${method} ${path} answered ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text) as T;
}

async function html(e: Env, path: string): Promise<Response> {
  const res = await fetch(`${e.o.url}${path}`, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
  return res;
}

/** True when the operator's world still looks as restored (the tour's own preflight rule). */
async function freshWorld(w: WorldApi): Promise<boolean> {
  const [clock, notices, props] = await Promise.all([
    w.get<{ now: string }>("/api/v1/sim/clock"), w.get<{ data: { formCode?: string }[] }>("/api/v1/notices?limit=100"), pending(w),
  ]);
  return clock.now === "2026-10-26T15:30:00.000Z" && !notices.data.some((n) => /DE ?2088/i.test(n.formCode ?? "")) && !props.some((p) => p.command === "tax.update_rate");
}

const PLATFORM: Check[] = [
  {
    id: "platform.assets",
    async run(e) {
      const out: string[] = [];
      for (const p of ["/", "/app/"]) {
        const r = await html(e, p);
        ensure(r.status === 200 && (r.headers.get("content-type") ?? "").includes("text/html"), `${p} answered ${r.status} ${r.headers.get("content-type")}`);
        ensure((await r.text()).includes("<html"), `${p} is not an HTML page`);
        out.push(`${p} 200`);
      }
      return `${out.join(", ")} (static assets; the zero invocation count is platform.invocations)`;
    },
  },
  { id: "platform.invocations", async run() { return delegate(`${BUDGET}: the GraphQL invocation count is unchanged by / and /app/`); } },
  {
    id: "platform.deep-link",
    async run(e) {
      const r = await html(e, "/app/people/wrk_0026/");
      ensure(r.status === 200, `/app/people/wrk_0026/ answered ${r.status}`);
      const shell = await r.text();
      ensure(shell.includes("<html"), "the deep link is not the people shell's HTML");
      const lena = await e.anon.get<{ name?: string; firstName?: string; lastName?: string }>("/api/v1/workers/wrk_0026");
      ensure(JSON.stringify(lena).includes("Lena Brooks (demo)"), "the showcase API does not name wrk_0026 Lena Brooks (demo)");
      return "/app/people/wrk_0026/ serves the people shell and its API read names Lena Brooks (demo) (rendered in the browser by cf-shell.spec.ts)";
    },
  },
  {
    id: "platform.csp",
    async run(e) {
      const r = await html(e, "/app/");
      const csp = r.headers.get("content-security-policy") ?? "";
      ensure(/default-src 'self'/.test(csp) && /frame-ancestors 'none'/.test(csp), `CSP on /app/: "${csp.slice(0, 160)}"`);
      ensure(r.headers.get("x-content-type-options") === "nosniff", "x-content-type-options is not nosniff");
      ensure((r.headers.get("referrer-policy") ?? "") === "same-origin", `referrer-policy is "${r.headers.get("referrer-policy")}"`);
      return "content-security-policy with default-src 'self' and frame-ancestors 'none', nosniff, same-origin referrer";
    },
  },
  {
    id: "platform.health",
    async run(e) {
      const h = await e.smoke.get<{ runtime: string; seedProfile: string; world: { slot: string; gen: number; mode: string } }>("/api/v1/health");
      ensure(h.runtime === "cloudflare" && h.seedProfile === "rich" && h.world?.slot === "slot-smoke" && Number.isInteger(h.world.gen), `health: ${JSON.stringify({ runtime: h.runtime, seedProfile: h.seedProfile, world: h.world })}`);
      return `runtime cloudflare, profile rich, ${h.world.slot} generation ${h.world.gen}`;
    },
  },
  {
    id: "platform.unleased-409",
    async run(e) {
      const r = await e.anon.request<{ code?: string }>("POST", "/api/v1/sim/clock/advance", { by: "P1D" });
      ensure(r.status === 409 && r.body?.code === "LEASE_REQUIRED", `an unleased mutation answered ${r.status} ${r.body?.code ?? r.text.slice(0, 100)}`);
      return "an unleased mutation answers 409 LEASE_REQUIRED";
    },
  },
  {
    id: "platform.no-grant-428",
    async run(e) {
      // The same operator lease with fresh cookies, minus the human grant. The mutation is harmless if it got through.
      const w = new OperatorWorld(e.o.url, e.sign, e.o.operator);
      await w.start();
      w.refreshGrants = false;
      w.jar.drop("__Host-weft-h");
      const r = await w.request<{ code?: string }>("PUT", "/api/_hosted/model", { provider: "scripted" });
      ensure(r.status === 428 && r.body?.code === "TURNSTILE_REQUIRED", `a mutation without the grant answered ${r.status} ${r.body?.code ?? r.text.slice(0, 100)}`);
      return `a mutation on ${w.lease?.slot} without the human grant answers 428 TURNSTILE_REQUIRED`;
    },
  },
  {
    id: "platform.conformance",
    async run(e) {
      const r = await admin<{ passed: number; failed: number; cases: { name: string; ok: boolean; skipped?: boolean; detail?: string }[] }>(e, "POST", "/api/_admin/conformance", {});
      const bad = r.cases.filter((c) => !c.ok);
      ensure(bad.length === 0, `conformance failures: ${bad.map((c) => `${c.name}: ${c.detail ?? ""}`).join("; ")}`);
      return `${r.passed} of ${r.cases.length} transaction conformance cases passed, ${r.cases.filter((c) => c.skipped).length} skipped by design`;
    },
  },
  {
    id: "platform.gateway-cache",
    async run(e) {
      if (e.kind === "local") skip("no AI Gateway under cf:dev");
      return delegate(`${BUDGET}: aiGatewayRequestsAdaptiveGroups cachedRequests and cost for the repeated seed-embedding call (the smoke has no route that reports a gateway cache verdict)`);
    },
  },
];

const SCENARIO_CHECKS: Check[] = [
  {
    id: "scenarios.reset",
    async run(e) {
      const r = await resetWorld(e.smoke);
      // The operator lease's pool slot (scenario 8 and the tour): reset it only when an earlier run used it.
      const lease = await e.op.start();
      await e.op.put("/api/_hosted/model", { provider: "scripted" });
      let opNote = `${lease.slot} gen ${lease.gen} is fresh`;
      if (!(await freshWorld(e.op))) {
        const or = await resetWorld(e.op);
        await e.op.put("/api/_hosted/model", { provider: "scripted" });
        opNote = `${lease.slot} reset to gen ${or.gen} (${or.resetsLeft} resets left)`;
      }
      return `slot-smoke reset (${r.method ?? "reset"}, gen ${r.gen}); operator lease ${e.o.operator}: ${opNote}, provider scripted`;
    },
  },
  ...SCENARIOS.map((s): Check => ({
    id: `scenario.${s.id}`,
    async run(e) {
      const ctx: ScenarioContext = { world: e.smoke, mcpWorld: e.op, mintMcpKey: () => e.op.post<{ key: string; url: string }>("/api/_hosted/mcp-key", {}) };
      return `${s.title}: ${await s.run(ctx)}`;
    },
  })),
  {
    id: "scenario.8.gateway-log",
    async run(e) {
      return skip(e.kind === "local"
        ? "no AI Gateway under cf:dev"
        : "scripted runs make no gateway call; after --live the run's metadata is in the AI Gateway log, which the smoke does not read");
    },
  },
  {
    id: "platform.isolation",
    async run(e) {
      const smokeNotices = (await e.smoke.get<{ data: { id: string; formCode: string }[] }>("/api/v1/notices?limit=100")).data.filter((n) => /DE ?2088/.test(n.formCode));
      ensure(smokeNotices.length > 0, "slot-smoke has no delivered DE 2088 notice to compare");
      const show = (await e.anon.get<{ data: { id: string; formCode: string }[] }>("/api/v1/notices?limit=100")).data;
      const leaked = show.filter((n) => /DE ?2088/.test(n.formCode));
      ensure(leaked.length === 0, `the showcase sees slot-smoke's notices: ${leaked.map((n) => n.id).join(", ")}`);
      return `slot-smoke's ${smokeNotices.map((n) => n.id).join(" and ")} are invisible from an unleased showcase context`;
    },
  },
];

const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const EXTRAS: Check[] = [
  {
    id: "extras.receipt-ocr",
    async run(e) {
      const form = new FormData();
      for (const [k, v] of Object.entries({ workerId: "wrk_0025", category: "meals", merchant: "Smoke Cafe (demo)", amountCents: "1062", transactionDate: "2026-10-20", businessPurpose: "Team lunch" })) form.set(k, v);
      form.set("receipt", new Blob([Buffer.from(PNG_1PX, "base64")], { type: "image/png" }), "lunch.png");
      const encoded = new Response(form);
      const bytes = new Uint8Array(await encoded.arrayBuffer());
      const r = await e.smoke.request<{ data?: { expense_id: string } }>("POST", "/api/v1/expenses", bytes, { headers: { "content-type": encoded.headers.get("content-type")!, "content-length": String(bytes.byteLength) } });
      ensure(r.status === 200 && r.body?.data?.expense_id, `the receipt upload answered ${r.status}: ${r.text.slice(0, 200)}`);
      const id = r.body!.data!.expense_id;
      const t0 = Date.now();
      // GET /v1/expenses/:id shows the extract once the weft-jobs consumer has written it back (total and date read).
      const exp = await until("the receipt's OCR extract", () => e.smoke.get<{ receiptExtract: { totalCents: number; date: string; merchant?: string } | null }>(`/api/v1/expenses/${id}`), (x) => !!x.receiptExtract, 60_000, 1000);
      const x = exp.receiptExtract!;
      return `${id}'s receipt has an OCR extract after ${((Date.now() - t0) / 1000).toFixed(1)} s (within 60 s): ${x.merchant ?? "no merchant"}, ${x.totalCents} cents, ${x.date}`;
    },
  },
  {
    id: "extras.offer-pdf",
    async run(e) {
      if (e.kind === "local") skip("Browser Run is not emulated under cf:dev, so a render job fails into weft-dlq by design (design 11.5)");
      const offer = await e.smoke.get<{ id: string; documentId: string | null }>("/api/v1/offers/offr_0004");
      ensure(offer.documentId, "offr_0004 has no documentId");
      const path = `/api/_hosted/pdf/offer_letter/${offer.documentId}`;
      const t0 = Date.now();
      let first: Response | null = null;
      for (;;) {
        const res = await fetch(`${e.o.url}${path}`, { headers: { "x-weft-smoke": await e.sign.smoke("GET", path) }, signal: AbortSignal.timeout(30_000) });
        if (res.status === 200) { first = res; break; }
        ensure(res.status === 202, `the PDF route answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
        await res.arrayBuffer();
        if (Date.now() - t0 > 120_000) throw new Error("the offer letter PDF was not rendered within 120 s");
        await sleep(5000);
      }
      const bytes = new Uint8Array(await first.arrayBuffer());
      ensure(first.headers.get("content-type") === "application/pdf" && Buffer.from(bytes.slice(0, 5)).toString("latin1") === "%PDF-", "the download is not a PDF");
      const again = await fetch(`${e.o.url}${path}`, { headers: { "x-weft-smoke": await e.sign.smoke("GET", path) }, signal: AbortSignal.timeout(30_000) });
      await again.arrayBuffer();
      ensure(again.status === 200 && again.headers.get("x-weft-pdf") === "cached", `the second request answered ${again.status}, x-weft-pdf ${again.headers.get("x-weft-pdf")}`);
      return `${offer.documentId} downloads as a ${bytes.byteLength} byte PDF after ${((Date.now() - t0) / 1000).toFixed(0)} s; the second request is served from R2 (x-weft-pdf: cached)`;
    },
  },
  {
    id: "extras.help-search",
    async run(e) {
      const core = readFileSync(join(REPO_ROOT, "apps/cf/wrangler.core.jsonc"), "utf8");
      if (!/"binding"\s*:\s*"HELP"/.test(core)) skip("the AI Search HELP binding is not declared in apps/cf/wrangler.core.jsonc yet (added in Deploy)");
      const r = await e.smoke.get<{ ok: boolean; code?: string; hits?: { path: string; title: string }[] }>("/api/_hosted/help?q=guided%20tour");
      if (!r.ok && r.code === "HELP_DISABLED") skip("Help search is switched off on this deployment (KV extras.help, or the AI Search instance is not reachable)");
      ensure(r.ok && (r.hits ?? []).some((h) => /tour/i.test(h.path)), `help search for "guided tour": ${JSON.stringify(r).slice(0, 200)}`);
      return `"guided tour" finds ${(r.hits ?? []).find((h) => /tour/i.test(h.path))!.path}`;
    },
  },
  {
    id: "extras.dead-letters",
    async run(e) {
      const p = await e.smoke.get<{ deadLetters: number }>("/api/_hosted/platform");
      ensure(p.deadLetters === 0, `${p.deadLetters} jobs in weft-dlq`);
      return "weft-dlq is empty";
    },
  },
  {
    id: "extras.lobby-sweep",
    async run(e) {
      const o = await admin<{ lobby: { readout: { lastSweepAt: string | null } } }>(e, "GET", "/api/_admin/ops");
      const at = o.lobby.readout.lastSweepAt;
      if (e.kind === "local" && !at) skip("wrangler dev runs no cron trigger, so the Lobby has not swept");
      ensure(at, "the Lobby has never swept (the */15 cron trigger)");
      const age = Date.now() - Date.parse(at!);
      ensure(age < 20 * 60_000, `the last Lobby sweep was ${Math.round(age / 60_000)} min ago`);
      return `the last Lobby sweep was ${Math.round(age / 60_000)} min ago`;
    },
  },
];

function runTour(e: Env): Promise<string> {
  const out = join(REPO_ROOT, ".scratch/cf7/smoke-tour.json");
  mkdirSync(join(REPO_ROOT, ".scratch/cf7"), { recursive: true });
  rmSync(out, { force: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env, WEFT_CF_URL: e.o.url, WEFT_CF_TOKENS_FILE: e.sign.file, WEFT_CF_OPERATOR: e.o.operator, WEFT_CF_TOUR_OUT: out,
    WEFT_CF_RESETS_NEEDED: "1", WEFT_CF_LIVE: e.o.live ? "1" : "0",
  };
  return new Promise((resolve, reject) => {
    const child = spawn(join(REPO_ROOT, "node_modules/.bin/playwright"), ["test", "-c", join(REPO_ROOT, "playwright.cf.config.ts"), "--project=deployed", "e2e/cf/cf-tour.spec.ts"], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    child.stdout.on("data", (d: Buffer) => { log += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { log += d.toString(); });
    child.on("exit", (code) => {
      let m: { total: number; steps: number } | null = null;
      try { m = JSON.parse(readFileSync(out, "utf8")) as { total: number; steps: number }; } catch { m = null; }
      const time = m ? `${(m.total / 1000).toFixed(1)} s over ${m.steps} steps` : "no timing";
      if (code === 0) resolve(`autoplay on the operator lease ${e.o.operator} ${e.o.live ? "on the demo default provider (live)" : "with the scripted provider"}: ${time}, every step on its own target, hosted reset through the Lobby`);
      else reject(new Error(`the tour spec failed (${time}): ${log.split("\n").filter((l) => /Error|expect|✘|failed/i.test(l)).slice(0, 6).join(" | ").slice(0, 600)}`));
    });
  });
}

const TOUR: Check[] = [{ id: "tour.autoplay", run: (e) => (e.o.tour ? runTour(e) : skip("--no-tour")) }];

const AFTER: Check[] = [
  {
    id: "after.chain",
    async run(e) {
      const v = await e.smoke.get<{ ok: boolean; head: { seq: number } | null }>("/api/v1/actions/verify");
      ensure(v.ok, "GET /v1/actions/verify is not valid on slot-smoke");
      return `slot-smoke's audit chain verifies (head #${v.head?.seq ?? "none"})`;
    },
  },
  {
    id: "after.reset-smoke",
    async run(e) {
      const r = await resetWorld(e.smoke);
      return `slot-smoke reset (${r.method ?? "reset"}, gen ${r.gen})`;
    },
  },
  { id: "after.cpu-and-limits", async run(e) { if (e.kind === "local") skip("GraphQL analytics cover deployed scripts only"); return delegate(`${BUDGET}: front CPU p99 at most 5 ms, DO route p99 at most 50 ms, no exceededResources or exceededMemory`); } },
  { id: "after.rows", async run(e) { if (e.kind === "local") skip("GraphQL analytics cover deployed scripts only"); return delegate(`${BUDGET}: the showcase GET sweep (platform.showcase-sweep) at 0 rows written, per-flow rows within 25% of design 8.2`); } },
  { id: "after.logs-secret-grep", async run(e) { if (e.kind === "local") skip("no Workers Logs under cf:dev"); return delegate("a Workers Logs dump grepped for known secret prefixes (Workers Logs are not read by the smoke; see pnpm cf:budget and design 11.6)"); } },
  {
    id: "platform.showcase-sweep",
    async run(e) {
      // Unsigned, so it reaches the showcase as a stranger would; the rows it writes are measured by cf:budget.
      const gets = ROUTES.filter((r) => r.method === "GET" && !r.path.includes(":") && !r.path.includes("/events"));
      const bad: string[] = [];
      for (const r of gets) {
        const res = await e.anon.request("GET", `/api${r.path}`);
        if (res.status >= 500) bad.push(`${r.path} ${res.status}`);
      }
      ensure(bad.length === 0, `showcase GETs answered 5xx: ${bad.join(", ")}`);
      if (e.kind === "local") return `${gets.length} showcase GET routes answered under 500 (rows written: cf:budget, deployed only)`;
      return delegate(`swept ${gets.length} showcase GET routes, all under 500; ${BUDGET} reads the rows they wrote (expected 0)`);
    },
  },
  {
    id: "platform.rate-limit-burst",
    gating: false,
    async run(e) {
      const n = HOSTED_RATE_LIMITS.RL_API.limit + 100;
      const statuses: number[] = [];
      let next = 0;
      const t0 = Date.now();
      const worker = async () => {
        while (next < n) {
          next += 1;
          try {
            const r = await fetch(`${e.o.url}/api/_no_such_route`, { signal: AbortSignal.timeout(30_000) });
            await r.arrayBuffer();
            statuses.push(r.status);
          } catch { statuses.push(0); }
        }
      };
      await Promise.all(Array.from({ length: 25 }, worker));
      const limited = statuses.filter((s) => s === 429).length;
      const other = statuses.filter((s) => s !== 429 && s !== 404).length;
      ensure(limited > 0, `no 429 among ${n} unsigned GETs in ${((Date.now() - t0) / 1000).toFixed(0)} s (${other} neither 404 nor 429)`);
      return `${limited} of ${n} unsigned GETs to /api/_no_such_route answered 429 within ${((Date.now() - t0) / 1000).toFixed(0)} s (RL_API ${HOSTED_RATE_LIMITS.RL_API.limit} per ${HOSTED_RATE_LIMITS.RL_API.period} s)`;
    },
  },
];

/** The design 11.6 list, in the order the smoke runs it; the limiter burst is last. */
export const CHECKS: readonly Check[] = [...PLATFORM, ...SCENARIO_CHECKS, ...EXTRAS, ...TOUR, ...AFTER];

/** --only takes ids or prefixes ("scenario", "extras", "platform.csp"); any scenario brings scenarios.reset first. */
export function selected(id: string, only: Set<string>): boolean {
  const match = (x: string) => [...only].some((f) => x === f || x.startsWith(`${f}.`) || (f === "scenarios" && x.startsWith("scenario.")));
  return match(id) || (id === "scenarios.reset" && CHECKS.some((c) => c.id.startsWith("scenario.") && match(c.id)));
}

async function runOne(c: Check, e: Env): Promise<Result> {
  const t0 = Date.now();
  const gating = c.gating !== false;
  try {
    return { id: c.id, status: "pass", detail: await c.run(e), gating, ms: Date.now() - t0 };
  } catch (err) {
    const ms = Date.now() - t0;
    if (err instanceof Skip) return { id: c.id, status: "skipped", detail: err.message, gating, ms };
    if (err instanceof Delegate) return { id: c.id, status: "delegated", detail: err.message, gating, ms };
    return { id: c.id, status: "fail", detail: err instanceof Error ? err.message : String(err), gating, ms };
  }
}

async function main(argv: string[]): Promise<void> {
  const o = parseArgs(argv);
  const kind = targetKind(o.url);
  const sign = signers(o.tokens ?? tokensFile(kind));
  const e: Env = { o, kind, sign, smoke: new SmokeWorld(o.url, sign), anon: new AnonWorld(o.url), op: new OperatorWorld(o.url, sign, o.operator) };
  console.log(`cf:smoke ${o.url} (${kind}${kind === "local" ? `, the local stack: ${LOCAL.dir}` : ""}); smoke calls on slot-smoke, scripted; operator lease "${o.operator}"${o.live ? "; --live: the tour runs on the demo default provider" : ""}`);
  const results: Result[] = [];
  const t0 = Date.now();
  for (const c of CHECKS) {
    if (o.only && !selected(c.id, o.only)) continue;
    const r = await runOne(c, e);
    results.push(r);
    console.log(formatResult(r));
  }
  const s = summarize(results);
  console.log(`${s.line} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  if (s.failed) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((e: unknown) => { console.error(`cf:smoke: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
}
