// pnpm cf:budget (docs/cloudflare/design.md 8 and 10): today's use against Weft's shares and the CPU targets, from the
// GraphQL Analytics API (workersInvocationsAdaptive for CPU p50 and p99 and status per script,
// durableObjectsPeriodicGroups for rows and CPU per object, aiGatewayRequestsAdaptiveGroups for requests and cost),
// compared with Weft's own spend ledger (GET /api/_admin/ops). Any gap between the ledger and the gateway's cost is
// reported, never silently trusted. It writes one budget_daily row per metric to D1 weft-ops. Run it through
// scripts/cf/with-cf.sh; `--url` names the deployed origin (the admin token comes from the cf secrets file).
//
//   scripts/cf/with-cf.sh pnpm cf:budget --url https://weft.nitish-ratakonda.workers.dev [--day 2026-10-26]
import { cfApiFromEnv, type CfApi } from "./lib/cf-api";
import { readResources } from "./lib/configs";
import { CF_SECRETS_FILE, readEnvValue } from "./lib/env-file";
import { signAdmin } from "../../apps/cf/src/shared/tokens";

/** Design 8.1 targets and 8.2 shares. */
export const TARGETS = { frontCpuP99Ms: 5, doRouteCpuP99Ms: 50, doRowsWritten: 60_000, doRowsRead: 3_000_000, doRequests: 60_000, workersRequests: 60_000 } as const;
export const SCRIPTS = ["weft", "weft-core"] as const;

export const QUERY = `query WeftBudget($account: string!, $start: Time!, $end: Time!, $day: Date!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      workers: workersInvocationsAdaptive(limit: 200, filter: { datetime_geq: $start, datetime_lt: $end, scriptName_in: ["weft", "weft-core"] }) {
        dimensions { scriptName status }
        sum { requests errors subrequests }
        quantiles { cpuTimeP50 cpuTimeP99 }
      }
      objects: durableObjectsPeriodicGroups(limit: 1000, filter: { date: $day }) {
        dimensions { namespaceId }
        sum { cpuTime rowsRead rowsWritten exceededCpuErrors exceededMemoryErrors }
      }
      gateway: aiGatewayRequestsAdaptiveGroups(limit: 100, filter: { datetime_geq: $start, datetime_lt: $end }) {
        dimensions { gateway provider }
        sum { cost requests cachedRequests }
      }
    }
  }
}`;

export interface BudgetData {
  workers: { dimensions: { scriptName: string; status: string }; sum: { requests: number; errors: number; subrequests: number }; quantiles: { cpuTimeP50: number; cpuTimeP99: number } }[];
  objects: { dimensions: { namespaceId: string }; sum: { cpuTime: number; rowsRead: number; rowsWritten: number; exceededCpuErrors: number; exceededMemoryErrors?: number } }[];
  gateway: { dimensions: { gateway: string; provider: string }; sum: { cost: number; requests: number; cachedRequests: number } }[];
}

export interface BudgetSummary {
  day: string;
  scripts: Record<string, { requests: number; errors: number; cpuP50Ms: number; cpuP99Ms: number; statuses: Record<string, number> }>;
  objects: { rowsRead: number; rowsWritten: number; cpuMs: number; exceededCpu: number; exceededMemory: number };
  gatewayUsd: number;
  ledgerUsd: number | null;
  findings: string[];
}

/** Turns the GraphQL rows into the day's summary and its findings (pure; the unit suite pins it). */
export function summarize(day: string, d: BudgetData, ledgerUsd: number | null, gatewayName: string | null): BudgetSummary {
  const scripts: BudgetSummary["scripts"] = {};
  for (const w of d.workers) {
    const s = (scripts[w.dimensions.scriptName] ??= { requests: 0, errors: 0, cpuP50Ms: 0, cpuP99Ms: 0, statuses: {} });
    s.requests += w.sum.requests;
    s.errors += w.sum.errors;
    s.cpuP50Ms = Math.max(s.cpuP50Ms, w.quantiles.cpuTimeP50 / 1000);
    s.cpuP99Ms = Math.max(s.cpuP99Ms, w.quantiles.cpuTimeP99 / 1000);
    s.statuses[w.dimensions.status] = (s.statuses[w.dimensions.status] ?? 0) + w.sum.requests;
  }
  const objects = d.objects.reduce((a, o) => ({
    rowsRead: a.rowsRead + o.sum.rowsRead, rowsWritten: a.rowsWritten + o.sum.rowsWritten, cpuMs: a.cpuMs + o.sum.cpuTime / 1000,
    exceededCpu: a.exceededCpu + o.sum.exceededCpuErrors, exceededMemory: a.exceededMemory + (o.sum.exceededMemoryErrors ?? 0),
  }), { rowsRead: 0, rowsWritten: 0, cpuMs: 0, exceededCpu: 0, exceededMemory: 0 });
  const gatewayUsd = d.gateway.filter((g) => !gatewayName || g.dimensions.gateway === gatewayName).reduce((n, g) => n + g.sum.cost, 0);
  const findings: string[] = [];
  const front = scripts.weft;
  if (front && front.cpuP99Ms > TARGETS.frontCpuP99Ms) findings.push(`front CPU p99 ${front.cpuP99Ms.toFixed(1)} ms is above ${TARGETS.frontCpuP99Ms} ms`);
  const core = scripts["weft-core"];
  if (core && core.cpuP99Ms > TARGETS.doRouteCpuP99Ms) findings.push(`weft-core CPU p99 ${core.cpuP99Ms.toFixed(1)} ms is above ${TARGETS.doRouteCpuP99Ms} ms`);
  for (const [name, s] of Object.entries(scripts)) {
    const bad = Object.entries(s.statuses).filter(([st]) => /exceeded/i.test(st));
    if (bad.length) findings.push(`${name}: ${bad.map(([st, n]) => `${n} ${st}`).join(", ")}`);
  }
  if (objects.exceededCpu) findings.push(`${objects.exceededCpu} Durable Object invocations exceeded CPU`);
  if (objects.exceededMemory) findings.push(`${objects.exceededMemory} Durable Object invocations exceeded memory`);
  if (objects.rowsWritten > TARGETS.doRowsWritten) findings.push(`DO rows written ${objects.rowsWritten} are above Weft's share ${TARGETS.doRowsWritten}`);
  if (objects.rowsRead > TARGETS.doRowsRead) findings.push(`DO rows read ${objects.rowsRead} are above Weft's share ${TARGETS.doRowsRead}`);
  const workerRequests = Object.values(scripts).reduce((n, s) => n + s.requests, 0);
  if (workerRequests > TARGETS.workersRequests) findings.push(`Workers requests ${workerRequests} are above Weft's share ${TARGETS.workersRequests}`);
  if (ledgerUsd !== null) {
    const gap = gatewayUsd - ledgerUsd;
    if (Math.abs(gap) > Math.max(0.01, ledgerUsd * 0.1)) findings.push(`the ledger says $${ledgerUsd.toFixed(4)} and the gateway $${gatewayUsd.toFixed(4)} (gap $${gap.toFixed(4)})`);
  }
  return { day, scripts, objects, gatewayUsd, ledgerUsd, findings };
}

