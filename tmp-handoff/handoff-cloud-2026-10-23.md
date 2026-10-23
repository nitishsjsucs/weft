# Handoff: the cloud session's integration work (2026-10-21 to 2026-10-23)

This is for Nitish's **local Claude agent** on the Mac, which wrote `handoff-2026-10-20.md` and handed the work to a cloud Claude Code session. That cloud session now hands it back. Read `handoff-2026-10-20.md` first; this file only adds what happened since.

## 0. In one minute

- **Branch:** all of the cloud session's work is on **`claude/happy-fermat-0quehc`** (tip `83d6a72`), on GitHub. It is `cf/integration` (`b2ef985`) plus one Playwright commit plus four merged fix branches. `cf/integration` and `main` were **not** changed by the cloud session.
- **State:** handoff section 5 (Integrate) is mostly done. Every open item from 5.2 was diagnosed, and the real ones were fixed in four chains. Two of the four chains (G2 worker, G5 node e2e) were **not adversarially reviewed**: the reviewers died on the account's weekly usage limit. The merged tree typechecks 18/18 and passes `lint:prose`, but **the full suites have not been run on the merged tree**.
- **Not started:** the cf7 deliverables (`scripts/cf/smoke.ts`, `playwright.cf.config.ts`, `e2e/cf/**`, `docs/cloudflare/resources.md`), Deploy, Verify and Land.
- **Next action:** pull the branch, review G2 and G5 (section 4), run the combined acceptance on the merged tree (section 5), then build the cf7 deliverables and deploy (section 6).
- **The local demo:** nothing on `main` or the tag `demo-stable-2026-10-20` moved. On the branch, with default settings, the G1 chain measured `pnpm test` fully green (2073 passed, 0 failed), `pnpm demo` identical to the tag, `pnpm eval:ci` gate passed and trial-for-trial identical to the tag. `pnpm e2e:tour` passed 31/31 (tour 151 s) before the fixes.

## 1. Get the work

```bash
cd ~/Developer/projects/weft
git fetch origin --tags
git switch -c cloud-integration origin/claude/happy-fermat-0quehc   # or check it out in the cf-integration worktree
pnpm install --frozen-lockfile
```

The four fix branches (`fix/g1-node-core`, `fix/g2-worker`, `fix/g3-web-hosted`, `fix/g5-node-e2e`) were merged with `--no-ff`, so each chain is one merge commit you can inspect: `git log --first-parent origin/claude/happy-fermat-0quehc`. The fix branches themselves were never pushed (only the merged branch was).

To fold this into `cf/integration`: `git -C <cf-integration worktree> merge --ff-only origin/claude/happy-fermat-0quehc` works, since the branch descends from `cf/integration`'s tip `b2ef985`.

## 2. Things that differ from your Mac (read before judging a failure)

The cloud container is Linux, x64, nodejs.org Node 25.9.0, git 2.43.0, no Google Chrome, 4 CPUs. Several "failures" were the container, and two were real bugs your Mac hid:

1. **Pinned digests and zlib (real bug, fixed in G1).** Official nodejs.org Node binaries bundle Chromium's zlib, which compresses two of the seed's receipt PNG patterns (seeds % 11 == 2 and 9) into different but valid bytes. Those bytes land in `uploads` rows, so the base, rich and every eval world digest depended on the Node build. Your Mac's Node writes canonical zlib streams (very likely a Homebrew Node linked to the system libz; confirm with `node -p process.versions.zlib`: a plain version means system zlib). Fix: `packages/seed/src/w3-expenses.ts` pins the 11 canonical IDAT streams and checks them with `inflateSync`. Proven here: base `950933e7...10d9`, rich `8c1beb14...5396`, `eval:suite digests --split all` 110/110, all equal to the Mac pins. **Your Mac's digests do not change.** This also makes a hosted snapshot built on Linux identical to one built on the Mac.
2. **git date format (real bug, fixed in G1).** git 2.45 changed `%cI` for a zero offset from `+00:00` to `Z`. `SqlRepo` printed `Z`, `GitRepo` printed whatever git printed, so `repos.test.ts` passed only on git 2.45+. `GitRepo` now reads `--date=raw` and formats with the same `strictIso`. On your Mac (git 2.50) output is byte-identical; SHAs unchanged.
3. **Browser.** New `e2e/browser.ts`: every Playwright config (root and `apps/web/playwright.hosted.config.ts`) launches Google Chrome as before unless `WEFT_PW_EXECUTABLE` names a binary. Unset on the Mac, nothing changes.
4. **Load-sensitive test.** `packages/executor/test/sandbox/code-run.test.ts` limits test ran at 3.6 to 4.6 s alone against vitest's 5 s default; under load it timed out. It now has a timeout derived from the sandbox budgets (no assertion changed).
5. **Workers runtime and the proxy.** workerd does not use the container's HTTPS proxy, so the Miniflare suite could not reach Cloudflare's real siteverify, and two fetch-budget tests depended on DNS timing. G2 made the suite hermetic (a siteverify stub with Cloudflare's published test-secret semantics; one opt-in real case).
6. **Brand lints are nominal here.** The reference folder is not in the container, so `lint:brand` checked only names and domains, and `brand:overlap` skipped. **Run both on the Mac before the PR merges.** cf5 and cf6 added visitor-facing copy that was never checked against the denylist.

## 3. What each chain did

Diagnosis first: a 9-agent workflow audited every 5.2 item, every `contract_requests`/`remaining` entry in `build-results-2026-10-20.json`, the cf pipeline and the cf7 plan, then a completeness critic checked them. About half of 5.2 was already done on `cf/integration` (memory wiring, `createSqlRepo`, migrate input, the `sql.ts` cast, `workers_ai`/`svc_jobs`, `hostedProviderSelector`, the live env Proxy, `extrasCron`, the snapshot flags, the lease keys, the deep link, hosted-only polling, the section 0 lease settings, the wrangler pins). `cf:snapshot` and `cf:build` already exited 0. The handoff's "exit 1 until memory wiring lands" was stale.

### G1 node-core (reviewed: clean, 0 blocking)
- `11691d4` seed: pin canonical receipt IDAT streams (section 2.1), plus `packages/seed/test/receipts.test.ts`.
- `9cbef6d` executor: `GitRepo` dates via `strictIso` (section 2.2).
- `3cccf8d` api test: `memory-recall.test.ts` reads through the repository port, not `git show` (the 5 semantic-recall failures under `WEFT_MEMORY=sqlite`).
- `aff7eaa` code-run timeout (section 2.4).
- `ca31ff3` db: `migrationsDir()` is lazy; `@weft/db` **no longer exports `MIGRATIONS_DIR`**. `factory.ts` stays in `MODULE_LEVEL_IMPORT_META_PENDING` (it is never bundled).
- `9940f55` api: Node's reset rebuild skips `_cf_` tables.
- `2c94fc0` db test: the delta reset failed (716 rows against the 696 band) only with SQL memory. The 557 baseline was measured on git memory. `recordRichSession(memory, rounds)` now names its memory repo; git memory keeps the 557 band; SQL memory has its own measured baseline, 717 rows (workerd; 716 on the emulator), band 896.
- Measured on the G1 branch: default `pnpm test` 2073 passed, 0 failed; durable-emu `pnpm test` (all four hosted flags) 2070 passed, 0 failed; `test:workerd` 24/24; `eval:ci` gate passed; `pnpm demo` exit 0.
- Review minors worth knowing: docs still say 557 rows for the hosted delta reset (design 4.6 and 8.2, tracks.md:90); hosted always uses SQL memory, so update them to the 717 figure. The flows comment says "verified locally" for a container measurement (fix the status word).

### G2 worker (NOT reviewed; builder's own acceptance passed)
Front, leases and security (pass 1):
- `d396bb7` one siteverify idempotency key per verification (sha of the token), and the hermetic Miniflare suite.
- `2c61967` the KV kill switch fails **closed** on a cold isolate; a failed run alarm is reported and re-armed.
- `03d1925` the per-IP-hash lease cap holds under concurrent starts.
- `6071766` an MCP key stops working when its lease ends. Caveat from the builder: after an idle or total expiry, the Lobby only notices at the next cron sweep (up to 15 min) or on status/assign, so a key can outlive an *expired* lease by up to 15 minutes. Review this.
- `1b2858e` `GET /api/_session` reports `reason: "world"` after the model switch.
- `5ea14de` **RL_API raised from 120 to 600 per 60 s per IP hash**, and signed smoke visits skip it. The guided tour measured more than 120 /api requests in its first minute (59 responses were 429 at the old limit). Measurements in design 6.3 (`1d89b3b`). **This loosens a protection Nitish set; confirm it with him**, or cut the tour's request burst instead.
- `de70fd7` **new operator lease**: `POST /api/_admin/lease` and `/api/_admin/grant`, admin-HMAC authenticated like the other admin routes. It leases a pool slot without Turnstile and returns the session and grant cookies, so Playwright, the smoke `--live` run and remote MCP on the deployed URL can work. Security-sensitive and unreviewed: check it first.
- `2d120d9` docs for the above.

Core, snapshot and scripts (pass 2):
- `74fc138` `kv_state` is restored but never dirty-tracked, and the weekly verify leaves it out. Before this, every clean stamped world (showcase included) failed its weekly verify and was needlessly rebuilt, burning the daily restore budget (confirmed in real workerd).
- `638fbf4` `LIVE_PING`/`LIVE_PONG` in `packages/contracts/src/ext/cf-hosted.ts`; CompanyDO uses them. (`apps/web/src/lib/hosted/flags.ts` still has its own copy with the same values; re-export from contracts when convenient.)
- `08d1210`, `64e8d91` `POST /api/_admin/seed-index`: runs `indexSeedMemory` resumably, metered by SpendDO's neuron budget. Run daily until `done: true`, then set KV `recall.semantic=on`.
- `1a2047f` world export counts no `_cf_` table; the local Browser Run stand-in refuses sessions with a clear reason (local PDFs fail fast instead of hanging; deployed PDFs use the real binding).
- `fc33553` `cf:build` reads resources before the web build and builds the export with the real `NEXT_PUBLIC_WEFT_TURNSTILE_SITEKEY` and `WEFT_PUBLIC_ORIGIN`, with `stats.json` in `apps/web/public`; it records `placeholders.sitekey`, and **`cf:deploy` refuses any build with the always-pass test sitekey**. `cf:dev` copies `stats.json`, takes `--turnstile-verify-url` (or `WEFT_CF_DEV_TURNSTILE_VERIFY_URL`) and fails fast when the restore budget cannot fit the pool. The snapshot revokes the seeded API keys and refuses a manifest with an unrevoked key. The import scan runs without a snapshot.
- `5e7ab15` real-engine workerd cases: `agent_ask` over `/mcp` with the `?wait` long poll, the deployed `scheduled()` handler (Lobby sweep plus `extrasCron`), the seed index, and the weekly verify.
- `8c14748` docs.
- Builder's acceptance on the G2 branch: `cf:snapshot` rc 0 (106 chunks, 8270 rows, keys revoked); whole `pnpm cf:test` 19 files, 152 passed, 1 skipped (the opt-in real-siteverify case), with no NO_PROXY trick; `cf:build` rc 0 (non-deployable only because resources and secrets are absent); `@weft/cf` unit project 11 files, 97 tests.
- Notes: the snapshot's cf1 id changes on every `cf:snapshot` run with the same world digest, so every redeploy marks slots stale (pre-existing, not investigated). `engine-real`'s pool is 5 in that test only.

### G3 web-hosted (reviewed: clean, 0 blocking)
- `bda1952` Dictate converts the clip to 16 kHz mono PCM WAV with `encodePcm16Wav` before posting (hosted dictation refused WebM/MP4, so every hosted dictation failed). The PDF button polls on 202 (bounded, 60 s), stops on 413/503, and saves only `application/pdf` (it used to save the 202 JSON as a `.pdf`). Offer-letter PDFs use the offer's `documentId` (they always 404'd) and hide when there is none. The Platform page labels every share key the Lobby sends.
- `fff442e` the cf5 review minors: gate codes re-read on retry, a 60 s human-check timeout, one lease request at a time, one refresh per reconnect, a bounded tables map (hosted-only).
- `a1a9b92` the hosted e2e stand-ins now refuse what the real routes refuse, so they can catch these bugs; `playwright.hosted.config.ts` uses `browserUse` and writes nothing at load.
- Acceptance: web unit 27 files, 293 tests; the default Node web build unchanged; the hosted export builds; `e2e:hosted` passes (port 5790).
- Review minors: each PDF poll spends an RL_MUTATE token (30/min), so two PDFs rendering at once plus other actions can hit it; `wrangler` writes `apps/web/.wrangler/tmp/` during `e2e:hosted`, which is not gitignored.

