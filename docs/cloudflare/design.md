# Weft on Cloudflare Workers Free: final design

Status: design. Nothing in this document is deployed yet. Status words follow the repo rules:

- **measured** means the account probe ran it on Nitish's Cloudflare account (Workers Free, `usage_model` standard) on 2026-10-20;
- **verified locally** means a scratch run on this Mac (Node 25.9, workerd through Miniflare or `wrangler dev`) with no deploy;
- **documented** means Cloudflare's docs as fetched on 2026-10-20;
- **to verify** marks a point a named first-deploy check settles, each with a fallback.

Integrations stay simulated on every platform. The implementation tracks are in [tracks.md](tracks.md).

## 0. Decisions this design builds on

These are Nitish's and are not revisited here:

- **Public URL, full live agent for anyone, no Access login.** Abuse protection is therefore part of the design: Turnstile before every model-calling action, the Rate Limiting binding per IP, the spend caps (`WEFT_RUN_USD_CAP` 0.10, `WEFT_DAY_USD_CAP` 2.00) enforced server side, and isolation so visitors never see each other's changes.
- **Model.** OpenAI `gpt-5.6-luna` through Cloudflare AI Gateway (logging, caching, rate limits) by default; Workers AI selectable as a switch and compared side by side.
- **Hostname.** `weft.nitish-ratakonda.workers.dev`. No custom domain, so no Email Routing.
- **Workers Free only.** Never upgrade, never add a payment method, never create accounts, never accept terms on his behalf. A product that needs Workers Paid is recorded as left out with its source (section 7.2).
- **Node stays the reference runtime.** The local app, `pnpm test`, the e2e suites and the evals keep running on Node with today's defaults.
- **Settings Nitish chose on 2026-10-20** (these override any other value in this design or in tracks.md):
  - No cumulative live cap on the hosted demo: hosted `WEFT_LIVE_USD_CAP` is off (no lifetime or monthly ceiling). Nitish is the only intended user.
  - The per-run cap (0.10) and the day cap (2.00) stay as backstops because the URL is public. Visitor and IP-hash caps equal the day cap. Every cap is read from KV `weft-config`, so it changes without a redeploy.
  - Pool: `WEFT_POOL_SIZE` 2 (plus the showcase and slot-smoke), so the whole pool seeds on the first UTC day.
  - Leases: 30 minutes idle and 3 hours total, 20 leases per IP hash per day, so a long demo is never cut off.
  - AI Search Help: kept, capped at 30 queries a day.
  - The OpenAI key stays a `weft-core` Worker secret (phase 1); Analytics Engine stays undeclared until Nitish enables it.

## 1. How this design was formed

It starts from the fidelity design (both reviews ranked it first or second, and it is the only one whose critical path was spiked in workerd), grafts the measured budgets of the risk design and the visitor-facing products of the native design, and fixes every fatal issue the reviews found.

| Source | Kept or grafted |
|---|---|
| fidelity (base) | One world per SQLite Durable Object; the libsql-compatible facade whose drizzle transactions run inside `ctx.storage.transaction()` (closure form) with nested transactions for savepoints; `rowsAffected` from `changes()`; the unchanged `PROCESS_RESTART` boot rule; agent runs started inside alarm invocations; two Worker scripts; SpendDO and LobbyDO singletons; SqlRepo memory with real git object SHAs; the `node:sqlite` emulator that runs the whole Node suite on the facade; smoke on a reserved slot at $0 |
| risk | DO rows read in the budget; ETag/304 on per-table versions; the `/v1/time-off/requests` N+1 fix; idle backoff; reads that write no rows; routine definitions upserted only when their hash changes; the measured delta-reset mechanics; MCP hosted inside the slot DO; lazy loading of `@weft/*`; isolate memory measured; the degradation ladder; the per-flow rows table as acceptance baselines |
| native | The read-only showcase world for unleased visitors; the runtime `IO_IN_TX` guard; the after-commit jobs outbox to Queues; receipt and notice OCR, PDF rendering, help search, dictation, the model comparison page, the in-app Platform page and the MCP connect dialog; the per-IP lease cap; the KV kill switch; orphaned reservations settled at worst case; generation-keyed R2 keys and vector metadata; PDF rendering through `setContent` with scripts off and every request aborted; `wrangler deploy --dry-run`; the read-only billing check in provisioning; `WEFT_BACKGROUND_LLM=1` to match `docs/demo-scenarios.md` |

Fatal issues fixed:

1. **No deferred-commit transaction facade.** The facade never implements `client.transaction()`. A deferred promise awaited inside `ctx.storage.transaction` leaves writes from the caller's async context in place after a reported rollback (verified locally by the review, top level and nested). The linear begin/commit shape hung for 30 s and reset the object (verified locally by the fidelity spike). Conformance tests pin both as negative cases (sections 4.2 and 11.3).
2. **No smoke check that expects an AI Gateway cache hit on an agent call.** Every run context carries a per-run nonce (`packages/agent/src/runtime.ts:360`, `<context n="...">` in `packages/agent/src/context.ts:43` and `:67`), so exact-match caching cannot hit across runs. Gateway caching stays on, as decided, and the smoke asserts a hit only on a deterministic call (section 5.1).
3. **Pool seeding respects the account-wide rows-written cap.** A full rich restore writes 20,556 rows (verified locally). Seeding the showcase, the smoke slot and four pool slots in one UTC day would pass the 100,000 rows-written cap shared with six other apps, so provisioning is spread over three days under a Lobby budget (section 9.2).
4. **The transaction mapping is not left as an open gate with an unscheduled sync-rewrite fallback.** The closure-form mapping is verified locally, including nesting, and the deployed conformance run is the first step of the deploy track.
5. **Remaining conditional items have first-deploy checks and named fallbacks:** point-in-time recovery cost and availability on Free, and AI Gateway BYOK, spend rules and authentication on Free.

## 2. Ground truth that shapes the design

| Fact | Value | Status and source |
|---|---|---|
| Worker request CPU | documented 10 ms; requests up to 870.5 ms succeeded; killed at 1,779.6 and 2,010.0 ms (HTTP 503, error 1102) | measured (probe: Worker CPU limit) |
| Workflow step CPU | documented 10 ms; 722 ms succeeded; killed at 2,050 ms | measured (probe: Workflows) |
| Durable Object fetch and alarm CPU | 6,900 ms fetch and 9,805 ms alarm succeeded; killed at 29.4 to 32.5 s; a killed alarm retried on its own | measured (probe: DO CPU, DO alarm CPU) |
| Subrequests per invocation | 50 external (the 51st throws), 1,000 to Cloudflare services | measured and documented (probe: Subrequests) |
| Worker size | 10.35 MiB of incompressible data deployed; documented 64 MiB uncompressed, no compressed limit | measured (probe: bundle size) |
| Full rich restore | 20,556 rows written (99 tables, 160 indexes, 8 triggers, 7,957 data rows; index entries count either way) | verified locally (risk design, workerd) |
| Delta reset after a 10-flow engaged session | 557 rows written, 6,789 rows read, 0 mismatches over 2 cycles, with memory in git (hosted worlds keep it in SQL: 717 rows, section 4.6) | verified locally (risk design) |
| 10-flow engaged session with dirty tracking | 894 rows written (824 without tracking), 29,044 rows read | verified locally (risk design) |
| Idle Home tab | `/v1/time-off/requests` reads 1,092 rows in 145 statements every 10 s, about 0.39M rows read per tab-hour | verified locally (risk design; poll at `apps/web/src/components/app/home/home-view.tsx:43`) |
| GET routes that write | nine GET routes write a `res_` id row on every call (`newId(sp, "res_")` at `packages/executor/src/pipeline.ts:281`) | verified locally (risk design) |
| First scheduler tick after a cold start | 55 rows written (26 routine definition writes) | verified locally (risk design) |
| Async `ctx.storage.transaction` | rolls back after microtask and timer awaits; nested inner rollback only; a second request waits until the transaction ends; `rowsWritten` 2 against `changes()` 1 on a compare-and-set | verified locally (fidelity spike, rerun by the review) |
| Module memory | 66.6 MB heap for Weft's modules under tsx, about 1 MB per extra world | verified locally (risk design; upper bound) |
| Rate Limiting binding | 23 of 25 sequential requests allowed against 5 per 10 s | measured (probe: Rate Limiting binding) |
| Other apps on the account | peak 6,672 DO rows written a day, 75 GB-s a day, about 1,800 Workers AI neurons a day | research (GraphQL, 2026-10-15 to 19) |

Consequences: Worker requests and Workflow steps stay near the documented 10 ms, and all domain, payroll and agent compute runs in Durable Objects. The binding daily constraint is Durable Object rows written, then rows read, not CPU.

## 3. Runtime topology

### 3.1 Picture

```
browser --static assets (no Worker invocation)--------------> Workers static assets: Next static export
browser --/api/*, /api/_live (WS), /api/_session/*--------+
MCP client --POST /mcp (Bearer or x-api-key mcp key)------+--> weft (front Worker, a few ms CPU)
                                                               verify session cookie (HMAC) or mcp key prefix
                                                               Rate Limiting binding (per IP hash, per key)
                                                               Turnstile siteverify (only on /api/_session/*)
                                                               strip client x-weft-proxy / x-weft-ctx / x-weft-smoke
                                                               inject x-weft-proxy and an HMAC'd x-weft-ctx
                                                               |  DO stubs and a service binding (script weft-core)
                                                               v
weft-core (workers_dev false, preview_urls false: no public route)
  CompanyDO "showcase"  read-only shared world for unleased visitors
  CompanyDO "slot-1..N" one leased world each (pool, WEFT_POOL_SIZE)
  CompanyDO "slot-smoke" reserved for the deployed smoke, scripted provider only
      WorldScope ALS -> lazy import of @weft/* -> assembleWeft(durablePlatform) -> Hono app.fetch
      executor, core, payroll-tax, sim, routines, grounding, agent runtime
      DO SQLite: 99 domain and harness tables + hosted tables (memory objects, blobs, run files, outbox)
      alarm: one live agent run per invocation, scheduler ticks only while the clock runs, watchdog
      hibernatable WebSocket change feed; SSE for active runs; remote MCP handler
  LobbyDO "lobby"   slots, leases, generations, per-IP-hash lease counts, daily budget counters, waitlist
  SpendDO "spend"   spend ledger, all caps, orphan sweep, neuron budget
  ReseedWorkflow    full restore and arm, chunked steps that only RPC into a CompanyDO
  HostedExtras      WorkerEntrypoint for help search, dictation, Platform and comparison readouts
  cron */15 -> LobbyDO.sweep()      queue consumers: weft-jobs (OCR, embeddings, exports), weft-render (PDF), weft-dlq
  bindings: AI (Workers AI), AI Gateway "weft", KV CONFIG, D1 weft-ops, R2 weft-files, Vectorize weft-memory,
            Browser Run, Images, Rate Limiting RL_RUN
```

### 3.2 Why two scripts

- The core bundle is about 6 MB (1.27 MiB gzip) with 114 ms of module evaluation on Node (fidelity measurement), plus `@cloudflare/puppeteer` (698 KiB, measured by the probe). The front Worker never imports `@weft/*`, so its cold start and per-request CPU stay small against the documented 10 ms and the 1 s startup limit (research: Workers limits).
- Inside weft-core, `@weft/*` is imported dynamically inside `CompanyDO`'s `blockConcurrencyWhile` in the constructor. LobbyDO, SpendDO, the cron handler and the queue consumers never evaluate it.
- Durable Object bindings across scripts (`script_name`) and service bindings work on Free. Calls over a service binding are not billed as separate requests (research: Workers pricing, "Service bindings").
- `preview_urls: false` on both scripts and `workers_dev: false` on weft-core, so no ungated copy of the app exists.

### 3.3 What runs where

| Code | Node (unchanged) | Cloudflare |
|---|---|---|
| `apps/api` Hono app, routes, `http/*` | Node process via @hono/node-server | `CompanyDO.fetch` calls `weft.app.fetch(req)` inside `WorldScope.run(slotKey)` |
| `packages/{executor,core,payroll-tax,sim,routines,grounding,agent}` | same | same code over durable platform adapters |
| Scheduler | `setInterval` every 5 s plus `kick()` after mutations | `kick()` inline after mutations, as today. Periodic ticks come only from the DO alarm and only while the clock rate is above 0. Hosted default `WEFT_CLOCK_RATE=0` (frozen at Mon 2026-10-26 08:30 PT), so time moves only through the Simulators advance buttons |
| Agent run queue | in-process queue, concurrency 1 (openai) or 8 (scripted) | the same queue behind a `RunHost` port. A job starts inside a DO alarm invocation, so its fetches count against a fresh 50-fetch budget. One live run per alarm invocation; the alarm re-arms while runs are queued |
| Boot rule | `PROCESS_RESTART` for running and queued runs | unchanged. The DO constructor calls `agent.boot()`, so a cold start is a process restart. Waiting and held runs survive (handles live in `run_handles`) |
| Spend ledger | jsonl files and an mkdir lock | `SpendDO` running `apps/cf`'s own ledger, with the file ledger's fold semantics, over a SQL table (5.5) |
| Memory | git CLI repository | SQL `MemoryRepo` that writes real git blob, tree and commit objects (same SHAs as git) |
| Seed | `pnpm db:seed` | a snapshot built on Node at deploy time and restored in the DO; the seed generator never runs in a Worker |
| Web | `next dev` / `next start` with the `/api` rewrite and `src/proxy.ts` | `next build` with `output: "export"`, served as static assets; the front Worker takes over the rewrite and the proxy's job |
| MCP | stdio `apps/mcp` | stateless Streamable HTTP inside the slot DO at `/mcp`, reusing `createMcpServer(cfg, fetchImpl)` with `fetchImpl` calling the DO's own Hono app in process |
| Tracing | Phoenix when `WEFT_TRACE=phoenix` | not hosted; the in-app run trace, AI Gateway logs and Workers traces take its place |
| QuickJS sandbox | opt-in `WEFT_SANDBOX=quickjs` | `WEFT_SANDBOX=off`, the same default as Node |
| Vendor adapters | simulated unless `WEFT_INTEGRATIONS_REAL=1` | always simulated |

