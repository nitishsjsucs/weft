# Track t5-app notes (round 2, 2026-10-15)

Owner paths: `apps/web/src/app/(app)/**`, `apps/web/src/components/app/**`, `apps/web/src/lib/api/{hooks,sse}.ts`, `apps/web/src/lib/api/mocks/**`, `packages/ui/src/components/**`. Tests live in `apps/web/test/`.

## What exists

- **Shell** (`components/app/shell/`): grid `244px 1fr 340px` (the sidebar becomes an overlay below 1024 px; the agent panel docks at 1280 px and overlays below), 48 px header with breadcrumb, Cmd+K (navigation plus record search over people and payroll runs), provider badge, sim clock chip, the "Viewing as" demo control, and the agent panel toggle. Container queries keep the header usable beside the docked panel and at 390 px.
- **Primitives** (`packages/ui/src/components/`, imported from `@weft/ui/components`): button, card, badge, table parts, drawer (radix Dialog), tabs, shimmer text, diff table, popover, kbd. TanStack Table v9 `useTable` drives the payroll and people tables.
- **Screens**:
  - Home: exactly 4 widgets (Upcoming payrolls, Approvals waiting, State tax registrations, Headcount).
  - Inbox: Approvals, Suggestions and Decided tabs. Each card has the risk chip, the diff, "Content to be sent" (escaped, in full), "Agent's note" as plain text, the tainted banner, money, reversibility, evidence, the expiry and Approve or Deny with a reason code and note.
  - Payroll list and review: the totals strip and a 12-field drawer, Needs Review and Ready groups, flag chips with an explanation popover that names the source (agent or template), the paycheck drawer with the tax trace, Preview again, Run review now, Submit, status and New draft.
  - People: the table and an Offers tab with Mark accepted. Person detail has Profile, Pay and tax (pay rate history with the action that set each rate, direct deposit, tax setup), Benefits, IT accounts and Onboarding tabs.
  - Compliance: Registrations, Rates with their source, and Notices with a plain-text body and extracted fields. Filings shows Coming soon.
  - Routines: the gallery and the create-your-own box. Routine detail shows instructions, tools, the checklist, the run log with cost, and Run now.
  - Run view: stage rows with tokens, cache-hit ratio, USD, model time, the checklist, proposals and the tainted banner.
  - Audit: chain status, Undo and reversed links.
  - Simulators: +30 min, +1 day and Next, the next weekday 9:00 PT slot, notice delivery, fault toggles, registrations, agency mail, bank batches, the IdP account count, device orders and chat feeds.
  - Benefits (plans, prices, enrollment counts), IT (accounts by system, devices) and Contractors (the global contractors) are read-only bodies over the simulators. Expenses, Time Off and Settings are labeled stubs.
- **Data layer** (`lib/api/hooks.ts`): one typed client with the "Viewing as" principal (`x-weft-principal`, saved in localStorage), `useGet` with a small cache and polling, `useMutation` that invalidates every query on success, and an exported `useVersion` for views that page through lists.
- **Live runs** (`lib/api/sse.ts`): SSE is read over `fetch` streaming so the principal header is sent. `classifyFrame` reads the API's frames (`event: step` with a `RunStepRow`, then `event: status` with `{ status }`) and also accepts run rows and traces. A status frame or an end marker triggers one trace read. If the stream fails or ends early, the UI polls the trace every 1 s. A paused run (`waiting`, `held`) is re-polled every 3 s and keeps its `sse` label. `?sse=off` forces polling.
- **Step chips** (`components/app/agent/run-steps.ts`): text comes from the tool result's `outcome.summary`, a proposal's `outcome.title` or a refusal message. Wire tool names (`payroll__explain_flags`) show as dotted names.
- **Mocks** (`lib/api/mocks/`): a fetch-compatible router over a contract-typed fixture world, behind `NEXT_PUBLIC_WEFT_MOCKS=1`. In round 2 they now return the API's shapes: WorkerDetail, `{ output, outcome }` step results, wire tool names and the real `GET /v1/sim/state` keys. They also serve plans, enrollments, IT accounts and devices. Mock state lives in the browser tab and resets on reload.

## How to run

