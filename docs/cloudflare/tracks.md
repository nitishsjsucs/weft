# Weft on Cloudflare: implementation tracks

These tracks implement [design.md](design.md). There are eight: a short serial round 0 (cf0), six parallel tracks in their own git worktrees (cf1 to cf6), and a final integration and deploy track (cf7). Owned paths are disjoint: a track never edits another track's paths. Tests follow source ownership: a track owns the `test/` files for the sources it owns, plus the test files named in its acceptance commands. A track that needs a change elsewhere writes it into `.scratch/contract-requests/<track-id>.md`, and the integration track folds it in.

## Rules for every track

- **Branches.** Cut `cf/integration` from `main`. Each track works in its own worktree at `/Users/nitishcs/Developer/projects/weft-worktrees/<track-id>` on branch `cf/<track-id>`, cut from `cf/integration` after cf0 lands.
- **Git.** Commits are authored as `nitishsjsucs <227862909+nitishsjsucs@users.noreply.github.com>` with no Co-Authored-By trailer. Never commit `apps/web/next-env.d.ts`. No file name contains the word "report".
- **Brand and prose.** Never name the reference product outside `research/`. No em or en dashes (`pnpm lint:prose`). Status words: verified locally, simulated, deployed; never claim production use.
- **Processes.** Never touch Nitish's dev server (ports 3070 and 4070) or `/Users/nitishcs/Developer/projects/weft/.data`. Check a port before starting anything (`lsof -nP -iTCP:<port> -sTCP:LISTEN`). `pnpm e2e` (3170, 4170) and `pnpm e2e:tour` use fixed ports, so tracks run them one at a time. Track-owned ports: cf4 5780, cf5 5790, cf7 5800. Data dirs live under `.scratch/<track-id>/`.
- **Dependencies.** cf0 adds every new dependency for every track, pinned exactly, and owns `pnpm-lock.yaml`. No other track changes a `package.json` dependency list or the lockfile; a track may add `scripts` entries to the `package.json` of a package it owns. A missing dependency is a contract request.
- **Secrets.** Never print, log, echo, commit or copy a secret value. Parse secrets files with awk (never `source` them) and load a value into a single command's environment only. Only cf7 calls the Cloudflare API, and only through `scripts/cf/with-cf.sh`.
- **Spend.** Automated tests use the scripted provider. Live calls happen only in cf7, inside the caps, with Nitish's opt-in for `--live`.
- **Free plan.** Never upgrade, add a payment method, create accounts, accept terms or enable account settings (Analytics Engine stays off until Nitish enables it).

## Overview