### 3.4 Request paths

- **Page load.** Every `/`, `/app/**` and `/portal/**` page is a static asset: no Worker invocation and no request count (research: static assets billing).
- **API call.** The browser sends `/api/v1/...`. The front Worker:
  1. verifies `__Host-weft` (HMAC over `visitor, slot, gen, exp, leaseExpiresMs`, about 0.1 ms; `leaseExpiresMs` names the lease, 6.4);
  2. applies `RL_API` keyed on the daily-salted IP hash (a valid `x-weft-smoke` visit skips it; 6.3);
  3. routes to the visitor's slot, or to `showcase` when there is no lease;
  4. for POST, PUT, PATCH and DELETE, checks `Origin`, the human grant `__Host-weft-h` and `RL_MUTATE`, and refuses showcase mutations with 409 `LEASE_REQUIRED`;
  5. deletes client copies of `x-weft-proxy`, `x-weft-ctx` and `x-weft-smoke`;
  6. sets `x-weft-proxy` (secret) and `x-weft-ctx = hmac({slot, gen, visitor, ipHash, human})`;
  7. rewrites `/api/v1/*` to `/v1/*` and forwards to `COMPANY.get(idFromName(slot))`, streaming the body.
  The DO answers 409 `LEASE_ENDED` when the cookie's generation is older than the world's; which of those cookies the front keeps and reissues is in 6.4.
- **Live updates.** `/api/_live` upgrades to a WebSocket. The front Worker authorizes it the same way and forwards it to the visitor's slot (never a slot named by the client). The DO accepts it hibernatably and sends `{seq, tables}` after every commit. Outgoing messages are free and the client sends none (pings use the auto-response), so an idle open tab costs nothing (research: hibernatable WebSockets).
- **Active run steps.** The existing SSE route stays for active runs only (it ends at a terminal status). The hosted web raises its trace-poll fallback from 1 s to 5 s.
- **Model step.** Inside the alarm: reserve in `SpendDO` (RPC), call the provider (AI Gateway fetch or `env.AI.run` with `{ gateway }`), settle, then run executor calls in short transactions.
- **After-commit job.** Commands that need OCR, an embedding or a PDF append an `outbox` row inside the command's transaction. After the outer commit the DO sends the job to a Queue and deletes the row. A row whose send fails stays for a retry that backs off (2 s doubling, at most 5 minutes); one whose send failed in at least 12 flushes in a row and for at least 20 minutes since the first of them (the backoff alone makes the 12th about 23 minutes after the first, but every commit that writes an outbox row and every boot flush too, so a short Queue outage can fail a row 12 times within seconds; the count and the first failure's time are kept in the object's storage, so an eviction starts neither again) is recorded in D1 `failed_jobs` as `OUTBOX_UNSENT`, logged and deleted, so it stops costing an alarm every 5 minutes. The consumer does the I/O and calls back into the DO through a hidden service command (section 5.4).

### 3.5 Serving the Next app

- **Export build.** `WEFT_STATIC_EXPORT=1` switches `next.config.ts` to `output: "export"`, `trailingSlash: true`, no `rewrites()`, and `pageExtensions: ["tsx"]`. `src/proxy.ts` is the only `.ts` file the app router would pick up and every page and layout is `.tsx`, so the proxy drops out of the export. Fallback if Next still bundles it: the deploy builds in a throwaway git worktree and deletes `src/proxy.ts` only there. The fidelity probe build emitted 226 files, 5.1 MB, for all 30 routes, so OpenNext and vinext are not needed, and Next 16.4.2 and React 19.3.0 stay pinned. Next moved from 16.4.0 to 16.4.2 for three security advisories against 16.4.0, GHSA-2464-fhr4-w9xw and GHSA-673q-mjm6-r5xr (critical) and GHSA-p3m5-59mp-jv5r (high); 16.4.2 fixes all three.
- **Dynamic ids.** The five `[id]` segments (people, payroll, runs, routines, offboarding) export `generateStaticParams() { return [{ id: "_" }] }`. A `useRouteId(section)` hook reads the real id from `usePathname()` when the prop is `_`; it works on Node too. `_redirects` rewrites `/app/people/* /app/people/_/index.html 200` and the matching `index.txt` RSC payload for each section. To verify in cf5: whether Workers assets honor these 200 rewrites. Fallback: add the five patterns to `run_worker_first` and serve the shell with `env.ASSETS.fetch`.
- **Landing.** `/` drops `force-dynamic`. A `stats.json` written by the snapshot builder renders first; leased visitors then refresh it from `/api/v1/stats`. An unleased landing visit costs zero Worker and DO requests.
- **Headers.** `_headers` sets `frame-ancestors 'none'`, `Referrer-Policy: same-origin`, `X-Content-Type-Options: nosniff`, and a CSP that allows scripts and frames from self and `challenges.cloudflare.com` and connections to self. The export emits inline RSC payload scripts, so cf5 hashes them into per-route CSP rules (30 routes, under the 100-rule `_headers` limit); `'unsafe-inline'` for scripts is the fallback.

## 4. Storage mapping and invariants

### 4.1 Where each kind of data lives

| Today | Cloudflare home | Notes |
|---|---|---|
| `.data/weft.db`: all 99 tables | `CompanyDO` SQLite, same 8 migrations, 160 indexes and 8 triggers | widest table 31 columns (limit 100); at most 72 bound parameters seen (limit 100); rich world 4.4 MB (limit 1 GB per object, 5 GB per account; probe wrote 15 MiB to one object without error) |
| `.data/companies/<id>/memory` (git, 90 files, 36 commits) | `mem_objects(sha PK, type, body)`, `mem_refs(name PK, sha)`, `mem_log(seq PK, sha, parent, date, chain_seq, chain_hash)` | new migration `0008_hosted.sql`, also present on Node and unused unless `WEFT_MEMORY=sqlite` |
| `<dataDir>/uploads/<sha256>` | `blobs(key, idx, bytes)`, 1 MiB chunks; `uploads.storage_path` becomes `blob:<sha256>` | under the 2 MB row limit; the reset path covers them; hosted upload cap 1.5 MB, image, PDF or text, 5 per visitor per day |
| `runs/<id>/artifacts/*.json`, `runs/<id>/code/*` | `run_files(path PK, body)` | the `run_artifacts` row is unchanged; bodies over 2 MB are chunked |
| `run/handles/<run>.json` | `run_handles(run_id PK, token, nonce)` | a bearer credential; never in `run_steps`; no route reads it |
| `run/proxy.secret` | Worker secret `WEFT_PROXY_SECRET` (both scripts) | |
| `run/vault.key` | Worker secret `WEFT_VAULT_KEY` | hosted fails closed when it is missing (`WEFT_REQUIRE_VAULT_KEY=1`); the snapshot is sealed with the same key |
| `companies/.world-id` | `kv_state('world.id') = "slot-N:gen-G"` | the generation increments on every reset, so run ids restart safely for the ledger |
| `demo-api-key.txt`, `demo-mcp-key.txt` | not shipped | seeded keys are revoked in the snapshot; each lease mints its own keys (hash stored, plaintext shown once and kept in `kv_state` for the redactor) |
| `run/errors.log` | `console.error`, redacted, to Workers Logs | |
| `.data/spend/<day>.jsonl` | `SpendDO.spend_entries(at, day, world, run_id, kind, reservation_id, usd_micros, model, live, visitor, ip_hash)` and `neuron_entries(day, product, model, neurons)`, with their per-day totals in `spend_days` | never reset with a world; the orphan sweep prunes entries older than 3 UTC days (the live totals of pruned rows carry over, 5.5) |
| `WEFT_SECRETS_FILE` | Worker secrets only | |
| Fixtures (mailed notices, scenario notices, `scenarios/*.json` at 236 KB, `drizzle/*.sql` and journal) | generated module `apps/cf/generated/fixtures.ts` plus wrangler Text rules | CI checks the module is fresh |
| Seeded world | `apps/cf/generated/snapshot-rich.sql.gz` (Data module, about 253 KB) plus `seed-rows.json.gz` (per-table rows for the delta reset) and `manifest.json`. Despite its name, `snapshot-rich.sql.gz` is gzip JSON, not a SQL script: an array of `{table, sql, args?, rows}` INSERT chunks with blobs as `{ "$b64": ... }` (`encodeSnapshot` in `packages/db/src/snapshot.ts`) | built at deploy time in the build worktree and gitignored; private, never a public asset, because it holds vault ciphertext sealed with the deploy key and key hashes |
| Outbox (new) | `outbox(id PK, kind, body, created_at)` in the slot | written in the command's transaction, deleted after the Queue send |
| Leases, pool, daily counters (new, global) | `LobbyDO` SQLite | |
| Flags, model default, kill switch, snapshot version (new) | KV `weft-config`, memoized 60 s in the isolate | far under 1,000 writes a day |
| Run outcomes, daily budget rows, failed jobs, smoke results (new) | D1 `weft-ops` | aggregates only reach visitors |
| PDFs, exports, help corpus (new) | R2 `weft-files`: `w/<slot>/g<gen>/pdf/<sha>.pdf`, `seed/<snapshot>/pdf/<sha>.pdf`, `exports/`, `help/` | lifecycle: `w/` and `exports/` expire after 3 days |
| Memory embeddings (new) | Vectorize `weft-memory` (768 dims, cosine): namespace `seed-<snapshot>` shared by all worlds and `slot-N` per slot, metadata `{path, commit, gen, tainted, kind}` with indexes on `gen`, `tainted` and `kind` | recall filters on `gen == current` |

D1 stays out of the data path. It has no interactive transactions (only `db.batch()` is a transaction), and the executor reads, decides and writes inside one transaction; 50 queries per invocation and a round trip per statement do not fit the 67 GET routes that issued 599 statements on Node (research: D1).

### 4.2 The database facade: `openDurableDb(storage)` in packages/db

