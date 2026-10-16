# Track w3-parity-routines: routine parity

Wave 3 goal 1 (the Weft agent does what the reference agent does), the routine half: New Hire Ready Check, the monthly
exec report and the Monday briefing, milestones, three anomaly rules, per-routine autonomy with its settings, and the
stretch items notice escalation (rank 10), the routine gallery (rank 11), the first-month check-in (rank 12) and
contractor tax forms (rank 15). Branch `track/w3-parity-routines`. Specs: `research/wave3/agent-parity.md` sections
5.6 to 5.14.

## What exists

### Routines (all ship disabled, at most 8 tools, scripted scenario in `scenarios/<id>.json`)

| Routine | Schedule (PT) | What it does | Writes |
|---|---|---|---|
| `rt_new_hire_ready` | weekdays 09:00 | Hires starting within 3 business days: one `#new-hires` post with a ready line per ready hire, the blocking items with owners per blocked hire, or a first-day welcome on the start date. | `comms.send_message`, `onboarding.flag_not_ready` |
| `rt_monthly_exec_report` | the 1st, 09:00 | The month that just ended to `#leadership` and the leadership email list: headcount by state, hires, departures, turnover, payroll cost against the month before, open items. | `comms.send_exec_report` |
| `rt_exec_briefing` | Mondays 08:00 | The weekly variant: next payday and deadline, hires in two weeks, registrations not active. | `comms.send_exec_report` |
| `rt_milestones` | weekdays 09:00 | Work anniversaries, and birthdays only for people with a synthetic `birth_month_day`, to `#general`. Never a year. | `comms.send_message` |
| `rt_contractor_forms` | Mondays 09:00 | Contractors whose W-9 or W-8 is missing, expired or lapses within 60 days get an email asking for a new one; a lapsing form is marked renewal requested so it is asked for once. | `contractors.request_tax_forms` |
| `rt_thirty_day_checkin` | weekdays 09:00 | Day 30 after the start date (caught up within the week), the hire gets a four-question check-in by email; three days after sending, one nudge. | `onboarding.send_checkins` |

Every routine's precheck reads one R0 command, skips when there is nothing to do, and derives the exact arguments of
its write, so the model only passes derived values on. Checklist predicates (`flagged_not_ready`,
`exec_report_sent`, `tax_forms_requested`, `checkins_sent`) pass on a done call that covers the count or a pending
call whose proposal is still live. The routines page opens with a Favorites row (ready check, pre-payroll, exec
report, digest, milestones) whose Try it fires an attended run; every card shows its last run and next run.

### Commands (`packages/core/src/commands/parity.ts`, logic in `packages/core/src/parity/`)

| Command | Risk | Notes |
|---|---|---|
| `onboarding.ready_check` | R0 | The eight `ReadyCheckItem` checks and the owner of each blocking item (the hire, IT, payroll). A checklist task decides when the hire has one; otherwise the data does. Weekends are skipped. |
| `onboarding.flag_not_ready` | R1 | One Inbox suggestion per blocked hire, recomputed from the database, superseding the previous pending one. `proposer_run_id` stays null so it never holds the run in waiting. |
| `reports.exec_figures` | R0 | Figures from the database; payroll cost is processed runs by payday month. |
| `comms.send_exec_report` | R3, autoAllow untainted | Writes the report text in code from the figures, grounds it against them, posts to `#leadership`, emails `leadership@larkspur.example`. |
| `people.list_milestones` | R0 | Anniversaries (whole years) and opted-in birthdays; findings carry kind and years only. |
| `routines.set_autonomy` | R1 | Only ever runs as an approved proposal (`POST /v1/routines/:id/autonomy` files it); auto is refused while the setting is off. Tier unavailable to agents. |
| `contractors.list_tax_forms` | R0 | Per active contractor: form needed (W-9 in the US, W-8BEN or W-8BEN-E abroad), form on file, signed and lapse dates (W-8: December 31 of the third year after signing), state (`valid`, `expiring`, `expired`, `missing`, `requested`). Superseded forms do not count. |
| `contractors.request_tax_forms` | R3, autoAllow untainted | Rechecks the list, emails each listed contractor who still needs a form, marks a lapsing form `renewal_requested`, skips current ones, refuses ids that are not active contractors. |
| `onboarding.list_checkins` | R0 | `to_send`, `to_nudge`, `open`, `submitted`, statuses only, never the answers. |
| `onboarding.send_checkins` | R3, autoAllow untainted | Creates the `checkins` row (unique per worker and due date) and emails the hire; nudges once. |
| `onboarding.submit_checkin` | R1, human only | Stores the four answers, emits `checkin.submitted`, emails the manager the two multiple-choice answers only (no numbers, none of the written words, which are untrusted). Agents and MCP cannot call it. |
| `notices.escalate` | R1, no approval | Sets an open notice to `escalated` with the reason and an evidence pack (notice, tax account, the account's filings, the parser's extract) in `resolution_json`, and emails the simulated tax specialist. Resolved or escalated notices are refused. The Compliance notice drawer shows the hand-off. |