| Id | Goal | Owns | Depends on |
|---|---|---|---|
| cf0-contracts | Round 0: ext interfaces, hosted schema, compose split, package skeletons, all new dependencies | `packages/contracts/src/ext/cf-*.ts`; `packages/db/src/schema.ts` and `packages/db/drizzle/**`; `packages/seed/src/digest.ts`; `apps/api/src/compose.ts`, `apps/api/src/assemble.ts`; `apps/cf/package.json`, `apps/cf/tsconfig.json`, `packages/cf-extras/package.json`, `packages/cf-extras/tsconfig.json`; root `package.json`, `pnpm-lock.yaml`, `turbo.json`; `tests/boundaries.test.ts` | none |
| cf1-db | Durable SQLite facade, emulator, meter, `IO_IN_TX`, WorldScope, snapshot and resets, SQL memory repo | `packages/db/**` except `src/schema.ts` and `drizzle/**`; `packages/executor/src/memory/**`, `packages/executor/test/memory/**`; `scripts/memory-*.ts` | cf0 |
| cf2-platform | Platform seams in the API, executor, routines, sim and seed; ETag/304; reads that write nothing; N+1 fix | `apps/api/src/**` except `compose.ts` and `memory/**`; `apps/api/test/**` except `memory-recall.test.ts`; `packages/executor/src/**` and `packages/executor/test/**` except `memory/**`; `packages/core/src/commands/time-off.ts`, `packages/core/test/time-off-requests.test.ts`; `packages/routines/**`; `packages/sim/src/notices/**`; `packages/integrations/src/secrets.ts`; `packages/seed/**` except `src/index.ts`, `src/cli.ts`, `src/digest.ts` | cf0 |
| cf3-agent | Spend core and hosted caps, RunHost, AI Gateway transport, Workers AI provider, remote MCP handler | `packages/agent/**`; `apps/mcp/**` | cf0 |
| cf4-worker | Front Worker, CompanyDO, LobbyDO, SpendDO, ReseedWorkflow, cron, queue dispatch, wrangler configs, deploy scripts, Miniflare suite | `apps/cf/**` except `package.json`, `tsconfig.json`, `src/extras/**`, `test/extras/**`, `d1/**`; `scripts/cf/**` except `smoke.ts`, `help-corpus.ts` | cf0; final acceptance after cf1, cf2, cf3 merge |
| cf5-web | Static export, dynamic-id shells, polling discipline, WebSocket feed, hosted shell and pages | `apps/web/**` (never `next-env.d.ts`) | cf0; deep-link check after cf4 merges |
| cf6-extras | OCR, PDF rendering, help search, dictation, semantic recall source, run catalog, metrics sink | `packages/cf-extras/**` except `package.json` and `tsconfig.json`; `apps/cf/src/extras/**`, `apps/cf/test/extras/**`; `apps/cf/d1/**`; `apps/api/src/memory/**`, `apps/api/test/memory-recall.test.ts`; `scripts/cf/help-corpus.ts` | cf0; final acceptance after cf2 and cf4 merge |
| cf7-integrate | Merge, combined suites, local full stack, resources, deploy, smoke, docs with measured numbers | `e2e/cf/**`; `playwright.cf.config.ts`; `scripts/cf/smoke.ts`; `docs/cloudflare/**` beyond this design; hosted sections of `README.md`, `SPEC.md` 9.9, `docs/models.md`, `docs/demo-scenarios.md`, `research/harness.md`; after cf0, every cf0 path | all |

Merge order into `cf/integration`: cf0, then cf1, cf2 and cf3 in any order, then cf4, then cf6, then cf5, then cf7 deploys and merges `cf/integration` into `main`.

## cf0-contracts (round 0, serial, small)

**Goal.** Land everything the parallel tracks share, without changing any Node behavior.

**Owns.** `packages/contracts/src/ext/cf-db.ts`, `cf-platform.ts`, `cf-memory.ts`, `cf-agent.ts`, `cf-hosted.ts` (session, lease, `x-weft-ctx`, WebSocket feed and hosted HTTP shapes the web uses), `cf-extras.ts`; `packages/db/src/schema.ts` (hosted tables only) and `packages/db/drizzle/0008_hosted.sql` plus `meta/**`; `packages/seed/src/digest.ts`; `apps/api/src/compose.ts` and `apps/api/src/assemble.ts`; `apps/cf/package.json`, `apps/cf/tsconfig.json`, `packages/cf-extras/package.json` and `packages/cf-extras/tsconfig.json`; root `package.json` (the `cf:*` scripts, each printing "not built yet" until its track lands), `pnpm-lock.yaml`, `turbo.json`; `tests/boundaries.test.ts`. These are frozen-contract changes under AGENTS.md rule 7, recorded in `.scratch/contract-requests/cf0-contracts.md`.

