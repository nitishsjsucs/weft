# Track t4-agent notes (Rounds 1 and 2, 2026-10-15)

Owner paths: `packages/agent`, `packages/routines`, `packages/grounding`, `packages/core/src/routines`,
`packages/core/src/commands/routines.ts`, `scenarios/*.json`, `evals/**`, the agent and routines routes and the S1, S4
and S5 scenarios.

## What exists

- `@weft/grounding`: `check(text, toolResults)` ported from StaySignal (MIT, same author) with the cents rule (only
  `*_cents` leaves divided by 100; `about`, `around`, `approximately` and `~` round to the stated precision, a bare
  amount must match exactly), percents (fraction times 100, decimal-string rates, `*_display` strings), ISO and US
  dates, bare years, the small-integer exemption (up to 10, not money or percents), array lengths and identifiers.
- `@weft/agent`:
  - `secrets.ts` (env, then `WEFT_SECRETS_FILE`; never logs, never writes `process.env`), `cost.ts` (the 3 Luna prices,
    `WEFT_PRICES_JSON` override), `spend.ts` (`.data/spend/<UTC wall date>.jsonl`, `mkdir` lock retried 2 s, stale
    lock over 10 s removed, reserve, settle, release, run, day and live caps).
  - Providers: `scripted` (stateless step index, `{{trigger.*}}`, `{{derived.*}}` with dotted keys, `{{last.<wire>.*}}`,
    chat `match`, readable `expect` diffs, synthetic usage), `openai` (harness 11.2 request builder and response
    handling; snapshot and recorded-fixture tests), `factory` (`WEFT_LLM` default scripted, `LIVE_PROVIDER_IN_TEST`,
    `PROVIDER_CONFIG` for claude, mlx, llama and a missing key).
  - `loop.ts` `runLoop`: timed stage rows (admission, assemble, model, dispatch, post, terminal), budgets (chat 12,
    routine 6, 8 calls per step), the harness 4.4 stopping rules in order, reserve before every attempt and settle
    after, the incomplete retry at 16,000 tokens, the recitation as `_weft_plan` inside the last
    `function_call_output`, chat grounding with one repair and then a grounded template, the routine checklist with
    one `NOT_DONE` notice.
  - `runtime.ts` `createAgentRuntime`: agent_runs rows reuse the executor's run id, the context pack is rendered once
    and stored, queue concurrency 1 for openai and 8 for scripted, `wake` (zero-token checklist wake), requeue cap 2,
    cancel, subscribe, trace, boot rule `PROCESS_RESTART`. Unattended routine runs under a live provider use the
    template provider (the default scripts, model `template`) unless `WEFT_BACKGROUND_LLM=1`.
  - `prompts/`: frozen developer prompts for chat, routine and routine_draft (about 1,750 tokens each, no dates,
    names, ids or nonces); `prefix_hash` on every model row.
  - `trace.ts`: stage rows with ms, labels from tool summaries, tokens, cache-hit ratio, USD, model time.
- `@weft/routines`: engine (croner slots since the cursor, judged at the slot time; run keys; code prechecks with
  derived args; checklists over the run's own tool outcomes plus seen decisions; manual triggers attended; decisions
  wake through `agent.wake`), the 4 prebuilt routines, `PRECHECKS`, `PREDICATES`.
- `@weft/core`: `routines/draft-parser.ts` ("Every Friday" gives `0 9 * * 5` America/Los_Angeles) and the
  `routines.*` commands (list, runs, draft with croner validation and the main-tier tool enum, human-only enable and
  disable).
- `scenarios/`: default scripts per prebuilt routine, `chat_ny_raise`, `chat_approve_all`. They double as the
  deterministic templates: unattended routine runs under a live provider, and routine runs whose live model failed
  (`PROVIDER_DOWN`, `MODEL_INCOMPLETE`), finish on them (model `template`, label "Template, no model").
- Routines engine extras: quiet hours (19:00 to 07:00 PT) defer digest-severity cron posts except the weekly digest;
  worth-surfacing skips a background run whose findings hash equals the last surfaced run (off for the digest).
- Routes: `/v1/agent` (POST runs answers 202 with the run id; list; get; trace with `summary` of stage rows, ms,
  tokens, cache-hit ratio, USD and `queuePosition`, plus proposals from the table; SSE `step` events then a `status`
  event; cancel; costs) and `/v1/routines` (list, get, runs, routine run, trigger answers 200, draft through the parser
  then `routines.draft` as the human, enable and disable through the HumanExecutor). Artifacts stay 501.
  `createChatContextSource(db)` in `routes/agent.ts` builds the chat pack's company summary and open loops.
- Scenarios S1, S4, S5 (`tests/scenarios/`) skip themselves in this branch until the merged world lands, naming the
  missing parts. On a trial merge they pass (see "Round 2: trial merge and live gate").
