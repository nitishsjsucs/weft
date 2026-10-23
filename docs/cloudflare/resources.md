# Weft on Cloudflare: the resources a deploy creates

Status: none of these exist yet. Nothing is deployed; this list is what `pnpm cf:resources` and `pnpm cf:deploy` create on Nitish's account (Workers Free) when the Deploy stage runs them, taken from [design.md](design.md) section 9, `scripts/cf/resources.ts`, `scripts/cf/deploy.ts` and the two wrangler configs (`apps/cf/wrangler.core.jsonc`, `apps/cf/wrangler.front.jsonc`, rendered for a deploy by `scripts/cf/lib/configs.ts`). Free limits are the documented account-wide limits from design 7.1 and 8.2; most are shared with the six other apps on the account, and the Lobby and SpendDO hold Weft to its share.

No secret values and no secret identifiers are written here. The account id is passed through the environment at deploy time. Resource ids (the KV namespace id, the D1 database id) and the public Turnstile sitekey go to `apps/cf/resources.json` (gitignored) when `pnpm cf:resources` creates them. The AI Gateway's name is a secret while the gateway is unauthenticated (design 9.3), so it lives only in the cf secrets file.

## Created by `pnpm cf:resources`

Run through `scripts/cf/with-cf.sh` with the account token; idempotent; it reads the account's subscriptions before and after and stops if anything about billing changed.