**Builds.**
- The interfaces in design sections 4 and 5: `DurableStorageLike`, `openDurableDb`, `SqlMeter`, `WeftPlatform`, `BlobStore`, `SmallState`, `FixtureSource`, `RunHandleStore`, `SchedulerHost`, `MemoryRepo`, `RunHost`, `HostedSpendLedger` with caps `run | day | live | visitor | ip | neurons`, provider id `workers_ai`, `extraCommands`, `ReceiptOcr`, `DocumentRenderer`, `RecallSource`, `HelpSearch`, `MetricsSink`.
- `0008_hosted.sql`: `mem_objects`, `mem_refs`, `mem_log`, `blobs`, `run_files`, `run_handles`, `kv_state`, `outbox`.
- `digest.ts` skips the hosted tables while they are empty, so the base digest `950933e7ed6a...10d9` and every pinned eval digest are unchanged.
- `assemble.ts` holds today's `createWeft` body unchanged; `compose.ts` becomes `createWeft(opts) = assembleWeft(nodePlatform, opts)` with the same signature.
- The boundaries rule: only `apps/cf/**` and `packages/cf-extras/**` may import `cloudflare:*`, `@cloudflare/*`, `miniflare` or `wrangler`.
- Exact pins: wrangler 4.151.3 and the miniflare, workerd and `@cloudflare/workers-types` versions it bundles; `@cloudflare/puppeteer` 1.4.0; miniflare as a devDependency of `packages/db`, `apps/cf` and `packages/cf-extras`. No `agents` package.

**Acceptance.**

```
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm exec vitest run --project @weft/seed
pnpm exec vitest run --project @weft/tests tests/boundaries.test.ts
pnpm e2e
pnpm lint:prose && pnpm lint:brand
```

The `@weft/seed` project pins the base digest. `pnpm e2e` proves the compose split is a pure move.

## cf1-db (critical path)

**Goal.** Make DO SQLite behave exactly like the libsql database Weft uses today, and give the hosted side its meter, guard, resets and SQL memory.

**Owns.** `packages/db/**` except `src/schema.ts` and `drizzle/**`; `packages/executor/src/memory/**` and `packages/executor/test/memory/**`; `scripts/memory-bundle.ts`, `scripts/memory-restore.ts`.

**Builds.**
- `durable.ts`: `DurableSession` and `DurableTransaction` running drizzle callbacks inside `storage.transaction` (nested for savepoints); `facadeClient.transaction()` throws `UNSUPPORTED_LINEAR_TRANSACTION`; `rowsAffected` and `lastInsertRowid` from `SELECT changes(), last_insert_rowid()`; PRAGMA filter; parameter inlining above 100; 2 MB guard; error mapping.
- `meter.ts`: per-request rows read and written and the tables read and written; per-table commit versions for ETags.
- `tx-guard.ts`: `inTx` and `assertNotInTx()` throwing `IO_IN_TX`.
- `scope.ts`: `WorldScope` (AsyncLocalStorage) and the per-world write lock.
- `emu.ts`: `node:sqlite` emulation of `DurableStorageLike` with workerd's refusals, limits and transaction gating. `openDb` honors `WEFT_DB=durable-emu`.
- `migrate-durable.ts`: one `transactionSync` per journal entry, writing `__drizzle_migrations` as libsql does.
- `snapshot.ts`: dump into INSERT chunks under 90 KB, per-table seed rows and a manifest; restore; arm the dirty triggers (`INSERT ... WHERE NOT EXISTS`); delta reset in one `transactionSync` with `defer_foreign_keys`, the append-only trigger exception and DROP TABLE wipes; per-table JS digests.
- Memory: `MemoryRepo`, `GitRepo`, `SqlRepo`, `gitobj.ts` (sha1 blob, tree and commit), `store.ts` over the repo, fast-import export. `WEFT_MEMORY=sqlite` selects the SQL repo on Node.
- Conformance tests in `packages/db/test-workerd/` (Miniflare under plain vitest) and the same cases against the emulator.

**Acceptance.**

```
pnpm exec vitest run --project @weft/db
pnpm --filter @weft/db test:workerd
pnpm exec vitest run --project @weft/executor packages/executor/test/memory
WEFT_DB=durable-emu WEFT_MEMORY=sqlite pnpm exec vitest run --project @weft/executor --project @weft/api --project @weft/tests
pnpm test
pnpm typecheck
```

