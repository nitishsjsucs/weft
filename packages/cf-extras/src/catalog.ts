// The run catalog (design 5.2 and 6.4) in D1 `weft-ops`: one row per hosted run outcome (provider, model, steps,
// grounded, cost, neurons, latency and status), keyed by slot, generation and run id (run ids restart with each
// generation), for the model comparison page. Only aggregates ever reach visitors, never run content: no prompts,
// summaries, visitor ids or tool output are stored. Track cf6-extras.
import type { HostedProviderId } from "../../contracts/src/ext/cf-agent";
import type { ModelComparisonRow, RunCatalog, RunCatalogRow } from "../../contracts/src/ext/cf-extras";
import type { D1Like } from "./bindings";

export const MAX_COMPARE_DAYS = 30;
/** The cron's comparison reads at most this many rows (D1 bills rows read; the pool runs far fewer a month): the
 * newest of the 30 days, through the `run_catalog_ended` index (apps/cf/d1/0002_run_catalog_ended.sql), so D1 stops
 * there. */
export const MAX_COMPARE_ROWS = 500;
/** How long the Worker reuses the stored comparison: GET /api/_hosted/models is anonymous, and each read is the one
 * `model_comparison` row (apps/cf/d1/0003_model_comparison.sql). */
export const COMPARE_MEMO_MS = 60_000;

export interface RunCatalogOptions {
  now?: () => Date;
  /** Reuse the stored comparison this long (0, the default, reads its row every time); a record() made through this
   * catalog drops what it kept. */
  memoMs?: number;
}

/** What the cron stores in the `model_comparison` row: the comparison for every window of 1 to MAX_COMPARE_DAYS days. */
export interface StoredComparison { computedAt: string; rows: number; windows: Record<string, ModelComparisonRow[]> }

const windowStart = (t: number, days: number) => `${new Date(t - (days - 1) * 86_400_000).toISOString().slice(0, 10)}T00:00:00.000Z`;

/**
 * The cron's part (design 5.2): the newest MAX_COMPARE_ROWS runs of the last MAX_COMPARE_DAYS days, read once through
 * the ended_at index, compared for every window of days and written to the one `model_comparison` row. A window starts
 * at UTC midnight `days - 1` days back; ended_at is the run's normalized ISO time, so `ended_at >=` that midnight is
 * the same window as `day >=`.
 */
export async function refreshComparison(db: D1Like, now: Date = new Date()): Promise<StoredComparison> {
  const t = now.getTime();
  const res = await db.prepare(`SELECT provider, model, steps, grounded, cost_usd_micros, neurons, latency_ms, status, ended_at FROM run_catalog WHERE ended_at >= ? ORDER BY ended_at DESC LIMIT ?`)
    .bind(windowStart(t, MAX_COMPARE_DAYS), MAX_COMPARE_ROWS).all<Row & { ended_at: string }>();
  const rows = res.results ?? [];
  const windows: Record<string, ModelComparisonRow[]> = {};
  for (let d = 1; d <= MAX_COMPARE_DAYS; d++) {
    const since = windowStart(t, d);
    windows[String(d)] = compareRows(rows.filter((r) => r.ended_at >= since));
  }
  const stored: StoredComparison = { computedAt: now.toISOString(), rows: rows.length, windows };
  await db.prepare(`INSERT INTO model_comparison (id, computed_at, body) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET computed_at = excluded.computed_at, body = excluded.body`)
    .bind(stored.computedAt, JSON.stringify(stored)).run();
  return stored;
}

const UPSERT = `INSERT INTO run_catalog (slot, gen, run_id, provider, model, trigger, steps, grounded, cost_usd_micros, neurons, latency_ms, status, terminal_reason, ended_at, day)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (slot, gen, run_id) DO UPDATE SET provider = excluded.provider, model = excluded.model, trigger = excluded.trigger, steps = excluded.steps,
  grounded = excluded.grounded, cost_usd_micros = excluded.cost_usd_micros, neurons = excluded.neurons, latency_ms = excluded.latency_ms,
  status = excluded.status, terminal_reason = excluded.terminal_reason, ended_at = excluded.ended_at, day = excluded.day`;

const int = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0);
const clip = (s: string, n: number) => s.slice(0, n);

export function catalogStatement(db: D1Like, r: RunCatalogRow) {
  const t = Date.parse(r.endedAt);
  const endedAt = new Date(Number.isFinite(t) ? t : Date.now()).toISOString();
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

/** The stored comparison's windows, or none before the cron's first run (or when the row cannot be read as one). */
function parseStored(body: unknown): Record<string, ModelComparisonRow[]> {
  try {
    const v = typeof body === "string" ? (JSON.parse(body) as Partial<StoredComparison>) : null;
    return v && v.windows && typeof v.windows === "object" ? v.windows : {};
  } catch {
    return {};
  }
}

/**
 * The run catalog: record() upserts one run's outcome; compare() answers a window from the row the cron's
 * refreshComparison wrote (one D1 row read, reused memoMs), so an anonymous read never scans the runs. Runs recorded
 * since the last cron show after the next one (at most 15 minutes).
 */
export function createRunCatalog(db: D1Like, opts: RunCatalogOptions = {}): RunCatalog {
  const now = opts.now ?? (() => new Date());
  const memoMs = Math.max(0, opts.memoMs ?? 0);
  /** When the stored comparison was read and its windows (a promise, so concurrent requests share one read). */
  let memo: { at: number; windows: Promise<Record<string, ModelComparisonRow[]>> } | null = null;
  return {
    async record(row) {
      await catalogStatement(db, row).run();
      memo = null;
    },
    compare(o = {}) {
      const days = Math.max(1, Math.min(MAX_COMPARE_DAYS, Math.floor(o.days ?? 7)));
      const t = now().getTime();
      let m = memo;
      if (!(memoMs > 0 && m && t >= m.at && t - m.at < memoMs)) {
        const windows = db.prepare(`SELECT body FROM model_comparison WHERE id = 1`).first<{ body: string }>().then((r) => parseStored(r?.body));
        m = { at: t, windows };
        if (memoMs > 0) {
          memo = m;
          windows.catch(() => { if (memo?.windows === windows) memo = null; });
        }
      }
      return m.windows.then((w) => w[String(days)] ?? []);
    },
  };
}
