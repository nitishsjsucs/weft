-- D1 weft-ops (docs/cloudflare/design.md 4.1, 5.2 and 10): operations data, off the harness data path.
-- Applied with `wrangler d1 migrations apply weft-ops --remote` (migrations_dir "d1" in wrangler.core.jsonc).
-- Cross-world rows: visitors only ever see aggregates of these, never content. Track cf6-extras.

-- Hosted run outcomes for the model comparison page. Run ids restart with each generation, so the key has all three.
CREATE TABLE run_catalog (
  slot TEXT NOT NULL,
  gen INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  trigger TEXT NOT NULL,
  steps INTEGER NOT NULL,
  grounded INTEGER,
  cost_usd_micros INTEGER NOT NULL,
  neurons INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  terminal_reason TEXT,
  ended_at TEXT NOT NULL,
  day TEXT NOT NULL,
  PRIMARY KEY (slot, gen, run_id)
);
CREATE INDEX run_catalog_day ON run_catalog (day);

-- One row per UTC day and metric, written by pnpm cf:budget (GraphQL use against Weft's shares) and the cron sweep.
CREATE TABLE budget_daily (
  day TEXT NOT NULL,
  metric TEXT NOT NULL,
  used REAL NOT NULL,
  share REAL,
  source TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (day, metric)
);

-- The job ledger: what each after-commit job has done, so a redelivered message never repeats a model call or a write.
-- Keyed by job id alone across every slot and generation, so job ids are globally unique (random obx_<16 hex>).
-- A job a daily share refused is `deferred` until not_before with its body in result_json, and `requeued` once the
-- cron has sent it again.
CREATE TABLE jobs (
  job_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('read', 'done', 'failed', 'deferred', 'requeued')),
  outcome TEXT NOT NULL DEFAULT '',
  result_json TEXT,
  updated_at TEXT NOT NULL,
  not_before TEXT
);
CREATE INDEX jobs_updated ON jobs (updated_at);
CREATE INDEX jobs_due ON jobs (state, not_before);

-- Jobs that failed for good (bad input, a refused write-back) and dead letters from weft-dlq.
CREATE TABLE failed_jobs (
  job_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  slot TEXT,
  gen INTEGER,
  queue TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  failed_at TEXT NOT NULL
);
CREATE INDEX failed_jobs_at ON failed_jobs (failed_at);

-- The MetricsSink while Analytics Engine stays undeclared: one row per day, metric and slot (no visitor ids).
CREATE TABLE metrics_daily (
  day TEXT NOT NULL,
  name TEXT NOT NULL,
  slot TEXT NOT NULL DEFAULT '',
  count INTEGER NOT NULL,
  total REAL NOT NULL,
  PRIMARY KEY (day, name, slot)
);

-- Results of pnpm cf:smoke against the deployed URL.
CREATE TABLE smoke_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  url TEXT NOT NULL,
  check_name TEXT NOT NULL,
  ok INTEGER NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX smoke_results_at ON smoke_results (at);