- It builds `new LibSQLDatabase("async", dialect, new DurableSession(facadeClient, ...), schema)`, typed as `Db` with `$client` set to the facade, so drizzle-orm/libsql and every `Db` and `DbTx` type stay unchanged.
- `DurableSession.transaction(cb)` is `storage.transaction(async () => cb(new DurableTransaction(...)))`. `DurableTransaction.transaction(cb)` is the same call nested. The drizzle callback runs inside the storage callback, so every write it issues, after any number of awaits, belongs to the transaction. Drizzle's `savepoint`, `release` and `rollback to` statements are never emitted.
- `facadeClient.transaction()` throws `UNSUPPORTED_LINEAR_TRANSACTION`. The deferred-commit and linear begin/commit shapes are unreachable, and the conformance suite keeps them as negative tests.
- `execute({ sql, args })` runs `sql.exec(sql, ...args)` and returns a libsql `ResultSet`. `rowsAffected` and `lastInsertRowid` come from one `SELECT changes(), last_insert_rowid()` after each non-read statement, never from `cursor.rowsWritten`, which counts index entries (verified locally: 2 against 1 on a compare-and-set).
- `batch()` and migrations run in `transactionSync`. `executeMultiple` drops `journal_mode` and `busy_timeout` (both return SQLITE_AUTH in workerd); `foreign_keys` and `defer_foreign_keys` pass through.
- Statements with more than 100 bound parameters are rewritten with inlined literals; values over 2 MB are refused with a clear error; DO errors get `code` and `extendedCode` from the `(extended: SQLITE_...)` suffix.
- **Meter.** Per request it records `rowsRead`, `rowsWritten` and the sets of tables read and written (from drizzle's quoted identifiers). It feeds the ETag versions (4.5), the clean-slot check, the Lobby's daily counters and the tests.
- **`IO_IN_TX` guard.** The facade sets `inTx` for the whole outer transaction. On the durable platform the BlobStore when backed by R2, the provider transports, the Queue producer and every DO RPC stub call `assertNotInTx()` and throw `IO_IN_TX`. A transaction body that waits on real I/O holds the object's input gate and resets it at the 30 s timeout (verified locally), so this turns that failure into a test failure. A lint rule also forbids self-RPC inside the executor.
- **Write lock.** `writeLocked` and `withWriteLock` stay, keyed per world through `WorldScope`, because several DO instances can share an isolate and today's module-level `tail` would serialize different visitors.
- **workerd behavior the facade relies on** (cf1, verified locally in Miniflare 5.20261019.1-beta with workerd 1.20261019.1; the `node:sqlite` emulator in `packages/db/src/emu.ts` copies each one and the conformance suite pins it on both):
  - `sql.exec` runs every statement of a script but binds only the last one and returns the last one's cursor; `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT` and `RELEASE` are refused.
  - The authorizer refuses `journal_mode`, `busy_timeout`, `user_version`, `integrity_check` and the other PRAGMAs outside workerd's list, `ATTACH`, temporary objects, `sqlite_version()` and similar functions, and any `_cf_*` table. Limits: 100 bound parameters, 100,000 bytes per statement, 100 columns. Errors read `<message>: SQLITE_X (extended: ...)`.
  - Bindings: numbers bind as REAL, booleans as the text `"true"` or `"false"`, `undefined`, NaN and Infinity as NULL, other objects as their string; a BigInt throws. Integers read back as numbers.
  - Writes outside an explicit transaction join one implicit SQLite transaction that commits at the end of the turn, once the microtask queue drains. Inside it a `PRAGMA foreign_keys` change does nothing and `defer_foreign_keys` stays on, and a commit that leaves a deferred foreign key violated resets the object.
  - `transaction(closure)` starts its closure on the next turn, after the caller's pending microtasks, and holds the input gate until it settles. Every statement while it is open belongs to it, after any number of awaits, and nested calls are savepoints that roll back alone. A second event, or a timer scheduled from outside the transaction, waits for the gate, so a body that waits on one deadlocks; after 30 s the object resets, the transaction rolls back and rejects, and the next event gets a fresh object.
  - `rowsWritten` counts an inserted row as 1 plus one per index on its table, an updated row as 1 plus one per index over a changed column, a deleted row as 1, a row a trigger inserts as 1 plus its table's indexes, DDL as 1 and DROP as 0. The emulator approximates this count and pins it only where it agrees with workerd; its `rowsRead` is a lower bound.

### 4.3 How each harness invariant holds

| Invariant | Mechanism on Cloudflare | Pinning test |
|---|---|---|
| The executor is the only writer; state change, simulator writes and the action row commit together | same pipeline code; `db.transaction` is `storage.transaction`: atomic, rolls back on throw, serializes the whole object (verified locally) | conformance on the emulator and in workerd, plus the scenario suite on the emulator |
| A failing command leaves only its refusal (`pipeline.ts:275` savepoint) | nested `storage.transaction` (verified locally: inner-only rollback) | a throwing `def.run` leaves no rows and one `exec_calls` refusal |
| Approval executes once | `rowsAffected` from `changes()`; both CAS updates (`status='pending'`, `executed_action_seq IS NULL`) and the UNIQUE index unchanged | double approve on one slot from two concurrent requests: one execution and one `NOT_PENDING`; approve racing deny: one wins |
| Hash-chained, append-only `actions` and `approval_audit`; Undo appends a reversing row | triggers unchanged (verified locally in workerd); the head read-then-insert is serialized by the transaction gate | `GET /v1/actions/verify` valid after GP1 approve plus Undo, after a full restore and after a delta reset; UPDATE and DELETE on `actions` fail with `SQLITE_CONSTRAINT_TRIGGER` |
| Only the reset path removes log rows | full restore uses `deleteAll()`; the delta reset drops the append-only triggers, deletes rows past the seed and recreates the triggers inside one `transactionSync` (verified locally); point-in-time recovery restores storage | reset digest equals the manifest digest; chain verify valid |
| Taint | `run_taint` and the untrusted wrapper nonce unchanged, in the same transaction; OCR extracts are listed in `UNTRUSTED_LIST` | GP5 (injected notice) and the @weft mention test: run tainted, zero executed R2 to R4; an OCR extract read taints the run |
| Grounding | pure package, unchanged | chat grounding tests in the scenario suite |
| Spend caps | `SpendDO` runs `apps/cf`'s own ledger, which keeps the file ledger's fold, totals and cap semantics (5.5); reserve before each attempt, settle after; open reservations count as spent; reservations are made outside executor transactions (a cross-DO write survives a company rollback, verified locally) | cross-slot day cap; run cap; crash between reserve and settle leaves the reservation counted; orphan settles at worst case after 15 min |
| Execute once under retries | `exec_calls(run_id, call_id)` dedupe unchanged; alarms are at-least-once | a replayed alarm with the same call ids executes nothing twice |
| Boot rule `PROCESS_RESTART` | unchanged; a running run exists only inside an alarm invocation, so eviction mid-run means a deploy or a kill, and the run fails visibly | kill the DO mid-run (Miniflare abort): the run fails with `PROCESS_RESTART` and its routine run fails visibly |
| Memory with provenance | the same `store.ts` over a `MemoryRepo`; `SqlRepo` writes real git objects with `+0000` sim-clock dates, so commit ids match git byte for byte; `Weft-Chain-Head` trailers and `verifyChain` gitLag unchanged; path rules, PII and secret refusals and the tainted-run refusal stay in shared code | rich memory on both repos: identical HEAD and all 36 commit SHAs, identical search, read-at, history, tree and recall output; `git fast-import` of the export reproduces the SHAs |
| Sim clock | `settings` row unchanged; spend uses the wall clock | clock advance buttons in the smoke |

The table rests on the workerd behavior listed in 4.2: the closure transaction holds the input gate and owns every statement issued while it is open, nested calls roll back alone, and a commit that leaves a deferred foreign key violated resets the object instead of committing.

One semantic gets stronger: a `memory.write_note` inside a command that later rolls back is rolled back too, where git keeps it today. The contract tests compare committed state only.

### 4.4 Reads that write nothing

- **Ephemeral read ids.** For `def.effect === "read"` with no run (`scope.run == null`), the pipeline returns `resultId = "res_e_" + 16 random hex` instead of minting a counter id. Run reads keep counter ids, because `exec_calls.outcome_json` persists them. The disjoint prefix means no persisted id can collide after an eviction. It is an executor option, `ephemeralReadIds`: on for the durable platform, off on Node, so Node's id sequences and pinned eval digests stay unchanged. Pins: with the option on, a sweep of all 67 GET routes writes 0 rows (facade meter); after the scenario suite no column of any table contains `res_e_`; `tests/scenarios` pass.
- **Routine definitions.** `ensurePrebuilt` stores a hash of the code-owned prebuilt definitions in `kv_state` under the key `routines.prebuilt_hash` and skips the comparison when it matches. The gate is always on for the durable platform; on Node it is on only behind `WEFT_PREBUILT_HASH=1`, which the snapshot build sets, so any other Node world compares the rows on every boot and writes no `kv_state` row, as before. `kv_state` is never in the world digest, so the base and eval digests are unchanged. The snapshot is dumped after one boot and one scheduler tick (9.2), so its rows and its hash already match the code. Pin: a cold start on a restored snapshot writes 0 rows on its first tick.
- **Showcase.** A cold start plus a full GET sweep on the read-only showcase writes 0 rows (facade meter, then GraphQL `durableObjectsPeriodicGroups` after the deploy).

### 4.5 Rows read and polling

- **ETag/304 on table versions.** The slot keeps an in-memory version per table, bumped on every commit that wrote it. A GET's ETag is `W/"<gen>.<hash(route, query, principal, versions of the tables it read)>"`. A request with a matching `If-None-Match` whose recorded tables have unchanged versions gets 304 without running the route: 0 rows read. Eligible routes are the GET routes the web polls (`refreshMs` in `apps/web/src/lib/api/hooks.ts`), and any route whose handler touched a source outside the company SQL (SpendDO, KV, env) is marked uncachable by its adapter. The versions start fresh after a restart, so the first poll after a restart computes normally.
- **`x-weft-tables`.** GET responses list the tables they read. WebSocket messages list the tables a commit wrote. The web refetches only queries whose tables intersect, and with the socket connected, polling drops to a 60 s safety net.
- **N+1 fix.** `time_off.list_requests` batch-loads workers, policies and balances with `inArray` queries. Pin: on the rich world the response is byte-identical before and after, with at most 6 statements.
- **Web.** Polling stops while `document.hidden`; after 2 minutes without input the interval is multiplied by 4 (capped at 60 s); the hosted build multiplies every interval by 2.
- **Showcase memo.** The showcase is immutable per snapshot, so the front Worker keeps an in-isolate memo of showcase GET responses keyed by path, query, principal and snapshot version, bounded at 4 MB. A memo hit costs a Worker request but no DO request and no rows read.

### 4.6 World resets

| Method | How | Cost | Status |
|---|---|---|---|
| **Point-in-time recovery** | after a slot's full restore, store `getCurrentBookmark()` in the Lobby; reset is `onNextSessionRestoreBookmark(bm)` then `ctx.abort()` | rows written undocumented; bookmarks cover 30 days; not available locally | to verify on the first deploy (GraphQL rows written per slot name); used only if close to 0 rows |
| **Delta reset** (default) | dirty-tracking triggers, armed at restore on every table but `kv_state` (the slot's own stamp; see below), record touched keys in `_weft_dirty(tbl, pk)` with `INSERT ... WHERE NOT EXISTS` (an `INSERT OR IGNORE` inside a trigger fails under an outer UPSERT, verified locally). Reset, inside one `transactionSync` with `defer_foreign_keys=ON`: delete dirty rows, reinsert their seed rows from the bundled `seed-rows.json.gz`, drop and recreate the append-only triggers around the log deletions, restore `sqlite_sequence` and `id_counters`, wipe `_weft_dirty` with DROP TABLE (0 rows written) and recreate it, then check per-table JS digests of the dirty tables against the manifest | 717 rows written in workerd (716 on the emulator) after a 10-flow session on SQL memory, the repo every hosted world uses, so the band is 896 (25% above); recorded on 2026-10-21 in the cloud session's Linux container, not yet verified locally. The 557 rows written and 6,789 rows read (verified locally by the risk design) were measured with memory in git, outside the database, and bound only that case. Tracking adds 8.5% to activity writes (verified locally) | default |
| **Full restore** | `ReseedWorkflow`: `deleteAll()` (also clears the alarm from compat date 2026-02-24), migrate, about 100 INSERT chunks under 90 KB, arm the dirty triggers, verify counts, digest and chain head, take a bookmark, mark the slot clean | 20,556 rows written (verified locally) | first seeding, snapshot or schema changes, digest mismatch |

After any reset: `gen += 1` (the Lobby holds the authoritative generation and stamps it into the slot, which also covers a point-in-time restore), keys minted for the lease are gone with the dirty rows, the previous generation's slot vectors are deleted by id (ids recorded in the Lobby at upsert), and `ctx.abort()` rebuilds the in-memory runtime (otel state, redactor, ETag versions). While a reset, a restore or a new generation's stamp stops a world and starts the next one, only that step boots it: an alarm that fires meanwhile asks again after a backoff instead of booting, an extras RPC from a queue consumer is refused with `WORLD_NOT_READY` (the queue retries it), a boot of the previous stamp still in flight is closed instead of served, a boot that fails after its engine came up closes that engine (its fence shut and its scheduler stopped) before the next boot, and an engine serves only the stamp it was booted for. A reset waits at most 10 s for mutations in flight and the engine's close drains runs for at most 5 s more, so the close shuts that engine's view of the storage last (`closableStorage` in `apps/api/src/platform/durable.ts`), in a `finally`, so a scheduler stop or an executor close that throws still shuts it: a statement or transaction that a write-back or an alarm-hosted run still going issues afterwards throws `ENGINE_CLOSED` (a transaction open then rolls back at its next statement), and nothing it does commits into the next generation, whose engine opens its own view. A queue job's write-back and export carry the job's generation, and the world refuses one from another generation (`STALE_GENERATION`, answered as a value that is never retried, since an error thrown across the RPC would reach the queue as a plain retryable Error; the job finishes as `stale`), so a late OCR read or export of the previous visitor never lands in the next visitor's world. A full verify (every table but `kv_state`, about 8k rows read with the JS digest, against 47,814 for an EXCEPT verify) runs weekly and on any mismatch. `kv_state` is restored with the snapshot (its seed row is `routines.prebuilt_hash`) and checked by the restore itself, but the slot stamps itself there after every restore and reset (`world.id`, the lease), so it is never dirty-tracked and the weekly verify leaves it out; otherwise every clean, stamped world would fail the verify and get a full restore it does not need (verified locally: a real-engine Miniflare case verifies the showcase and a reset slot, then sweeps eight days on and starts no restore).

A deploy that changes migrations or the snapshot marks every slot stale. A stale slot keeps serving its current lease, then gets a full restore instead of a delta reset, within the daily restore budget. So schema changes are batched (section 9.5).

## 5. Model path

### 5.1 Default: OpenAI `gpt-5.6-luna` through AI Gateway

- The OpenAI provider is unchanged except `baseURL = https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway>/openai`, with the account id and gateway name read from the environment. The body stays identical: `/responses`, strict tools, `reasoning.effort: "low"`, `store: false`, `prompt_cache_key`. A request snapshot test pins that only the URL and headers change.
- Headers:
  - `cf-aig-metadata` with at most 5 keys: `{slot, gen, run, kind, visitor}`;
  - `cf-aig-authorization: Bearer <CF_AIG_TOKEN>` once the gateway is authenticated (section 9.3);
  - no `cf-aig-skip-cache` and no `cf-aig-collect-log` override, so the gateway's logging and caching apply as Nitish chose.
- **Gateway `weft` settings.** Logs collected; cache TTL 1 day; rate limit 60 requests per 60 s (sliding); a spend-limit rule of $2.50 a day on provider openai as an eventually consistent backstop behind Weft's own $2.00 cap (research: AI Gateway spend limits are eventually consistent and return 429). Whether spend rules apply on Free is to verify; Weft's caps are the real gate either way.
- **What caching does here.** Gateway caching is exact match on the whole request (research: AI Gateway caching). Agent calls carry a per-run nonce, so they hit only when an at-least-once alarm replays an identical step. Deterministic calls do hit: seed memory embeddings, OCR of an identical image, and replayed evaluation calls. The provider calls `.withResponse()` and settles at $0 only when `cf-aig-cache-status: HIT` is present. The smoke checks a HIT on a repeated seed-embedding call, never on an agent step.
- **Logs.** This account's first gateway was created after 2026-09-24, so gateway logs go to Workers Logs and its allowance (research: AI Gateway limits). Logs keep visitor-typed text, so the hosted shell says the data is fictional and asks visitors not to type real personal data. Weft's redactor still runs before any tool output reaches a prompt. A KV flag `aig.collect_log` exists as an operations lever if the shared logs allowance runs short.
- **Key placement.** Phase 1: `OPENAI_API_KEY` as a weft-core Worker secret; the redactor learns it as today. Phase 2 (to verify on Free): BYOK, with the key held in the existing Secrets Store (one store per account, measured) through the gateway; the Worker then sends no `Authorization` header (an injected fetch strips the SDK placeholder).
- **Pricing.** The ledger prices from Weft's Luna table ($0.20 in, $0.02 cached in, $1.20 out per million tokens). The gateway catalog also lists $0.25 per million for cache creation, which Weft's table does not charge. `pnpm cf:budget` compares the daily ledger with the gateway's cost and reports any gap; it is never silently trusted.

### 5.2 Switch: Workers AI `@cf/openai/gpt-oss-120b`

- Provider id `workers_ai` (an ext contract addition), badge "Workers AI gpt-oss-120b". It uses the same Responses request builder and parser over a transport that calls `env.AI.run(model, body, { gateway: { id, metadata } })`, non-streaming (Weft does not stream). The probe measured Responses-shaped output through the binding with gateway logging and caching (532 ms, 2.26 neurons for 75 input and 28 output tokens); function calling is documented for this model.
- `live: true`, so the run and day caps apply. It is priced in USD equivalents of neurons (31,818 per million input, 68,182 per million output; research: Workers AI pricing), with a neuron day cap in `SpendDO`.
- **Neuron budget.** The account gets 10,000 neurons a day and other apps peaked at about 1,800. Weft's share is 5,000: agent 4,000, OCR 500 (about 50 receipts at 10.1 each, measured), embeddings 200, dictation 300. At about 12k input and 300 output tokens per run, that is about 10 Workers AI runs a day (estimate; the research's 40k and 3k assumption gives about 6 on the whole allowance).
- **Selection.** KV `model.provider` is the global default. A per-world `settings` row set from the Simulators panel overrides it. The provider is chosen once at run creation and pinned, as today. When `SpendDO` reports less than $0.01 left for the day or the visitor, or the neuron cap is spent, the run is created on the scripted provider with its honest badge and the hosted banner says why.
- **Side by side.** Hosted run outcomes (provider, model, steps, grounded, cost, neurons, latency, outcome) go to D1 for the model comparison page. Evals stay on Node: a Node `workers_ai` transport over the gateway's Workers AI REST path gives the offline comparison; it needs a narrow Workers AI token that Nitish creates, and the `LIVE_PROVIDER_IN_TEST` guard covers the new provider.

### 5.3 Unattended runs

`WEFT_BACKGROUND_LLM=1` on hosted, matching `docs/demo-scenarios.md`, so routine runs show the live agent. With the clock frozen, a routine run only follows a visitor's mutation in that slot (a delivered notice, an accepted offer, a clock advance), which is already behind Turnstile and the lease. The slot stores the lease's visitor and IP hash, and every reservation for a background run is charged to them, so background runs sit inside the same visitor, IP, run and day caps. The cron sweep never fires a world's routines.

### 5.4 Embeddings, OCR and dictation

- **Embeddings:** `@cf/baai/bge-base-en-v1.5` (768 dims; the probe ranked "when do we pay salaries" first at 0.708) through the gateway. The seed's 90 memory files (about 250 chunks, 0.19M stored dimensions) are indexed once per snapshot into `seed-<snapshot>` by the operator: `POST /api/_admin/seed-index` (admin HMAC) runs one step on the showcase (its memory is the snapshot's), paid for batch by batch through SpendDO's embeddings share (200 neurons a day), and the Lobby keeps the next chunk per snapshot, so the call is repeated once a day until it answers `done`; semantic recall stays off until then. Notes written after a reset go to the slot namespace with their generation.
- **Semantic recall** stays off (`WEFT_SEMANTIC_RECALL=0`) until the live L1 to L4 gate and the recall evals show no regression. Then the deploy track flips the KV flag. A candidate hit is re-read from the slot's `MemoryRepo` at HEAD and kept only if its path and commit still match, so citations stay `path#L<line>` at a real commit, and tainted hits keep `trustedOnly`. `memory.search` itself stays a fixed-strings grep (harness 9.4). Vectors become visible 1 to 3 minutes after upsert (measured), so fresh notes are found lexically first.
- **Receipt and notice OCR:** uploads enqueue a job; the consumer normalizes the image with the Images binding (at most 1024 px JPEG), reads it with `@cf/mistralai/mistral-small-3.1-24b-instruct` (measured: merchant, date and total 10.62 read correctly in 1.07 s for 10.1 neurons, no license step), and writes the extract back through a hidden service command (`expenses.attach_receipt_extract`, `notices.attach_scan_extract`). These commands are registered only on the durable platform through an `extraCommands` option, so Node's registry and its count assertions stay at 190; they are never exposed over MCP and are on no allowlist. The extract fields are in `UNTRUSTED_LIST`, so a run that reads them is tainted. `llama-3.2-11b-vision` needs a Meta license agreement and is never used.
- **Dictation (Dictate button in the composer):** `@cf/openai/whisper-large-v3-turbo` (measured correct on a 3 s clip), clips of at most 30 s, 46.63 neurons per audio minute; the text fills the composer and is never sent on its own.

