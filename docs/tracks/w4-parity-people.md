# w4-parity-people

Wave 4 track for life events, enrollment windows, carrier filings, the first-month check-in form, the out-this-week
digest line, the first-day message and the portal time-off form (docs/wave4.md, ranks 3, 8, 9, 13, 15 and 16).
Round 1 landed the cut line (life-event windows and the check-in form) plus carrier filings with receipts.

## What landed in round 1

| Area | What it does | Where |
|---|---|---|
| Window rules | One rule per `LifeEventKind`, each 30 days (`LIFE_EVENT_WINDOW_DAYS`) from the event date, with its citation and eCFR source: HIPAA special enrollment (29 CFR 2590.701-6) for marriage, birth, adoption and loss of other coverage; Section 125 change in status (26 CFR 1.125-4(c)) for divorce, a dependent's death and a move | `packages/core/src/life-events/rules.ts` |
| Report | `benefits.report_life_event` (R2, human only): the employee's own record; a future date and a duplicate are refused; an event whose window already closed is recorded as `rejected` with no window; otherwise a `life_event` window opens and `life_event.reported` and `enrollment_window.opened` are emitted | `packages/core/src/commands/w4-people.ts` |
| Elect | `benefits.elect_in_window` (R2, human only, not in the planned table): plan changes in the caller's own open window (one plan per type, a tier for medical, dental and vision, a deferral inside the plan's range for the 401(k)) or no change; closes the window, which stops reminders, and queues one filing per carrier | same |
| Reminders | `benefits.send_window_reminders` (R1, comms edit like the open enrollment nudge): 14, 7 and 2 days before the close, once per date, a missed run sends one email and counts every passed date; nothing is due once the employee chooses. `rt_benefits_window_reminders` (weekday 09:00 PT, disabled) derives the call | `packages/routines/src/wave4/people.ts`, `scenarios/rt_benefits_window_reminders.json` |
| Date sweep | `benefits.close_windows` (R1, system only, svc_scheduler): opens scheduled windows on their date and closes windows past their close date; an unelected life event becomes `expired`. The scheduler runs it only when a window is due | `apps/api/src/routes/life-events.ts` (`sweepEnrollmentWindows`), `apps/api/src/scheduler.ts` (contract) |
| Carrier filings | `benefits.submit_elections` (R3, always a proposal, preview per filing, comms edit) sends queued filings; the same sweep hands each sent filing to the carrier intake simulator and records its deterministic receipt with `benefits.record_carrier_receipt` (R1, system only), emitting `carrier.submission_confirmed`. `rt_life_event_window` (on `enrollment_window.closed`, disabled) proposes the filing. `benefits.list_carrier_submissions` (R0) | `packages/sim/src/carriers/index.ts`, `scenarios/rt_life_event_window.json` |
| Check-in form | `onboarding.submit_checkin_form` (R1, human only, not in the planned table): validates the wave 4 `CheckinAnswers` on the caller's own open check-in (someone else's reads as unknown), stores them with `form: "w4"` and emails the manager the scale in words and the two yes or no answers, never a number or the written words | `packages/core/src/life-events/checkin-form.ts` |
| Manager view | `GET /v1/checkins`: the caller's direct reports only (by `workers.manager_id`), with the written answers for that manager; anyone else gets an empty list. Wave 3 answers read back too | `apps/api/src/routes/life-events.ts` |
| Routes | `GET /v1/life-events`, `/v1/enrollment-windows`, `/v1/carrier-submissions`; `POST /v1/portal/life-events`; `GET /v1/portal/checkins`; `POST /v1/portal/checkins/:id/submit`; `GET /v1/checkins`; plus two portal routes not yet in the table (below) | same |
| Portal | Life events and benefits (report, the window with its rule, elections or no change) and the first-month check-in form, below the wave 3 sections | `apps/web/src/components/portal/w4-people.tsx` |

The employee's note on a life event is stored and never returned by a list an agent reads, never put in an email or a
reminder, and never in a precheck's findings (tests pin it).

## Tests

- `apps/api/test/life-events.test.ts`: the window length and source, refusals, rejected late reports, reminders once
  per date and none after electing, the sweep, the check-in form validation, own check-in only, the manager's email
  and the direct-reports-only view.
- `tests/scenarios/w4-benefits-window-reminders.test.ts` and `tests/scenarios/w4-life-event-filing.test.ts`: the two
  routines on the scripted provider, the proposal, approval, and the receipt on the next tick.
- `e2e/gp20-people-life-events.spec.ts` (provisional number): the portal report, election and check-in form. Run
  with `WEFT_E2E_WEB_PORT=4846 WEFT_E2E_API_PORT=4847 pnpm e2e gp20-people`. GP7 and GP13 portal specs still pass.

## Decisions and deviations

- `benefits.report_life_event` is R2 with approval `always`, not the planned `never`: a human caller executes either
  way (`policy.ts`), and the t2 registry rule (`apps/api/test/offers.test.ts`) asks every R2 command in `benefits.`
  for approval. The same holds for `benefits.elect_in_window`.
- The employee's own submissions need `people: view` (like `time_off.submit`), so any employee with a worker record
  can file, including the manager principal, who has no benefits grant.
- `benefits.send_window_reminders` and `benefits.submit_elections` run in the `comms` domain (edit), like
  `benefits.nudge_open_enrollment`: the agent's seeded grants give benefits view only, and both send outside Weft.
- Two commands are not in `W4_PLANNED_COMMANDS`: `benefits.elect_in_window` (R2, human only) and
  `onboarding.submit_checkin_form` (R1, human only). The wave 3 `onboarding.submit_checkin` keeps the four wave 3
  questions; the portal form uses the wave 4 `CHECKIN_QUESTIONS`.
- The reminders routine is `rt_benefits_window_reminders`; `rt_life_event_window` is the filing on window close.
- No seed change this round (it would refresh the eval world digests through w4-eval-suite).

## Contract commits on this branch (all `contract: ...`)

1. `packages/core/src/index.ts` exports `lifeEvents` (the read surface for the API).
2. `packages/executor/src/system.ts`: svc_scheduler may run `benefits.close_windows` and `benefits.record_carrier_receipt`;
   `apps/api/src/scheduler.ts` runs `sweepEnrollmentWindows` after the time-off year end.
3. `apps/api/test/offers.test.ts`: samples for the new required inputs.
4. `packages/routines/test/engine.test.ts`, `apps/api/test/routines.test.ts`: the two new prebuilt ids (sorted union).
5. `apps/web/src/components/portal/w3-sections.tsx` renders `PortalW4People`.
6. `packages/sim/src/index.ts` exports the carrier intake simulator.

Requested, not done (see `.scratch/contract-requests/w4-parity-people.md`): route table rows for
`GET /v1/portal/life-events` and `POST /v1/portal/enrollment-windows/:id/elections` (served now, UI sessions only,
checked in the handler), the planned table rows for the two extra commands, the digest line, and the Ready Check
holiday fix.

What is left is in `.scratch/w4-parity-people/left.md`.
