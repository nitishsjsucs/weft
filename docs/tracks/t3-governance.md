# t3-governance: the executor (hands)

Branch `track/t3-governance`. Round 1 status and the notes other tracks and the integrator need.

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

## For T4 (loop)

- Pass `batch` on each call (the model step n) or write the `run_steps` model_call row before dispatch; the executor falls back to the latest model_call n.
- The run nonce is `handle.nonce`; `nonceFromToken(token)` gives the same value.
- `routines.draft` emitting `routine.drafted` gets its `routine_enable` proposal from the notifier; approving it runs `routines.enable` as the approver.
- `POST /v1/proposals/:id/start` opens a chat run (tainted when the suggestion is) and calls `agent.startChat` best-effort.

## Contract notes

- `packages/contracts/src/ext/t3-governance.ts` (commit `contract: ...`): `BatchedAgentCall`, `RunHandleWithNonce`, `CommandOutputTaintHints`. Additive only.
- `seedGovernance` inserts the SPEC 5.1 company row with `onConflictDoNothing` when the company step has not run (track tests); the company step still owns it.
- `seedGovernance` skips vault and memory when the seed digest test passes no executor.
- `apps/api/test/health.test.ts` route-table check now accepts any JSON 2xx and tells a missing route (`No route for`) from a missing record (404 NotFound).
- Rollback of an irreversible action returns `DOMAIN_IRREVERSIBLE` with the reason.

## Tests

`packages/executor/test` (51), `apps/api/test` (route contracts, auth), `tests/scenarios/s7-taint`, `s7b-taint-carry`, `s8-mcp-api`. Until T1 and T2 land, tests run on fixture commands shaped like theirs (`packages/executor/test/fixtures.ts`, `fixtureWeft()`); the integrator can switch S7 and S8 to the real `notices.get`, `comms.send_message` and `tax.update_rate`.

## Left for round 2 or later

- Memory alias expansion in `memory.search` (cut first; plain `git grep` today).
- Artifact paging beyond 50 rows per page is in place; recall at run start is P1.
- Rate limits are the scaffold's fixed windows (60 per minute per key, 1,200 per minute per UI principal); the auth test covers the key limit.
- The secret-request card has no route to enter the value yet (vault put is human-only and has no route in the table).
- S7 and S8 against the real T2 commands after merge 1.
