# Track t5-app notes (round 1)

Owner paths: `apps/web/src/app/(app)/**`, `apps/web/src/components/app/**`, `apps/web/src/lib/api/{hooks,sse}.ts`, `apps/web/src/lib/api/mocks/**`, `packages/ui/src/components/**`.

## What exists

- **Shell** (`components/app/shell/`): grid `244px 1fr 340px` (sidebar collapses below 1024 px into an overlay; the agent panel docks at 1280 px and overlays below), 48 px header with breadcrumb, Cmd+K (navigation plus record search over people and payroll runs), provider badge, sim clock chip, the "Viewing as" demo control, and the agent panel toggle. The header uses container queries so it fits beside the docked panel and at 390 px.
- **Primitives** (`packages/ui/src/components/`, imported from `@weft/ui/components`): button, card, badge, table parts, drawer (radix Dialog), tabs, shimmer text, diff table, popover, kbd. TanStack Table v9 `useTable` drives the payroll and people tables in `apps/web`.
- **Screens**: Home (4 widgets), Inbox (Approvals, Suggestions, Decided), Payroll list and review, People (table and Offers tab with Mark accepted) and person detail (profile and onboarding), Compliance (Registrations, Rates, Notices with a plain-text detail drawer, Filings coming soon), Routines (gallery, create-your-own box) and routine detail (instructions, tools, checklist, run log, Run now), Run view, Audit (chain status, Undo, reversed links), Simulators (clock steps, notice delivery, fault toggles, sim state tables, chat feeds). Benefits, IT, Contractors, Expenses, Time Off and Settings are labeled stubs.
- **Data layer** (`lib/api/hooks.ts`): one typed client with the "Viewing as" principal (`x-weft-principal`, persisted in localStorage), `useGet` with a small cache and polling, `useMutation` that invalidates every query on success.
- **Live runs** (`lib/api/sse.ts`): SSE read over `fetch` streaming (so the principal header rides along), with a 1 s trace polling fallback whenever the stream fails or ends early; paused runs (`waiting`, `held`) are re-polled every 3 s so a run that wakes after an approval reaches `done` on screen. `?sse=off` in the page URL forces polling.
- **Mocks** (`lib/api/mocks/`): a fetch-compatible router over a contract-typed fixture world (48 workers with the 4/44 anomaly split, totals that satisfy the SPEC 7.4 identities, GP1 proposals, a tainted proposal, runs with steps, routines, notices, actions, sim state). `NEXT_PUBLIC_WEFT_MOCKS=1` swaps it in under the same client, so screens exercise real paths and `_tag` errors. Mock state lives in the browser tab and resets on reload.

Run with mocks: `NEXT_PUBLIC_WEFT_MOCKS=1 pnpm --filter @weft/web dev` (check the port first).

## Contract change (separate commit)

- `contract: export @weft/ui/components entry for app primitives`: one additive line in `packages/ui/package.json` exports, `"./components": "./src/components/index.ts"`. Nothing else in tokens, theme or `index.ts` changed.

## Assumptions the integrator and other tracks should check

1. **Principal ids** are `usr_dana`, `usr_theo`, `usr_sam` (same as T6's e2e fixtures). The option labels contain the first name, so T6's `viewAs` helper works.
2. **SSE frames** on `GET /v1/agent/runs/:id/events`: each `data:` is JSON, either a `RunStepRow` (has `n` and `stage`), an `AgentRunRow` (has `id` and `status`) or a `RunTrace`. Event names are free; `end`, `done` or `run.finished` trigger a final trace read. If the stream closes before a terminal status, the UI falls back to polling.
3. **Run review now** posts `POST /v1/routines/rt_pre_payroll/trigger` with body `{ runId }`, expects `{ routineRunId }` and then polls `GET /v1/routine-runs/:id` for `agentRunId` (an `agentRunId` in the trigger response is used directly when present).
4. **Deliver notice** posts `POST /v1/sim/notices/deliver { scenario }`. To show the run in the agent panel the UI uses `data.agentRunId` from the outcome when present, otherwise it diffs `GET /v1/agent/runs?limit=10` before and after. Suggestion for T2: return `{ noticeId, agentRunId? }` in `data`.
5. **New draft** reads the new run id from the outcome's `data.runId`, else from `resultId` when it starts with `pay_`.
6. **`GET /v1/sim/state`** has no contract type. The UI renders `{ registrations[], bankBatches[], idpAccounts[], faults: ArmedFault[], nextEvent?: { at, label } }` generically (any object rows). T2: please match these keys or tell t5.
7. **Test id suffixes**: `sim-advance-30m`, `sim-advance-1d`, `sim-advance-next` (matches T6 `SIM_STEP`), `sim-fault-<target>` with the dotted target (`sim-fault-bank.submitBatch`), `chat-channel-<name without #>`, `rate-row-<J>-<code>` repeated per history row, `registration-row-<state>` once per account, `notice-status` inside each `notice-row-<id>`. Exactly one `agent-status` exists at a time (the latest run in the thread), so T6's strict locators hold.
8. **Audit** rows with `reversible: "no"` show `Not reversible: <notReversibleReason>` (the prefix is added unless the reason already has it). GP1 expects the reason "filed with the agency simulator".
9. **Auth**: `/v1/health` is public, but the scaffold auth middleware returns 401 for an unknown `x-weft-principal` even on public routes. The UI always sends a principal, so the header chips need the governance seed to exist.
10. **Extra test ids** used by t5 only (not in SPEC 11.4): `home-widget-*`, `paycheck-drawer`, `paycheck-tax-trace`, `payroll-totals-all`, `payroll-submit-confirm`, `payroll-run-<id>`, `people-row-<id>`, `notice-detail`, `notice-body`, `run-status`, `run-tainted-banner`, `sim-clock-now`, `sim-registrations`, `sim-bank-batches`, `sim-idp-accounts`.

## Checks run in round 1

- `pnpm --filter @weft/web build`, `pnpm typecheck`, `pnpm test` (web: 9 tests over the mocks and streaming helpers), `pnpm lint:prose`, `pnpm lint:brand`.
- Playwright scratch scripts (not committed) against `next dev` with mocks at 1280 and 390 px: no horizontal page scroll on any screen; every SPEC 11.4 app test id present; Inbox approve as Theo records Theo; deny needs a reason; the tainted banner and escaped content render; payroll review shows Needs Review (4) and Ready for Approval (44), flag popovers with the explanation source, the paycheck tax trace and all 12 totals; Run review now and Deliver show live steps in the agent panel (polling mode under mocks); +30 min, +1 day and a fault toggle work and the clock chip updates; Undo appends a reversing row.
- Against the scaffold API on 4181 (no seed yet): the proxy injects `x-weft-proxy` (the API answered `Unknown human principal`, not a proxy error) and screens show the `_tag` errors instead of breaking.

## Left for round 2

- Turn mocks off and verify every screen against the merged API and seed: 4/44 on `pay_2026_10_30`, totals equal `GET /v1/payrolls/:id`, live SSE steps for a scripted GP1 run, the Theo switch on Approve.
- Adjust to the real shapes of `/v1/sim/state`, the SSE frame names and the trigger and deliver responses (items 2 to 6 above).
- People detail tabs beyond profile and onboarding (pay rate history, tax setup, benefits, IT accounts); Benefits, IT and Contractors page bodies (cut line: badge-only stubs today).
- Cut, per the cut line: charts, row flash animation, Suggestions polish.
