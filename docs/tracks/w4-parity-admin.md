# w4-parity-admin

Wave 4 parity rows Q3, R7, R16 (Reports), G1 and G2 (permissions and per-action narrowing) and G10, G7, G8 (routine
gallery). Branch `track/w4-parity-admin`. Live model spend over both rounds: $0.00 (scripted provider and a capturing
test provider only), so nothing was added to the wave ledger.

## Acceptance

| Item | State | Evidence |
|---|---|---|
| Every ReportMetric and ReportMetricW4 renders a chart and a table, with SQL tests | Met | `apps/api/test/w4-admin-reports.test.ts`, `e2e/gp-reports.spec.ts` |
| Sending a report files a proposal and sends nothing until approved | Met | the same API test and spec; R16 test below |
| deny hides the command from the agent's tools, propose_only forces a proposal, with executor tests | Met | `packages/executor/test/scope-overrides.test.ts`, `apps/api/test/w4-admin-overrides.test.ts` |
| Gallery shows correct last and next run for cron routines | Met | `apps/api/test/w4-admin-gallery.test.ts` (hand-worked slots across the 1 November PDT to PST change), gallery test in `e2e/gp-permissions.spec.ts` |
| e2e for Reports and permissions at 1440 docked and 390 with no overflow | Met | `e2e/gp-reports.spec.ts`, `e2e/gp-permissions.spec.ts` (run on ports 4890 and 4891 through a temporary config, then deleted) |

## Reports screen (round 1)

`/app/reports`, sidebar entry "Reports" under Company (`nav.ts`).

