// D1 weft-ops (design 4.1, 5.2 and 10), over node:sqlite with the real apps/cf/d1 migrations: the run catalog and
// its comparison aggregates, the job ledger that makes queue handlers idempotent, the metrics sink, the Platform
// readout and the retention sweep.
import { describe, expect, it } from "vitest";
import type { HostedSpendStatus } from "../../contracts/src/ext/cf-agent";
import { HOSTED_CAP_DEFAULTS } from "../../contracts/src/ext/cf-agent";
import type { RunCatalogRow } from "../../contracts/src/ext/cf-extras";
import { COMPARE_MEMO_MS, compareRows, createRunCatalog, MAX_COMPARE_DAYS, MAX_COMPARE_ROWS, refreshComparison } from "../src/catalog";
import { COUNTERS, memoryDailyCounters } from "../src/counters";
import { d1JobLedger, parseJob, pruneOps, queueOfJob } from "../src/jobs";
import { createAnalyticsEngineSink, createD1MetricsSink, metricsForDay, noopMetricsSink, selectMetricsSink } from "../src/metrics";
import { buildPlatformReadout } from "../src/platform";
import { d1Shim } from "./fakes";

const row = (o: Partial<RunCatalogRow> = {}): RunCatalogRow => ({
  runId: "run_0001", slot: "slot-1", gen: 3, provider: "openai", model: "gpt-5.6-luna", trigger: "chat", steps: 4, grounded: true,
  costUsdMicros: 3100, neurons: 0, latencyMs: 4200, status: "done", terminalReason: "DONE", endedAt: "2026-10-26T15:31:00.000Z", ...o,
});