These must show:
- the conformance cases in design 11.3 pass on both the emulator and workerd, including the negative linear-transaction case and the rollback of writes issued after awaits, top level and nested;
- a double approve gives one execution and one `NOT_PENDING`;
- restore then delta reset after the 10 recorded flows reproduces the manifest digests twice, at no more than 25% above 557 rows written;
- both memory repos give identical HEAD, all 36 commit SHAs and identical search, read-at, history, tree and recall output, and `git fast-import` of the export reproduces the SHAs.

## cf2-platform

**Goal.** Let the API, executor and simulators run on either platform with zero `node:fs` on the durable path, and cut the rows Weft reads and writes per request.

**Owns.** `apps/api/src/**` except `compose.ts` and `memory/**` (it owns `assemble.ts` after cf0); `apps/api/test/**` except `memory-recall.test.ts`; `packages/executor/src/**` and `packages/executor/test/**` except `memory/**`; `packages/core/src/commands/time-off.ts` and `packages/core/test/time-off-requests.test.ts`; `packages/routines/**`; `packages/sim/src/notices/**`; `packages/integrations/src/secrets.ts`; `packages/seed/**` except `src/index.ts`, `src/cli.ts`, `src/digest.ts`.

**Builds.**
- `WeftPlatform` with Node and durable platforms; file and SQL BlobStore (`WEFT_BLOBS=sqlite`); SmallState; FixtureSource; RunHandleStore.
- Per-world auth windows; allowed origins from `WEFT_PUBLIC_ORIGIN` on hosted; vault fails closed under `WEFT_REQUIRE_VAULT_KEY=1`.
- The hosted reset hook and the read-only world guard; additive `?wait=25` long poll on `GET /v1/agent/runs/:id`; the `extraCommands` registry option.
- ETag/304 middleware over the cf1 meter for the polled GET routes, and the `x-weft-tables` header.
- Ephemeral read ids (`ephemeralReadIds`, env `WEFT_EPHEMERAL_READ_IDS=1`) in `pipeline.ts`.
- The prebuilt-routine hash gate in `packages/routines`; the `time_off.list_requests` N+1 fix.
- The after-commit outbox writer in the executor; the `IO_IN_TX` call sites in BlobStore and executor I/O.

**Acceptance.**

```
pnpm test
pnpm e2e
pnpm e2e:tour
pnpm eval:ci
WEFT_BLOBS=sqlite WEFT_EPHEMERAL_READ_IDS=1 pnpm exec vitest run --project @weft/api --project @weft/tests
pnpm exec vitest run --project @weft/api apps/api/test/hosted-platform.test.ts apps/api/test/hosted-etag.test.ts apps/api/test/hosted-reads.test.ts
pnpm exec vitest run --project @weft/routines packages/routines/test/prebuilt-hash.test.ts
pnpm exec vitest run --project @weft/core packages/core/test/time-off-requests.test.ts
pnpm typecheck
```

These must show:
- an fs guard proves the durable platform makes no `node:fs` calls;
- an unchanged poll returns 304 with 0 rows read;
- with ephemeral read ids, a sweep of all 67 GET routes writes 0 rows, and no table holds a `res_e_` id after the scenarios;
- a second boot writes 0 rows on its first tick;
- `/v1/time-off/requests` on the rich world is byte-identical with at most 6 statements;
- a missing `WEFT_VAULT_KEY` on the durable platform throws at assemble time;
- two Weft instances in one process share no limiter, redactor or recall state.

## cf3-agent

**Goal.** Put the hosted model path and spend enforcement behind the existing agent contracts, and expose MCP over Streamable HTTP.

**Owns.** `packages/agent/**`; `apps/mcp/**`.

