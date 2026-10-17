# w4-parity-admin

Wave 4 parity rows Q3, R7, R16 (Reports), G1 and G2 (permissions and per-action narrowing) and G10, G7, G8 (routine
gallery). Branch `track/w4-parity-admin`. Live model spend this round: $0.00 (scripted provider only).

## Landed (round 1)

**Reports screen** (`/app/reports`, sidebar entry "Reports" under Company).

- The catalog (`GET /v1/reports`) lists all eleven metrics: the seven wave 3 `ReportMetric` values (served by the
  frozen `reports.query` through `GET /v1/reports/:metric`) and the four `ReportMetricW4` values, with label, unit,
  data domain, snapshot flag and whether the person may read it (view on the metric's domain).
- `reports.breakdown` (R0, `packages/core/src/commands/w4-admin.ts`) computes the four wave 4 metrics, one SQL family
  each, with rows, `range_totals` and a `ChartSpec` in the wave 3 shape:
  - `payroll_cost_by_state`: per paycheck of a paid run (processing or processed, payday in range), gross plus
    employer taxes (`taxes_json` rows with payer employer), employer benefit contributions (`benefits_json`
    employerCents) and reimbursements, grouped by the worker's work state. Adds back exactly to the runs' stored
    `totalCost` (test). The state is the worker's current one: Weft keeps no work-state history yet.
  - `headcount_and_cost_by_state`: employees on the roll on `to` (the wave 3 rule) beside the same cost per state and
    cost per employee.
  - `contractor_vs_employee_cost_by_month`: the runs' `totalCost` by payday month beside paid contractor payouts by
    scheduled month, with the contractor share; empty periods are left out as in wave 3.
  - `compliance_due_by_month`: compliance items by due month as done (or waived), open and overdue (past due and not
    done); every month in the range is a row.
- The web view draws the chart with the wave 3 `ReportChart` and a full table of every row column (series first,
  then the rest, with a Total row for money), a date range (default 1 January to today on the sim clock) and month or
  quarter grouping (disabled for snapshot metrics). Wave 4 metrics are fetched through `POST /v1/tools/:name`
  (`reports.breakdown`); no new route was needed.
- **Email this report** posts `POST /v1/reports/:metric/send`, which files a `comms.send_report` proposal through
  `executor.human.propose`. Nothing is sent until a person approves it in the Inbox (API test and e2e).

**Deviation from the route note "(a proposal: comms.send_message)".** `comms.send_message` grounds its text against a
fixed fact sheet (headcounts, open approvals, onboarding dates) that holds no report figure, so a report text would be
refused UNGROUNDED on approval, and it posts to chat, not email. `comms.send_report` (R3, approval always, autoAllow
never, delegated for task agents) writes the text in code from the report rows, grounds it against them, and emails
up to ten `*.example` recipients through the email simulator, like `comms.send_exec_report` does for the exec report.

**Permissions screen** (`/app/settings/permissions`).

- `settings.permission_matrix` (R0) behind `GET /v1/permissions/matrix`: a `PermissionMatrixRow` per person with
  their View, Edit or Approve level per domain, `agentDomains` (the agent grant intersected with theirs, approve
  capped at edit, the executor's `runGrants` rule), and the agent's own row last.
- `settings.set_agent_action_override` (R2, approval always, unavailable to the agent on every tier) behind
  `POST /v1/permissions/agent-actions`: deny, propose_only or clear for one command, for one person or for the agent
  itself. Always a proposal; refuses commands the agent can never call and propose_only on a read.
- **Enforcement in `packages/executor/src/scope.ts`.** `agentScope` loads the overrides binding the run (the agent's
  row for every run, the on-behalf-of person's row) into `CallScope.overrides` and takes denied commands off the run's
  frozen allowlist, so the pipeline's existing allowlist check refuses them `UNAVAILABLE` (executor tests).
  `narrowAllowlist` gives the tool list without them; `actionOverrideOf` and `narrowDecision` are the propose_only
  hook. Deny wins over propose_only; human calls are never narrowed.

## Contract changes and requests

- Commit `contract: export the Reports screen catalog from @weft/core`: one additive line in
  `packages/core/src/index.ts` (`REPORT_CATALOG`, `CatalogEntry`) so the admin route serves the catalog.
- Two commands beyond `W4_PLANNED_COMMANDS`: `reports.breakdown` (R0) and `comms.send_report` (R3, always). Request:
  add both rows to the planned table.
- **Pipeline hook (owned by w4-telemetry, `packages/executor/src/pipeline.ts`)**, needed for propose_only and for the
  tool list (see `.scratch/contract-requests/w4-parity-admin.md` for the exact lines).
- **Tool list at run open** (`packages/agent/src/runtime.ts` or `packages/executor/src/runs.ts`): pass the run's
  allowlist through `narrowAllowlist(allowlist, await loadActionOverrides(tx, companyId, [agentId, onBehalfOf]))` so
  the model is never shown a denied command. Until then a denied command is refused at call time.
- The e2e specs are named by the brief (`e2e/gp-reports.spec.ts`, `e2e/gp-permissions.spec.ts`), which the
  playwright `testMatch` (`gp\d+-`) does not pick up. The integrator numbers them (GP20 onward) when folding in.
- Tests beside the owned code: `apps/api/test/w4-admin-reports.test.ts` and
  `packages/executor/test/scope-overrides.test.ts` (new files only).

## Left

See `.scratch/w4-parity-admin/left.md`: the routine gallery (G10, G7, G8), the R16 weekly cost by state routine, the
propose_only pipeline hook test, and per-role context defaults.