describe("RunCatalog", () => {
  it("stores outcomes only, keyed by slot, generation and run, and upserts on a repeat", async () => {
    const db = d1Shim();
    const cat = createRunCatalog(db);
    await cat.record(row());
    await cat.record(row({ steps: 5, status: "escalated", terminalReason: "REPEATED_ERRORS" }));
    await cat.record(row({ gen: 4 }));
    const rows = db.rows("run_catalog");
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.gen === 3)).toMatchObject({ steps: 5, status: "escalated", grounded: 1, day: "2026-10-26" });
    const cols = (db.sqlite.prepare("PRAGMA table_info(run_catalog)").all() as { name: string }[]).map((c) => c.name);
    for (const banned of ["summary", "prompt", "visitor", "ip_hash", "text", "content"]) expect(cols).not.toContain(banned);
  });

  it("compares providers side by side over a window of days", async () => {
    const db = d1Shim();
    const cat = createRunCatalog(db, { now: () => new Date("2026-10-27T12:00:00Z") });
    const rows = [
      row({ runId: "run_1", latencyMs: 4000 }), row({ runId: "run_2", latencyMs: 6000, grounded: false, costUsdMicros: 4900 }),
      row({ runId: "run_3", latencyMs: 5000, trigger: "routine", grounded: null, status: "waiting" }),
      row({ runId: "run_4", provider: "workers_ai", model: "@cf/openai/gpt-oss-120b", neurons: 412, costUsdMicros: 4532, latencyMs: 2100, steps: 6 }),
      row({ runId: "run_5", endedAt: "2026-10-01T10:00:00.000Z" }),
    ];
    for (const r of rows) await cat.record(r);
    // Before the cron's first run there is no comparison; then it answers every window from the one stored row.
    expect(await cat.compare({ days: 7 })).toEqual([]);
    await refreshComparison(db, new Date("2026-10-27T12:00:00Z"));
    const cmp = await cat.compare({ days: 7 });
    expect(cmp).toEqual([
      { provider: "openai", model: "gpt-5.6-luna", runs: 3, avgSteps: 4, groundedRate: 0.5, avgCostUsdMicros: 3700, avgNeurons: 0, p50LatencyMs: 5000, outcomes: { done: 2, waiting: 1 } },
      { provider: "workers_ai", model: "@cf/openai/gpt-oss-120b", runs: 1, avgSteps: 6, groundedRate: 1, avgCostUsdMicros: 4532, avgNeurons: 412, p50LatencyMs: 2100, outcomes: { done: 1 } },
    ]);
    expect((await cat.compare({ days: 365 }))[0]!.runs).toBe(4);
    expect(compareRows([])).toEqual([]);
  });

  it("is computed in the cron from the newest runs through the ended_at index, at most MAX_COMPARE_ROWS of them; a visitor's read is one row", async () => {
    expect(MAX_COMPARE_ROWS).toBe(500);
    const db = d1Shim();
    const now = new Date("2026-10-27T12:00:00Z");
    const cat = createRunCatalog(db, { now: () => now });
    await refreshComparison(db, now);
    const q = db.statements.find((x) => /FROM run_catalog/.test(x))!;
    expect(q).toMatch(/ORDER BY ended_at DESC LIMIT \?/);
    const plan = (db.sqlite.prepare(`EXPLAIN QUERY PLAN ${q}`).all("2026-09-28T00:00:00.000Z", MAX_COMPARE_ROWS) as { detail: string }[]).map((p) => p.detail);
    // A range of the index read backwards, in the order asked: no sort of the whole window before the limit.
    expect(plan).toEqual([expect.stringMatching(/^SEARCH run_catalog USING INDEX run_catalog_ended \(ended_at>\?\)$/)]);
    // 2,000 runs this month: the cron reads 500 and stores every window in one row.
    const insert = db.sqlite.prepare(`INSERT INTO run_catalog (slot, gen, run_id, provider, model, trigger, steps, grounded, cost_usd_micros, neurons, latency_ms, status, terminal_reason, ended_at, day)
      VALUES ('slot-1', 1, ?, 'openai', 'gpt-5.6-luna', 'chat', 3, 1, 1000, 0, 900, 'done', 'DONE', ?, ?)`);
    for (let i = 0; i < 2_000; i++) { const at = new Date(now.getTime() - i * 20 * 60_000).toISOString(); insert.run(`run_${i}`, at, at.slice(0, 10)); }
    const stored = await refreshComparison(db, now);
    expect(stored.rows).toBe(MAX_COMPARE_ROWS);
    expect(Object.keys(stored.windows)).toHaveLength(MAX_COMPARE_DAYS);
    expect(db.rows("model_comparison")).toHaveLength(1);
    // A visitor's read is that row, for any window.
    const n = db.statements.length;
    for (const days of [1, 7, 30, 365]) expect((await cat.compare({ days }))[0]!.runs).toBeGreaterThan(0);
    expect(db.statements.slice(n)).toEqual(Array.from({ length: 4 }, () => "SELECT body FROM model_comparison WHERE id = 1"));
    // The window still starts at UTC midnight days - 1 back: a run at 23:59 the day before is out, one at 00:00 is in.
    const db2 = d1Shim();
    const cat2 = createRunCatalog(db2, { now: () => now });
    await cat2.record(row({ runId: "run_out", endedAt: "2026-10-20T23:59:59.999Z" }));
    await cat2.record(row({ runId: "run_in", endedAt: "2026-10-21T00:00:00.000Z" }));
    await refreshComparison(db2, now);
    expect((await cat2.compare({ days: 7 }))[0]!.runs).toBe(1);
  });

  it("memoizes the stored comparison for a minute when asked, for every window, and a record through it drops the memo", async () => {
    const db = d1Shim();
    let now = Date.parse("2026-10-27T12:00:00Z");
    const cat = createRunCatalog(db, { now: () => new Date(now), memoMs: COMPARE_MEMO_MS });
    await cat.record(row({ runId: "run_1" }));
    await refreshComparison(db, new Date(now));
    const reads = () => db.statements.filter((x) => /^SELECT body FROM model_comparison/.test(x)).length;
    const first = await cat.compare({ days: 7 });
    expect(reads()).toBe(1);
    // Many visitors within the minute, at once and one after another, any window: one read.
    await Promise.all(Array.from({ length: 20 }, (_, i) => cat.compare({ days: 1 + (i % 30) })));
    now += COMPARE_MEMO_MS - 1;
    expect(await cat.compare({ days: 7 })).toEqual(first);
    expect(reads()).toBe(1);
    // A minute on, the row is read again.
    now += 1;
    await cat.compare({ days: 7 });
    expect(reads()).toBe(2);
    // A new run shows once the cron has compared again; a record through this catalog drops the memo.
    await cat.record(row({ runId: "run_2" }));
    await refreshComparison(db, new Date(now));
    expect((await cat.compare({ days: 7 }))[0]!.runs).toBe(2);
    expect(reads()).toBe(3);
  });
});