**Builds.**
- `spend-core.ts` shared by the file store and a SQL store (SpendDO uses the SQL store); visitor, IP-hash and neuron caps; orphan settle at worst case after 15 min.
- `RunHost` (Node runs the job at once; durable drains an alarm FIFO, one live run per invocation); the boot rule unchanged; provider chosen and pinned at run creation; background runs charged to the lease's visitor and IP hash.
- OpenAI gateway transport: base URL from env, `cf-aig-metadata`, optional `cf-aig-authorization`, `.withResponse()` with a $0 settle on a gateway HIT, a BYOK fetch that strips the placeholder `Authorization`.
- The `workers_ai` provider over `env.AI.run` with the gateway option, plus a Node REST transport for evals; neuron pricing rows in `cost.ts`; `LIVE_PROVIDER_IN_TEST` covers it.
- Env-only secrets on durable; per-world otel state; a per-invocation fetch counter.
- `apps/mcp`: `createRemoteMcpHandler(cfg, fetchImpl)` on SDK 1.32.1's `WebStandardStreamableHTTPServerTransport` (stateless), with `agent_ask` using the long poll.

**Acceptance.**

```
pnpm exec vitest run --project @weft/agent
pnpm exec vitest run --project @weft/mcp
pnpm eval:ci
pnpm test
pnpm typecheck
```

These must show:
- the shared ledger tests give identical results on the file and SQL stores for every cap;
- with a deferring fake RunHost, runs start only when it drains, settled waiters and SSE subscribers still fire, and live concurrency stays 1;
- the OpenAI request snapshot differs only in URL and headers;
- a fake-binding `workers_ai` tool round trip prices correctly and the factory refuses it in tests;
- the remote handler lists 122 tools, refuses approve, rollback and vault, and `agent_ask` makes at most 3 requests per call;
- the stdio MCP tests are unchanged.

## cf4-worker

**Goal.** Host Weft on Workers: the public front, the Durable Objects, the reset pipeline and the scripts that build and deploy them.

**Owns.** `apps/cf/**` except `package.json`, `tsconfig.json`, `src/extras/**`, `test/extras/**` and `d1/**`; `scripts/cf/**` except `smoke.ts` and `help-corpus.ts`.

**Builds.**
- `src/front/`: cookies and human grant, Turnstile siteverify, `RL_API`, `RL_MUTATE` and `RL_MCP`, routing by lease and mcp key prefix, header stripping and the HMAC'd `x-weft-ctx`, the showcase memo, the `[id]` shell fallback through `env.ASSETS.fetch`, `/api/_session/*`, the `/api/_admin/*` HMAC routes, the hosted reset intercept.
- `src/core/`: `CompanyDO` (WorldScope, lazy `@weft/*` import in `blockConcurrencyWhile`, durable migrations, the alarm runner, the WebSocket feed, the SSE pass-through, `/mcp`, the delta reset and PITR paths, showcase and smoke modes, the outbox flush); `LobbyDO` (slots, leases, generations, per-IP-hash lease cap, daily counters and shares, waitlist, degradation level, restore budget); `SpendDO`; `ReseedWorkflow`; the cron handler; queue dispatch to cf6 handlers.
- `wrangler.core.jsonc` and `wrangler.front.jsonc` as in design 9.4.
- Scripts: `with-cf.sh`, `put-secret.sh`, `resources.ts`, `fixtures.ts`, `snapshot.ts`, `build.ts` (throwaway worktree, export, dry run), `deploy.ts`, `budget.ts`, `dev.ts`.
- `apps/cf/vitest.workerd.config.ts` and the Miniflare suite in `apps/cf/test/**`.

**Acceptance.**

```
pnpm --filter @weft/cf typecheck
pnpm cf:fixtures && git diff --exit-code apps/cf/generated/fixtures.ts
pnpm cf:snapshot
pnpm cf:test
pnpm cf:build
pnpm test
```