- Against the API (two terminals; check the ports first with `lsof -nP -iTCP:<port> -sTCP:LISTEN`):
  1. `pnpm db:reset && pnpm db:seed`
  2. `WEFT_DEV_AUTH=1 WEFT_API_PORT=4070 pnpm --filter @weft/api start`. The UI proxy only works with `WEFT_DEV_AUTH=1`, because the auth middleware ignores `x-weft-principal` without it.
  3. `WEFT_API_PORT=4070 pnpm --filter @weft/web dev -p 3070`, then open `/app`.
- With mocks: `NEXT_PUBLIC_WEFT_MOCKS=1 pnpm --filter @weft/web dev -p <port>`.
- Tests: `pnpm --filter @weft/web test` (17 tests: mocks, the SSE parser and frame classifier, step chips, the clock helper, audit reasons, mock shapes).

## Verified against the merged API (round 2)

There was no merge on `main` yet. I built a scratch integration in my own scratchpad folder: main plus t1, t2, t3 and t4, with t4's uncommitted agent and routines routes copied in and one scratch-only seed fix (see finding 1 below). I seeded it, ran the API on 4181 (`WEFT_DEV_AUTH=1`, scripted provider), and ran `next dev` from this worktree on 4180 through the proxy. Scratch Playwright scripts are not committed. Results:

- Payroll review on `pay_2026_10_30`: Needs Review (4) and Ready for Approval (44). Flag chips for NEW_IN_RUN, PRORATED, MISSING_BANK_ACCOUNT, GROSS_CHANGE and HOURS_SPIKE. The popover names the source (template). All 12 totals in the drawer equal `GET /v1/payrolls/:id`. The paycheck drawer shows 10 tax trace rows.
- Run review now (POST trigger, then poll `GET /v1/routine-runs/:id` for `agentRunId`) shows live step chips over SSE ("Explanations for pay_2026_10_30: 0 agent, 4 template, 0 refused", then the submit proposal waiting for approval). The status ends as `waiting` and the label stays `sse`. A chat run with `?sse=off` shows the same steps by polling.
- Inbox: the R4 submit card shows its diff. After switching "Viewing as" to Theo, Approve records `decidedBy: usr_theo` and the payroll goes to `processing`. Deny with a reason code records `denied`, `incorrect` and Vic.
- Run view for a completed run: stage rows, 7,214 input tokens, a 38% cache-hit ratio, USD and model time.
- Simulators: the clock chip moves from 8:30 to 9:00 AM (+30 min) and then to Tue 9:00 AM (+1 day). Arming `bank.submitBatch` shows up in `GET /v1/sim/state`. Delivering `ca_de2088_rate_change` creates `ntc_0002`.
- Home shows 4 widgets on live data (headcount 51, +3 in 30 days). Audit shows a valid chain; Undo appends a reversing row and links both ways. Offer accept creates 9 onboarding tasks. Compliance shows 7 registration rows, rates with their source and notices with plain-text bodies. Routines: 4 prebuilt cards, the draft box adds a card and a `routine_enable` proposal, and the run log shows cron and manual runs with cost.
- No horizontal page scroll at 1280 or 390 px on any `/app` screen with live data.

Fixed in round 2 because of these checks: the person detail page read a `Worker`, but the API returns a `WorkerDetail` (the page showed "undefined"). Tool step chips now read `{ output, outcome }`. The SSE `status` frame is now handled. The Simulators panel now handles `idpAccounts` as a count, snake_case rows and the missing `nextEvent`. Audit reasons are no longer doubled ("Not reversible: x is not reversible."). Home registration rows show agency names. Long routine checklist and trigger text wraps. A runless `routine_enable` proposal says "Routine draft".

## Findings for the integrator and other tracks

