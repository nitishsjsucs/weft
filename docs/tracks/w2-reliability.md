# Track w2-reliability: gate report fixes

Branch `track/w2-reliability`, cut from main at 9b88e26 (the wave 2 scaffold). Owner: w2-reliability. Every item of
the wave 1 gate report is fixed with tests; nothing on the cut line is left.

## What exists

| # | Gate report item | Fix | Where | Test |
|---|---|---|---|---|
| 1 | `weft.close()` did not drain in-flight routine finalization; a background write rejection went unhandled (CLIENT_CLOSED) | The routines engine runs every finalization through `track()` (a pending set, errors caught) and exposes `drain(ms, closing)`; the agent runtime exposes `drain(ms)` over its queue. `close()` stops the scheduler, drains the agent, then the routines engine, each within `WEFT_CLOSE_DRAIN_MS` (default 5 s), then closes the executor and the database. The SSE route's background reads catch too | `apps/api/src/compose.ts`, `packages/routines/src/engine.ts`, `packages/agent/src/runtime.ts`, `apps/api/src/routes/agent.ts` | `apps/api/test/close.test.ts`: close during a routine run, close at the moment a finalization starts (status written before the database closes), a zero bound with late writes, idempotent close |
| 2 | A waiting routine run lost its trigger and handle across an API restart | The trigger goes into the run's context step (`RunSetup.trigger`) and is read back with the routine by id. Handles go to a `RunHandleStore`; compose.ts keeps one 0600 JSON file per open run under `<dataDir>/run/handles` (never in `run_steps`, which the trace and SSE read) and drops it when the run ends. `boot()` still fails `running` runs with PROCESS_RESTART and drops their handles; `waiting` and `held` runs are rehydrated. The routines engine watches a run again on its first decision after a restart | `packages/agent/src/runtime.ts`, `packages/agent/src/loop.ts` (RunSetup), `apps/api/src/compose.ts`, `packages/routines/src/engine.ts` | `close.test.ts` "restart survival" (two `createWeft` instances on one data dir: the run still waits after one approval, ends done after the second, the routine run ends done, the handle file is 0600, its token is not in `run_steps`, and it is removed at the end); `packages/agent/test/restart.test.ts` (two runtimes on one database; the trigger reaches the checklist; without a store the old PROCESS_RESTART path holds; the boot rule) |
| 3 | Live L3 flaky: a write on a read-only question, and step overruns | Chat runs are not offered `comms__post_update` (the one write in CHAT_TOOLS); the frozen allowlist is unchanged and a call to it is refused before the executor. Chat answers by `CHAT_ANSWER_BY = 4` model steps (`WEFT_CHAT_ANSWER_STEPS` overrides): an ANSWER_NOW budget notice the step before, calls at the cap are not run and the grounded template answers, and no repair round at the cap. The chat role asks for one batch of reads, concise results, null optional filters and a retry folded into the next batch. The eval logs every tool call and every new action row per case and accepts repeats such as `L3x6` | `packages/agent/src/loop.ts`, `packages/agent/src/prompts/index.ts`, `evals/live/run.ts` | `restart.test.ts` "chat answer-by cap and read-only tools"; live L3 6 of 6 twice (below) |
| 4 | Run Steps and paycheck tables clipped at 1440 px with the agent panel docked | Both cards are containers. The paycheck table hides Reimbursements and Company benefits below a 960 px card (the drawer shows both); Run Steps hides Cache hit and Model time below 900 px (both in the metrics above). Narrower still, each table scrolls inside its card | `apps/web/src/components/app/payroll/paycheck-table.tsx`, `apps/web/src/components/app/runs/run-view.tsx` | Measured with Playwright at 1440x900, panel docked: each table 789 px in a 789 px card (was 957 and 880, clipped); e2e GP2 and GP5 still pass |
| 5 | Headcount tile said 51 people on payroll including onboarding | Counts employees with status active and shows onboarding beside it; with offboarding they make `/v1/stats` employees (48 in the seed). Contractors are not headcount | `apps/web/src/components/app/home/home-view.tsx` | Checked against `/v1/stats` and `/v1/workers` on a seeded world (48 active, 0 onboarding) |
| 6 | The run view said (live) on scripted runs | The provider badge reads Scripted, no model or Template, no model for those runs and `<provider> <model> (live)` only for a real model; the feed mode reads streaming instead of live | `apps/web/src/components/app/runs/run-view.tsx` | Screenshot of a scripted chat run; `data-live` on the badge |
| 7 | Grounding treated short strings with spaces as identifiers | `isIdentifier()`: no whitespace and digits plus letters, or a spaced code of at most 3 capitals-and-digits tokens (DE 2088). Identifiers are cut only as whole tokens | `packages/grounding/src/check.ts`, `index.ts` | `packages/grounding/test/identifiers.test.ts` |
| 8 | research/product.md and research/agent.md quoted reference marketing lines | Every quoted reference line paraphrased with its source key kept; no brand denylist phrase left in either file | `research/product.md`, `research/agent.md` | `pnpm lint:brand`, `pnpm lint:prose`, a denylist scan of `research/` |
| extra | A reset world never finalized routine runs (found by e2e GP4 on this branch) | The routines engine's watch set is keyed by routine run and agent run, because agent run ids restart after `POST /v1/sim/reset` | `packages/routines/src/engine.ts` | `close.test.ts` "routine finalization after a world reset" |

