# Track t4-agent notes (Round 1, 2026-10-15)

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
- `scenarios/`: default scripts per prebuilt routine, `chat_ny_raise`, `chat_approve_all`.
- `evals/live/smoke.ts`: the 5 smoke calls (results in `.scratch/t4-agent/smoke.md`, $0.0015 total).

## Smoke results (gpt-5.6-luna, Responses API)

Strict tools work at effort low; replaying reasoning and function_call items with their ids under `store: false`
works (no id stripping); `_weft_plan` inside the last output beats a separate user item (0 vs 85 reasoning tokens,
and the user item started a new turn); Luna emits parallel calls; `cached_tokens` 1,780 of 1,783 on a repeat and
`cache_write_tokens` is present (priced 0, no price was given); a different `prompt_cache_key` does not share the
cache and does not disturb the first key.

## For the integrator

1. **routinesView.** The agent's `RoutinesView` gained an optional `checklist(...)`. Routines are created after the
   agent, so wire it lazily: `routinesView: { get: (id) => routinesRef.current!.view.get(id), checklist: (x) => routinesRef.current!.view.checklist(x) }`.
2. **Optional runtime options** (additive, my package): `companyId` (default `cmp_larkspur`), `contextSource` (the
   chat pack's deterministic company summary and open-loops rows, built in apps/api from DB rows; the brain never
   reads domain tables), `env`, `modelTimeoutMs`.
3. **Events for the routines engine.** Boundary rule 1 lets the brain import only `agentRuns`, `runSteps`,
   `routineRuns` and `routines`, so the engine cannot read the `events` table. `createRoutines` takes an optional
   `events: { unconsumed(), consume(id) }`; without it event routines (`rt_agency_notice`, `rt_new_hire`) never fire
   from `tick`. Either pass one from apps/api or add `events` to `RUN_STORE` in `tests/boundaries.test.ts`
   (request in `.scratch/contract-requests/t4-agent.md`).
4. **Batch identity for the executor.** `AgentCall` carries no batch id. track/t3-governance keys a batch by the
   run's latest `model_call` row in `run_steps`; the loop writes that row (kind `model_call`, outcome `ok`) right
   before it dispatches the turn's calls in emitted order, so the two agree without a contract change.
5. **Read shapes the prechecks assume** (read tolerantly, several spellings): `notices.get` `data.extracted.{new_rate,
   effective_date, tax_account_id, tax_code, kind}`; `payroll.list_runs` `data.runs[].{id, status, approval_deadline}`;
   `payroll.get_run` `data.flagged[].{paycheck_id, worker, rule, before_display, after_display}`; `people.get`
   `data.{display, work_state}`; `tax.list_registrations` `data.registrations[].{agency, status}`; `people.search`
   `data.total`. Derived argument names to reconcile with T2 inputs: `tax.update_rate {tax_account_id, rate,
   effective_date, source_notice_id, tax_code}`, `tax.register_state_account {state, agency}`, `it.create_account
   {worker_id, system}`, `it.order_device {worker_id, sku}`. `chat_ny_raise.json` cites
   `data.flagged.0.evidence.result_id` from `payroll.get_run`.
6. **Prebuilt owner.** `packages/routines/src/prebuilt.ts` uses `OWNER = "usr_dana"` (the principal the scaffold tests use).
7. **Scaffold core test.** Commit `5f2bd05` applies the same change to `packages/core/test/shared.test.ts` as
   track/t1-payroll `3129725` (commands and handlers are appended), so the merge is identical on both sides.
8. **Boot rule suggestion.** The brain fails the agent run and its routine run with `PROCESS_RESTART`; the "Run again"
   inbox suggestion needs the proposal notifier (T3), since the brain cannot write proposals.
9. **Trace proposals.** `RunTrace.proposals` is empty from the brain; the agent route fills it from the proposals table.
10. **Spend ledger dir.** compose.ts passes `join(dataDir, "spend")`; harness 4.5 wants it outside every company
   directory and untouched by `POST /v1/sim/reset`. If reset rebuilds `dataDir`, point the ledger at the repo's
   `.data/spend` instead.
