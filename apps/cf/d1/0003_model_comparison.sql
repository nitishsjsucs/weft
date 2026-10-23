-- The model comparison (GET /api/_hosted/models, anonymous), computed by the cron sweep from the newest runs of the
-- last 30 days (at most MAX_COMPARE_ROWS of them, packages/cf-extras/src/catalog.ts refreshComparison) into this one
-- row, every window of days at once. A visitor's read is this row: one D1 row read however many runs there are.
-- Track cf6-extras.
CREATE TABLE IF NOT EXISTS model_comparison (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  computed_at TEXT NOT NULL,
  body TEXT NOT NULL
);