1. **Seed (t1 and t2)**: `pnpm db:seed` fails with "bank.submitBatch: account refs must be vault names". `core/payroll/lifecycle.ts` sends `accountRef: <bank account id>`, and t2's bank simulator requires `vault:`. My scratch fix mapped refs to `vault:<id>` in `seed/src/payroll.ts`. The real fix belongs to t1 or t2.
2. **Merge conflict**: `packages/core/src/index.ts` (t1 `export * as payroll` against t2 `export * from "./demo/index"`). Keep both lines. `packages/core/test/shared.test.ts` also conflicts with t4.
3. **Auth**: the UI needs `WEFT_DEV_AUTH=1` on the API. `scripts/dev.ts` should set it.
4. **Event routines (t4)**: `rt_agency_notice` never starts after `POST /v1/sim/notices/deliver`, so GP1 cannot run end to end yet. Item 3 in t4's notes says `createRoutines` needs `events` from apps/api. A manual trigger of `rt_agency_notice` creates a routine run but no agent run. The deliver outcome's `data` has `notice_id` (snake_case) and no `agentRunId`. The UI finds the new run by diffing `GET /v1/agent/runs`, which works once the routine fires.
5. **Chat script (t4 and t1)**: `scenarios/chat_ny_raise.json` fails with "script template {{last.payroll__get_run.data.flagged.0.flags.0.evidence.result_id}} resolved to nothing" against t1's `payroll.get_run` output. The UI shows the failed status and the message.
6. **Reset (t2 and t4)**: after `POST /v1/sim/reset`, `GET /v1/routines` is empty. The prebuilt routines are not re-seeded by `seedWorld`.
7. **Client typing (scaffold)**: `apps/web/src/lib/api/client.ts` types `GET /v1/workers/:id` as `Worker`, but the route table and the API say `WorkerDetail`. The person view reads both forms (`toDetail`). Please type it as WorkerDetail once a contract type exists.
8. **Digest post (t4 and t2)**: on the scratch API, +30 min to Mon 9:00 PT fires `rt_people_digest` (cron run `done`, `run_0004`). Its summary says "Posted the weekly people digest in #people-ops", but `GET /v1/sim/chat?channel=#people-ops` has no new message. Either the post went elsewhere or the summary is not grounded in a tool outcome. GP4 needs this message.
9. **next dev side effects**: every start writes an untracked `apps/web/AGENTS.md` (which fails `lint:prose`) and edits `apps/web/next-env.d.ts`. Neither is committed. Consider `agentRules: false` in `next.config.ts` and a `.gitignore` entry.

## Assumptions still open

- Principals are `usr_dana`, `usr_theo` and `usr_sam`. The option labels contain the first name, which T6's `viewAs` helper needs.
- Run review now uses `POST /v1/routines/rt_pre_payroll/trigger`, which returns `{ routineRunId }` (confirmed), then polls `GET /v1/routine-runs/:id` for `agentRunId` (confirmed).
- New draft reads the new run id from the outcome's `data.runId`, else from `resultId` when it starts with `pay_`. This is not yet checked against t1's outcome.
- Test id suffixes: `sim-advance-30m`, `sim-advance-1d`, `sim-advance-next`, `sim-fault-<dotted target>`, `chat-channel-<name without #>`, `rate-row-<J>-<code>` per history row, `registration-row-<state>` per account, `notice-status` inside `notice-row-<id>`. Exactly one `agent-status` exists at a time.
- Extra t5-only test ids (not in SPEC 11.4): `home-widget-*`, `paycheck-drawer`, `paycheck-tax-trace`, `payroll-totals-all`, `payroll-submit-confirm`, `payroll-run-<id>`, `people-row-<id>`, `notice-detail`, `notice-body`, `run-status`, `run-tainted-banner`, `sim-clock-now`, `sim-next-event`, `sim-registrations`, `sim-agency-mail`, `sim-bank-batches`, `sim-idp-accounts`, `sim-device-orders`, `pay-rate-<id>`, `enrollment-<id>`, `it-account-<id>`, `benefit-plan-<id>`, `it-system-<system>`, `device-<id>`, `contractor-<id>`.

## Stubbed or left

- GP1 and the tainted proposal are verified only against mocks, because of finding 4. On the API, the Inbox, Compliance and Audit paths that GP1 uses are verified with other proposals and actions.
- Expenses, Time Off and Settings are labeled stubs. Filings on Compliance shows Coming soon. Contractor payouts are P1.
- Cut per the cut line: charts, row flash animation and Suggestions tab polish.

## Contract changes

- Round 1, in its own commit (`contract: export @weft/ui/components entry for app primitives`): one additive exports line in `packages/ui/package.json`. There were no contract changes in round 2.
- Still requested (in `.scratch/contract-requests/t5-app.md`): a `SimState` contract type for `GET /v1/sim/state` matching the API's keys (`clock`, `registrations`, `agencyMail`, `bankBatches`, `idpAccounts` as a number, `deviceOrders`, `faults`, `catalog`); `Responses` entries for `GET /v1/routine-runs/:id`, `GET /v1/sim/state`, `GET /v1/sim/chat` and `POST /v1/sim/notices/deliver`; and `GET /v1/workers/:id` typed as `WorkerDetail`.