### 5.5 Which spend, run and config code the Worker runs

The Worker runs `apps/cf`'s own pieces, never cf3's:

- **Spend ledger.** `SpendDO` keeps `apps/cf/src/core/spend/ledger.ts`: the file ledger's fold (a reservation is open at its reserved amount until a settle or release closes it, and open reservations count as spent), plus the visitor, IP hash, neuron and live caps, checked and inserted in one synchronous transaction. A world reaches it through `hostedSpendLedger` in `apps/api/src/platform/durable.ts`. Its reads stay flat however many entries exist, and they stay flat cold, since DO rows read are an account-wide daily cap that any caller of a public route could otherwise spend, and a Durable Object with no timers, I/O or WebSockets hibernates after about 10 s idle and drops its memory (it is evicted after 70 to 140 s otherwise), so nothing is kept in memory: each UTC day's fold is persisted in `spend_days`, one row per day (settled and open micros, open reservations, neurons, neurons by product with the direct neuron entries, and the same micros and neurons for live entries), updated in the same `transactionSync` as every write that changes it (reserve, settle, release, the orphan sweep's settles, direct neurons, pruning). So a status, the day and live totals `GET /v1/agent/costs` asks for (any visitor, for any `day`) and the Platform page's `status({})` read only `spend_days` and the live carry, a few rows, never an entry, however many entries exist and on a ledger that just woke up; a day outside the retained three (today and the two before it) answers zero without a query; a reservation reads its own run's rows, today's row and, for the visitor and IP-hash caps, only that visitor's and that address's rows of the day (partial indexes on `(day, visitor)` and `(day, ip_hash)`), and a leased visitor's status reads the same two. Unit tests meter every one of these on a fresh ledger over a table of thousands of entries, as after a hibernation, on a small table and one hundreds of times larger, and check after random reserves, settles and releases of earlier days' reservations, direct neurons, orphan sweeps and pruning that the persisted rows equal a full fold of the entries left and that the live totals equal that fold plus the carry. The cron's orphan sweep reads only the reservations that crossed the 15-minute orphan age since its previous run (a partial index on reservations by time), then prunes entries older than 3 UTC days in bounded batches (at most 500 reservations, each with its settle or release row, and 500 direct neuron entries per sweep, so a backlog is deleted over several sweeps instead of one large write), taking each batch out of its day's row and carrying its live part into `spend_meta`, so the cumulative live cap still counts it; an old day's row goes with its last entry. Its tables and indexes are created with `IF NOT EXISTS` in the constructor, so an existing ledger gains a new index once and every later start creates nothing. A schema 1 ledger (totals in memory) is upgraded once at its first start: the day rows are built from its entries (each read once; the table holds 3 days of entries) in the transaction that records schema 2, and the partial `live` index the in-memory totals were built through is dropped. Each entry now writes two more index rows (visitor, IP hash) and one `spend_days` update, about 2 rows written more per reserve or close than before. The front asks SpendDO for the caps only on a leased visitor's `GET /api/_session`; a cookie-less read reaches it only through the Lobby's degradation level (`status({})`, a few rows cold, 6.5).
- **Run host.** The alarm run host in `apps/cf/src/core/company/hosts.ts` (3.3).
- **Config fold.** CompanyDO folds KV `weft-config` into the world's env under the `WEFT_*` names the stack reads (`apps/cf/src/core/company/company-do-env.ts`), at most 60 s old, so the caps, the model switch and the kill switch change without a redeploy.

cf3's equivalents in `packages/agent` (`createSqlSpendStore`, `createHostedSpendLedger`, `kvCapsSource`, `bindSpendLedger` and `alarmRunHost`) are test-only: their own tests pin them, and no deployed path imports them. A change to the hosted caps or the fold is made in `apps/cf`.

## 6. Public-agent protection and demo-company isolation

### 6.1 Three kinds of world

| World | Who | Writes | Gate |
|---|---|---|---|
| `showcase` | every visitor without a lease | refused at the edge (409 `LEASE_REQUIRED`) and again in the DO (`kv_state('world.readonly')`) | none; reach is not limited by the pool |
| `slot-1..N` | one visitor at a time, leased | the full app, the live agent | Turnstile at lease start and a fresh human grant for mutations |
| `slot-smoke` | the deployed smoke only | full app, provider forced to scripted | `x-weft-smoke` HMAC with `WEFT_SMOKE_TOKEN` over method, path and timestamp, so a leaked header works for one request shape only; never leased |

### 6.2 Visitor flow

1. **Browse.** `/app` loads statically. API calls without a lease go to `showcase`. A banner says it is a shared read-only demo company and offers "Start my demo company".
2. **Start.** The managed Turnstile widget runs, then `POST /api/_session/lease {token}`. The front Worker calls siteverify with `remoteip` and an `idempotency_key` (tokens are single-use and expire after 300 s; research: Turnstile). The key is one UUID per verification, sent again only on the one retry after a transport failure (a network error, a timeout or a 5xx), so a token Cloudflare redeemed for a lost answer is not refused as a duplicate, while a token the client sends again is a new verification and is refused. A key derived from the token would make every replay pass. On success `LobbyDO.assign(visitor, ipHash)` returns `{slot, gen, expiresAt}` or a waitlist position, subject to at most 20 leases per IP hash per UTC day (section 0). The front sets `__Host-weft` and the human grant `__Host-weft-h` (10 min), both HttpOnly, Secure, SameSite=Strict.
3. **While leased.** Every mutation needs a valid grant, otherwise 428 `TURNSTILE_REQUIRED`. The web then runs the widget (usually without interaction), posts the token to `/api/_session/verify` and retries once. Every route that can start a model call is a POST, and unattended runs follow only from those POSTs (5.3), so "Turnstile before model-calling actions" holds without a per-route list. That covers chat, the portal ask, @mentions, routine drafts, Run now, Deliver, Mark accepted, Review with agent, Run review now and approvals that wake runs.
4. **Lease end.** 15 minutes idle or 60 minutes in all. The slot keeps its last-activity time in memory and reports it when the Lobby asks, which saves writes. The Lobby releases the slot and resets it right away (4.6), so the next visitor gets a clean world. A slot whose facade meter shows zero domain writes is reassigned without a reset. Only the reset asks a slot whether it is clean (`heartbeat({ clean: true })`, then the stamp's own `ifClean` check), and the check stops at the first dirty key (`SELECT 1 ... LIMIT 1` on `_weft_dirty`), never reading every key a session recorded; the heartbeats a lease holder's `GET /api/_session` and the sweep send skip it (and load no engine module for it).
5. **Visitor reset.** "Reset demo data..." is intercepted by the front Worker, which calls `LobbyDO.reset(slot)` (at most 3 per lease) and reissues the cookie with the new generation. Hosted reset supports the rich profile only; `profile: base` returns 400 with a reason.
6. **Pool or budget exhausted.** The visitor stays on the showcase with "All N demo companies are in use; one frees in about M min" or "Today's demo budget is used up; back after 00:00 UTC". The waitlist holds at most 50 live entries (refreshed within its 10-minute TTL): a visitor already in line keeps its place, and a new one past the cap is answered `full` ("the line is full; try again in a few minutes") and not added, since a cookie-less visitor gets a new visitor id at each attempt. A new entry first deletes the stale ones, so the table stays near the cap between sweeps.
   Every cookie-less `GET /api/_session` asks the Lobby for the pool and the level, and the Lobby hibernates after about 10 s idle, which drops its 30 s memos of the level and the Platform readout, so each of its anonymous reads is bounded cold: the level reads SpendDO's few-row `status({})` (5.5) and the six usage counters by key (never the day's other counter rows: one per IP hash, upload, MCP key and admin signature), the slots and leases are the pool's size, and the waitlist count is an index range on `seen` of at most 50 entries. A unit test meters a cookie-less status and the readout on a Lobby that just woke up, with thousands of other counters and stale entries, and finds the same reads as with ten.
7. **Operator lease.** Automated checks never solve a Turnstile challenge, so the deploy's own checks (Playwright on the deployed URL, the smoke's MCP and `--live` cases, the Verify walkthrough) lease through `POST /api/_admin/lease {name?}`. It is authenticated exactly like every `/api/_admin/*` route (the `x-weft-admin` header `<ts>.<nonce>.<hmac>`: an HMAC with `WEFT_ADMIN_TOKEN` over method, path, timestamp, a random nonce and the body; at most 5 minutes old and 30 s ahead; single-use, because the Lobby records each signature for its day; a constant-time check) and is refused without it (401 `ADMIN_SIGNATURE`, no cookies). It calls `LobbyDO.assign` for the operator visitor of that name (`vis_` plus the HMAC of the name under `WEFT_ADMIN_TOKEN`, so one lease per name and none without the token) and the caller's IP hash, and sets `__Host-weft` and `__Host-weft-h` exactly as a Turnstile lease does; Playwright calls it through `page.request` so the cookies land in the browser context. Nothing else is skipped: the pool (a waitlist answer when it is full), the per-IP-hash lease cap, the day's budget and level, the idle and total lease times, the 428 for a mutation without a grant, and the spend caps (live runs are charged to the operator visitor and IP hash) all apply. Asking again while the lease lasts returns the same slot and generation with fresh cookies; `POST /api/_admin/grant {name?}` sent with that lease's session cookie refreshes only the human grant and answers 409 `LEASE_ENDED` once the lease is over. `POST /api/_admin/release`, under the same signature, ends the operator lease when a check is done instead of leaving the slot to its idle time. Every operator lease logs `lease.operator`.

