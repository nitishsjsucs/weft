# Track w4-parity-compliance

Recurring filings, the compliance calendar, notices beyond rate changes, hand-offs to a person, and (round 2) notice
upload and required training. Parity rows T2, S2, R12, T3, T4, G11 and T11 in `research/wave3/agent-parity.md`.

## Round 1: what landed

| Area | Where | What |
|---|---|---|
| Filing rule table | `packages/core/src/compliance/rules.ts` | One row per `FilingForm` with agency, cadence, due rule and an agency source URL; due dates computed in code (last day of the month after the quarter, January 31 after the year, weekends roll to Monday); monthly deposit dates (the 15th of the next month, IRS Publication 15) |
| Preparation | `packages/core/src/compliance/prepare.ts` | Form 941 (lines 1 to 16), CA DE 9 and DE 9C, NY NYS-45, TX C-3, CO UITR-1 from the paychecks of processed runs paid in the quarter; Form 940, W-2 and W-3 and 1099-NEC from the YTD ledger. Integer cents throughout; line 7 carries the fractions of cents adjustment |
| Calendar | `packages/core/src/compliance/calendar.ts` | Rows for filings, federal deposits, notice reply deadlines, training assignments and contractor tax forms; status recomputed from the date on read (due soon within `COMPLIANCE_DUE_SOON_DAYS`, overdue after) |
| Hand-offs | `packages/core/src/compliance/handoffs.ts` | One table for tax specialist, HR person and vendor specialist cases with a reason code and an evidence pack; a notice subject reuses the wave 3 pack, turns escalated and emails the simulated specialist; one open case per subject |
| Commands | `packages/core/src/commands/w4-compliance.ts` | `compliance.calendar` (R0), `compliance.refresh_calendar` (system R1), `compliance.post_reminders` (R3, text written in code), `tax.list_filings`, `tax.get_filing` (R0), `tax.prepare_filing` (R1), `tax.file_return` (R4, always, preview, not reversible), `handoffs.list` (R0), `handoffs.open` (R1), `handoffs.resolve` (human only), `tax.set_deposit_schedule` (R2, checked against the notice), `notices.acknowledge` (R1, informational kinds only) |
| Handlers | `packages/core/src/compliance/handlers.ts` | Refresh on `payroll.processed`, `filing.filed`, `notice.resolved`, `handoff.opened` and on `clock.advanced` when it crosses a PT date (the daily tick) |
| Routines | `packages/routines/src/wave4/compliance.ts` | `rt_compliance_reminders` (weekdays 08:00 PT, disabled) and `rt_compliance_notices` (on `notice.received`, disabled), with prechecks and the `reminders_posted` and `notice_handled` predicates |
| Notice plans | `packages/contracts/src/ext/w4-parity-compliance.ts` | `planNotice()` maps `NOTICE_HANDLING` plus the filing on record to a plan, shared by the precheck and the scripted variant chooser |
| Seed | `packages/seed/src/w4-compliance.ts` | Filing rows for 2026-Q3, 2026-Q4 and 2026 for every active account (13 rows, none for Colorado until it registers) and the calendar built from them; nothing prepared or filed |
| API | `apps/api/src/routes/{compliance,handoffs}.ts` | `GET /v1/compliance/calendar`, `GET /v1/filings`, `GET /v1/filings/:id`, `POST /v1/filings/:id/prepare`, `POST /v1/filings/:id/file` (files a pending proposal through `human.propose`), `GET /v1/handoffs`, `GET /v1/handoffs/:id`, `POST /v1/handoffs/:id/resolve` |
| Web | `apps/web/src/components/app/compliance/w4-calendar.tsx` | Calendar, Filings (with the prepared return drawer) and Hand-offs tabs on Taxes & Compliance; `?tab=calendar` deep link |
| Scripts | `scenarios/rt_compliance_*.json` | One script per notice plan plus the reminder script |

### Notice kinds and their handling

| Kind | `NOTICE_HANDLING` | Plan | What the routine leaves |
|---|---|---|---|
| rate_change | update_rate | (rt_agency_notice) | skipped here |
| missing_filing | attach_filing | `attach_filing` when the return is filed, `file_return` when it is on record but not filed, `escalate` when there is none | reply citing the confirmation, or prepare plus an R4 `tax.file_return` proposal plus the reply proposal, or a hand-off |
| deposit_schedule_change | update_deposit_schedule | `update_deposit_schedule` | an R2 `tax.set_deposit_schedule` proposal with the notice's schedule and date |
| late_deposit_penalty | pay_penalty_or_abate | `pay_penalty_or_abate` | an abatement reply proposal and a tax specialist hand-off for the payment decision |
| futa_credit_reduction, registration_confirmed | acknowledge | `acknowledge` | the notice resolved as acknowledged |
| benefit_charge | escalate | `escalate` | a tax specialist hand-off with the evidence pack |
| anything else | none | `escalate` (reason `unknown_notice_kind`) | a tax specialist hand-off with the evidence pack |
| an uploaded notice read with confidence below 0.9 | any | `escalate` (reason `low_confidence_extract`) | round 2 (upload) |