describe("job ledger", () => {
  it("keeps an intermediate read until done, never reverts a done job, and records failures", async () => {
    const db = d1Shim();
    const ledger = d1JobLedger(db, () => new Date("2026-10-26T16:00:00Z"));
    expect(await ledger.get("obx_1")).toBeNull();
    await ledger.saveRead("obx_1", "ocr.receipt", { extract: { totalCents: 1062 } });
    expect(await ledger.get("obx_1")).toEqual({ state: "read", outcome: "", result: { extract: { totalCents: 1062 } } });
    await ledger.done("obx_1", "ocr.receipt", "attached");
    expect(await ledger.get("obx_1")).toEqual({ state: "done", outcome: "attached", result: null });
    await ledger.saveRead("obx_1", "ocr.receipt", { extract: null });
    expect((await ledger.get("obx_1"))!.state).toBe("done");
    await ledger.failed({ jobId: "obx_2", kind: "render.pdf", slot: "slot-1", gen: 3, queue: "weft-render", attempts: 1, code: "PDF_KEY_MISMATCH", message: "x".repeat(500) });
    await ledger.failed({ jobId: "obx_2", kind: "render.pdf", slot: "slot-1", gen: 3, queue: "weft-dlq", attempts: 6, code: "DEAD_LETTER", message: "dead" });
    expect(db.rows("failed_jobs")).toEqual([{ job_id: "obx_2", kind: "render.pdf", slot: "slot-1", gen: 3, queue: "weft-render", attempts: 6, code: "DEAD_LETTER", message: "dead", failed_at: "2026-10-26T16:00:00.000Z" }]);
    expect(await ledger.get("obx_2")).toMatchObject({ state: "failed", outcome: "DEAD_LETTER" });
  });

  it("prunes old rows on the daily sweep", async () => {
    const db = d1Shim();
    await d1JobLedger(db, () => new Date("2026-10-01T00:00:00Z")).done("obx_old", "export.world", "stored");
    await d1JobLedger(db, () => new Date("2026-10-26T00:00:00Z")).done("obx_new", "export.world", "stored");
    await createRunCatalog(db).record(row({ endedAt: "2026-06-01T00:00:00.000Z" }));
    await pruneOps(db, new Date("2026-10-26T12:00:00Z"));
    expect(db.rows("jobs").map((r) => r.job_id)).toEqual(["obx_new"]);
    expect(db.rows("run_catalog")).toHaveLength(0);
  });

  it("validates job bodies strictly", () => {
    const sha = "e".repeat(64);
    const base = { v: 1, jobId: "obx_1", slot: "slot-1", gen: 3 };
    expect(parseJob({ ...base, kind: "ocr.receipt", uploadId: "upl_0001", expenseId: "exp_0101", sha256: sha, storagePath: `blob:${sha}`, contentType: "image/jpeg" }).ok).toBe(true);
    expect(parseJob({ ...base, kind: "ocr.notice", uploadId: "upl_0001", noticeId: "ntc_0009", sha256: sha, storagePath: `blob:${sha}`, contentType: "image/png" }).ok).toBe(true);
    expect(parseJob({ ...base, kind: "embed.memory", namespace: "slot-1", notes: [{ path: "knowledge/a.md", commit: "a".repeat(40), tainted: false, kind: "knowledge" }] }).ok).toBe(true);
    expect(parseJob({ ...base, kind: "export.world", what: "memory", requestedBy: "usr_dana" }).ok).toBe(true);
    const pdf = { ...base, kind: "render.pdf", pdf: "pay_stub", subjectId: "pyc_0042", sha256: sha, html: "<p>x</p>" };
    expect(parseJob(pdf).ok).toBe(true);
    expect(queueOfJob(pdf as never)).toBe("weft-render");
    expect(queueOfJob({ kind: "ocr.receipt" })).toBe("weft-jobs");
    for (const bad of [{ ...pdf, extra: 1 }, { ...pdf, sha256: "x" }, { ...pdf, html: "x".repeat(100_001) }, { ...pdf, kind: "mail.send" }, { ...pdf, v: 2 }, { ...pdf, slot: "../x" }, null, "x"]) {
      expect(parseJob(bad).ok).toBe(false);
    }
  });
});