### 6.3 Gates per action

| Action | Turnstile | Rate limit (binding, coarse) | Hard cap (strongly consistent, in a DO) |
|---|---|---|---|
| Static pages and assets | none | none | none |
| GET `/api/v1/*` | none | `RL_API` 600 per 60 s per IP hash (Nitish's decision, kept; sizing below); a valid `x-weft-smoke` visit skips it | DO request share in the Lobby |
| Any mutation | grant within 10 min | `RL_MUTATE` 30 per 60 s per IP hash (a valid signed smoke visit uses the separate `mut:smoke` key, so automated checks never spend a visitor address's budget) | lease required |
| Operator lease: `POST /api/_admin/lease`, `POST /api/_admin/grant`, `POST /api/_admin/release` (6.2 step 7) | none: the `x-weft-admin` HMAC with `WEFT_ADMIN_TOKEN` instead, or 401 `ADMIN_SIGNATURE` and no cookies | `RL_API`, as every `/api` path | as any lease: the pool, at most 20 leases per IP hash a day, the day's budget and level, the idle and total lease times; `grant` never starts a lease (409 `LEASE_ENDED` once it is over), and `release` ends the named operator lease before its idle or total time, after which the slot is reset as at any lease end (6.2 step 4) |
| Live run admission (in the DO) | inherited from the mutation | `RL_RUN` 6 per 60 s per visitor | `SpendDO`: run $0.10 (`slot:gen:run`), day $2.00 (all worlds), visitor $0.25 a day, IP hash $0.50 a day, live cap (open decision 1), neurons |
| Upload | as a mutation | as a mutation | 1.5 MB; 5 per visitor per day |
| PDF render | as a mutation | one render queue at concurrency 1 | browser seconds in the Lobby, 300 s a day for Weft; served from R2 when cached |
| Help search | none | `RL_API` | 30 a day (Lobby counter), under the 1,000 a month included |
| Dictation | as a mutation | `RL_RUN` | 300 neurons a day |
| `/mcp` | none possible (machine client) | `RL_MCP` 60 per 60 s per IP hash, then per key; only keys naming `slot-1` to `slot-N` are routed | the key stops when its lease ends or expires (at the idle or total lease time, or when it is released; the slot answers MCP only while its stamp names a lease visitor, so a world waiting for its reset or a deferred restore refuses it) and dies with its lease generation; tools are read and propose only (`NEVER_EXPOSED` unchanged); `agent_ask` at most 5 per key per day inside the visitor's caps |
| Kill switch | | | KV `agent.enabled=false` makes model-calling admissions return 503 "agent paused"; an isolate that has never read KV and cannot reach it treats the switch as on (fails closed) until KV answers |

The Rate Limiting binding is per location and eventually consistent (measured: 23 of 25 allowed against 5 per 10 s), so it is never the cap.

**`RL_API` sizing (measured in the cloud session, 2026-10-21).** The hosted guided tour (autoplay, scripted provider, the static export against `pnpm cf:dev` with the real engine, on an operator-leased pool slot) made 261 to 269 `/api` requests in about 150 s, with a peak of 157 to 158 requests (155 GETs) in any 60 s window, in all three runs (after 20 s on the showcase first, after a hosted reset, and at the new limit, where no request answered 429). The former limit of 120 therefore answered real visitors taking the tour with 429 and the rate-limited banner. `RL_API` is 600 per 60 s per IP hash: about four times the tour's peak, so a second tab, or two visitors taking the tour behind one address, still fit. An abusive address is held by the DO caps and the Lobby's shares, as before. The deployed smoke's own visits carry the `x-weft-smoke` HMAC and skip `RL_API`; its unsigned burst (more GETs than the limit) still exercises the limiter. Mutations keep `RL_MUTATE` 30 per 60 s, smoke included. Orphaned reservations from a run killed mid-step settle at their reserved worst case after 15 minutes, which errs toward the cap.

### 6.4 Isolation guarantees

- **Database.** One DO per world is one SQLite database per world. The slot comes from the signed cookie or the mcp key prefix `wk_mcp_<slot>_<gen>_<rand>`, never from the URL. DO bindings are not publicly reachable, and client trust headers are stripped.
- **Generations.** Every reset bumps `gen`. R2 keys and slot vectors carry it, recall filters on it, and admin keys and mcp keys from an older generation fail. A world answers a session cookie of an older generation with 409 `LEASE_ENDED`, and the front accepts such a cookie in exactly one case: it was issued for the same lease, meaning the same visitor and slot and a `leaseExpiresMs` claim equal to the lease's total expiry to the millisecond (a reset keeps the lease's start; the visitor's next lease has another), that lease still lasts, and its generation is newer than the cookie's. That is a cookie from before the visitor's own "Reset demo data...": `GET /api/_session` reissues it for the lease's current generation, and a request that got the 409 with it keeps its cookies. A cookie of an earlier, ended lease of the same visitor (operator visitor ids are stable per name) is never moved onto a later lease of that slot: it gets the 409 and its cookies cleared, so a cookie that leaked stops working when its lease ends. A cookie whose generation is newer than its lease's names no lease.
- **Module state.** `WorldScope` keys the write-lock tail, the auth `Window` limiters (`usr_dana` exists in every world), otel `learned`, `recallNotes` and the trace redactor, and the integrations webhook receivers. A test runs two slots in one isolate and checks they share nothing. An import scan fails if `node:fs`, `node:child_process` or `node:net` is reachable from the weft-core entry.
- **"Viewing as".** `WEFT_DEV_AUTH=1` keeps the persona switch inside the visitor's own world; on the showcase it only changes what is read.
- **Cross-world data.** D1 and the Platform page hold cross-world rows, but visitors see aggregates only (provider, model, steps, cost, outcome), never content.
- **IPs.** Hashed with a daily salt derived from `WEFT_SESSION_SECRET`, never stored raw. Every per-IP key (the per-IP-hash lease count, the rate limits, the IP-hash spend cap) hashes an IPv4 address as it is, an IPv6 address by its /56 prefix (ISPs commonly delegate a whole /56 to one subscriber, so its 256 /64s count once) and an IPv4-mapped IPv6 address as its IPv4 address. Workers Logs events carry the client IP as platform metadata (measured), so head sampling stays low and log dumps stay out of the repo.
- **PDF rendering.** HTML comes from Weft templates with escaped text and is loaded with `page.setContent`; JavaScript is off and every network request is intercepted and aborted, so Browser Run cannot be used for SSRF.

### 6.5 Degradation ladder

The Lobby computes a level from its daily counters against Weft's shares (8.2):

1. **At 70% of any share:** hosted poll intervals triple and refresh comes from the WebSocket feed only.
2. **Day dollar cap, neuron cap or kill switch:** new runs use the scripted provider with its badge and a banner.
3. **At 90% of DO rows written, rows read or DO requests:** no new leases; the showcase stays.
4. **Account Workers request cap reached:** the platform returns 429 on `run_worker_first` paths (research: static assets billing); the landing and app shells still load from assets and show a static notice.

## 7. Cloudflare products

### 7.1 Used

| Product | Decision | Weft feature it powers | Free limit that matters | Source |
|---|---|---|---|---|
| Workers (`weft`, `weft-core`) | use | front routing and gate; core host | 100,000 requests a day account-wide (shared with 6 apps); 10 ms CPU documented (870 ms succeeded, 1.78 s killed); 50 external subrequests; 128 MB; 1 s startup | probe: Worker CPU, Subrequests; developers.cloudflare.com/workers/platform/limits/ |
| Workers static assets | use | the whole web UI; `_redirects` for `[id]` shells; `_headers` CSP | free and unlimited; 20,000 files; 25 MiB per file | probe: static assets; developers.cloudflare.com/workers/static-assets/billing-and-limitations/ |
| Service bindings and RPC | use | front to `HostedExtras` in weft-core | not billed as separate requests | developers.cloudflare.com/workers/platform/pricing/ (Service bindings) |
| Durable Objects (SQLite) | use | CompanyDO worlds, LobbyDO, SpendDO | 100,000 requests, 100,000 rows written, 5M rows read, 13,000 GB-s a day; 5 GB stored; 2 MB row, 100 columns, 100 parameters, 100 KB statement; 30 s CPU per invocation measured | probe: DO CPU, DO SQLite; developers.cloudflare.com/durable-objects/platform/limits/ and /pricing/ |
| DO alarms | use | agent runs, scheduler ticks while the clock runs, watchdog, Lobby resets | at-least-once, retries from 2 s up to 6; 15 min wall per handler; each `setAlarm` is 1 row written | probe: DO alarm CPU; developers.cloudflare.com/durable-objects/api/alarms/ |
| Hibernatable WebSockets | use | `/api/_live` change feed in place of polling | incoming messages bill 20:1 against DO requests; outgoing free; no duration while hibernated | developers.cloudflare.com/durable-objects/best-practices/websockets/ |
| DO point-in-time recovery | use if the first-deploy check passes | cheapest slot reset | 30-day window; row cost undocumented; not available locally | developers.cloudflare.com/durable-objects/api/sqlite-storage-api/ |
| Workflows | use | `ReseedWorkflow`: full restore, arm, verify, mark clean, with durable retries | 3,000 steps a day; 10 ms CPU per step documented (2.05 s killed), so steps only RPC; 1,024 steps; 100 concurrent | probe: Workflows; developers.cloudflare.com/workflows/reference/limits/ |
| Queues | use | `weft-jobs` (OCR, embeddings, exports), `weft-render` (PDF, concurrency 1, 20 s retry delay), `weft-dlq` | 10,000 operations a day (about 3,300 messages); 128 KB messages; 24 h retention | probe: Queues; developers.cloudflare.com/queues/platform/limits/ |
| Workers KV | use | model default, kill switch, feature flags, snapshot version | 100,000 reads and 1,000 writes a day; 1 write per second per key | probe: KV; developers.cloudflare.com/kv/platform/limits/ |
| D1 (`weft-ops`) | use, off the data path | run catalog for the model comparison page, `budget_daily`, `failed_jobs`, smoke results | 10 databases per account (7 used, this makes 8); 100,000 rows written and 5M read a day; 50 queries per invocation | probe: D1; developers.cloudflare.com/d1/platform/limits/ |
| R2 (`weft-files`) | use, small | PDF cache, memory and world exports, the help corpus for AI Search | 10 GB-month, 1M Class A, 10M Class B a month; this account is on a usage-metered R2 plan, so lifecycle rules and app caps keep it inside the free tier | probe: R2; developers.cloudflare.com/r2/pricing/ |
| Workers AI | use | the model switch, embeddings, receipt and notice OCR, dictation | 10,000 neurons a day account-wide | probe: Workers AI; developers.cloudflare.com/workers-ai/platform/pricing/ |
| AI Gateway (`weft`) | use for every model call | logs, cache, rate limit, cost analytics, spend backstop, metadata per slot and run | 10 gateways (3 used); logs count against Workers Logs for this account | probe: AI Gateway; developers.cloudflare.com/ai-gateway/reference/limits/ |
| Vectorize (`weft-memory`) | use, recall flag off until the gate | semantic memory recall candidates | 5M stored and 30M queried dimensions a month; 1,000 namespaces per index | probe: Vectorize; developers.cloudflare.com/vectorize/platform/limits/ |
| AI Search (`weft-help`) | use, capped | "Help" results in Cmd+K over Weft's own docs | 1,000 semantic queries a month included; billing begins 2026-11-01 (open decision 4) | probe: AI Search; developers.cloudflare.com/ai-search/platform/limits-pricing/ |
| Browser Run | use | offer letter, signed agreement and pay stub PDFs from Weft templates, cached in R2 | 10 browser-minutes a day; 3 concurrent; 1 new browser per 20 s (measured 429 on a second REST call 1 s later; binding PDF 3.3 s) | probe: Browser Rendering; developers.cloudflare.com/browser-run/limits/ |
| Images binding | use (to verify) | normalize and downscale receipt photos before OCR | 5,000 unique transformations a month; no charge past it on Free | developers.cloudflare.com/images/pricing/ |
| Rate Limiting binding | use | coarse per-IP-hash and per-key throttles; per-visitor run admission | per location, eventually consistent; period 10 or 60 s | probe: Rate Limiting binding; developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ |
| Turnstile | use | human check at lease start and before mutation windows | 20 widgets, unlimited challenges, 10 hostnames per widget; the workers.dev hostname was accepted at widget creation | probe: Turnstile; developers.cloudflare.com/turnstile/plans/ |
| Cron Triggers | use (1) | `*/15` Lobby sweep, orphan settle, bookmark refresh, daily budget row | 5 per account (1 used, this makes 2); 10 ms CPU; about 5m40s to propagate | probe: Cron Triggers; developers.cloudflare.com/workers/platform/limits/ |
| Workers Logs | use | structured, redacted logs; the per-invocation CPU source | 200,000 events a day, 3-day retention; 0.5 GB a day shared from 2026-12-01 | probe: Workers Logs; developers.cloudflare.com/workers/observability/logs/workers-logs/ |
| Workers traces | use at 5% | gateway, DO RPC and queue latency | shares the Observability allowance | developers.cloudflare.com/workers/observability/traces/ |
| GraphQL Analytics API | use (ops script) | CPU p50 and p99, DO rows per slot name, gateway cost | needs Account Analytics Read | probe: GraphQL Analytics API |
| Secrets Store | use in phase 2 | holds the OpenAI key for AI Gateway BYOK | 1 store per account (exists, empty) | probe: Secrets Store |
| Remote MCP on Workers | use | `/mcp` Streamable HTTP for external agents, inside the slot DO | counts as Worker and DO requests | developers.cloudflare.com/agents/model-context-protocol/protocol/transport/ |
| workers.dev | use | `weft.nitish-ratakonda.workers.dev` | free | |
| Analytics Engine | ready, not declared | per-run and per-visitor metrics through `MetricsSink`; D1 until then | 100,000 data points a day; needs Nitish's one-time dashboard opt-in (deploy failed with code 10089) | probe: Analytics Engine; developers.cloudflare.com/analytics/analytics-engine/limits/ |

### 7.2 Evaluated and not used, or left out

| Product | Why | Source |
|---|---|---|
| Containers | Workers Paid only (code 1000 on this account) | probe: Containers; developers.cloudflare.com/containers/platform/pricing/ |
| Pipelines | Workers Paid only (code 1021 on this account, and on 2026-10-10) | probe: Pipelines; developers.cloudflare.com/basin-pipelines/platform/pricing/ |
| Sandbox SDK | Workers Paid only | developers.cloudflare.com/sandbox/ |
| Dynamic Workers | Workers Paid only; the upgrade path behind Weft's `SandboxEngine` contract | developers.cloudflare.com/dynamic-workers/ |
| Workers for Platforms | Paid plan ($25 a month) | developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/pricing/ |
| Artifacts | Workers Paid only | research (2026-10-20) |
| Email Routing and Email Service | need a custom domain; the hostname is workers.dev only | Nitish's decision; developers.cloudflare.com/email-service/ |
| Web Search API | needs prepaid credits or a provider key | research (2026-10-20) |
| Agents SDK (`Agent`, `schedule`, `setState`) | duplicates the run store, scheduler and state the harness owns; `setState` and each schedule add rows written; a 0.x package; `McpAgent` is deprecated | developers.cloudflare.com/agents/ and /agents/model-context-protocol/apis/agent-api/ |
| OpenNext and vinext | the static export fits (pages are client views fetching `/api`); OpenNext needed next 16.4.1 or later (Next is now 16.4.2, section 3.5) and cannot ship the Node-runtime `proxy.ts`; vinext is beta and needs react 19.3.1 | developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/ ; opennext.js.org/cloudflare |
| Pages | Workers static assets replace it | developers.cloudflare.com/workers/static-assets/ |
| Hyperdrive | available on this account, but Weft has no Postgres | probe: Hyperdrive |
| Cache API | not relied on: writes are expected to have no effect on workers.dev hostnames (to verify in cf4); isolate memos take its place | developers.cloudflare.com/workers/runtime-apis/cache/ |
| Workers Builds | needs Nitish to authorize the GitHub app himself; optional later | research (2026-10-20) |
| Access (Zero Trust) | the demo is public with no login, by decision | Nitish's decision |
| Stream, Realtime | no Weft feature to serve | |

### 7.3 Corrections to SPEC 9.9 and docs/models.md

The deploy track updates these with the measured numbers:

- Durable Object CPU on Free is 30 s per invocation in practice (measured), not 10 ms.
- R2 is already active on this account, so no card is needed.
- Free Worker size is 64 MiB uncompressed; the 3 MB compressed limit was removed on 2026-09-04.
- `wrangler tail` is not relied on; CPU comes from Workers Logs and GraphQL.

## 8. CPU and cap budgets

### 8.1 CPU per invocation

| Invocation | Documented on Free | Measured on this account | Weft target |
|---|---|---|---|
| Front Worker request | 10 ms | 870 ms succeeded; killed at 1.78 s and 2.01 s | at most 5 ms p99: HMAC, rate limit, routing, memo; siteverify is wall time |
| CompanyDO fetch | the limits table says 30 s, the FAQ says the Workers limit | 6.9 s succeeded; killed at 29.4 to 32.5 s | route p99 at most 50 ms (Node median 0.5 ms, worst 16 to 20 ms); cold start at most 250 ms (createWeft 12 ms plus 114 ms module evaluation) |
| CompanyDO alarm | same | 9.8 s succeeded; 32 s killed, then retried | tick at most 50 ms (Node 7 to 24 ms); live-run alarm at most 3 s CPU, mostly waiting on fetch |
| MCP request in the slot | same as fetch | | at most 100 ms including building the 122-tool server, memoized per isolate |
| Delta reset | | 3 to 5 ms of SQL (verified locally) | at most 500 ms including the seed-row parse |
| Full restore | | 20 to 27 ms of SQL (verified locally) | at most 5 s, chunked across Workflow steps |
| Transaction | input gate times out at 30 s (verified locally) | | commands are milliseconds; `IO_IN_TX` forbids I/O inside |
| Workflow step | 10 ms | 722 ms succeeded; 2.05 s killed | at most 5 ms (RPC only) |
| Cron | 10 ms | | at most 5 ms (one Lobby RPC) |
| Queue consumer | Workers limit | | I/O bound; `@cloudflare/puppeteer` imported lazily |
| Startup | 1 s | | weft-core top level evaluates only class shells; `@weft/*` loads lazily |

**Memory.** The isolate limit is 128 MB. Weft's modules took 66.6 MB of heap under tsx and each extra world about 1 MB (verified locally, upper bound). cf4 measures heap in Miniflare with 4 slots in one isolate (target under 100 MB), and the deploy track checks that Workers Logs show no `exceededMemory` outcome.

**Subrequests.** 50 external fetches per invocation. A chat run makes at most 12 steps times 3 attempts, 36 model fetches; a routine at most 18. One live run per alarm invocation; SpendDO RPCs, `env.AI` and Vectorize count against the 1,000 Cloudflare-service subrequests. The front Worker makes at most one siteverify per request, plus one retry with the same idempotency key after a transport failure. A per-invocation fetch counter asserts at most 40 in tests.

### 8.2 Daily caps (reset at 00:00 UTC, shared with six other apps)

Weft takes 60% of the request, row, duration and log caps and half of the AI, queue, Workflow and browser allowances, leaving the rest for the other apps. The Lobby and SpendDO enforce the shares.

| Cap (account-wide) | Others' peak | Weft share | Per engaged session | Sessions a day at the share |
|---|---|---|---|---|
| DO rows written 100,000 | 6,672 | 60,000 | about 1,710 or more: 894 activity with tracking (verified locally, with memory in git; on SQL memory the session's memory commits add rows of their own, not yet measured) plus 717 delta reset on SQL memory (section 4.6: recorded in the cloud session's container, not yet verified locally) plus about 100 for Lobby and ledger rows | **about 35 (binding)**; about 60 if point-in-time recovery costs close to 0 |
| DO rows read 5,000,000 | low | 3,000,000 | about 60,000: 29,044 for the 10 flows, about 15,000 for page GETs after the N+1 fix and ETag, 6,789 reset, about 8,000 digest | about 50 |
| DO requests 100,000 | low | 60,000 | about 450 | about 130 |
| Workers requests 100,000 | low | 60,000 | about 400 (304s still count; the WebSocket feed and pause-when-hidden keep it there) | about 150 |
| DO duration 13,000 GB-s | 75 | 7,800 | about 25 GB-s (3 min active at 128 MB; hibernated sockets are free) | about 310 |
| OpenAI (Weft day cap) | n/a | $2.00 | $0.0030 to $0.0048 per live tour (verified locally) | about 400 |
| Workers AI 10,000 neurons | about 1,800 | 5,000 | only when switched | about 10 agent runs |
| Workers Logs 200,000 events | | 120,000 | about 1 per invocation at sampling 0.2 (front) and 0.5 (core) | fits |
| Queue operations 10,000 | | 5,000 | about 3 per job | fits |
| Workflow steps 3,000 | 4 workflows exist | 1,500 | about 10 per full restore | fits |
| Browser minutes 10 | | 5 | about 3 s per uncached PDF | about 90 PDFs |

Showcase visitors cost requests only: page loads are free assets, memo hits skip the DO, and ETag 304s read 0 rows. They are not limited by the pool.

Per-flow baselines (risk design, verified locally on the rich world with the scripted provider) become acceptance baselines. The deployed numbers must stay within 25% of them:

| Flow | SQL statements | Rows read | Rows written |
|---|---|---|---|
| First scheduler tick after boot | 70 | 694 | 55 today, 0 after the hash gate |
| Warm idle tick | 38 | 274 | 0 |
| Deliver DE 2088, routine run to 2 proposals | 270 | 2,053 | 115 |
| Approve CA SUI rate (re-previews 48 paychecks) | 208 | 8,101 | 80 |
| Approve notice reply | 184 | 1,753 | 114 |
| Pre-payroll review run | 240 | 2,359 | 89 |
| Chat "Show payroll cost by month" | 71 | 2,409 | 53 |
| Expense review run (8 proposals) | 537 | 2,873 | 237 |
| Chat time-off balance | 76 | 504 | 55 |
| Offer accept, readiness run | 1,596 | 11,257 | 249 |
| Clock to payday | 516 | 5,683 | 181 |
| All 67 GET routes once | 572 | 7,491 | 10 today, 0 with ephemeral read ids |

## 9. Deployment

### 9.1 Resources (`pnpm cf:resources`, idempotent)

Created with the account token through `scripts/cf/with-cf.sh` (never wrangler OAuth). Names avoid the remaining `weft-probe*` log traces.

- KV `weft-config`; D1 `weft-ops` (migrations in `apps/cf/d1/`); R2 `weft-files` with lifecycle rules (`w/` and `exports/` expire after 3 days);
- Queues `weft-jobs`, `weft-render`, `weft-dlq`; Vectorize `weft-memory` (768, cosine) with metadata indexes on `gen`, `tainted` and `kind` created before the first upsert;
- AI Gateway with logs on, cache TTL 1 day, a sliding rate limit and the spend rule;
- Turnstile widget `weft` (managed, domain `weft.nitish-ratakonda.workers.dev`); its secret goes straight to the secrets file and is never printed;
- AI Search `weft-help` over R2 `help/`, created only after its first-deploy check.

The script reads the account's subscriptions (read only) before and after and stops if anything about billing would change. It never upgrades, adds a payment method or accepts terms. Analytics Engine is not enabled by any script.

### 9.2 Order

1. `pnpm cf:fixtures` writes `apps/cf/generated/fixtures.ts`.
2. `pnpm cf:snapshot` seeds the rich world on Node into `.scratch/cf-snapshot/` with `WEFT_MEMORY=sqlite`, `WEFT_BLOBS=sqlite`, `WEFT_CLOCK_RATE=0`, `WEFT_PREBUILT_HASH=1` and the deploy `WEFT_VAULT_KEY`, boots it once and runs one scheduler tick (so routine rows and the prebuilt hash in `kv_state` match the code, 4.4), revokes the seeded API keys (their plaintexts sit in the Node data dir and are deleted after the build), and dumps the world after that one boot and one scheduler tick into `snapshot-rich.sql.gz`, `seed-rows.json.gz` and `manifest.json` (per-table counts and digests, the `db:digest` digest, the chain head, the memory HEAD SHA, the migration journal hash, `stats.json`). The build fails if the journal hash differs from the bundled migrations or if the seed rows hold an API key that is not revoked.
3. `pnpm cf:build` works in a throwaway git worktree of the deploy commit under the session scratchpad, so only committed code ships and the main checkout, its dev server on ports 3070 and 4070 and `.data` are never touched. It reads `apps/cf/resources.json` first, puts the snapshot's `stats.json` in `apps/web/public` (the landing's HTML is built from it), and runs `WEFT_STATIC_EXPORT=1 NEXT_PUBLIC_WEFT_HOSTED=1 pnpm --filter @weft/web build` with `NEXT_PUBLIC_WEFT_TURNSTILE_SITEKEY` from the resources and `WEFT_PUBLIC_ORIGIN` from weft-core's config (the CSP's `wss:` origin), then `wrangler deploy --dry-run` for both configs as the size and binding check. An export that still carries Turnstile's always-pass test sitekey (no resources yet) is recorded as a placeholder, and `pnpm cf:deploy` refuses it; without resources the build still succeeds as a dry run.
4. `pnpm cf:deploy` deploys weft-core, then weft.
5. The first step after the deploy is the transaction conformance suite against the deployed runtime, through an admin route on a scratch CompanyDO instance named `conformance` that wipes itself with `deleteAll()` afterwards. Any failure means rolling back both scripts with `wrangler rollback`.
6. `POST /api/_admin/provision` (HMAC with `WEFT_ADMIN_TOKEN`, 5-minute timestamp) starts `ReseedWorkflow` under the Lobby's restore budget. On provisioning days Weft's rows-written ceiling rises from 60,000 to 80,000 (the other apps peaked at 6,672), and pool seeding is spread over three days so no day passes it:

   | UTC day | Full restores | Rows written by restores | Left for visitors under 80,000 |
   |---|---|---|---|
   | 1 | showcase, slot-smoke, slot-1 | 61,668 | about 18,000 (about 10 sessions) |
   | 2 | slot-2, slot-3 | 41,112 | about 38,900 |
   | 3 | slot-4 | 20,556 | about 59,400 |