| Resource | Name | Binding (Worker) | Purpose | Free limit that matters |
|---|---|---|---|---|
| Workers KV namespace | `weft-config` | `CONFIG` (weft, weft-core) | the kill switch, the model default, feature flags, every cap, the snapshot version, Lobby levers (`HOSTED_CONFIG_KEYS` and `CF4_CONFIG_KEYS`) | 100,000 reads and 1,000 writes a day; 1 write per second per key |
| D1 database | `weft-ops` | `OPS` (weft-core), migrations in `apps/cf/d1/` | off the data path: `run_catalog` (the model comparison page), `budget_daily` (`pnpm cf:budget`), `jobs` and `failed_jobs` (the queues' ledger and dead letters), `metrics_daily`, `smoke_results` | 10 databases per account (this makes 8); 100,000 rows written and 5M read a day; 50 queries per invocation |
| R2 bucket | `weft-files` | `FILES` (weft-core) | rendered PDFs (generation-keyed), memory and world exports, the help corpus under `help/` for AI Search | 10 GB-month, 1M Class A and 10M Class B operations a month; the account is on a usage-metered R2 plan |
| R2 lifecycle rules | `expire-w`, `expire-exports` on `weft-files` | | objects under `w/` and `exports/` expire after 3 days, which keeps the bucket inside the free tier | |
| Queue | `weft-jobs` | `JOBS` producer and consumer (weft-core) | after-commit jobs: receipt and notice OCR, embeddings, exports (batch 5, 5 retries) | 10,000 operations a day (about 3,300 messages); 128 KB messages; 24 h retention |
| Queue | `weft-render` | `RENDER` producer and consumer (weft-core) | PDF rendering through Browser Run, concurrency 1, 20 s retry delay | shares the queue operations above |
| Queue | `weft-dlq` | consumer (weft-core) | dead letters from both queues; each is written to D1 `failed_jobs` and logged | shares the queue operations above |
| Vectorize index | `weft-memory` (768 dimensions, cosine) | `MEMVEC` (weft-core) | semantic memory recall candidates, filtered by generation; off until the live L1 to L4 gate (KV `recall.semantic`) | 5M stored and 30M queried dimensions a month; 1,000 namespaces per index |
| Vectorize metadata indexes | `gen` (number), `tainted` (boolean), `kind` (string) on `weft-memory` | | created before the first upsert, so recall can filter on them | |
| AI Gateway | a secret name (`weft-` plus random hex, in the cf secrets file as `WEFT_AIG_GATEWAY`) | used by weft-core through `WEFT_AIG_GATEWAY` and `env.AI.run({ gateway })` | every model call: logs on, cache TTL 1 day, a sliding rate limit of 60 per 60 s, cost analytics, per-slot and per-run metadata | 10 gateways per account (this makes 4); its logs count against Workers Logs |
| Turnstile widget | `weft` (managed, domain `weft.nitish-ratakonda.workers.dev`) | `TURNSTILE_SITEKEY` var and `TURNSTILE_SECRET` secret (weft); `NEXT_PUBLIC_WEFT_TURNSTILE_SITEKEY` in the web build | the human check at lease start and the 10-minute human grant for mutations | 20 widgets, unlimited challenges, 10 hostnames per widget |

Left for the Deploy stage, listed by `pnpm cf:resources` as manual steps:

| Resource | Name | Binding | Purpose | Free limit that matters |
|---|---|---|---|---|
| AI Search instance | `weft-help`, over R2 `help/` | `HELP` (weft-core; not declared in `wrangler.core.jsonc` yet) | Help results in Cmd+K over Weft's own docs, capped at 30 queries a day by the Lobby; created only after its first-deploy check, and kept after 2026-11-01 only if Free accounts are capped rather than billed (design 13.4) | 1,000 semantic queries a month included |
| AI Gateway spend rule | $2.50 a day on the gateway | | a backstop behind SpendDO's own caps; a first-deploy check settles whether spend rules apply on Free | |

## Created by `pnpm cf:deploy`

`pnpm cf:deploy secrets` generates the missing secrets into `~/Developer/projects/.weft.cf.secrets.env` (mode 600, outside the repo) and installs them with `scripts/cf/put-secret.sh`, which prints names only. `pnpm cf:deploy` applies the D1 migrations, deploys weft-core, then weft, then writes KV `snapshot.version`.

### Worker scripts

| Resource | Name | Purpose | Free limit that matters |
|---|---|---|---|
| Worker | `weft-core` (`workers_dev` false, `preview_urls` false: no public route) | hosts the worlds and the operations objects; reached only through Durable Object bindings and the `CORE` service binding | 100,000 Worker requests a day account-wide; 10 ms CPU documented per request; 50 external subrequests; 128 MB memory; 1 s startup; 64 MiB uncompressed size |
| Worker | `weft` (`workers_dev` true at `weft.nitish-ratakonda.workers.dev`, `preview_urls` false) | the public front: static assets, then for `/api/*` and `/mcp` only the cookie and key checks, rate limits, Turnstile siteverify and routing to a world | the same Worker limits; static asset requests are free and not counted |
| Static assets | the Next static export (`apps/web/out`), binding `ASSETS` (weft) | every page; `_redirects` serves the `[id]` shells, `_headers` sets the CSP and security headers | free and unlimited; 20,000 files; 25 MiB per file; 100 `_headers` rules |

### weft-core bindings

| Resource | Name | Binding | Purpose | Free limit that matters |
|---|---|---|---|---|
| Durable Object namespace (SQLite) | class `CompanyDO` | `COMPANY` (also bound in weft with `script_name: "weft-core"`) | one world per object: `showcase` (read-only, unleased visitors), `slot-1` and `slot-2` (the pool, `WEFT_POOL_SIZE` 2), `slot-smoke` (the deployed smoke, scripted provider), `conformance` (the post-deploy transaction check, wiped after) | 100,000 requests, 100,000 rows written, 5M rows read and 13,000 GB-s a day account-wide; 5 GB stored; 30 s CPU per invocation measured |
| Durable Object namespace (SQLite) | class `LobbyDO`, object `lobby` | `LOBBY` (weft-core and weft) | slots, leases, generations, the per-IP-hash lease cap, daily counters and shares, the waitlist, the degradation level, the restore budget | the DO limits above |
| Durable Object namespace (SQLite) | class `SpendDO`, object `spend` | `SPEND` (weft-core and weft) | the spend ledger, every cap, the orphan sweep, the neuron budget | the DO limits above |
| Durable Object migration | tag `v1` (`new_sqlite_classes` CompanyDO, LobbyDO, SpendDO) | | the three classes; later migrations are additive only | |
| Workflow | `weft-reseed`, class `ReseedWorkflow` | `RESEED` | a full restore and arm in chunked steps that only RPC into a CompanyDO, with durable retries | 3,000 steps a day; 10 ms CPU per step documented; 1,024 steps per instance |
| Workers AI | | `AI` | the model switch (`@cf/openai/gpt-oss-120b`), embeddings, receipt and notice OCR, dictation | 10,000 neurons a day account-wide (Weft's share 5,000; `WEFT_NEURON_DAY_CAP` 5000) |
| Browser Run | | `BROWSER` | offer letter, signed agreement and pay stub PDFs from Weft templates, JavaScript off and every request aborted | 10 browser-minutes a day; 3 concurrent; 1 new browser per 20 s |
| Images | | `IMAGES` | normalizes and downscales receipt photos before OCR | 5,000 unique transformations a month, no charge past it on Free |
| Rate Limiting namespace | `4103` | `RL_RUN` (6 per 60 s) | live run admission per visitor | per location, eventually consistent |
| Cron Trigger | `*/15 * * * *` | weft-core `scheduled()` | the Lobby sweep (lease ends, resets, restores within the budget), orphaned reservations, bookmarks, parked jobs | 5 per account (this makes 2) |
| Service entrypoint | `HostedExtras` | `CORE` service binding in weft | help search, dictation, the Platform and model comparison readouts, exports | not billed as separate requests |
| Workers Logs and traces | `observability` on, head sampling 0.5, traces 0.05 | | structured, redacted events; CPU per invocation | 200,000 events a day, 3-day retention |

Plus the KV `CONFIG`, D1 `OPS`, R2 `FILES`, Vectorize `MEMVEC` and the `JOBS` and `RENDER` producers from the table above.

### weft bindings

| Resource | Name | Binding | Purpose | Free limit that matters |
|---|---|---|---|---|
| Rate Limiting namespace | `4101` | `RL_API` (600 per 60 s per IP hash) | `/api` GETs; a signed smoke visit skips it (design 6.3) | per location, eventually consistent |
| Rate Limiting namespace | `4102` | `RL_MUTATE` (30 per 60 s per IP hash) | every mutation, the smoke's included | as above |
| Rate Limiting namespace | `4104` | `RL_MCP` (60 per 60 s per key) | remote MCP requests | as above |
| Workers Logs | `observability` on, head sampling 0.2 | | front events | shares the allowance above |

Plus `COMPANY`, `LOBBY` and `SPEND` (with `script_name: "weft-core"`), the `CORE` service binding, KV `CONFIG` and `ASSETS`.

### Secrets (names only)

| Worker | Secret | Source |
|---|---|---|
| weft-core | `WEFT_VAULT_KEY`, `WEFT_PROXY_SECRET`, `WEFT_CTX_SECRET`, `WEFT_SESSION_SECRET` | generated by `pnpm cf:deploy secrets` |
| weft-core | `OPENAI_API_KEY` | Weft's own secrets file (phase 1) |
| weft-core | `WEFT_AIG_GATEWAY` | written by `pnpm cf:resources` |
| weft-core | `CF_AIG_TOKEN` | optional, once Nitish creates the gateway token |
| weft | `WEFT_SESSION_SECRET`, `WEFT_CTX_SECRET`, `WEFT_PROXY_SECRET`, `WEFT_SMOKE_TOKEN`, `WEFT_ADMIN_TOKEN` | generated by `pnpm cf:deploy secrets` |
| weft | `TURNSTILE_SECRET` | written by `pnpm cf:resources` from the `weft` widget |

`WEFT_SMOKE_TOKEN` signs the smoke's `x-weft-smoke` header and `WEFT_ADMIN_TOKEN` the `/api/_admin/*` routes, the operator lease included; `pnpm cf:smoke` and `pnpm e2e:cf --project deployed` read both from the cf secrets file with awk and never print them.

## Not created

Analytics Engine stays undeclared until Nitish enables it once in the dashboard (design 13.2); metrics go to D1 until then. Secrets Store (phase 2, for AI Gateway BYOK) already exists on the account and is empty. Nothing that needs Workers Paid is created (design 7.2). No custom domain, so no Email Routing.
