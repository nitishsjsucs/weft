// The run catalog (design 5.2 and 6.4) in D1 `weft-ops`: one row per hosted run outcome (provider, model, steps,
// grounded, cost, neurons, latency and status), keyed by slot, generation and run id (run ids restart with each
// generation), for the model comparison page. Only aggregates ever reach visitors, never run content: no prompts,
// summaries, visitor ids or tool output are stored. Track cf6-extras.
import type { HostedProviderId } from "../../contracts/src/ext/cf-agent";
import type { ModelComparisonRow, RunCatalog, RunCatalogRow } from "../../contracts/src/ext/cf-extras";
import type { D1Like } from "./bindings";

export const MAX_COMPARE_DAYS = 30;
/** The comparison reads at most this many rows (D1 bills rows read; a day holds far fewer hosted runs). */
export const MAX_COMPARE_ROWS = 5000;

const UPSERT = `INSERT INTO run_catalog (slot, gen, run_id, provider, model, trigger, steps, grounded, cost_usd_micros, neurons, latency_ms, status, terminal_reason, ended_at, day)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (slot, gen, run_id) DO UPDATE SET provider = excluded.provider, model = excluded.model, trigger = excluded.trigger, steps = excluded.steps,
  grounded = excluded.grounded, cost_usd_micros = excluded.cost_usd_micros, neurons = excluded.neurons, latency_ms = excluded.latency_ms,
  status = excluded.status, terminal_reason = excluded.terminal_reason, ended_at = excluded.ended_at, day = excluded.day`;

const int = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0);
const clip = (s: string, n: number) => s.slice(0, n);

export function catalogStatement(db: D1Like, r: RunCatalogRow) {
  const endedAt = new Date(Date.parse(r.endedAt)).toISOString();
  return db.prepare(UPSERT).bind(
    clip(r.slot, 32), int(r.gen), clip(r.runId, 40), clip(r.provider, 24), clip(r.model, 64), clip(r.trigger, 24), int(r.steps),
    r.grounded === null ? null : r.grounded ? 1 : 0, int(r.costUsdMicros), int(r.neurons), int(r.latencyMs), clip(r.status, 24),
    r.terminalReason === null ? null : clip(r.terminalReason, 40), endedAt, endedAt.slice(0, 10),
  );
}

interface Row { provider: string; model: string; steps: number; grounded: number | null; cost_usd_micros: number; neurons: number; latency_ms: number; status: string }

/** Pure: the comparison rows from catalog rows (latency p50 is the lower median). */
export function compareRows(rows: readonly Row[]): ModelComparisonRow[] {
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const k = `${r.provider}\u0000${r.model}`;
    const g = groups.get(k);
    if (g) g.push(r); else groups.set(k, [r]);
  }
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : 0);
  return [...groups.values()].map((g) => {
    const graded = g.filter((r) => r.grounded !== null);
    const lat = g.map((r) => Number(r.latency_ms)).sort((a, b) => a - b);
    const outcomes: Record<string, number> = {};
    for (const r of g) outcomes[r.status] = (outcomes[r.status] ?? 0) + 1;
    return {
      provider: g[0]!.provider as HostedProviderId, model: g[0]!.model, runs: g.length,
      avgSteps: avg(g.map((r) => Number(r.steps))),
      groundedRate: graded.length ? Math.round((graded.filter((r) => Number(r.grounded) === 1).length / graded.length) * 1000) / 1000 : null,
      avgCostUsdMicros: Math.round(avg(g.map((r) => Number(r.cost_usd_micros)))),
      avgNeurons: avg(g.map((r) => Number(r.neurons))),
      p50LatencyMs: lat.length ? lat[Math.floor((lat.length - 1) / 2)]! : 0,
      outcomes,
    };
  }).sort((a, b) => b.runs - a.runs || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
}

export function createRunCatalog(db: D1Like, opts: { now?: () => Date } = {}): RunCatalog {
  const now = opts.now ?? (() => new Date());
  return {
    async record(row) { await catalogStatement(db, row).run(); },
    async compare(o = {}) {
      const days = Math.max(1, Math.min(MAX_COMPARE_DAYS, Math.floor(o.days ?? 7)));
      const since = new Date(now().getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
      const res = await db.prepare(`SELECT provider, model, steps, grounded, cost_usd_micros, neurons, latency_ms, status FROM run_catalog WHERE day >= ? ORDER BY ended_at DESC LIMIT ${MAX_COMPARE_ROWS}`).bind(since).all<Row>();
      return compareRows(res.results ?? []);
    },
  };
}