### Hand-checked totals (2026-Q3, from the ledger rows of pay_2026_09_15 and pay_2026_09_30)

Form 941: line 2 $439,407.62, line 3 $56,343.26, line 5a $56,878.79 (Social Security wages $458,699.92 at 12.4%),
line 5c $13,302.30, line 6 $126,524.35, line 7 minus $0.13 (per-paycheck rounding), line 10 $126,524.22, deposits
$126,524.22, balance due $0.00. CA DE 9C: 19 employees, subject wages $239,845.32, PIT withheld $14,142.50, SDI
$3,118.04, UI and ETT $0.00 (the $7,000 base was met before September). Pinned in `apps/api/test/compliance.test.ts`.

The 941 for 2026-Q3 covers only the two Weft runs: pay before 2026-09-01 ran through the previous provider and the YTD
import holds it as one year-to-date total, so the coverage note says to reconcile July and August before filing.

## Round 2: notice upload and required training

### Notice upload (T4)

- `POST /v1/notices/upload` takes a multipart `file` (stored like receipts as `uploads/<sha256>.bin`) or JSON
  `NoticeUploadBody` naming an upload already made. `notices.upload` (human only) stores the upload row (purpose
  `agency_notice`) and a placeholder notice with `source = 'upload'` and `upload_id`, and emits `notice.uploaded`.
- The svc_events handler on `notice.uploaded` runs `notices.ingest_upload` before any routine sees the event. It looks
  up the sidecar JSON for the uploaded bytes by sha256 in `packages/sim/src/notices/mailed/` (no OCR, no model call),
  stores the kind, form, dates, amount and a confidence (kept beside the shared `NoticeExtract` fields, which the
  parser schema strips), and matches the tax account by number.
- In code, before any run: an unrecognized file (`low_confidence_extract`), a confidence under 0.9
  (`low_confidence_extract`) or a kind outside `NOTICE_HANDLING` (`unknown_notice_kind`) opens a tax specialist
  hand-off with the evidence pack (which includes the uploaded file) and shows under Hand-offs and `/v1/handoffs`.
- `rt_compliance_uploads` (on `notice.uploaded`, disabled) is marked tainted (`taintedBy: "notice_upload"`), so the
  executor starts every run tainted: no auto-allow, R3 and R4 always proposals, memory and routine drafts refused.
  `planNotice()` with `source: "upload"` also sends rate changes and informational kinds to a person, and
  `notices.acknowledge` refuses an agent for an uploaded notice, so an upload never closes or changes a record
  without a person. Tested with an injection upload: the only executed calls are the draft (with `tainted_by`) and
  the hand-off; the reply waits as a proposal.
- Six mailed samples with sidecars: late deposit penalty, a penalty carrying an injection, FUTA credit reduction,
  benefit charge, an unknown kind (third party designee) and a smudged scan (confidence 0.58). They also deliver the
  notice kinds the simulator has no scenario for, so the demo needs no hand-inserted rows. The Notices tab has an
  upload form.

### Required training (T11)

| Course | Rule | Source |
|---|---|---|
| California, supervisors | 2 hours within six months of hire or promotion, then every two years | Gov. Code 12950.1 |
| California, staff | 1 hour within six months of hire, then every two years | Gov. Code 12950.1 |
| New York | interactive training every year; 30 days for new hires is Weft's default | Labor Law 201-g |
| Illinois | at least once a year; 30 days for new hires is Weft's default | 775 ILCS 5/2-109 |

- Rules live in `packages/core/src/compliance/training.ts`; a supervisor is anyone with a direct report. Status is
  computed when read: an open assignment past its due date is overdue.
- `training.list_assignments` (R0) also returns `needs_assignment` (a new hire, or a completed cycle coming due within
  30 days). `training.assign` and `training.send_reminders` are R3 and always approved (they email the person);
  `training.complete` is human only (the person or an admin) and stores a certificate upload, or the completion
  certificate Weft issues when none is uploaded.
- `rt_compliance_training` (weekdays 07:30 PT, disabled) proposes assignments and reminders from the precheck's
  derived arguments; scripts `scenarios/rt_compliance_training.<assign|remind|both>.json`.
