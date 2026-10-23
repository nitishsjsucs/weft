-- The model comparison (GET /api/_hosted/models, anonymous) reads the newest runs of the window first, at most
-- MAX_COMPARE_ROWS of them (packages/cf-extras/src/catalog.ts). This index serves both the window and the order, so D1
-- stops at the limit instead of reading every run of the last 30 days and sorting them. Track cf6-extras.
CREATE INDEX IF NOT EXISTS run_catalog_ended ON run_catalog (ended_at);
