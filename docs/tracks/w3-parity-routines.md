# Track w3-parity-routines: routine parity

Wave 3 goal 1 (the Weft agent does what the reference agent does), the routine half: New Hire Ready Check, the monthly
exec report and the Monday briefing, milestones, three anomaly rules, and per-routine autonomy with its settings.
Branch `track/w3-parity-routines`. Specs: `research/wave3/agent-parity.md` sections 5.6 to 5.9 and 5.13.

## What landed

| Item | Where | What it does |
|---|---|---|
| Anomaly rules | `packages/core/src/payroll/parity-flags.ts` | `DUPLICATE_SUPPLEMENTAL` (block): a bonus, commission, supplemental or taxable reimbursement line with the same type and amount as another line on the paycheck, or as a line on the worker's paycheck in either of the two most recent runs on the schedule that left draft. Block because special runs keep only blocking flags and a doubled bonus is money out twice. `RAISE_NOT_APPLIED` (review): a pay rate of the same kind and a higher amount, effective after the previous run's period end and on or before this period's end, that the paycheck did not use. `WITHHOLDING_CHANGED` (review): a `federal_w4` or `state_withholding` submission after the previous run was processed and on or before this period's end, for a worker paid in that run (new hires are `NEW_IN_RUN`). |
| Planted cases | `packages/seed/src/w3-parity.ts` (`plantParityAnomalyCases`, `PARITY_CASES`) | One case per rule, all dated inside Nov 1 to 15 so the open draft keeps its GP2 flags: a 6% raise for wrk_0010 whose end date was keyed as its first day, a W-4 for wrk_0011 submitted Nov 2, a processed off-cycle bonus for wrk_0012 (payday Nov 6). Test and demo worlds call it; the default seed does not (it would add a processed run and change wave 1 counts). |
| Birthdays | `packages/seed/src/w3-parity.ts` (`seedW3Parity`) | Every other active person (by id) gets a synthetic `birth_month_day` (`MM-DD`, never a year). |
| `onboarding.ready_check` (R0) | `packages/core/src/parity/ready-check.ts`, `commands/parity.ts` | Employees starting within N business days (default 3, weekends skipped) with the eight `ReadyCheckItem` checks and the owner of each blocking item (the hire, IT, payroll). A checklist task decides when the hire has one; otherwise the data does. |
| `onboarding.flag_not_ready` (R1) | same, `packages/core/src/parity/suggestions.ts` | One Inbox suggestion per blocked hire, recomputed from the database (never from arguments), superseding the previous pending one for the same hire. `proposer_run_id` stays null so a suggestion never holds the routine run in waiting. |
| `rt_new_hire_ready` | `packages/routines/src/wave3/parity.ts`, `scenarios/rt_new_hire_ready.json` | Weekday 09:00 PT, disabled. One `#new-hires` post: a ready line per ready hire, the blocking items with owners per blocked hire, or a first-day welcome on the start date; then `onboarding.flag_not_ready`. Checklist: `posted:#new-hires` and `flagged_not_ready:{blocked_count}`. |
| `reports.exec_figures` (R0), `comms.send_exec_report` (R3) | `packages/core/src/parity/exec-report.ts` | Figures from the database: headcount by state at month end, hires, departures, turnover, payroll cost of processed runs by payday month against the month before, open notices and approvals; the weekly kind adds the next payday and deadline, hires in two weeks and registrations not active. `send_exec_report` writes the text in code from those figures, runs the grounding check against them, posts to `#leadership` and emails `leadership@larkspur.example` through the email simulator. Same risk and autoAllow as `comms.send_message`. |
| `rt_monthly_exec_report`, `rt_exec_briefing` | `packages/routines/src/wave3/parity.ts` | `0 9 1 * *` and `0 8 * * 1` PT, both disabled. The precheck reads `reports.exec_figures` and derives `{ kind, month, as_of }`; the model only passes them on. |
| `people.list_milestones` (R0), `rt_milestones` | `packages/core/src/parity/milestones.ts` | Work anniversaries (whole years) and opted-in birthdays, posted to `#general` weekday 09:00 PT. Disabled. Findings carry the kind and years only. |
| Autonomy in `policy()` | `packages/executor/src/policy.ts` (`AutonomyFacts`, `loadAutonomyFacts`, `withAutonomy`) | recommend: every R2 to R4 write becomes a suggestion (reads and R1 still run). approve: unchanged. auto, only with `agent.allow_auto_autonomy` on and only untainted: an R2 command that declares `autoEligible` executes when its amount is at or under that limits row; R3 keeps autoAllow; R4 never; no amount, no limit, a pending call earlier in the batch, the setting off or a tainted run all fall back to approve. Ceilings refuse first. Humans, MCP and approved proposals ignore autonomy. |
| Pipeline wiring | `packages/executor/src/pipeline.ts` (separate `contract:` commit) | Gathers `AutonomyFacts` for agent calls in a routine run and files a `suggest` decision as a `suggestion` proposal. |
| `routines.set_autonomy` (R1) | `commands/parity.ts`, `apps/api/src/routes/routines.ts` | `POST /v1/routines/:id/autonomy` files it with `human.propose` (MCP propose path), so it is always a proposal; `run()` refuses unless it executes an approved proposal, and auto is refused at proposal and at execution while the setting is off. Tier unavailable to agents. |
| Agent settings | `apps/api/src/routes/settings.ts` | `GET /v1/settings/agent` and `PUT` (ui_only, admin only through `adminChange`, audited). Both default off. |
| Engine | `packages/routines/src/engine.ts` | A recommend run's pending writes are listed as "Review the suggestion ..." in the run log. |
| UI | `apps/web/src/components/app/routines/{autonomy-control,agent-settings}.tsx`, routines view, Settings page | Three-way segmented control on the routine page (auto disabled until Settings allows it; a pending change is shown with a link to the Inbox); an autonomy badge on routine cards; Settings > Agent with both switches. |

