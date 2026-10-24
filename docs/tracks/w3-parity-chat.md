# Track w3-parity-chat: chart answers, chat that can propose, interactive approval cards

Wave 3 gaps 3, 4 and 5 of `docs/wave3.md` (research/wave3/agent-parity.md 5.3 to 5.5). Branch `track/w3-parity-chat`.
The cut line (reports.query, the chart in the agent panel, the interactive card) landed, and so did chat proposals
behind `agent.chat_can_propose` (off by default). Round 2 hardened them: act-mode writes must be proposal-only, a
tainted proposal is not approvable from a card, and GP15 covers Deny and the simulator card. Task agents and learning
from overrides (stretch) did not start.

## What exists

| Item | Where | What it does |
|---|---|---|
| `reports.query` (R0) | `packages/core/src/reports/query.ts`, `packages/core/src/commands/reports.ts` | Seven metrics, one deterministic SQL family each: `payroll_cost_by_month` (paid runs by payday month from each run's stored totals, plus paid contractor payouts; gross, employer taxes, employer benefits, reimbursements and contractor payouts as five stacked series; months with no paid run are left out so a zero never reads as "payroll cost nothing"), `headcount_by_state` and `headcount_by_department` (employees on the roll on `to`: started, not past their last day, not a draft), `hires_and_departures_by_month` (every month in range, zeros included, with headcount at month end), `turnover_rate` (departures over the average of start and end headcount, two decimals), `time_off_minutes_by_month` (absolute sum of `use` ledger rows), `expenses_by_category` (approved, scheduled and paid against awaiting review; declined and returned left out). `group_by: "quarter"` folds months. Rows carry cents beside display strings and `period_start`/`period_end` dates (the grounding check reads dates in full form). Default range: the last twelve calendar months ending today; at most 120 months. The command's domain is `company`; each metric also needs view on its data domain (payroll or people) for the person the call acts for, else `NOT_PERMITTED`. |
| `GET /v1/reports/:metric` | `apps/api/src/routes/reports.ts` | Runs `reports.query` through `executor.human.exec`, so grants and the redactor apply; `from`, `to`, `groupBy`. 403 for a missing metric grant, 422 for a bad range. |
| Artifacts route | `apps/api/src/routes/agent.ts` | `GET /v1/agent/runs/:id/artifacts/:ref` (was 501). Reads the `run_artifacts` row and its file (path from the row, kept inside the data dir). A chat run's artifacts are readable only by the person the run acted for; a routine run's by anyone in the company with view on the artifact's domain. Returns `{ ref, runId, stepN, kind: "chart" | "rows", summary, domain, bytes, sha256, taintedBy, data }`, redacted. A report over 8,000 characters (for example ten years of hires by month) is offloaded by the executor as before. |
| Chat allowlist choice | `apps/api/src/agent/chat-allowlist.ts`, `apps/api/src/routes/agent.ts` | Chat reads are `CHAT_TOOLS_W3`. A deterministic intent check (action verbs, not a question unless it is a polite imperative; bulk decisions never count) plus `agent.chat_can_propose` (settings row, JSON `true`) picks `CHAT_ACT_TOOLS`; MCP sessions never act. Names not in the registry are dropped, so neither list passes 16. An act-mode write is offered only when its definition is `approval: "always"` with `autoAllow: "never"` (`notProposalOnly`), so a decide command a later track registers with an amount threshold or auto-allow is dropped instead of executing from chat; when the definition cannot be read the write is dropped (fail closed). With a live provider, a tool whose strict schema carries `propertyNames` or `patternProperties` is dropped (see contract request 3). `POST /v1/agent/runs` answers `{ runId, chatMode }`. |
| Approval card | `packages/executor/src/proposals.ts` (`approvalCardOf`) | `ApprovalCardW3` from the stored proposal row: headline, risk, money, fields from the preview diff (`before to after`, or `after` for a new line; at most 12), the subject's name for one worker, the routine's name, the approver (decider, else the person asked for), status. The agent's note and free-text content stay on the proposal page. The notifier posts this card to the chat simulator, and the run trace carries `cards`. |
| Agent panel | `apps/web/src/components/app/agent/chart.tsx`, `approval-card.tsx`, `run-feed.tsx`, `run-steps.ts` | A `reports.query` step renders a recharts chart (inline data, or the artifact through the route) in a fixed token order (blue-11, accent-9, violet-9, green-9, amber-11), validated with the dataviz palette script on the light surface (all checks pass); legend for two or more drawn series; a series that is all zero is not drawn but stays in the table; the data table is always in the page (screen readers) and one toggle away. "Ran N tools" after the run. Cards show Approve, Deny and Open; decisions go through `components/app/inbox/decide.ts`, which the Inbox card now shares. A proposal whose run read untrusted content (`taintedBy` on the proposal) shows the Inbox's warning on the card and offers Deny and Open but no Approve: it is approved in the Inbox, where the full content is on screen. |
| Chat simulator | `apps/web/src/components/app/simulators/simulators-view.tsx` | A posted `ApprovalCardW3` renders as the same card with its live status and taint warning (polls the proposal every 3 s). |
| Scenarios | `scenarios/chat_payroll_cost.json`, `chat_off_cycle_bonus.json`, `chat_off_cycle_missed.json` | Scripted chart answer (grounded on the first try) and the GP10 off-cycle request in two forms (bonus only for e2e on a fresh seed; missed period for the scenario test). |
| Live eval L5 | `evals/live/l5-chat-propose.ts` | Opt-in GP10 in chat on a live model, cap $0.02, data in `.data/eval-l5/`. |

## How to run it

- Tests: `apps/api/test/reports.test.ts` (SQL per metric against the seed, golden chart spec, grants, ranges),
  `apps/api/test/agent-artifacts.test.ts` (artifacts route for a chat run and a routine run, a stored path outside the
  data dir, intent check, both lists within 16, the setting gate, the proposal-only guard, a tainted act-mode run, card
  from the preview), `tests/scenarios/gp15-chat-chart.test.ts` (GP15: chart, read-only with the setting off, proposal
  and approve once with it on, Deny executes nothing, approve-all refused), and the e2e
  `WEFT_E2E_WEB_PORT=4620 WEFT_E2E_API_PORT=4621 pnpm e2e e2e/gp15-chat-chart.spec.ts` (two tests: the panel's chart,
  table and card; the simulator's card, the tainted card and Deny).
- Verified on this branch (2026-10-16, round 2): see "Verification" below. Run `site-dev-runner.spec.ts` with
  `WEFT_E2E_RUNNER_PORT=4624` while other tracks run e2e: its default port 4216 and its
  `pgrep -f "api-port 4216"` leftovers check see another worktree's runner and fail.
- Turn chat proposals on for a world: insert `settings (key 'agent.chat_can_propose', value_json 'true')`. The
  settings screen and `PUT /v1/settings/agent` belong to w3-parity-routines; the GP15 e2e uses that route when it
  answers and otherwise writes the row in the e2e world's own database.
- Live: `WEFT_SECRETS_FILE=~/Developer/projects/.weft.secrets.env WEFT_LIVE_OPENAI=1 WEFT_LLM=openai node_modules/.bin/tsx evals/live/l5-chat-propose.ts`.

## Real versus simulated

- Real: `reports.query` is plain SQL over the world's own tables (the seeded Larkspur Robotics data, all fictional), and
  the chart draws exactly those rows. The intent check, the allowlist choice, the proposal-only guard, the policy, the
  decide routes and the approval card are the production code paths; nothing is mocked in the scenario or e2e tests.
- Simulated: the chat channel the notifier posts cards to is the in-repo chat simulator (`/app/simulators`, labeled
  "Chat (simulated)"); no real chat workspace is involved. Off-cycle pay approved from a card follows the same path as
  one approved in the Inbox, and its bank batch goes to the in-repo bank simulator.
- Scripted: the GP15 scenario and e2e use the scripted provider (`scenarios/chat_*.json`). Only `evals/live/l5-*` calls
  a live model, opt-in, with a $0.02 cap.

## Live check

Two L5 runs on gpt-5.6-luna, 2026-10-16, $0.0018 in total. The first failed every model step with a 400: the
provider refused `payroll__propose_off_cycle` because `bonus_cents` is a `z.record`, whose strict schema has
`propertyNames` (and, with `additionalProperties: false`, could not carry any worker key anyway). After the live
filter, the second run answered read-only in 4 steps (people.search, payroll.list_runs, payroll.get_run), done, no
proposal and no action. L5 stays failing until contract request 3 lands; scripted GP15 covers the proposal path.

## What is left

- Live L5 passes only after contract request 3 (`payroll.propose_off_cycle` bonuses as an array); until then a live act
  run drops that tool and answers read-only.
- Expense and time-off proposals from chat: `CHAT_ACT_TOOLS` names `expenses.decide`, `expenses.get`, `time_off.decide`
  and `time_off.get_balance`; they join once w3-expenses and w3-timeoff register them, if their definitions are
  `approval: "always"` with no auto-allow (otherwise the guard drops them; the test shows how). Their chat scripts
  belong to those tracks.
- The settings toggle and `PUT /v1/settings/agent` (w3-parity-routines); requests 4 to 6 below.
- No standalone Reports screen (the route is ready for one). The panel does not scroll to a new card or chart by itself.
- Stretch not started: task agents (`openChildRun`) and learning from overrides.

## Contract changes (separate `contract:` commits)

1. `AgentRuntime.startChat` input gains optional `allowlist` (`packages/contracts/src/runtime.ts`), used by
   `packages/agent/src/runtime.ts` for the chat context step; omitted keeps `CHAT_TOOLS`. Without it the allowlist the
   API passed to `openChatRun` never reached the loop.
2. Chat cards carry the `ApprovalCardW3` fields; `@weft/executor` re-exports `approvalCardOf`; the workspace test that
   pins the posted card JSON gains the new fields.

Additive, in the track's own `W3_CHAT_TID` block (`packages/contracts/src/w3/testids-parity.ts`): `ranTools` (round 1)
and `cardTainted` (round 2).

## Contract requests (not done here)

3. `payroll.propose_off_cycle` (w2-offboarding, `packages/core/src/commands/payroll.ts`): replace `bonus_cents`
   (record keyed by worker id) with `bonuses: [{ worker_id, cents }]`, or accept both and map. Today no strict-schema
   model can pass a bonus, and a live run that offers the tool fails outright (hence the filter above).
4. `apps/api/src/routes/proposals.ts` (start a suggestion) still opens its chat run with `CHAT_TOOLS`; switch it to
   `chooseChatTools` or `CHAT_TOOLS_W3` and pass the list to `startChat`.
5. `apps/web/src/lib/api/client.ts` `Responses`: add `"GET /v1/reports/:metric": ReportResult` and the artifact shape
   (the panel casts today).
6. w3-parity-routines: `PUT /v1/settings/agent` should store `agent.chat_can_propose` as JSON `true` or `false`
   (this track also accepts `"on"`).

## Verification

Round 2, 2026-10-16: `pnpm test` 660 passed (624 before the wave, 656 after round 1), `pnpm typecheck`,
`pnpm lint:prose`, `pnpm lint:brand`, `pnpm brand:overlap`, and the full e2e suite on 4620 and 4621 (33 passed, with
`WEFT_E2E_RUNNER_PORT=4624`). The last commit (the simulator card waits for the proposal read before it offers
Approve) is web only; typecheck and the GP15 and GP10 e2e specs were rerun on it and pass. No live calls this round;
the track's wave live spend stays $0.0018.

## Design notes

- Nothing executes from chat: every write on `CHAT_ACT_TOOLS` is R2 or R4 with approval always, the executor's policy
  is unchanged, and GP15 counts actions before and after. Bulk approval stays the scripted refusal (S5) because a bulk
  request never selects the act list. A tainted run keeps the executor's refusals.
- Chat runs still end `done` after filing a proposal (the loop's chat branch), so the panel shows the card under the
  answer; the decided callback ignores a finished chat run.
- The card's coarse status maps executed and failed to `approved` (the contract enum); the panel and the simulator
  show the proposal's real status beside it.
- A tainted proposal is still a proposal (the policy proposes R2 and R4 with the taint note; the laundering writes of
  harness 6.2 are on neither chat list, which a test pins). The card does not offer one-click approval for it, because
  the card shows only the preview fields and the Inbox shows the full content beside the same warning.
  `ApprovalCardW3` has no taint field, so the surfaces read `taintedBy` from the proposal (trace or proposal read).
- Only `#payroll`, `#people-ops` channels receive cards (unchanged notifier routing).