These must show:
- every design 11.4 case passes;
- `pnpm cf:build` ends with `wrangler deploy --dry-run` succeeding for both configs and prints bundle sizes (front under 1 MiB, core under 16 MiB);
- 4 slots in one isolate stay under 100 MB of heap;
- an alarm makes at most 40 counted fetches;
- `pnpm cf:dev` serves the tour on port 5780 with data under `.scratch/cf4-worker/`.

## cf5-web

**Goal.** Ship the web app as a static export without changing the Node app, keep idle tabs nearly free, and add the hosted shell.

**Owns.** `apps/web/**` (never commit `apps/web/next-env.d.ts`).

**Builds.**
- The conditional export config in `next.config.ts` (`output: "export"`, `trailingSlash`, no rewrites, `pageExtensions: ["tsx"]` under `WEFT_STATIC_EXPORT=1`); `generateStaticParams` with `_` for the five `[id]` pages; `useRouteId`; the client-rendered landing with `stats.json`.
- `apps/web/scripts/cf-export.ts`: writes `_redirects`, `_headers` with per-route CSP script hashes, and checks the output.
- `hooks.ts`: pause when hidden, idle backoff, the hosted interval multiplier, the WebSocket invalidation feed keyed by `x-weft-tables`, a 5 s SSE trace fallback on hosted.
- The hosted shell under `NEXT_PUBLIC_WEFT_HOSTED=1`: showcase banner, Start my demo company with the Turnstile widget, the 428 retry, the lease countdown and lease-ended, waitlist and budget screens, the hosted reset UX, the model switch, the Platform page, the model comparison page, the MCP connect dialog, PDF buttons, Help in Cmd+K, the Dictate button and the fictional-data notice.

**Acceptance.**

```
pnpm --filter @weft/web build
pnpm exec vitest run --project @weft/web
WEFT_STATIC_EXPORT=1 NEXT_PUBLIC_WEFT_HOSTED=1 pnpm --filter @weft/web build
pnpm --filter @weft/web cf:check-export
pnpm e2e
pnpm e2e:tour
```

These must show:
- the Node build and both e2e suites are unchanged;
- the export emits all 30 routes, contains no proxy code, and has `_redirects` and `_headers` within their rule limits;
- a Playwright check shows a hidden tab makes 0 API requests in 60 s, and an idle visible tab with the socket connected makes at most 1 request per 60 s.

After cf4 merges, against `pnpm cf:dev` on port 5790:
- `/app/people/wrk_0026/` renders from the shell;
- the `_redirects` 200 rewrite is confirmed, or the `run_worker_first` fallback is switched on and recorded.

## cf6-extras

**Goal.** Add the visitor-facing Cloudflare features, all off the harness path and each behind a KV flag.

**Owns.** `packages/cf-extras/**` except `package.json` and `tsconfig.json` (new package; cf0 creates those two); `apps/cf/src/extras/**` (the `HostedExtras` WorkerEntrypoint and the queue job handlers) and `apps/cf/test/extras/**`; `apps/cf/d1/**`; `apps/api/src/memory/**` and `apps/api/test/memory-recall.test.ts`; `scripts/cf/help-corpus.ts`.

**Builds.**
- `ReceiptOcr` and `NoticeOcr` (Images binding, then `mistral-small-3.1-24b-instruct`; extracts written back through the hidden `expenses.attach_receipt_extract` and `notices.attach_scan_extract` service commands, registered with `extraCommands` and listed in `UNTRUSTED_LIST`).
- `DocumentRenderer` (Weft HTML templates, `page.setContent` with JavaScript off and every request aborted, R2 cache keyed by generation and sha256).
- `RecallSource` (Vectorize and bge-base, filtered by generation, re-verified at HEAD) and the hybrid recall hook in `apps/api/src/memory`, off by default.
- `HelpSearch` (AI Search, 30 a day, kill flag) and the help corpus upload script.
- `Dictation` (whisper-large-v3-turbo, 30 s clips, 300 neurons a day).
- `RunCatalog` (D1 writer and the comparison aggregates); `MetricsSink` (D1 now, Analytics Engine once enabled); the Platform readout.