7. On UTC day 2 (11.6), `pnpm cf:smoke`, then `pnpm cf:smoke --live` (Nitish's opt-in, one notice run on Luna at about $0.0012), then `pnpm cf:budget`. The cases that need a pool slot (scenario 8's MCP key, the `--live` run, the 428 check, the Verify walkthrough in Playwright) take an operator lease (`POST /api/_admin/lease`, 6.2 step 7) under the same admin signature as provisioning; they never touch Turnstile.

### 9.3 Secrets

Values are never printed, logged, echoed or committed. The secrets files are parsed with awk, never sourced: the `CF_SETUP_TOKEN` line has a space after `=`, and sourcing it can leave the variable empty and make bash print the token in a "command not found" error. `scripts/cf/with-cf.sh` exports `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` into one child command only. `scripts/cf/put-secret.sh NAME FILE KEY` pipes one value to `wrangler secret put` on stdin and prints the name only.

- **weft-core:** `WEFT_VAULT_KEY`, `WEFT_PROXY_SECRET`, `WEFT_CTX_SECRET`, `WEFT_SESSION_SECRET` (IP-hash salt), `OPENAI_API_KEY` (phase 1), `WEFT_AIG_GATEWAY` (the gateway name, kept out of the repo while the gateway is unauthenticated), `CF_AIG_TOKEN` (once Nitish creates it).
- **weft:** `TURNSTILE_SECRET`, `WEFT_SESSION_SECRET`, `WEFT_CTX_SECRET`, `WEFT_PROXY_SECRET`, `WEFT_SMOKE_TOKEN`, `WEFT_ADMIN_TOKEN` (the admin routes, including the operator lease, whose visitor ids it also derives).