- The catalog (`GET /v1/reports`) lists all eleven metrics: the seven wave 3 `ReportMetric` values (served by the
  frozen `reports.query` through `GET /v1/reports/:metric`) and the four `ReportMetricW4` values, with label, unit,
  data domain, snapshot flag and whether the person may read it (view on the metric's domain). A metric the person
  cannot read shows a lock and no data.
- `reports.breakdown` (R0, `packages/core/src/commands/w4-admin.ts`) computes the four wave 4 metrics, one SQL family
  each, with rows, `range_totals` and a `ChartSpec` in the wave 3 shape:
  - `payroll_cost_by_state`: per paycheck of a paid run (processing or processed, payday in range), gross plus
    employer taxes, employer benefit contributions and reimbursements, grouped by the worker's work state. Adds back
    exactly to the runs' stored `totalCost` (test). The state is the worker's current one: Weft keeps no work-state
    history yet.
  - `headcount_and_cost_by_state`: employees on the roll on `to` beside the same cost per state and per employee.
  - `contractor_vs_employee_cost_by_month`: the runs' `totalCost` by payday month beside paid contractor payouts by
    scheduled month, with the contractor share.
  - `compliance_due_by_month`: compliance items by due month as done (or waived), open and overdue.
- The web view draws the chart with the wave 3 `ReportChart` and a full table with a Total row for money, a date range
  and month or quarter grouping (disabled for snapshot metrics).
- **Email this report** posts `POST /v1/reports/:metric/send`, which files a `comms.send_report` proposal through
  `executor.human.propose`. Nothing is sent until a person approves it in the Inbox.

**Deviation from the route note "(a proposal: comms.send_message)".** `comms.send_message` grounds its text against a
fixed fact sheet that holds no report figure, so a report text would be refused UNGROUNDED on approval, and it posts
to chat, not email. `comms.send_report` (R3, approval always, autoAllow never) writes the text in code from the report
rows, grounds it against them, and emails up to ten `*.example` recipients through the email simulator.

## Permissions screen and per-action narrowing

`/app/settings/permissions`.

- `settings.permission_matrix` (R0) behind `GET /v1/permissions/matrix`: a `PermissionMatrixRow` per person with their
  View, Edit or Approve level per domain, `agentDomains` (the agent grant intersected with theirs, approve capped at
  edit, the executor's `runGrants` rule), and the agent's own row last.
- `settings.set_agent_action_override` (R2, approval always, unavailable to the agent on every tier) behind
  `POST /v1/permissions/agent-actions`: deny, propose_only or clear for one command, for one person or for the agent
  itself. Always a proposal; refuses commands the agent can never call and propose_only on a read.
- **Enforcement.** `packages/executor/src/scope.ts` loads the overrides binding a run (the agent's row for every run,
  the on-behalf-of person's row; deny wins) into `CallScope.overrides` and takes denied commands off the run's frozen
  allowlist, so a call to one is refused `UNAVAILABLE`. Round 2 added the two hooks that make the rest real:
  - **propose_only** (commit `contract: propose_only per-action overrides in the executor pipeline`): `runInTx` passes
    the `policy()` decision through `narrowDecision(decision, actionOverrideOf(scope, def.name), isRead)`. An agent
    call that would execute becomes a proposal; refusals, existing proposals, reads and human calls are unchanged.
  - **deny hides the tool** (commit `contract: hide denied commands from the model's tool list`): `AgentExecutor`
    gains an optional `toolAllowlist(run, allowlist)` (executor `agent.ts`), and the loop builds its tool specs from
    it, so the model is never offered a denied command. Optional, so fake executors are unchanged.
  - Tests: executor (`scope-overrides.test.ts`, the todo is now two pipeline tests) and an API test with a capturing
    provider that reads the tool list the model was shown before and after an approved deny, for the person it binds,
    for the agent's own row, and after clear.

## Routine gallery (round 2)

- `routines.gallery` (R0, planned) in `w4-admin.ts` behind `GET /v1/routine-gallery`, one `RoutineGalleryRow` per
  routine plus `createdByName`, `schedule` and `pending`:
  - created by: the person whose request drafted a custom routine (`routine.drafted` requested_by, else the owner);
    prebuilt routines have none.
  - enabled at: the latest `routine.enabled` when it is newer than any `routine.disabled`; a routine that shipped
    enabled with no event shows its creation time; null while disabled.
  - last run: the newest `routine_runs` row by start (or end) time, with its status.
  - next run: the next cron slot strictly after the sim clock in the routine's time zone (croner, the engine's
    `nextRunAt` rule); null for disabled, event and manual routines.
  - approvals and overrides: proposals filed by the routine's runs, with the mapping the learned approval preferences
    use. Approved counts approved, executed and failed; overridden counts denied, superseded (edited) and dismissed.
    Pending is separate; expired counts in neither.
- Web: `apps/web/src/components/app/routines/gallery/routine-gallery-w4.tsx`. `RoutineGalleryW4` is a table from
  tablet width up and one card per routine below it; `RoutineDecisionCounts` sits beside the autonomy control on a
  routine's page. Both are mounted in the wave 3 `routines-view.tsx` (three lines, commit
  `contract: mount the wave 4 routine gallery on the Routines page`).

## R16 weekly cost by state (round 2)

`rt_weekly_cost_by_state` in `packages/routines/src/wave4/admin.ts`, shipping disabled: Mondays 08:00 PT, tools
`reports.breakdown` and `comms.send_report`. The precheck reads `payroll_cost_by_state` for the year to date in code
and skips with zero tokens when no paid run falls in it; the derived arguments carry the `comms.send_report` call, so
the model restates no number. The checklist (`report_proposed:payroll_cost_by_state:{from}`) holds once the proposal
is live, the run waits for approval, and the approval wakes it to done with no model step. The scripted script is
inline in `apps/api/test/w4-admin-routine.test.ts` (`RT_WEEKLY_COST_BY_STATE_SCRIPT`); the integrator may copy it to
`scenarios/rt_weekly_cost_by_state.json`.

## Contract changes

Each is its own `contract:` commit and is additive.

1. `contract: export the Reports screen catalog from @weft/core` (round 1): one export line in
   `packages/core/src/index.ts`. It exports names that the next commit adds, so it does not typecheck if cherry-picked
   alone.
2. `contract: propose_only per-action overrides in the executor pipeline`: `packages/executor/src/pipeline.ts`
   (w4-telemetry owns the file; no wave 4 branch edits it, so it merges cleanly).
3. `contract: hide denied commands from the model's tool list`: an optional method on `AgentExecutor`
   (`packages/contracts/src/commands.ts`), its implementation in `packages/executor/src/agent.ts`, and one line in
   `packages/agent/src/loop.ts`. w4-telemetry edits `loop.ts` too, but not near the tool-spec line.
4. `contract: mount the wave 4 routine gallery on the Routines page`: three lines in
   `apps/web/src/components/app/routines/routines-view.tsx` (no wave 4 branch edits that folder).

## Notes for the integrator

- Add `reports.breakdown` (R0, all, never) and `comms.send_report` (R3, all, always) to `W4_PLANNED_COMMANDS`.
- `packages/routines/test/engine.test.ts` lists every prebuilt id; this branch adds `rt_weekly_cost_by_state`, and
  w4-parity-people adds its own ids to the same line, so the merge needs the union.
- The e2e specs are named by the brief (`e2e/gp-reports.spec.ts`, `e2e/gp-permissions.spec.ts`), which the playwright
  `testMatch` (`gp\d+-`) does not pick up. Give them GP numbers when folding in. The gallery test lives in the
  permissions spec because this track owns only those two spec files.
- Tests beside the owned code (new files only): `apps/api/test/w4-admin-{reports,overrides,gallery,routine}.test.ts`
  and `packages/executor/test/scope-overrides.test.ts`.
- Ports: the brief said 4880 to 4899 while `docs/wave4.md` assigns 4850 and 4851; e2e ran on 4890 and 4891 after
  checking both were free.

## Left

See `.scratch/w4-parity-admin/left.md`.
