# w4-parity-people

Wave 4 track for life events, enrollment windows, carrier filings, open enrollment, the first-month check-in form, the
out-this-week digest line, the first-day message and the portal time-off form (docs/wave4.md, ranks 3, 8, 9, 13, 15
and 16). Round 1 landed the cut line (life-event windows and the check-in form) plus carrier filings with receipts.
Round 2 landed open enrollment with real dates, the out-this-week line, the first-day message, the portal Request time
off form and the helpers behind the two routine contract requests.

## What landed

| Area | What it does | Where |
|---|---|---|
| Window rules | One rule per `LifeEventKind`, each 30 days (`LIFE_EVENT_WINDOW_DAYS`) from the event date, with its citation and eCFR source: HIPAA special enrollment (29 CFR 2590.701-6) for marriage, birth, adoption and loss of other coverage; Section 125 change in status (26 CFR 1.125-4(c)) for divorce, a dependent's death and a move | `packages/core/src/life-events/rules.ts` |
| Report | `benefits.report_life_event` (R2, human only): the employee's own record; a future date and a duplicate are refused; an event whose window already closed is recorded as `rejected` with no window; otherwise a `life_event` window opens and `life_event.reported` and `enrollment_window.opened` are emitted | `packages/core/src/commands/w4-people.ts` |
| Elect | `benefits.elect_in_window` (R2, human only, not in the planned table): plan changes in the caller's own open window (one plan per type, a tier for medical, dental and vision, a deferral inside the plan's range for the 401(k)) or no change; closes the window, which stops reminders, and queues one filing per carrier | same |
| Reminders | `benefits.send_window_reminders` (R1, comms edit like the open enrollment nudge): 14, 7 and 2 days before the close, once per date, a missed run sends one email and counts every passed date; nothing is due once the employee chooses. `rt_benefits_window_reminders` (weekday 09:00 PT, disabled) derives the call | `packages/routines/src/wave4/people.ts`, `scenarios/rt_benefits_window_reminders.json` |
| Date sweep | `benefits.close_windows` (R1, system only, svc_scheduler): opens scheduled windows on their date and closes windows past their close date; an unelected life event becomes `expired`. The scheduler runs it only when a window is due | `apps/api/src/routes/life-events.ts` (`sweepEnrollmentWindows`), `apps/api/src/scheduler.ts` (contract) |
| Carrier filings | `benefits.submit_elections` (R3, always a proposal, preview per filing, comms edit) sends queued filings; the same sweep hands each sent filing to the carrier intake simulator and records its deterministic receipt with `benefits.record_carrier_receipt` (R1, system only), emitting `carrier.submission_confirmed`. `rt_life_event_window` (on `enrollment_window.closed`, disabled) proposes the filing. `benefits.list_carrier_submissions` (R0) | `packages/sim/src/carriers/index.ts`, `scenarios/rt_life_event_window.json` |
| Open enrollment | `benefits.open_window` (R1, benefits edit): one company `open_enrollment` window with real open and close dates (close on or after open and not in the past, at most 60 days, one live at a time; the plan year is the year after the close). It is `scheduled` until its open date; the sweep opens it (adding a `not_started` row for any eligible employee without one) and, the day after the close date, closes it and records everyone still `not_started` or `in_progress` as `waived`, listed by name in the result. `openEnrollmentDates` gives the live window's dates, or the wave 2 constants when there is none | `packages/core/src/life-events/open-enrollment.ts` |
| Check-in form | `onboarding.submit_checkin_form` (R1, human only, not in the planned table): validates the wave 4 `CheckinAnswers` on the caller's own open check-in (someone else's reads as unknown), stores them with `form: "w4"` and emails the manager the scale in words and the two yes or no answers, never a number or the written words | `packages/core/src/life-events/checkin-form.ts` |
| Manager view | `GET /v1/checkins`: the caller's direct reports only (by `workers.manager_id`), with the written answers for that manager; anyone else gets an empty list. Wave 3 answers read back too | `apps/api/src/routes/life-events.ts` |
| Out this week | `people.out_this_week` (R0): approved and taken requests (the ledger's holds) on working days of Monday to Sunday of `as_of`, one row per person with the days (`Mon to Wed`, `part of Fri`) and a ready line, `Out this week: Name (demo) (Wed to Thu).` Names and days only, never the kind of leave or the reason. `outThisWeekLine` reads it for the Monday digest (contract request 3) | `packages/core/src/life-events/people-week.ts`, `packages/routines/src/wave4/people.ts` |
| First day | `onboarding.list_first_days` (R0, not in the planned table) lists hires whose start date is today; `comms.send_first_day_message` (R3, approval always, autoAllow untainted like the check-in emails) emails the hire a templated welcome and the manager and up to eight teammates a note, then emits `worker.first_day`. A hire with that event, or not starting today, is skipped, so it goes out once per hire. `rt_first_day_message` (daily 08:00 PT, disabled) derives the call | same, `scenarios/rt_first_day_message.json` |
| Ready Check holidays | `addWorkingDays(from, n, holidays)` skips weekends and company holidays; the Ready Check calls it in contract request 4 | `packages/core/src/life-events/business-days.ts` |
| Routes | `GET /v1/life-events`, `/v1/enrollment-windows`, `/v1/carrier-submissions`; `POST /v1/portal/life-events`; `GET /v1/portal/checkins`; `POST /v1/portal/checkins/:id/submit`; `GET /v1/checkins`; plus four portal routes not yet in the table (below) | `apps/api/src/routes/life-events.ts` |
| Portal | Life events and benefits (report, the window with its rule, elections or no change), the first-month check-in form, and Request time off (balances, a request on a policy with dates and a note, the hire's own requests with their status). A hire after the seed sees the policies their state calls for until the first request assigns them | `apps/web/src/components/portal/w4-people.tsx` |

The employee's note on a life event is stored and never returned by a list an agent reads, never put in an email or a
reminder, and never in a precheck's findings (tests pin it). The time-off reason never reaches the out-this-week line.

## Tests

- `apps/api/test/life-events.test.ts`: the window length and source, refusals, rejected late reports, reminders once
  per date and none after electing, the sweep, the check-in form validation, own check-in only, the manager's email
  and the direct-reports-only view.
- `apps/api/test/people-week.test.ts`: the portal time-off form files for the caller's own worker only (an extra
  `workerId` is a 400, the HR route a 403), the out-this-week line after approval (names and days, no reason or leave
  kind, gone next week), the first-day message once per hire on the start date, and open enrollment opening and
  closing on its dates with the stragglers waived.
- `tests/scenarios/w4-benefits-window-reminders.test.ts`, `tests/scenarios/w4-life-event-filing.test.ts` and
  `tests/scenarios/w4-first-day-message.test.ts`: the three routines on the scripted provider (the first-day run
  sends with no proposal because it is untainted, and a second run that day skips), plus the two helpers.
- `e2e/gp20-people-life-events.spec.ts` (provisional number): the portal report, election, check-in form and a day
  off through the Request time off form. Run with
  `WEFT_E2E_WEB_PORT=4846 WEFT_E2E_API_PORT=4847 pnpm e2e gp20-people`. The round 2 run passed it together with
  GP6, GP7, GP9, GP13 and GP14 (8 specs); the full `pnpm test` passed 923 tests with 1 skipped.

## Decisions and deviations

- `benefits.report_life_event` is R2 with approval `always`, not the planned `never`: a human caller executes either
  way (`policy.ts`), and the t2 registry rule (`apps/api/test/offers.test.ts`) asks every R2 command in `benefits.`
  for approval. The same holds for `benefits.elect_in_window`.
- The employee's own submissions need `people: view` (like `time_off.submit`), so any employee with a worker record
  can file, including the manager principal, who has no benefits grant.
- `benefits.send_window_reminders`, `benefits.submit_elections` and `comms.send_first_day_message` run in the `comms`
  domain (edit): the agent's seeded grants give benefits view only, and all three send outside Weft.
- Three commands are not in `W4_PLANNED_COMMANDS`: `benefits.elect_in_window` (R2, human only),
  `onboarding.submit_checkin_form` (R1, human only) and `onboarding.list_first_days` (R0, the first-day precheck's
  read). The wave 3 `onboarding.submit_checkin` keeps the four wave 3 questions.
- Open enrollment is one company window, not one per person: the per-person state stays in the wave 2
  `open_enrollment` rows. A straggler at the close is recorded as `waived`, the active enrollment default; the enum
  has no other closed state.
- The first-day message is Weft's template (names, the date, the manager), so no model writes it and autoAllow
  untainted applies; "once per hire" is the `worker.first_day` event, checked before sending.
- The digest line and the Ready Check holiday fix are contract requests (wave 2 and wave 3 files), with the helpers
  they call landed and tested here.
- No seed change (it would refresh the eval world digests through w4-eval-suite), so GP9, GP11 and GP14 are unchanged.

## Contract commits on this branch (all `contract: ...`)

1. `packages/core/src/index.ts` exports `lifeEvents` (the read surface for the API).
2. `packages/executor/src/system.ts`: svc_scheduler may run `benefits.close_windows` and `benefits.record_carrier_receipt`;
   `apps/api/src/scheduler.ts` runs `sweepEnrollmentWindows` after the time-off year end.
3. `apps/api/test/offers.test.ts`: samples for the new required inputs (round 1 and round 2).
4. `packages/routines/test/engine.test.ts`, `apps/api/test/routines.test.ts`: the three new prebuilt ids (sorted union).
5. `apps/web/src/components/portal/w3-sections.tsx` renders `PortalW4People`.
6. `packages/sim/src/index.ts` exports the carrier intake simulator.

Requested, not done (see `.scratch/contract-requests/w4-parity-people.md`): route table rows for the four portal
routes (served now, UI sessions only, checked in the handler), the planned table rows for the three extra commands,
the digest line, the Ready Check holiday calendar, the wave 2 open enrollment chase reading the window's dates, and
the Benefits page windows tab wiring.

What is left is in `.scratch/w4-parity-people/left.md`: chiefly the Benefits page windows tab, the seed step and the
wiring the contract requests describe.

Live model spend: $0 in both rounds (scripted provider only); nothing was added to the wave ledger, and no Phoenix was
started.