async function ledgerUsd(url: string, day: string): Promise<number | null> {
  const token = readEnvValue(CF_SECRETS_FILE, "WEFT_ADMIN_TOKEN");
  if (!token) return null;
  const path = "/api/_admin/ops";
  const res = await fetch(`${url.replace(/\/$/, "")}${path}`, { headers: { "x-weft-admin": await signAdmin({ token, method: "GET", path }) } });
  if (!res.ok) throw new Error(`GET ${path} answered ${res.status}`);
  const body = (await res.json()) as { spend: { day: string; spentMicros: { day: number } } };
  return body.spend.day === day ? body.spend.spentMicros.day / 1e6 : null;
}

async function writeBudgetRows(api: CfApi, s: BudgetSummary): Promise<void> {
  const r = readResources();
  if (!r) return;
  const at = new Date().toISOString();
  const rows: [string, number, number | null][] = [
    ["graphql.do_rows_written", s.objects.rowsWritten, TARGETS.doRowsWritten],
    ["graphql.do_rows_read", s.objects.rowsRead, TARGETS.doRowsRead],
    ["graphql.workers_requests", Object.values(s.scripts).reduce((n, x) => n + x.requests, 0), TARGETS.workersRequests],
    ["graphql.front_cpu_p99_ms", s.scripts.weft?.cpuP99Ms ?? 0, TARGETS.frontCpuP99Ms],
    ["graphql.core_cpu_p99_ms", s.scripts["weft-core"]?.cpuP99Ms ?? 0, TARGETS.doRouteCpuP99Ms],
    ["graphql.gateway_usd", s.gatewayUsd, null],
    ...(s.ledgerUsd !== null ? [["ledger.usd", s.ledgerUsd, null] as [string, number, null]] : []),
  ];
  for (const [metric, used, share] of rows) {
    await api.post(`/accounts/:account/d1/database/${r.d1.OPS}/query`, {
      sql: `INSERT INTO budget_daily (day, metric, used, share, source, updated_at) VALUES (?, ?, ?, ?, 'cf:budget', ?) ON CONFLICT (day, metric) DO UPDATE SET used = excluded.used, share = excluded.share, source = excluded.source, updated_at = excluded.updated_at`,
      params: [s.day, metric, used, share, at],
    });
  }
}

async function main(argv: string[]): Promise<void> {
  const arg = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] ?? null : null; };
  const day = arg("--day") ?? new Date().toISOString().slice(0, 10);
  const api = cfApiFromEnv();
  const data = await api.graphql<{ viewer: { accounts: BudgetData[] } }>(QUERY, { account: api.accountId, start: `${day}T00:00:00Z`, end: new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString(), day });
  const acct = data.viewer.accounts[0] ?? { workers: [], objects: [], gateway: [] };
  const url = arg("--url");
  const s = summarize(day, acct, url ? await ledgerUsd(url, day) : null, readEnvValue(CF_SECRETS_FILE, "WEFT_AIG_GATEWAY"));
  for (const [name, x] of Object.entries(s.scripts)) console.log(`${name}: ${x.requests} requests, ${x.errors} errors, CPU p50 ${x.cpuP50Ms.toFixed(2)} ms, p99 ${x.cpuP99Ms.toFixed(2)} ms`);
  console.log(`Durable Objects: ${s.objects.rowsWritten} rows written, ${s.objects.rowsRead} rows read, ${s.objects.cpuMs.toFixed(0)} ms CPU, ${s.objects.exceededCpu} exceeded CPU, ${s.objects.exceededMemory} exceeded memory`);
  console.log(`AI Gateway cost $${s.gatewayUsd.toFixed(4)}; ledger ${s.ledgerUsd === null ? "not read" : `$${s.ledgerUsd.toFixed(4)}`}`);
  if (!argv.includes("--no-write")) await writeBudgetRows(api, s);
  if (s.findings.length) { console.log(`findings:\n  ${s.findings.join("\n  ")}`); process.exit(1); }
  console.log("cf:budget: within the targets and shares");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((e: unknown) => { console.error(`cf:budget: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
}
