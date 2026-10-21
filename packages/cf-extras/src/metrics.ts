// The MetricsSink (design 7.1 and 10): per-run and per-lease counters. Analytics Engine stays undeclared until
// Nitish enables it on his account (a one-time dashboard opt-in; a deploy that declares it fails with code 10089),
// so today the sink is D1: points are folded into one row per day, metric and slot (`metrics_daily`), buffered in
// the isolate and written in one batch when the invocation flushes. Visitor ids never reach the sink's storage.
// `selectMetricsSink` switches to Analytics Engine the day its binding is declared. Track cf6-extras.
import type { MetricName, MetricPoint, MetricsSink } from "../../contracts/src/ext/cf-extras";
import type { AnalyticsEngineLike, D1Like } from "./bindings";
import { utcDay } from "./bytes";

export interface FlushableSink extends MetricsSink {
  /** Writes what is buffered; safe to call more than once. */
  flush(): Promise<void>;
  readonly kind: "d1" | "analytics_engine" | "noop";
}

const UPSERT = `INSERT INTO metrics_daily (day, name, slot, count, total) VALUES (?, ?, ?, ?, ?)
ON CONFLICT (day, name, slot) DO UPDATE SET count = metrics_daily.count + excluded.count, total = metrics_daily.total + excluded.total`;

/**
 * D1 sink. `emit` is synchronous (it only buffers); `flush` writes one upsert per distinct (day, name, slot) in a
 * single batch. Pass `waitUntil` to flush after each emit without holding the response.
 */
export function createD1MetricsSink(db: D1Like, opts: { now?: () => Date; waitUntil?: (p: Promise<unknown>) => void; onError?: (e: unknown) => void } = {}): FlushableSink {
  const now = opts.now ?? (() => new Date());
  let buf = new Map<string, { day: string; name: MetricName; slot: string; count: number; total: number }>();
  let scheduled = false;
  const flush = async () => {
    scheduled = false;
    if (buf.size === 0) return;
    const items = [...buf.values()];
    buf = new Map();
    try {
      await db.batch(items.map((i) => db.prepare(UPSERT).bind(i.day, i.name, i.slot, i.count, i.total)));
    } catch (e) {
      opts.onError?.(e);
    }
  };
  return {
    kind: "d1",
    emit(p: MetricPoint) {
      const day = utcDay(now());
      const slot = (p.slot ?? "").slice(0, 32);
      const k = `${day}|${p.name}|${slot}`;
      const cur = buf.get(k) ?? { day, name: p.name, slot, count: 0, total: 0 };
      cur.count += 1;
      cur.total += Number.isFinite(p.value) ? p.value : 0;
      buf.set(k, cur);
      if (opts.waitUntil && !scheduled) { scheduled = true; opts.waitUntil(Promise.resolve().then(flush)); }
    },
    flush,
  };
}

/** Analytics Engine sink, ready for the day the dataset is declared: blobs [name, slot], doubles [value], index name. */
export function createAnalyticsEngineSink(dataset: AnalyticsEngineLike): FlushableSink {
  return {
    kind: "analytics_engine",
    emit(p) {
      const tags = Object.entries(p.tags ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join(",").slice(0, 200);
      dataset.writeDataPoint({ indexes: [p.name], blobs: [p.name, p.slot ?? "", tags], doubles: [Number.isFinite(p.value) ? p.value : 0] });
    },
    async flush() { /* Analytics Engine writes are fire and forget */ },
  };
}

export const noopMetricsSink: FlushableSink = { kind: "noop", emit() { /* nothing */ }, async flush() { /* nothing */ } };

/** Analytics Engine when its binding exists, else D1 when `weft-ops` is bound, else nothing. */
export function selectMetricsSink(env: { METRICS?: AnalyticsEngineLike | undefined; OPS?: D1Like | undefined }, opts: Parameters<typeof createD1MetricsSink>[1] = {}): FlushableSink {
  if (env.METRICS && typeof env.METRICS.writeDataPoint === "function") return createAnalyticsEngineSink(env.METRICS);
  if (env.OPS) return createD1MetricsSink(env.OPS, opts);
  return noopMetricsSink;
}

/** The daily rows for the Platform page and `pnpm cf:budget` (aggregates only). */
export async function metricsForDay(db: D1Like, day: string): Promise<{ name: string; slot: string; count: number; total: number }[]> {
  const r = await db.prepare("SELECT name, slot, count, total FROM metrics_daily WHERE day = ? ORDER BY name, slot").bind(day).all<{ name: string; slot: string; count: number; total: number }>();
  return r.results ?? [];
}