- Routes: `GET /v1/training/courses`, `GET /v1/training/assignments`, `POST /v1/training/assignments/:id/complete`,
  `GET /v1/portal/training` (the caller's own) and `POST /v1/portal/training/:id/complete`. Screens: the Training tab
  on Taxes & Compliance and the portal section `W4TrainingSection` in `apps/web/src/components/portal/w4-training.tsx`.
- The seed adds the four courses and one assignment per required course for every active employee in CA, NY or IL:
  recent hires due from the start date, every fifth due in 10 days, every seventh from the fourth overdue by a week,
  the rest completed. The calendar shows them as training rows.

## Decisions

- `tax.file_return` has `needs: "edit"` so the agent can propose it; approval is always, R4, never auto-allowed, and the
  route files a person's request as a proposal too (`human.propose`), so nothing files without an approval.
- Filing goes to the agency simulator by writing a `sim_agency_mail` row of kind `return_filing` with a confirmation
  (`IRS-F-0001`), after resolving the portal credential in memory. `AgencySim` has no `fileReturn` (contract request 3).
- Both routines ship disabled. Enabling `rt_compliance_notices` by default would act on the GP16 missing-filing notice
  before the test escalates it by hand.
- `compliance.post_reminders` writes the message in code because `comms.send_message` grounding refuses form numbers
  and dates that are not company facts.
- `notices.upload` is approval `always` where the planned table says `never`: harness 5.4 (the t2 registry rule)
  requires approval for every R2 `notices.*` command. It is human only, so a person's upload still executes directly.
- An uploaded informational notice (FUTA credit reduction) becomes a hand-off for a person to confirm rather than an
  agent acknowledgment, because its kind came from untrusted bytes.
- New-hire due dates for New York and Illinois (30 days) are Weft's defaults; the statutes set annual training only.
- The 1099-NEC threshold is $2,000 for payments made in 2026 (`NEC_THRESHOLD_CENTS`); confirm it each year.

## Contract requests for the integrator

1. Landed in commit `contract: ...`: `compliance.refresh_calendar` and `notices.ingest_upload` on the svc_events
   allowlist (`packages/executor/src/system.ts`), and the wave 4 samples in the t2 registry test
   (`apps/api/test/offers.test.ts`).
2. Wire `complianceNoticeVariant(db)` (`packages/core/src/compliance/script-variant.ts`) into
   `apps/api/src/compose.ts` `scriptVariant` (try it before the injection variant returns null), so the scripted
   provider picks `rt_compliance_notices.<plan>` in dev and the demo. Tests construct the provider with it today.
3. `AgencySim.fileReturn` in `packages/contracts/src/sim.ts`, with fault injection on `agency.<code>.fileReturn`;
   `tax.file_return` would then call it instead of writing the simulator's table.
4. Add `tax.set_deposit_schedule`, `notices.acknowledge` and `compliance.post_reminders` to `W4_PLANNED_COMMANDS`.
5. Mount `HandoffsPanel` from `apps/web/src/components/app/compliance/w4-calendar.tsx` in the Inbox (the screen is not
   this track's), and add the response types to `apps/web/src/lib/api/client.ts` `Responses`.
6. Decide whether `rt_compliance_notices` stays a separate routine or `rt_agency_notice` routes its non-rate kinds to
   the `compliance_notices` precheck; either way the scripts are ready.
7. The seed adds 13 filing rows and the calendar: the w4-eval-suite world digests need a refresh.
8. A scheduler daily tick (`svc_scheduler` running `compliance.refresh_calendar` once per PT day) in live mode, where
   the clock moves without `clock.advanced`.
9. Mount `W4TrainingSection` (`apps/web/src/components/portal/w4-training.tsx`) in the portal page, and add
   `rt_compliance_uploads` and `rt_compliance_training` to `complianceNoticeVariant`'s caller in compose (one chooser
   covers all three; it now takes the sim clock as a second argument).
10. Landed in commit `contract: ...`: the two new routine ids in the pinned prebuilt routine lists and the
    `notices.ingest_upload` sample in the t2 registry test.
11. The seed now also adds four training courses and the assignments: refresh the eval world digests with item 7.

## Tests

`apps/api/test/compliance.test.ts` (rules, planned risk and access, the seeded calendar, the hand-checked 941 and DE
9C, NYS-45, the annual returns, the R4 proposal through the UI and from an agent run, approval to filed, refusals,
hand-offs) and `tests/scenarios/w4-compliance-notices.test.ts` (every seeded notice kind, an unknown kind, the reminder
routine) and `tests/scenarios/w4-compliance-uploads-training.test.ts` (sidecar validation, unknown kind and
low-confidence hand-offs, duplicate upload, the tainted injection run, the informational upload, courses with
sources, seeded statuses and calendar rows, completion with a certificate, the portal scope, and the training
routine for a new California hire). E2E: `e2e/gp20-compliance-calendar.spec.ts` (the integrator may renumber it):
the 941 through the Inbox, and an uploaded unknown notice reaching Hand-offs plus completion on the Training tab.