Generated values go to `~/Developer/projects/.weft.cf.secrets.env` (mode 600, outside the repo). The account id is passed through the environment at deploy time and not committed.

**Gateway authentication.** An authenticated gateway needs a gateway token, an account API token that Nitish creates himself (open decision 3). Until it exists, the gateway runs unauthenticated: a stranger who learned the gateway URL could spend only their own OpenAI key but would use the gateway's rate limit and logs allowance. The gateway name is therefore a secret, the gateway rate limit applies, and the switch to the authenticated gateway is one secret plus one setting.

### 9.4 Wrangler configs (sketch)

`apps/cf/wrangler.core.jsonc`:

```jsonc
{
  "name": "weft-core", "main": "src/core/index.ts",
  "compatibility_date": "2026-10-01", "compatibility_flags": ["nodejs_compat"],
  "workers_dev": false, "preview_urls": false,
  "durable_objects": { "bindings": [
    { "name": "COMPANY", "class_name": "CompanyDO" },
    { "name": "LOBBY", "class_name": "LobbyDO" },
    { "name": "SPEND", "class_name": "SpendDO" } ] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["CompanyDO", "LobbyDO", "SpendDO"] }],
  "workflows": [{ "name": "weft-reseed", "binding": "RESEED", "class_name": "ReseedWorkflow" }],
  "ai": { "binding": "AI" }, "browser": { "binding": "BROWSER" }, "images": { "binding": "IMAGES" },
  "kv_namespaces": [{ "binding": "CONFIG", "id": "<from cf:resources>" }],
  "d1_databases": [{ "binding": "OPS", "database_name": "weft-ops", "database_id": "<from cf:resources>", "migrations_dir": "d1" }],
  "r2_buckets": [{ "binding": "FILES", "bucket_name": "weft-files" }],
  "vectorize": [{ "binding": "MEMVEC", "index_name": "weft-memory" }],
  "queues": {
    "producers": [{ "binding": "JOBS", "queue": "weft-jobs" }, { "binding": "RENDER", "queue": "weft-render" }],
    "consumers": [
      { "queue": "weft-jobs", "max_batch_size": 5, "max_batch_timeout": 2, "max_retries": 5, "dead_letter_queue": "weft-dlq" },
      { "queue": "weft-render", "max_batch_size": 1, "max_concurrency": 1, "max_retries": 5, "retry_delay": 20, "dead_letter_queue": "weft-dlq" },
      { "queue": "weft-dlq", "max_batch_size": 10 } ] },
  "ratelimits": [{ "name": "RL_RUN", "namespace_id": "4103", "simple": { "limit": 6, "period": 60 } }],
  "triggers": { "crons": ["*/15 * * * *"] },
  "rules": [{ "type": "Text", "globs": ["**/*.sql", "**/*.txt"], "fallthrough": true },
            { "type": "Data", "globs": ["**/*.gz"], "fallthrough": true }],
  "vars": {
    "WEFT_RUNTIME": "cloudflare", "WEFT_LLM": "openai", "WEFT_MODEL": "gpt-5.6-luna", "WEFT_BACKGROUND_LLM": "1",
    "WEFT_CLOCK_RATE": "0", "WEFT_SANDBOX": "off", "WEFT_DEV_AUTH": "1", "WEFT_REQUIRE_VAULT_KEY": "1",
    "WEFT_SEMANTIC_RECALL": "0", "WEFT_RUN_USD_CAP": "0.10", "WEFT_DAY_USD_CAP": "2.00", "WEFT_LIVE_USD_CAP": "0.50",
    "WEFT_VISITOR_DAY_USD_CAP": "0.25", "WEFT_IP_DAY_USD_CAP": "0.50", "WEFT_NEURON_DAY_CAP": "5000",
    "WEFT_POOL_SIZE": "4", "WEFT_PUBLIC_ORIGIN": "https://weft.nitish-ratakonda.workers.dev" },
  "observability": { "enabled": true, "head_sampling_rate": 0.5, "traces": { "enabled": true, "head_sampling_rate": 0.05 } }
}
```

`apps/cf/wrangler.front.jsonc` (name `weft`, `workers_dev: true`, `preview_urls: false`) declares:

- `assets`: `directory` `../web/out`, binding `ASSETS`, `html_handling` `force-trailing-slash`, `not_found_handling` `404-page`, `run_worker_first` `["/api/*", "/mcp", "/mcp/*"]`;
- `COMPANY`, `LOBBY` and `SPEND` with `script_name: "weft-core"`, and a service binding `CORE` to the `HostedExtras` entrypoint;
- KV `CONFIG`; rate limits `RL_API` (600 per 60 s, 6.3), `RL_MUTATE` (30 per 60 s) and `RL_MCP` (60 per 60 s);
- vars `TURNSTILE_SITEKEY` and `WEFT_PUBLIC_ORIGIN`; observability with head sampling 0.2.

wrangler is pinned exactly at 4.151.3 (already on this Mac), with the matching miniflare, workerd and `@cloudflare/workers-types`, plus `@cloudflare/puppeteer` 1.4.0 (used by the probe). No `agents` package.

### 9.5 Migrations and rollback

- **DO classes:** wrangler migration tags, starting at `v1`, additive only.
- **Weft schema:** the CompanyDO constructor runs `migrate-durable` under `blockConcurrencyWhile`, one `transactionSync` per pending journal entry, writing `__drizzle_migrations` exactly as libsql does. A schema or snapshot change marks slots stale; each stale slot gets a full restore after its current lease, within the restore budget. Schema changes are batched because each costs 20,556 rows written per slot.
- **D1:** `wrangler d1 migrations apply weft-ops --remote`.
- **Lobby and Spend:** small hand-written schemas with a version row. Code refuses a version newer than its own, so SpendDO's schema 2 (`spend_days`, 5.5) does not start under schema 1 code: a rollback of weft-core across it fails the ledger closed (no reservation passes) until the newer code is deployed again. The version row is never edited by hand, since schema 1 code would write entries without their day totals.
- **Rollback:** `wrangler rollback <version>` per script. A Weft schema migration only moves forward, so a rollback across a migration also restores the previous snapshot by full restore.

## 10. Observability