- `evals/live/run.ts`: L1 to L4 on a fresh seed per case in `.data/eval-live/` (ledger kept there, so the live cap is
  cumulative), results in `evals/results/` (gitignored). L1 to L3 pass on gpt-5.6-luna on a trial merge.
- `createRoutinesEventSource(db)` in `apps/api/src/routes/routines.ts`: the events source for `createRoutines`
  (unconsumed means `consumed_json` lacks `"routines"`, rowid order; `consume` appends the marker once). The brain
  cannot read the events table (boundary rule 1), so the composition root passes this one.
- Tool cap: `MAX_TOOLS = 16` and `assertToolCap` in `loop.ts`; the loop refuses an allowlist or tool spec list over 16.
- Run-store writes (`store.ts`, the routines engine) go through `lockedWrite`: the process write lock plus up to about
  5 s of `SQLITE_BUSY` retries (`busy.ts`; a copy lives in `packages/routines/src/busy.ts`).
- `evals/live/smoke.ts`: the 5 smoke calls (results in `.scratch/t4-agent/smoke.md`, $0.0015 total).

## Smoke results (gpt-5.6-luna, Responses API)

Strict tools work at effort low; replaying reasoning and function_call items with their ids under `store: false`
works (no id stripping); `_weft_plan` inside the last output beats a separate user item (0 vs 85 reasoning tokens,
and the user item started a new turn); Luna emits parallel calls; `cached_tokens` 1,780 of 1,783 on a repeat and
`cache_write_tokens` is present (priced 0, no price was given); a different `prompt_cache_key` does not share the
cache and does not disturb the first key.

## Round 2: trial merge and live gate (2026-10-15, 15:50 to 16:20 PDT)

I merged track/t2-world, track/t1-payroll and track/t3-governance into this branch in a scratch clone (outside every
worktree, never committed or pushed), applied the wiring below, and ran the suite there.