## How to run it

```sh
pnpm test                                    # includes close.test.ts, restart.test.ts, identifiers.test.ts
pnpm --filter @weft/api exec vitest run test/close.test.ts
pnpm --filter @weft/agent exec vitest run test/restart.test.ts
WEFT_SECRETS_FILE=~/Developer/projects/.weft.secrets.env WEFT_LIVE_OPENAI=1 WEFT_LLM=openai WEFT_LIVE_USD_CAP=0.25 pnpm eval:live L3x6
```

Live L3 on gpt-5.6-luna, 2026-10-15 (results in `evals/results/`, gitignored):

| Run | Commit | Result | Spend |
|---|---|---|---|
| After the read-only and answer-by fixes | 52097a3 | 4 of 6; no writes, all within 4 steps; two runs read detailed results (offloaded to an artifact) and ran out of steps, one sent a review status as the state filter | $0.0059 |
| After the concise-read prompt (uncommitted, same tree as abdf29f) | 52097a3 plus prompt | 6 of 6, 2 to 3 steps, no action rows | $0.0054 |
| Record run | abdf29f | 6 of 6, 2 steps each, no action rows | $0.0047 |

Total live spend for this track: $0.016 of the $0.25 allowance.

## What is stubbed or left

Nothing from the brief is stubbed. Left for later rounds is in `.scratch/w2-reliability/left.md` (not tracked):
an e2e spec for the layout checks (e2e/ is not this track's), a detailed `payroll.get_run` offload that pages to an
empty artifact, and handle files left behind by a world reset. The home footer now reads Paid by simulated ACH
debit, in Weft's own words.

## Contract changes

None to frozen contracts. Additive, inside owned files:

- `RunSetup.trigger?` (optional) in `packages/agent/src/loop.ts`.
- `CreateAgentRuntimeOptions.handleStore?`, the `RunHandleStore` interface and `WeftAgentRuntime.drain()` in `packages/agent/src/runtime.ts`.
- `WeftRoutinesEngine.drain()` and `pendingFinalizations()` in `packages/routines/src/engine.ts`.
- `isIdentifier` exported from `@weft/grounding`.
- `CHAT_ANSWER_BY`, `CHAT_HIDDEN_TOOLS`, `chatAnswerBy()` exported from `packages/agent/src/loop.ts` (not re-exported from the package index, which this track does not own).
- New env knobs: `WEFT_CLOSE_DRAIN_MS` (default 5000), `WEFT_CHAT_ANSWER_STEPS` (default 4), `WEFT_EVAL_TAG` (eval results file suffix).

Note for other tracks: chat runs no longer see `comms__post_update`, and a chat answer is cut at its fourth model
step. A scripted chat script longer than 4 model steps would be cut; none exists today. The chat role prompt changed,
so the chat prefix hash changed.
