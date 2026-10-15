# t3-governance: the executor (hands)

Branch `track/t3-governance`. Status after rounds 1 and 2, plus the notes other tracks and the integrator need.

## How to run

- `pnpm install`, then `pnpm test`, `pnpm typecheck`, `pnpm lint:prose` and `pnpm lint:brand` from the worktree root.
- Executor only: `npx vitest run packages/executor`. Routes: `npx vitest run apps/api/test`. Scenarios: `npx vitest run tests/scenarios/s7-taint.test.ts tests/scenarios/s7b-taint-carry.test.ts tests/scenarios/s8-mcp-api.test.ts`.
- MCP over stdio, end to end: `npx tsx scripts/mcp-smoke.ts` (seeds a scratch data dir, starts the API on 127.0.0.1:4141 in its own process group, spawns `apps/mcp`, lists tools, calls `actions__list`, stops everything).
- The MCP server for a real client: `WEFT_API_URL=http://127.0.0.1:<api port> WEFT_API_KEY=$(cat .data/demo-mcp-key.txt) npx tsx apps/mcp/src/main.ts`.

## What is built

`packages/executor/src`:

| File | What it does |
|---|---|
| `strict-schema.ts` | `toStrictJsonSchema` (zod 4 `z.toJSONSchema`, then `additionalProperties: false`, all required, optional as `["T","null"]`, no bounds, no `format` or `pattern`, keys sorted), `nullToUndefined`, `sampleFromSchema` |
| `registry.ts` | one registry, wire names `namespace__action`, `toolSpecs` sorted, frozen, throws over 16 tools or on an unknown or unavailable name |
| `policy.ts` | the one `policy()`: R0 to R4, approval, autoAllow (R3, main agent, untainted, nothing pending in the batch), `TAINTED_WRITE`, ceilings per call and per day, batch rules, at most 3 open R4 per run, system and read-only bounds |
| `runs.ts`, `scope.ts` | `RunAuthority` mints `exec_runs` ids; the handle is `{ runId, token, nonce }`, only sha256(token) is stored; `ExecContext` is rebuilt from executor rows on every call, taint read fresh |
| `pipeline.ts` | per call, inside one transaction under `withWriteLock`: tier, null mapping and Zod (`INVALID_INPUT`, 5 issues), model args redacted, `UNKNOWN_REFERENCE` (3 closest ids, company and grant-visible domains only), grant intersection, `amountCents` and ceilings, preview, policy, lease, then a proposal or the run in a savepoint (action row, stamped events, notifier, lease), untrusted wrapping and taint, redaction, offload |
| `agent.ts` | `AgentExecutor.exec` deduped on `(run_id, call_id)` in `exec_calls`; batch state per run and batch key |
| `proposals.ts` | proposals with headline from structured fields, "Content to be sent", plain-text `agentNote` (from `agent_note`, `reason` or `note` args), `tainted_by`, supersede on `(command, subject_ref)`, 72 h expiry (payroll domain: 1 h before the run's approval deadline if sooner), `proposal.created` event, approval card through `sims.chat.post` (best-effort) |
| `human.ts` | `exec`, `decide` (CAS on `pending`, full pipeline re-run in the same transaction, unique `executed_action_seq`, money check, refusal codes, audit rows, `proposal.decided`, decision notes to `knowledge/decisions/DEC-*.md`), `rollback` |
| `chain.ts` | `appendAction` with the exact harness 6.5 preimage, `approval_audit` chain, `verifyActions` (gaps, bad seq, one action per executed proposal, gitLag) |
| `system.ts` | `SystemExecutor` with exact `svc_` allowlists, `ReadOnlyExecutor` (reads only, no lock, no transaction) |
| `builtins.ts` | `comms.post_update`, `actions.list`, `actions.get_run`, `agent.read_artifact` |
| `workspace.ts` | offload over 8,000 chars to `runs/<run>/artifacts/<step>-<wire>.json` with `run_artifacts`, `readArtifact` within the run family, `toCsv` with formula escaping |
| `vault/` | AES-256-GCM vault (`.data/run/vault.key`, mode 0600, or `WEFT_VAULT_KEY`), redactor (secrets in 5 encodings plus SSN, EIN, routing and account patterns) |
| `memory/` | hardened git store (execFile argv, hardening flags, minimal env, `GIT_LITERAL_PATHSPECS=1`), seed content in one commit, timeline bullets with `Weft-Chain-Head`, `memory.search` / `read` / `write_note`, `vault.list` / `request` |
| `admin.ts` | audited admin changes (agent grants, API keys) |

Untrusted paths are dotted; arrays are walked implicitly and a `*` segment matches every array element or object key (`notices.*.title`, `notice.body`). The taint source is the result's id, the id of a single wrapped record (`{ notice: { id } }`), or the first id-shaped arg, so T2's `notices.get` taints as `notice:ntc_...`. Event payloads are redacted before they are stored, and `/v1/events` plus every refusal body from `/v1/tools` and `/v1/proposals` pass through the redactor.

Routes: `/v1/proposals` (list, get, approve, deny, dismiss, start), `/v1/actions` (list, verify, get, rollback), `/v1/tools`, `/v1/memory/*`, `/v1/events`, `/v1/settings/*`, `/v1/api-keys`. `apps/mcp` is a stdio server over `/v1/tools?surface=mcp` plus `agent_ask`. `scripts/mcp-smoke.ts` runs it end to end against a scratch API (port 4141 by default, its own process group, stopped at exit).

Seed step `governance`: principals `usr_dana` (admin), `usr_theo` (payroll_admin), `usr_sam` (hr_manager), `agt_weft`, `svc_scheduler`, `svc_events`, `svc_sim`, `svc_digest`; agent grants; ceilings; settings; 9 vault secrets; the admin and mcp demo keys in `.data/demo-api-key.txt` and `.data/demo-mcp-key.txt` (0600); `executor.memory.init`.

## Rules for command authors (T1, T2, T4)

- Refuse from inside a command by throwing a `Refused` WeftError, or any error with a string `code` that is a `RefusalCode` or starts with `DOMAIN_`. Anything else becomes `INTERNAL` and the savepoint rolls back.
- `CommandOutput` may carry `taintedBy` (taint the run with that source) and `untrusted` (extra dotted paths to wrap for this result). Types in `packages/contracts/src/ext/t3-governance.ts`.
- Day ceilings: the executor reads `${ceilingKey}_day` and also `agent.device_day_cents` style keys (`_cents` replaced by `_day_cents`), so the seeded SPEC names work with `ceilingKey: "agent.device_cents"`.
- `access: "system_only"` commands are R1 by definition. System callers need the command on `SYSTEM_ALLOWLISTS` in `packages/executor/src/system.ts`: today `svc_events` has `tax.record_registration`, `payroll.mark_processed`, `payroll.mark_failed`, `onboarding.complete_task`, `comms.post_update`. Ask T3 for additions; nothing at R2 or above is ever allowed.
- The executor redacts model-originated args (agent and MCP) before hashing, storing or running them. A field that only validates unredacted gets `INVALID_INPUT`.
- `deps.sims` is built on first use, so read commands never need the simulators.
- Never call `withWriteLock` inside a command: the executor already holds it.
- Rollback runs `reversible.reverse` as the human with `output.reverseArgs`; mark reverse commands `access: "human_only"`.
- Proposal `agentNote` comes from an `agent_note`, `reason` or `note` string arg.
- A command with `amountCents` must report the same `moneyCents` from `run()`; on an approved proposal a mismatch rolls the transaction back with `INTERNAL` (harness 5.5 money check).
- Daily ceilings sum pending, approved and executed proposals created on the same sim-clock day (the demo clock is the only clock the app shows).
- T4 and T2 routes: `POST /v1/agent/runs` with an mcp-scope key should call `openChatRun(session, { surface: "mcp" })` (the run starts tainted); `GET /v1/sim/state` and SSE payloads should pass through `executor.redact`.

## For T4 (loop)

- Pass `batch` on each call (the model step n) or write the `run_steps` model_call row before dispatch; the executor falls back to the latest model_call n.
- The run nonce is `handle.nonce`; `nonceFromToken(token)` gives the same value.
- `routines.draft` emitting `routine.drafted` gets its `routine_enable` proposal from the notifier; approving it runs `routines.enable` as the approver.
- `POST /v1/proposals/:id/start` opens a chat run (tainted when the suggestion is) and calls `agent.startChat` best-effort.

## Integration hazard: every writer takes withWriteLock

Verified on this Mac with `@libsql/client` 0.18: while an executor transaction is open, a write through `weft.db` on
another pooled connection fails at once with `SQLITE_BUSY` (the open-time `busy_timeout` PRAGMA applies only to the
first connection). Passing `timeout` to `createClient` is worse: the local driver busy-waits synchronously, so the
event loop never lets the open transaction commit and the write fails after the timeout. So every write in the process
(the loop's run store, scheduler cursors, simulator ticks, route handlers) must go through `withWriteLock` from
`@weft/db`, and nothing may nest it. Reads are fine outside the lock (WAL).

## Contract notes

- `packages/contracts/src/ext/t3-governance.ts` (commit `contract: ...`): `BatchedAgentCall`, `RunHandleWithNonce`, `CommandOutputTaintHints`. Additive only.
- `seedGovernance` inserts the SPEC 5.1 company row with `onConflictDoNothing` when the company step has not run (track tests); the company step still owns it.
- `seedGovernance` skips vault and memory when the seed digest test passes no executor.
- `apps/api/test/health.test.ts` route-table check now accepts any JSON 2xx and tells a missing route (`No route for`) from a missing record (404 NotFound).
- Rollback of an irreversible action returns `DOMAIN_IRREVERSIBLE` with the reason.
- `POST /v1/proposals/:id/approve` takes an optional `value` (1 to 4,096 chars) only for a pending `secret_request`; `api.ts` still documents the body as `{ reasonCode, note }`, so the integrator may add `value` there. decide() runs first (roles, CAS, audit); the proposal stays `approved` (no action row, as before) and the value goes into the vault as the approver. A secret approve without a value, or a value on anything else, is a 400 `ValidationError`.
- Human decision notes pass through the redactor before they are stored, audited or written to memory.

## Tests

`packages/executor/test` (56), `apps/api/test` (route contracts and auth for every route file this track owns), `tests/scenarios/s7-taint`, `s7b-taint-carry`, `s8-mcp-api`. On this branch the gate is 123 passed, 2 skipped (the real-stack S7 and S8 below), 13 todo owned by other tracks; typecheck 15 of 15.

Until T1 and T2 land, most tests run on fixture commands shaped like theirs (`packages/executor/test/fixtures.ts`, `fixtureWeft()`). The fixture `notices.get` now returns T2's shape (`{ notice }`, title and body only with `response_format: "detailed"`), and the S7 script asks for detailed. Two more scenario tests run on the real commands and switch on by themselves when `@weft/core` carries `sim.deliver_notice`, `notices.get` and `tax.update_rate`:

- S7 real: deliver `ca_de2088_injection`, one batch `[notices__get, comms__send_message]` as Dana's chat run, then `memory__write_note`. The run taints with `notice:<id>`, the send is a pending tainted proposal, memory gets `TAINTED_WRITE`, no action row is appended, no plain chat message carries the text, the chain verifies.
- S8 real: deliver `ca_de2088_rate_change`, read it over MCP, `tax__update_rate` with the notice's extracted fields gives a tainted proposal, the mcp key gets 403 on approve and rollback, Theo approves (the live CA SUI rate becomes 1.5%), Theo rolls back (3.4% again, reversing row with `reverses_seq`), verify is ok.

Acceptance map: import scan (`tests/boundaries.test.ts`, scaffold) plus the forged handle and forged principal tests (`pipeline.test.ts`) and the forged proposal test (`decide.test.ts`); decide CAS, OVER_CEILING, STALE_SUBJECT, AGENT_PRINCIPAL, UI_SESSION_REQUIRED (`decide.test.ts`); policy snapshot (`registry.test.ts`); taint and S7 (`pipeline.test.ts`, `memory.test.ts`, S7, S7b); action log triggers, verify, tamper (`chain.test.ts`, `actions.test.ts`); rollback (`chain.test.ts`, `actions.test.ts`, S8 real); redaction over the DB file, WAL, artifacts, git objects, logs, event rows, MCP responses and `/v1/events` (`chain.test.ts`, `logs.test.ts`, `memory.test.ts`, `hardening.test.ts`, S8); memory paths, reproducible SHAs, non-hex `at` (`memory.test.ts`, `apps/api/test/memory.test.ts`); S8 scopes (S8, `auth.test.ts`); `svc_` principals (`pipeline.test.ts`).

## Trial merges (round 2, in a scratch clone, nothing pushed or merged here)

- `track/t2-world` into this branch: no conflicts; the whole suite passes (190 tests); the real-stack S7 and S8 pass. Probed by hand as well: taint, proposal, `TAINTED_WRITE`, MCP proposal, approve, rollback and verify all behave on T2's commands. Note that a Theo chat run gets `NOT_PERMITTED` on `comms.send_message` (Theo's comms grant is view), so S7 runs as Dana.
- Plus `track/t1-payroll`: two trivial conflicts (`packages/core/src/index.ts` keeps both export lines; `packages/core/test/shared.test.ts` takes T1's stricter test). `payroll.submit_run` through the agent gives an R4 proposal with the headline and money from T1's preview; Theo's approve executes it once with the money check passing, a second approve gives `NOT_PENDING`, verify is ok. One failure is T1 and scaffold business: the seed digest test (`packages/seed/test/seed.test.ts`) passes `sims: {}` and T1's `seedBank` reads `sims.bank.submitBatch` (TypeError). T1's payroll determinism test failed once under full-suite load and passes alone and on a rerun.
- Plus `track/t4-agent`: typecheck passes; 8 tests fail. The ones that matter for the integrator:
  - `POST /v1/sim/clock/advance {toNext}` gives Internal 500: `packages/core/src/shared/clock.ts` `write()` upserts `settings` (`clock.base_sim`) outside `withWriteLock` while a routine run kicked by the previous request holds an executor write transaction, and fails with SQLITE_BUSY. This is the hazard below. Fix: route clock writes through `withWriteLock` (careful: never from inside a locked section, the lock does not nest), or have the sim routes take the lock around `clock.advance`.
  - T2's `apps/api/test/sim.test.ts` calls `runDirect` with `directDeps(weft.db, ...)` outside the lock, so it races the same background work (SQLITE_BUSY_SNAPSHOT on `id_counters`).
  - `apps/api/src/compose.ts` passes no `events` source to `createRoutines`, so event-triggered routines never fire. With a minimal source wired in the scratch clone (unconsumed rows by `consumed_json`, consume under `withWriteLock`), the `rt_agency_notice` routine ran through this executor and produced exactly the two GP1 proposals (`tax.update_rate`, `notices.send_response`), untainted, with the routine run in `waiting_approval`. The GP1 test still failed on timing: it polls `scheduler.tick()` 20 times without waiting for the background agent run to settle.
  - GP5 fails on a T1 and T4 data mismatch, not the executor: the scripted chat expects `flags.0.evidence.result_id`, T1's `payroll.get_run` returns `evidence.action_result_id`. The tool call itself went through the executor fine. GP4 failed on an assertion not traced further.
  - The scaffold scheduler's `writeCursor` (`apps/api/src/scheduler.ts`) also writes `settings` outside `withWriteLock`, so it can hit the same SQLITE_BUSY while a background run holds an executor transaction.
- T4's SSE route (`GET /v1/agent/runs/:id/events`) sends `RunStepRow`s without `executor.redact`. Executor outcomes inside them are already redacted, but raw model call args stored by the loop are not. Pass each payload through `weft.executor.redact(JSON.stringify(...))` before `send`.

## Left after round 2

- Memory alias expansion in `memory.search` (cut first; plain `git grep --fixed-strings` today). Recall at run start is P1.
- T5: the secret-request card needs a password field that sends `value` on approve (below); today the card shows only the badge.
- Rate limits are the scaffold's fixed windows (60 per minute per key, 1,200 per minute per UI principal); the auth test covers the key limit.
- After merge 1: delete the fixture-only S7 and S8 bodies or keep them as executor unit tests; the real-stack variants already cover the merged world.
- The integrator items from the trial merges above (clock writes under the lock, T2's direct test writes, the events source for routines, SSE redaction).

## Sandbox and the Cloudflare free tier

Nitish asked for open-source sandboxes and a Cloudflare free-tier option. SPEC 9.9 and harness section 3 hold the decision: locally `code.run` on `quickjs-emscripten` (MIT) is P1, and hosting on Cloudflare Workers Free is a design only (one SQLite-backed Durable Object per company, `WEFT_SANDBOX=off`, Dynamic Workers as the paid upgrade path). This track ships only the `createSandbox()` stub that throws `NotImplemented` with `WEFT_SANDBOX=off`, and `code.run` is on no allowlist. Nothing in the executor blocks either option: the sandbox would call back through `weft.call(name, args)`, which maps to the same pipeline as a read-only agent call.