### G5 node e2e and evals (NOT reviewed; builder's acceptance passed)
- `cb13b27` `site-dev-runner` reads `/proc/<pid>/environ` where `ps -E` is missing (macOS unchanged) and kills its runner in a `finally`; `site-layout-1440` allows the scrollbar width.
- `f57d1ef` `pnpm eval:suite --provider workers_ai` behind the same live opt-in as openai (never used by `eval:ci`); hosted env names documented in `docs/models.md`; one line in `docs/evals.md`.
- Acceptance: `pnpm e2e` 53 passed, 1 skipped (gp18 docusign, by design), with `WEFT_PW_EXECUTABLE`.
- Open decision: whether `workers_ai` gets a `RUN_CAP_SCALE` entry in `packages/agent/src/cost.ts` (its input price is about 1.75x Luna's).

## 4. Review G2 and G5 first

Run an adversarial review of each unreviewed chain through its merge commit (merge order: G1 `36144d4`, G3 `b1311eb`, G5 `b5e9837`, G2 `83d6a72`): `git diff 83d6a72^1 83d6a72` is everything G2 added, and `git diff b5e9837^1 b5e9837` is G5. Priorities:
1. `/api/_admin/lease` and `/api/_admin/grant`: unusable without the admin token (no token, wrong token, stale timestamp, replay); cannot pick another visitor's slot; respects pool, per-IP and spend caps and lease expiry.
2. MCP key lifetime after an expired (not ended) lease.
3. RL_API 600: confirm with Nitish.
4. The kill switch failing closed, and the alarm re-arm.
5. Node neutrality: G2 touches only `apps/cf`, `scripts/cf`, `packages/db/src/snapshot.ts` and contracts `ext/`; G5 touches e2e specs, the eval runner and docs.

## 5. Combined acceptance on the merged tree (not yet run)

On the Mac, on the branch, in this order:
1. `pnpm typecheck` (18/18 in the container), `pnpm lint:prose` (ok), `pnpm lint:brand` and `pnpm brand:overlap` (Mac only, section 2.6).
2. `pnpm test` and `WEFT_DB=durable-emu WEFT_MEMORY=sqlite WEFT_BLOBS=sqlite WEFT_EPHEMERAL_READ_IDS=1 pnpm test`.
3. `pnpm eval:ci`, `pnpm demo`, `pnpm e2e`, `pnpm e2e:tour` (through the e2e lock).
4. `pnpm cf:snapshot` **before** `pnpm cf:test` (engine-real reads the manifest; tracks.md cf7 step 2 omits this), then `pnpm cf:build`.
5. One capped live check of the Node live path, about $0.01: `openai.ts` changed (`.withResponse()`, the gateway transport, new error causes) and has not run against the real API since. For example one `WEFT_LIVE_OPENAI=1 WEFT_LLM=openai` scenario.

Known item to check after merging: `apps/cf/test/workerd/engine-real.test.ts` asserted the hosted delta reset against `Math.ceil(557 * 1.25)`; G2's whole `cf:test` passed on its own branch, but G1's SQL-memory baseline (717) came from a different branch, so rerun `cf:test` on the merged tree.

## 6. Still to do (from handoff-2026-10-20 section 6, updated)

**cf7 deliverables** (do not exist yet). A detailed plan is in the diagnosis (findings F17 to F20). Key points:
- `playwright.cf.config.ts`: projects `local` (cf:dev on `http://localhost:5800`, not 127.0.0.1, or Origin checks fail) and `deployed`; local webServers start a siteverify stub on 5809 and `cf:dev --port 5800 --dir .scratch/cf7/cf-dev-e2e --turnstile-verify-url ...` from fresh state, pool 2 or less.
- `e2e/cf/`: `auth.ts` (smoke and admin tokens read with awk, never logged), `fixtures.ts`, `siteverify-stub.ts`, `global-setup.ts`, `cf-tour.spec.ts`, `cf-visitor.spec.ts` (local only, at most 2 leases), `cf-shell.spec.ts`, `cf-scenarios.spec.ts`. Use the operator lease (`/api/_admin/lease`) instead of Turnstile wherever a leased slot is needed on the deployed URL.
- `scripts/cf/smoke.ts`: the design 11.6 list against `--url`. Smoke calls skip RL_API; the limiter check is an unsigned burst of `HOSTED_RATE_LIMITS.RL_API.limit + 100` GETs to a path like `/api/_no_such_route`, run last. The offer-letter check uses the offer's `documentId`. Help search is "skipped" until the AI Search `HELP` binding exists (it is not declared in `wrangler.core.jsonc` yet; add it in Deploy). Some items can only be "delegated" to `cf:budget` (invocation counts, the Workers Logs secret grep).
- `docs/cloudflare/resources.md`.

**Deploy budget warning (F5).** On a provisioning day the 90,000-row ceiling minus 4 full restores (about 21,106 rows each) leaves about 5,500 rows for visitors; the ladder triples polling at 70% and closes leases at 90%. Deployed day 1 is a provisioning day: run the deployed smoke and Playwright on UTC day 2, or measure that the whole run stays under about 3,500 rows.

**Deploy, Verify, Land:** as in handoff-2026-10-20 sections 6.1 to 6.4. `cf:deploy` now refuses a build with the test sitekey, so run `pnpm cf:resources` before `pnpm cf:build`.

**Docs to update in Land:** design 4.1 (keys), 4.4 (prebuilt hash lives in `kv_state` behind `WEFT_PREBUILT_HASH`), 4.6 and 8.2 (SQL-memory delta reset 717 rows), 9.2 (provisioning ceiling is 90,000 in code); the wrangler config comments naming `scripts/cf/config.ts`; README:192 eval figures (the tag gives 128 trials, 72 passes, not 119 and 79); record that production uses `apps/cf`'s own SpendDO ledger, run host and KV fold, and cf3's equivalents in `packages/agent` are test-only.

**Known minors not done (low value, recorded so nobody rediscovers them):** `DO_SQL_LIMITS.maxStatementBytes` is 102,400 in contracts against 100,000 measured (unused field); `HostedProviderId`/`asModelProvider` cleanup; the snapshot chunk file is named `.sql.gz` but holds gzip JSON; cf1 minors (emulator `replayFailures` never asserted, `SqlRepo.abbrev` uses substr, tokenize cache bounded by count); cf2 minors (hosted tests use cf2's own sqlite stand-in, `useNoticeFixtures` module global, the upload undo race, pre-existing); the D1 job ledger keyed by `job_id` alone (ids are random and globally unique); nothing produces `export.world` jobs; cf3 Node-path minors in `packages/agent` and `apps/mcp` (providerFor falls back silently, currentWorld falls back to NODE_WORLD, agent_ask takes its slot before the POST, a UTC-midnight test flake); `/api/_session` reports `openai` locally although cf:dev runs scripted (assert the provider through `/api/v1/health`).

## 7. Housekeeping notes

- **Commit identities.** The cloud container signs commits with Claude's key, and GitHub only verifies that signature when the committer is Claude. The repo config there set `author.name nitishsjsucs`, `author.email 227862909+nitishsjsucs@users.noreply.github.com`, `committer.name Claude`, `committer.email noreply@anthropic.com`. So every cloud commit is **authored by nitishsjsucs** (as AGENTS.md requires) and committed by Claude. No Co-Authored-By trailers were added. The Mac's plain `user.name`/`user.email` setup is unaffected.
- **Cloud environment.** Network access is now Full. The keys (`CF_SETUP_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `OPENAI_API_KEY`) were added to the environment settings after this session started, so this session never saw them; a new cloud session would. The setup script in handoff-2026-10-20 section 10.1 fails on Node 25 (no corepack). A working one installs the nodejs.org tarball to `~/.local/node-v25.9.0-linux-x64`, runs `npm install -g pnpm@12.3.4`, prepends that bin directory to PATH in `~/.bashrc` and `~/.profile`, and writes `~/.weft-secrets/{cf,weft}.env` from the env vars.
- **The contract request files** (`.scratch/contract-requests/*.md`) and cf2's patches never reached the cloud session; it worked from the summaries in `build-results-2026-10-20.json`. Worth a quick check against the originals on the Mac.
- **Diagnosis and fix records** (full agent outputs) stayed in the container's scratchpad and are not in the repo; this file is their summary.
- **Usage.** The cloud session stopped because the account hit its weekly usage limit (resets 2026-10-23 05:00 UTC), which also killed the G2 and G5 reviews.