### Anomaly rules (`packages/core/src/payroll/parity-flags.ts`)

- `DUPLICATE_SUPPLEMENTAL` (block): a bonus, commission, supplemental or taxable reimbursement line with the same type
  and amount as another line on the paycheck, or on the worker's paycheck in either of the two most recent runs on the
  schedule that left draft.
- `RAISE_NOT_APPLIED` (review): a higher pay rate of the same kind, effective after the previous run's period end and on
  or before this period's end, that the paycheck did not use.
- `WITHHOLDING_CHANGED` (review): a `federal_w4` or `state_withholding` submission after the previous run was processed,
  for a worker paid in that run (new hires are `NEW_IN_RUN`).
- `plantParityAnomalyCases()` (`packages/seed/src/w3-parity.ts`) plants one case per rule inside Nov 1 to 15, so the
  open draft keeps its GP2 flags. Tests and demo worlds call it; the default seed does not.

### Autonomy and settings

- `packages/executor/src/policy.ts`: recommend turns every R2 to R4 write into an Inbox suggestion (reads and R1 run);
  approve is unchanged; auto (only with `agent.allow_auto_autonomy` on and only untainted) executes an R2 command that
  declares `autoEligible` when its amount is at or under that limits row, keeps R3 autoAllow, and never runs R4. No
  amount, no limit, a pending call earlier in the batch, the setting off or a tainted run all fall back to approve.
  Ceilings refuse first. Humans, MCP and approved proposals ignore autonomy.
- `GET /v1/settings/agent` and `PUT` (ui_only, admin only, audited). Both settings default off. Settings > Agent has
  both switches; the routine page has a Recommend / Approve / Auto control (Auto disabled until Settings allows it).

### Seed (`packages/seed/src/w3-parity.ts`, step `w3_parity`)

- Every other active person gets a synthetic `birth_month_day` (`MM-DD`).
- Contractor forms: Ines and Arjun have a W-8BEN in effect through 2028-12-31; Claire's W-8BEN is superseded (she now
  works through her own company), so the Monday routine asks her for a W-8BEN or W-8BEN-E.
- No wave 1 or wave 2 count changes: only new tables and a new column are written.

## How to run it

- Unit and scenario tests: `pnpm vitest run packages/routines/test/wave3 packages/executor/test/autonomy.test.ts tests/scenarios/gp16-*.test.ts`.
- E2E: `WEFT_E2E_WEB_PORT=4630 WEFT_E2E_API_PORT=4631 pnpm e2e e2e/gp16-routines.spec.ts` (Settings switches, the
  autonomy change through the Inbox, the gallery, and an escalated notice in the Compliance drawer).
- In the app: Routines > open a routine > Run now (all are disabled, so they only run when triggered); Settings >
  Agent for the two switches; Compliance > Notices for an escalated notice.

## Real versus simulated

- Everything is simulated. Emails (exec report, tax form requests, check-ins, nudges, manager summaries, the specialist
  hand-off) go to the email simulator and appear at `/v1/sim/email`; chat posts go to the chat simulator. The tax
  specialist is a simulated principal (`sim_tax_specialist`), not a person.
- Birthdays are synthetic month and day values; there are no birth years anywhere.
- The live model is never required: every routine has a scripted scenario, and the model only passes derived
  arguments. Live spend for this track: $0.

## Tests

- `packages/routines/test/wave3/parity.test.ts`: definitions (disabled, at most 8 tools, registered precheck, known
  predicates, valid cron, scenario scripts only its own tools, no dashes in copy), each precheck's skip and derived
  arguments, each predicate's done, pending, denied and refused cases.