## Tests

- `packages/executor/test/autonomy.test.ts`: policy snapshot per level for every fixture command, approve equals no autonomy, the limit, taint, setting, amount and pending fallbacks, R4 never, ceilings first.
- `tests/scenarios/gp16-anomalies.test.ts`: pure rule cases; the open draft's flags unchanged after planting and a recompute; a new Nov 1 to 15 draft flags exactly the raise and the W-4 workers; an off-cycle repeating the planted bonus is blocked and another worker's is not.
- `tests/scenarios/gp16-routines.test.ts`: ready check with one ready and one blocked hire (exact post, one suggestion, refreshed not duplicated), the exec report on Nov 1 (numbers equal the figures, email sent, derived args), milestones (anniversaries, opted-in birthdays only, no year).
- `tests/scenarios/gp16-autonomy.test.ts`: settings defaults and admin-only PUT; the autonomy change is a proposal applied on approval; direct execution refused; auto gate; a recommend run posts nothing and files a suggestion.
- `e2e/gp16-routines.spec.ts` (ports 4630 and 4631): Settings switches and the autonomy change through the Inbox.
- PREBUILT id assertions updated in `packages/routines/test/engine.test.ts` and `apps/api/test/routines.test.ts` (outside the owned paths, required by the acceptance list).

## Decisions and deviations

- Exec report numbers: `comms.send_message` grounds only against company facts, so a payroll cost could never pass it.
  The report goes through `comms.send_exec_report`, which builds and grounds the text in code. `reports.query`
  (w3-parity-chat) is not used yet; `reports.exec_figures` computes the same numbers.
- `routines.set_autonomy`, `onboarding.flag_not_ready`, `reports.exec_figures` and `comms.send_exec_report` are not in
  `W3_PLANNED_COMMANDS`; no test requires them to be. The integrator may add them to the planned table.
- Suggestions are proposal rows of kind `suggestion` written by `upsertSuggestion` (core) for the ready check and by
  the pipeline for recommend runs; no chat card is posted for them.
- Business days skip weekends only; the 2026 holiday calendar belongs to w3-timeoff.
- The task text said ports 4640 to 4659 in one line and 4630 and 4631 for e2e in another; docs/wave3.md assigns
  4630 and 4631 to this track, and 4640 to 4659 belong to w3-timeoff and w3-expenses, so e2e ran on 4630 and 4631.

## Left

- Auto end to end with a real `autoEligible` command: `expenses.decide` (w3-expenses) must declare
  `autoEligible: "agent.expense_auto_cents"` and seed that limits row; then a GP16 scenario where a routine at auto
  approves a clean expense under the cap, proposes one above it, and a tainted run falls back to approve.
- The approval and override counts from `knowledge/preferences/approvals.md` next to the autonomy control (G8).
- Stretch items not started: notice escalation (rank 10), routine gallery with last and next run (rank 11), 30-day
  check-in (rank 12), contractor W-9 and W-8 expiry (rank 15). `contractors.list_tax_forms` and `notices.escalate`
  from the planned table are not implemented.
- `rt_new_hire_ready` does not yet read the holiday calendar or Workday-owned start dates.
- The exec report uses processed runs by payday month; it does not split contractor payouts.