**Acceptance.**

```
pnpm exec vitest run --project @weft/cf-extras
pnpm exec vitest run --project @weft/api apps/api/test/memory-recall.test.ts
pnpm eval:ci
pnpm test
```

After cf4 merges:

```
pnpm cf:test apps/cf/test/extras
```

These must show:
- with every flag off, every other suite's output is byte-identical and recall blocks are unchanged;
- an OCR extract read by a run taints it (a GP5-style test);
- a PDF job renders through a fake browser with no network request allowed, then serves from cache on repeat;
- recall never cites a path or commit missing at HEAD;
- every job handler is idempotent on redelivery;
- help search and dictation respect their daily caps.

## cf7-integrate (final integration and deploy)

**Goal.** Merge the tracks, prove the whole stack locally, create the resources, deploy, smoke and record measured numbers.

**Owns.** `e2e/cf/**`; `playwright.cf.config.ts`; `scripts/cf/smoke.ts`; `docs/cloudflare/**` beyond `design.md` and `tracks.md` (which it updates only with measured results); the hosted sections of `README.md`, `SPEC.md` 9.9, `docs/models.md`, `docs/demo-scenarios.md` (the scenario 8 hosted note) and `research/harness.md`; after cf0, every cf0 path, including contract requests and dependency changes.

**Steps.**
1. Merge in the order above; resolve contract requests.
2. Run the combined suites:
   ```
   WEFT_DB=durable-emu WEFT_MEMORY=sqlite WEFT_BLOBS=sqlite WEFT_EPHEMERAL_READ_IDS=1 pnpm test
   pnpm test && pnpm e2e && pnpm e2e:tour && pnpm eval:ci
   pnpm cf:test
   pnpm cf:dev
   pnpm exec playwright test -c playwright.cf.config.ts --project local
   ```
3. `pnpm cf:resources` (read-only billing check before and after; stops on any change).
4. Generate secrets into `~/Developer/projects/.weft.cf.secrets.env` (mode 600) and install them with `scripts/cf/put-secret.sh`.
5. `pnpm cf:deploy`, then the deployed transaction conformance route on the scratch `conformance` CompanyDO. Any failure means `wrangler rollback` for both scripts.
6. `POST /api/_admin/provision` for UTC day 1 (showcase, `slot-smoke`, `slot-1`); days 2 and 3 follow under the Lobby's restore budget.
7. Run the deployed checks:
   ```
   pnpm cf:smoke --url https://weft.nitish-ratakonda.workers.dev
   pnpm exec playwright test -c playwright.cf.config.ts --project deployed
   pnpm cf:budget
   ```
8. With Nitish's opt-in: `pnpm cf:smoke --url https://weft.nitish-ratakonda.workers.dev --live` (one notice run on Luna, under $0.01; one Workers AI run recorded in D1).
9. Run the live L1 to L4 gate with semantic recall on, inside the caps; set KV `recall.semantic=on` only if nothing regresses.
10. Write the measured CPU, rows and spend numbers into `docs/cloudflare/`, update `SPEC.md` 9.9 and `docs/models.md` (DO CPU, R2 already active, 64 MiB Worker size), then `pnpm lint:prose && pnpm lint:brand && pnpm brand:overlap`, and merge `cf/integration` into `main`.

**Acceptance.**
- Every command above exits 0.
- `pnpm cf:smoke` passes the design 11.6 list: platform checks, the guided tour within 180 s, the eight scenarios with their exact figures, the extras, chain verify, and a clean secret grep over the Workers Logs dump.
- `pnpm cf:budget` shows front p99 CPU at most 5 ms, DO route p99 at most 50 ms, no `exceededResources` or `exceededMemory`, a showcase GET sweep at 0 rows written, and per-flow rows within 25% of the design 8.2 baselines.
- Every created resource is listed in `docs/cloudflare/resources.md`, and the docs say "deployed" only for what the smoke run proved.