- `packages/executor/test/autonomy.test.ts`: policy snapshot per level and every fallback.
- `tests/scenarios/gp16-anomalies.test.ts`, `gp16-routines.test.ts`, `gp16-autonomy.test.ts` (round 1).
- `tests/scenarios/gp16-contractor-forms.test.ts`: lapse rule, seeded states, a Monday run that emails missing,
  expired and lapsing forms only, and a week later does not re-ask the lapsing one.
- `tests/scenarios/gp16-checkin.test.ts`: day 30 send, outside-window skip, one nudge three days after sending,
  submission summary without numbers or written words, double submit refused, agents cannot submit.
- `tests/scenarios/gp16-escalation.test.ts`: missing-filing notice escalated with its evidence pack and the specialist
  email; closed and unknown notices refused.
- `e2e/gp16-routines.spec.ts`: two tests on ports 4630 and 4631.

## Contract changes

- `packages/executor/src/pipeline.ts`, own commit "contract: pipeline passes routine autonomy to policy() and files
  suggestions". Additive: `PolicyFacts.autonomy` (optional) is filled for agent calls in a routine run; a `suggest`
  decision is inserted as a `suggestion` proposal. Every other caller is unchanged.
- PREBUILT id lists in `packages/routines/test/engine.test.ts` and `apps/api/test/routines.test.ts` gained
  `rt_contractor_forms`, `rt_exec_briefing`, `rt_milestones`, `rt_monthly_exec_report`, `rt_new_hire_ready` and
  `rt_thirty_day_checkin`. Other tracks touch the same two lines; merge by taking the sorted union.
- `W3_ROUTINES_TID` (this track's block) gained `autonomyLevel`, `autonomyStatus`, `settingsAgent`,
  `settingChatCanPropose`, `settingAllowAutoAutonomy` and `noticeEscalation`.
- `GET /v1/routines` rows also carry `lastRun` and `nextRunAt` (a superset of `RoutineDef`).
- New commands not in `W3_PLANNED_COMMANDS`: `onboarding.flag_not_ready` (R1), `reports.exec_figures` (R0),
  `comms.send_exec_report` (R3), `contractors.request_tax_forms` (R3), `onboarding.list_checkins` (R0),
  `onboarding.send_checkins` (R3), `onboarding.submit_checkin` (R1, human only). The integrator may add them to the
  planned table; no test requires it.

## Decisions and deviations

- Exec report numbers: `comms.send_message` grounds only against company facts, so a payroll cost could never pass it.
  The report goes through `comms.send_exec_report`, which builds and grounds the text in code. `reports.query`
  (w3-parity-chat) is not used yet; `reports.exec_figures` computes the same numbers.
- The W-8 lapse date follows the form instructions (December 31 of the third calendar year after signing), not a flat
  three years from signing.
- The check-in nudge counts three days from when it was sent, not from day 30, so a check-in caught up on a Monday is
  not nudged the next day.
- `onboarding.submit_checkin` is human only and callable through `/v1/tools` by a signed-in person until the portal
  form exists; the hire's portal session is the intended caller.
- Escalation keeps the case on `notices.resolution_json` and uses the email simulator as the specialist's inbox; there
  is no tasks table or specialist queue screen.
- Business days skip weekends only; the 2026 holiday calendar belongs to w3-timeoff.
- The task text gave e2e ports 4630 and 4631 and also "4640 to 4659"; docs/wave3.md assigns 4630 and 4631 to this
  track, so e2e ran there.

## Left

- Auto end to end with a real `autoEligible` command: `expenses.decide` (w3-expenses) must declare
  `autoEligible: "agent.expense_auto_cents"` and seed that limits row; then a GP16 scenario where a routine at auto
  approves a clean expense under the cap, proposes one above it, and a tainted run falls back to approve. Only the
  policy level covers it today.
- Approval and override counts from `knowledge/preferences/approvals.md` beside the autonomy control (G8).
- The check-in portal form (four questions for the hire's portal session) and a manager view of submitted answers.
- Contractor form upload in the contractor portal (a new form supersedes the old one) and renewal on entity change.
- Notice precheck branches for `deposit_schedule_change` and `missing_filing` in `rt_agency_notice`, notice upload
  through `uploads`, and a specialist queue view.
- `rt_new_hire_ready` does not read the holiday calendar or Workday-owned start dates.
- Switch the exec report's payroll cost to `reports.query` once w3-parity-chat merges; contractor payouts are not split.
- The demo script could call `plantParityAnomalyCases()` before a Nov 1 to 15 draft step.