describe("MetricsSink", () => {
  it("D1 folds points into one row per day, metric and slot, with no visitor ids", async () => {
    const db = d1Shim();
    const sink = createD1MetricsSink(db, { now: () => new Date("2026-10-26T15:00:00Z") });
    sink.emit({ name: "run.ended", value: 4200, slot: "slot-1", visitor: "v_secret" });
    sink.emit({ name: "run.ended", value: 1800, slot: "slot-1", visitor: "v_other" });
    sink.emit({ name: "lease.started", value: 1 });
    expect(db.rows("metrics_daily")).toHaveLength(0);
    await sink.flush();
    await sink.flush();
    sink.emit({ name: "run.ended", value: 1000, slot: "slot-1" });
    await sink.flush();
    expect(await metricsForDay(db, "2026-10-26")).toEqual([{ name: "lease.started", slot: "", count: 1, total: 1 }, { name: "run.ended", slot: "slot-1", count: 3, total: 7000 }]);
    expect(JSON.stringify(db.rows("metrics_daily"))).not.toContain("v_");
    expect(db.statements.filter((s) => s.startsWith("INSERT INTO metrics_daily"))).toHaveLength(3);
  });

  it("flushes through waitUntil, and Analytics Engine is chosen only when its binding exists", async () => {
    const db = d1Shim();
    const pending: Promise<unknown>[] = [];
    const sink = selectMetricsSink({ OPS: db }, { waitUntil: (p) => { pending.push(p); } });
    expect(sink.kind).toBe("d1");
    sink.emit({ name: "job.done", value: 1, slot: "slot-2" });
    sink.emit({ name: "job.done", value: 1, slot: "slot-2" });
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(db.rows("metrics_daily")).toMatchObject([{ name: "job.done", count: 2 }]);
    const points: unknown[] = [];
    const ae = selectMetricsSink({ OPS: db, METRICS: { writeDataPoint: (p) => points.push(p) } });
    expect(ae.kind).toBe("analytics_engine");
    ae.emit({ name: "run.started", value: 1, slot: "slot-1", tags: { provider: "openai" } });
    expect(points).toEqual([{ indexes: ["run.started"], blobs: ["run.started", "slot-1", "provider=openai"], doubles: [1] }]);
    expect(createAnalyticsEngineSink({ writeDataPoint() {} }).kind).toBe("analytics_engine");
    expect(selectMetricsSink({})).toBe(noopMetricsSink);
  });
});

describe("Platform readout", () => {
  it("composes the Lobby, SpendDO, today's dead letters and the extras counters", async () => {
    const db = d1Shim();
    const now = new Date("2026-10-26T18:00:00Z");
    await d1JobLedger(db, () => new Date("2026-10-25T23:59:00Z")).failed({ jobId: "a", kind: "ocr.receipt", slot: null, gen: null, queue: "weft-dlq", attempts: 6, code: "DEAD_LETTER", message: "" });
    await d1JobLedger(db, () => new Date("2026-10-26T01:00:00Z")).failed({ jobId: "b", kind: "ocr.receipt", slot: null, gen: null, queue: "weft-dlq", attempts: 6, code: "DEAD_LETTER", message: "" });
    const counters = memoryDailyCounters(() => now);
    await counters.add(COUNTERS.help, 4);
    await counters.add(COUNTERS.browserMs, 6600);
    const status: HostedSpendStatus = { day: "2026-10-26", caps: HOSTED_CAP_DEFAULTS, spentMicros: { day: 41_200, visitor: null, ip: null, live: 0 }, neurons: { used: 133, byProduct: { agent: 100, ocr: 22, embeddings: 1, dictation: 10 } }, openReservations: 0 };
    const out = await buildPlatformReadout({
      lobby: async () => ({ day: "2026-10-26", level: 1, restoresLeft: 2, leases: { active: 1, pool: 2, waitlist: 0 }, lastSweepAt: "2026-10-26T17:45:00.000Z", shares: { "do.rows_written": { used: 41_000, share: 60_000 } } }),
      spend: { status: async () => status }, ops: db, counters, now: () => now,
    });
    expect(out).toEqual({
      day: "2026-10-26", level: 1, dollars: { spentUsd: 0.0412, dayCapUsd: 2, runCapUsd: 0.1 }, neurons: { used: 133, cap: 5000 }, restoresLeft: 2,
      leases: { active: 1, pool: 2, waitlist: 0 }, deadLetters: 1, lastSweepAt: "2026-10-26T17:45:00.000Z",
      shares: { "do.rows_written": { used: 41_000, share: 60_000 }, "help.queries": { used: 4, share: 30 }, "pdf.browser_seconds": { used: 6.6, share: 300 } },
    });
  });
});