- Conflicts: `packages/core/test/shared.test.ts` (take t1's and mine, they are identical) and `packages/core/src/index.ts`
  (keep both `export * from "./demo/index"` and `export * as payroll from "./payroll/index"`). Typecheck passes.
- S1, S4 and S5 pass (8 tests, 3 runs in a row), and so do S3, the boundaries test and every agent and routines test.
  Bugs the merge found, fixed here: the NY raise evidence key is `action_result_id`, not `result_id`; the digest cited
  51 active workers, which `comms.send_message` refuses as UNGROUNDED (its company facts count employees, and
  contractors carry no work state), so it now cites the per-state counts and their sum ("48 employees by work state
  (CA 22, NY 14, TX 12)"); S1 waited on proposals instead of the routine's agent run; the forged-decide test skipped
  because the seed has no proposal, so it now makes its own through the agency notice routine.
- Live gate on gpt-5.6-luna (Responses API), all on the trial merge, fresh seed per case:

  | Case | Result | Model steps | Tool calls | USD | Cache hit |
  | --- | --- | --- | --- | --- | --- |
  | L1 agency notice to 2 proposals | pass | 2 | 3 | 0.0014 | 46% |
  | L2 pre-payroll, 4 model explanations, submit proposal | pass | 5 | 5 | 0.0023 | 70% |
  | L3 grounded NY raise answer citing the raise result id | pass | 3 | 3 | 0.0014 | 58% |

  Cumulative live spend for this track is $0.0067 (smoke $0.0015 plus the gate), well under the $0.50 cap. The ledger
  with every entry is `.data/eval-live/spend/2026-10-15.jsonl` (it also holds the smoke entries, so reruns stay
  cumulative); the combined results are `evals/results/2026-10-15-trial-merge-L1-L3.json`. L4 was not run.
- The first L1 attempt picked the digest's agent run (a fresh world fires the digest on its first tick); the runner now
  finds the agency notice run by routine id.
- **S2 (t1's GP2) fails on the trial merge, and the cause is in the DB layer.** The libsql 0.18 client pools
  connections, and the open-time PRAGMAs in `openDb` (busy_timeout among them) reach only the first one. While a
  woken routine run writes in the background, the test's own direct `bank_accounts` updates get `SQLITE_BUSY`, then
  `SQLITE_BUSY_SNAPSHOT` (517) even under `withWriteLock`. Before `lockedWrite`, my run-store append failed instead
  and the run ended `REPEATED_ERRORS`. Setting `createClient({ url, timeout: 5000 })` made it worse: the timeout blocks
  the one JS thread while the lock holder sits on another connection in the same process, so S4 stalled 5 s. This needs
  an owner in `packages/db` (one connection for writes, or PRAGMAs on every pooled connection, plus finding the
  connection that goes back to the pool with a read snapshot). S3 passes.

## For the integrator

0. **Wiring for compose.ts** (exactly what the trial merge used):

   ```ts
   import { createRoutines, type WeftRoutinesEngine } from "@weft/routines";
   import { createChatContextSource } from "./routes/agent";
   import { createRoutinesEventSource } from "./routes/routines";
   // createAgentRuntime({ ...,
   routinesView: {
     get: (id: string) => (routinesRef.current as WeftRoutinesEngine).view.get(id),
     checklist: (x) => (routinesRef.current as WeftRoutinesEngine).view.checklist(x),
   },
   contextSource: createChatContextSource(db),
   // createRoutines({ db, clock, agent, runs: executor.runs, readOnly: executor.readOnly, events: createRoutinesEventSource(db) })
   ```

1. **routinesView.** The agent's `RoutinesView` gained an optional `checklist(...)`. Routines are created after the
   agent, so wire it lazily: `routinesView: { get: (id) => routinesRef.current!.view.get(id), checklist: (x) => routinesRef.current!.view.checklist(x) }`.
2. **Optional runtime options** (additive, my package): `companyId` (default `cmp_larkspur`), `contextSource` (pass
   `createChatContextSource(db)` from `apps/api/src/routes/agent.ts`; the brain never reads domain tables), `env`,
   `modelTimeoutMs`. Without `contextSource` the chat pack says no company summary is available.
3. **Events for the routines engine.** Boundary rule 1 lets the brain import only `agentRuns`, `runSteps`,
   `routineRuns` and `routines`, so the engine cannot read the `events` table. Pass
   `events: createRoutinesEventSource(db)` (item 0); without it event routines (`rt_agency_notice`, `rt_new_hire`)
   never fire from `tick`. No boundary change is needed.
4. **Batch identity for the executor.** `AgentCall` carries no batch id. track/t3-governance keys a batch by the
   run's latest `model_call` row in `run_steps`; the loop writes that row (kind `model_call`, outcome `ok`) right
   before it dispatches the turn's calls in emitted order, so the two agree without a contract change.
5. **Read shapes the prechecks use**, checked against track/t1-payroll and track/t2-world on 2026-10-15:
   `notices.get` `data.notice.{kind, tax_account_id, extracted.{agency, effectiveFrom, respondBy, rates[].{code,
   oldRate, newRate}}}`; `payroll.list_runs` `data.runs[].{run_id, status, approval_deadline}`; `payroll.get_run`
   `data.flagged[].{paycheck_id, worker, flags[].{rule, evidence}}`; `payroll.explain_flags` `data.{refused,
   unexplained_flagged}`; `people.get` `data.worker.{name, work_state}`; `tax.list_registrations`
   `data.accounts[].{id, jurisdiction, status}`; `people.search` `data.total`. Derived args match their inputs:
   `tax.update_rate {tax_account_id, code, rate, effective_from, source_notice_id}`, `tax.rate_change_impact
   {jurisdiction, code, new_rate, effective_from}`, `tax.register_state_account {tax_account_id}`, `it.create_account
   {worker_id, system}`, `it.order_device {worker_id}`, `payroll.explain_flags {run_id, items[].{paycheck_id}}` (no
   explanation, so T1 saves its template), `payroll.submit_run {run_id, exclude_blocked: true}`.
   `chat_ny_raise.json` cites `data.flagged.0.flags.0.evidence.action_result_id` with `state: "NY"`; confirmed on the
   trial merge: the NY raise (Lena Brooks, wrk_0026) is the first NY flagged row.
6. **Prebuilt owner.** `packages/routines/src/prebuilt.ts` uses `OWNER = "usr_dana"` (the principal the scaffold tests use).
7. **Scaffold core test.** Commit `5f2bd05` applies the same change to `packages/core/test/shared.test.ts` as
   track/t1-payroll `3129725` (commands and handlers are appended), so the merge is identical on both sides.
8. **Boot rule suggestion.** The brain fails the agent run and its routine run with `PROCESS_RESTART`; the "Run again"
   inbox suggestion needs the proposal notifier (T3), since the brain cannot write proposals.
9. **Trace proposals.** `RunTrace.proposals` is empty from the brain; the agent route fills it from the proposals table.
10. **Spend ledger dir.** compose.ts passes `join(dataDir, "spend")`; harness 4.5 wants it outside every company
   directory and untouched by `POST /v1/sim/reset`. If reset rebuilds `dataDir`, point the ledger at the repo's
   `.data/spend` instead.
11. **What is stubbed or left.** `GET /v1/agent/runs/:id/artifacts/:ref` answers 501; overdue detection, the
   `WEFT_PIN_PREFIX=1` pin test and L4 are not built or not run (cut line); the boot rule's "Run again" inbox suggestion
   needs T3's proposal notifier; the model-backed routine_draft recipe runs only under a live provider (the parser is the
   default path).

## How to run

- Tests: `pnpm vitest run packages/agent packages/routines packages/grounding apps/api/test/agent.test.ts
  apps/api/test/routines.test.ts packages/core/src/routines tests/scenarios/s1-agency-notice.test.ts
  tests/scenarios/s4-digest.test.ts tests/scenarios/s5-chat-guardrails.test.ts` (the scenarios skip until merge).
- Live gate (costs money, opt-in): see `evals/live/README.md`; `pnpm eval:live` runs L1 to L3 with the cumulative cap.