- **Workers Logs:** one JSON line per notable event, `{evt, slot, gen, run, step, outcome, ms, rowsRead, rowsWritten}`, passed through the executor redactor. No prompts, keys, cookies or raw IPs in Weft's fields. Workers Logs was the most reliable per-invocation CPU source in the probe (`$workers.cpuTimeMs`, `outcome`). A Worker that streams a DO response shows outcome `canceled`, which is noise.
- **`pnpm cf:budget` (GraphQL):** `workersInvocationsAdaptive` (CPU p50 and p99 and status per script), `durableObjectsPeriodicGroups` (CPU, rows read and written, `exceededCpuErrors` per slot name), `aiGatewayRequestsAdaptiveGroups` (requests, tokens, cost) and Workers AI neurons; it compares the ledger with the gateway cost and writes `budget_daily` to D1. `wrangler tail` is not relied on (it rarely delivers events on this Mac).
- **In app (unchanged):** run trace (`run_steps`), `GET /v1/agent/costs`, `GET /v1/actions/verify`. **New:** the Platform page (today's dollars against the caps, neurons, restores left, leases, queue dead letters, the degradation level; the Lobby reuses its part for 30 s, as it does the level, so any number of visitors read its counters at most twice a minute), the model comparison page (D1 aggregates), and an admin-only `GET /api/_ops`.
- **Traces:** Cloudflare traces at 5%. Weft's OpenInference spans stay off on hosted, so scenario 8 shows the in-app run trace and the gateway log entries carrying the run's metadata instead of Phoenix. OTLP export is possible later.
- **Dead letters:** the `weft-dlq` consumer writes each to D1 `failed_jobs` and logs it; CompanyDO does the same for an outbox row it could never send (`OUTBOX_UNSENT`, section 3.4).

## 11. Testing and smoke checks

### 11.1 Node, unchanged

`pnpm test`, `pnpm e2e`, `pnpm e2e:tour` and `pnpm eval:ci` stay green on Node with today's defaults. Tracks use their own ports and data dirs, never 3070, 4070 or `.data`.

### 11.2 Node on the facade

`WEFT_DB=durable-emu WEFT_MEMORY=sqlite WEFT_BLOBS=sqlite WEFT_EPHEMERAL_READ_IDS=1 pnpm test` runs the whole existing suite (packages, `apps/api` routes, `tests/scenarios` GP1 to GP5) through `openDurableDb(emu)`. The emulator (`node:sqlite`) copies workerd's authorizer refusals, the 100-parameter and 100 KB limits, transaction gating and the `IO_IN_TX` guard.

### 11.3 workerd conformance (Miniflare under plain vitest)

The same cases run on the emulator and in workerd, so the emulator stays pinned to the real runtime:

- rollback after microtask and timer awaits; inner-only nested rollback; outer throw rolls back an inner commit; `transactionSync` nested in an async transaction;
- writes issued from the drizzle callback after awaits roll back on throw, top level and nested (the shape the review showed failing under a deferred commit);
- `facadeClient.transaction()` throws `UNSUPPORTED_LINEAR_TRANSACTION`, and a raw linear begin/commit is kept as a negative test (hang and reset);
- interleave gating, error identity, `changes()` against `rowsWritten`, triggers, PRAGMAs, more than 100 parameters, the 2 MB guard, the trigger dance in `transactionSync`, `IO_IN_TX`.

`@cloudflare/vitest-pool-workers` is used only if a pinned release supports vitest 5.0.4.

### 11.4 workerd integration (`pnpm cf:test`, Miniflare, scripted provider)

- full restore matches the manifest counts, digests and chain head; delta reset after the 10 flows returns the digest to the manifest twice in a row;
- GP1: deliver DE 2088, 2 proposals, approve, Undo, chain valid; double-approve CAS; GP5 taint;
- an alarm-driven run with an SSE subscriber; `PROCESS_RESTART` after `abort()`; a replayed alarm executes nothing twice;
- spend caps across two slots and one SpendDO (day cap, visitor cap, IP cap, neurons, orphan settle);
- lease assign, expiry and reset; 20 concurrent starts get unique slots; the per-IP lease cap, also for concurrent starts from one address; the operator lease (refused without a valid admin signature, under the pool, the per-IP cap and expiry, 428 without its grant, its MCP key dead once the lease ends); isolation (a write in slot 1 is invisible in slot 2; an old cookie generation gets 409); showcase mutations get 409 at the edge and in the DO;
- a showcase cold start plus GET sweep writes 0 rows; ETag 304s read 0 rows; a warm tick writes 0 rows;
- Turnstile with Cloudflare's published test secrets (`1x0000000000000000000000000000000AA` passes, `2x0000000000000000000000000000000AA` fails) against a local siteverify stub with the same semantics (`TURNSTILE_VERIFY_URL`, so the suite needs no network; a refused lease fails its case with the stub's verdict), plus one opt-in case against Cloudflare's own endpoint (`WEFT_CF_REAL_SITEVERIFY=1`); tampered cookie gets 401; client trust headers are stripped; the kill switch returns 503; the session reports the world's model switch (`reason: "world"`); a valid smoke visit skips `RL_API`;
- the fetch counter stays at or under 40 per alarm (the fake engine's runs fetch the loopback discard port, refused at once with no DNS lookup or proxy); `/mcp` lists 122 tools and refuses approve, rollback and vault; MCP `agent_ask` settles through the `?wait=25` long poll while alarms run the run; 4 slots in one isolate stay under 100 MB of heap;
- the `/api/_live` keepalive (`LIVE_PING`) is answered with `LIVE_PONG` by the hibernation auto-response;
- weft-core's deployed `scheduled()` handler runs the Lobby sweep and sends a parked job that is due back to its queue; the seed memory index runs from `POST /api/_admin/seed-index`, metered and resumed; clean stamped worlds pass the weekly verify and an eight-day sweep restores none;
- queue handlers with fake AI, Vectorize, Browser and Images bindings (not emulated locally) are idempotent on redelivery.

`pnpm cf:test` needs `pnpm cf:snapshot` first: the real-engine cases restore the bundled snapshot and fail without it. The import scan (section 6.4) does not: where the snapshot files are missing it bundles with empty stand-ins.

### 11.5 Local full stack

`pnpm cf:dev` runs `wrangler dev` with both configs on port 5780 and data under `.scratch/cf-dev`; Playwright runs the guided tour (scripted, every step on its own target, within the 180 s hard budget) and the hosted shell checks against it. It copies the snapshot's `stats.json` beside the assets it serves. `--turnstile-verify-url` (or `WEFT_CF_DEV_TURNSTILE_VERIFY_URL`) points the front Worker's siteverify at a local stand-in with Cloudflare's test-secret answers, for machines where the internet is reachable only through an HTTPS proxy, which workerd does not use. The pool must fit one day's restore budget (the showcase, `slot-smoke` and the slots, one full restore each: `--pool 2` at most), so a larger pool is refused at once, and the wait stops when the Lobby defers a restore (state kept under `--dir` from earlier runs can have used the day's budget). PDFs stay pending locally: Browser Run is not emulated, and its stand-in refuses a browser session with 501, so a render job fails at once with that reason, retries and ends in `weft-dlq` (the PDF route then reports the failure); the deployed smoke checks PDFs end to end (section 11.6: an offer letter downloads, and the second request is served from R2).

### 11.6 Deployed smoke (`pnpm cf:smoke --url https://weft.nitish-ratakonda.workers.dev`)

The smoke loads `WEFT_SMOKE_TOKEN` into its own command environment only. The token grants a human session restricted to `slot-smoke` with the provider forced to scripted, so it spends $0. Agents never solve a real Turnstile challenge; Nitish exercises the real widget once in his own browser.

The deployed checks run on UTC day 2 of provisioning, not on the provisioning day: a full local `e2e:cf` run writes about 4,100 visitor rows, and on day 1 the three full restores already take 61,668 rows written (9.2 step 6).

- **Platform:** `/` and `/app/` come from assets (GraphQL invocation count unchanged); `/app/people/wrk_0026/` renders Lena Brooks (demo) from the shell; the CSP header is present; `/api/v1/health` reports runtime `cloudflare`, profile `rich`, the slot and generation; an unleased mutation gets 409; a mutation without a grant gets 428 (an operator lease with its grant cookie dropped); an unsigned burst of more GETs than `RL_API` allows (limit plus 100) yields at least one 429 (recorded, not gating, because the binding is loose); a change in `slot-smoke` is invisible from an unleased showcase context (isolation between pool slots is covered by the Miniflare suite); the transaction conformance route passes; a showcase GET sweep writes 0 rows; a repeated seed-embedding call is a gateway cache HIT that settles $0.
- **Guided tour:** tour autoplay in a pool slot under the operator lease `smoke` (6.2 step 7), every step on its own target, within 180 s; the hosted reset goes through the Lobby. It does not run on `slot-smoke`: the hosted shell needs a lease's session and grant cookies and cannot run on the `x-weft-smoke` header.
- **The eight scenarios** (`docs/demo-scenarios.md`), through the API on `slot-smoke`:
  1. Deliver CA EDD DE 2088: two proposals; approve the rate; Undo appends `tax.revert_rate`; chain valid.
  2. Run review now: "Explained 4 flagged paychecks" and a Submit card for 47 paychecks, $267,919.36.
  3. Mark accepted on Noor Castellanos: approvals 2 to 5 (2 CO registrations and the $1,899.00 laptop); after +1 day twice the CO accounts are active.
  4. Injected notice and #payroll mention: tainted, zero executed R2 to R4; "Approve everything in my inbox" refused.
  5. Review with agent: 8 expense proposals; approving Mateo Alvarez's $412.38 puts it on the Oct 30 run outside gross.
  6. Time off: Grace Adeyemi and Oscar Lindqvist, 89 hours left.
  7. Chart: Sep 2026 $537,996.96, total $5,302,554.78; Lena Brooks $139,240.00 effective Oct 16.
  8. Remote MCP with the official SDK client over Streamable HTTP, with the MCP key of an operator lease's pool slot (slot-smoke mints none): 122 tools, read the notice, `tax__update_rate` returns `pending_approval`; the in-app run trace is present and the gateway log carries the run's metadata.
- **Extras:** an uploaded receipt gets an OCR extract within 60 s; an offer letter PDF downloads and the second request is served from R2; Help search returns the tour document; the dead-letter queue is empty; the last Lobby sweep is under 20 minutes old.
- **After:** `GET /v1/actions/verify` valid; `slot-smoke` reset; `pnpm cf:budget` shows CPU p99 under the targets and no `exceededResources`; `pnpm cf:budget --logs` finds no credential shape (`sk-`, `weft_sk_`, a full `wk_mcp_` key, an `x-weft-*` credential header with a value) in the day's Workers Logs events, counted by prefix and never compared with a loaded secret.
- **`--live`** (Nitish's opt-in): one notice run on Luna in an operator-leased pool slot under the caps, about $0.0012, and one Workers AI run recorded in D1 (not gating).

## 12. Risks

1. **Transaction semantics are verified locally only.** Production workerd should match; the deployed conformance run is the first post-deploy step and gates everything else.
2. **Rows written limits visitors to about 35 engaged sessions a day.** Point-in-time recovery cost on Free is undocumented; the delta reset is the default and the Lobby enforces Weft's share.
3. **DO CPU on Free is documented both ways.** 30 s was measured, but it is leniency that could change. Restores stay chunkable and routes stay in milliseconds.
4. **Shared account caps.** Weft can starve the six other demos or be starved by them. The shares, the kill switch, the WebSocket feed and the degradation ladder contain it.
5. **The Rate Limiting binding and the gateway spend rule are eventually consistent.** SpendDO is the only real gate.
6. **Undocumented subrequest attribution for background promises in DOs.** Model fetches start only inside alarm invocations, with a counter in tests.
7. **Input gate timeout.** A transaction body that waits on I/O or an inbound event resets the object at 30 s. `IO_IN_TX` and the lint rule guard it.
8. **AI Gateway on Free.** BYOK, spend rules and authentication are not stated for Free; the fallbacks are the Worker secret, Weft's own caps and an unauthenticated gateway with a secret name.
9. **The live cap is cumulative** (0.50 by default) and would end live runs on the public demo after about 100 to 150 live tours; the demo then falls back to the scripted provider with its badge. Open decision 1.
10. **Metered billing.** R2 is on a usage-metered plan and AI Search billing starts 2026-11-01; whether Free accounts are capped or billed past the included amounts is not documented. Lifecycle rules and app-side caps keep use inside them.
11. **Next export details.** `pageExtensions` exclusion of `proxy.ts`, `_redirects` 200 rewrites on Workers assets and the CSP hash step each have a first check in cf5 and a named fallback.
12. **Module-level state shared by DO instances in one isolate.** The `WorldScope` audit must be complete; the two-slots-one-isolate test guards it.
13. **Isolate memory.** 66.6 MB under tsx is an upper bound against 128 MB; measured in cf4 with 4 slots.
14. **Privacy.** Gateway logs keep visitor-typed text; Workers Logs carry client IPs as platform metadata; Observability ingestion becomes 0.5 GB a day shared from 2026-12-01.
15. **Token breadth.** `CF_SETUP_TOKEN` includes Billing Write, Account API Tokens Write and Access and Zero Trust write. A narrower deploy token reduces the damage if it leaks.
16. **Turnstile on workers.dev.** The hostname was accepted at widget creation (measured); the challenge flow in a real browser is checked once by Nitish.
17. **Scenario 8 differs on hosted.** Phoenix is not hosted; `docs/demo-scenarios.md` gets a hosted note.
18. **Schema changes are expensive.** Each costs a full restore per slot (20,556 rows written), spread over days.

## 13. Open decisions for Nitish

None of these revisit his earlier decisions.

1. **Hosted `WEFT_LIVE_USD_CAP`.** It is cumulative; the first deploy keeps 0.50. A deploy-lifetime or monthly value (for example $20 lifetime or $10 a month) keeps live runs available longer.
2. **Analytics Engine.** A one-time dashboard opt-in on his account. Until then metrics go to D1.
3. **Tokens he creates himself:** an AI Gateway auth token (for the authenticated gateway and BYOK), a narrower Weft deploy token to replace `CF_SETUP_TOKEN`, and optionally a narrow Workers AI token for the Node side-by-side evals. Rotating `CF_SETUP_TOKEN` is also worth considering.
4. **AI Search after 2026-11-01.** Keep Help search (capped at 30 a day) only if Free accounts are capped rather than billed.
5. **Caps and pool:** visitor $0.25 and IP $0.50 a day, 3 leases per IP a day, pool size 4 growing to 8, leases of 15 minutes idle and 60 in all.
