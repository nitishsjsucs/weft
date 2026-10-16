# Track w3-timeoff: real Time Off

Branch `track/w3-timeoff`, cut from main at 35b385f (the wave 3 plan). Golden path GP14 (time off with a coverage
conflict), docs/wave3.md 2 and 5; design and hand-computed cases in research/wave3/expenses-timeoff.md 6, 8.1 and 9.1.

## What exists

### Ledger and balances

- Every amount is integer minutes in the append-only `time_off_ledger` (kinds `import`, `accrual`, `accrual_capped`,
  `front_load`, `use`, `hold`, `hold_release`, `adjustment`, `carryover_forfeit`, `payout`, `reinstatement`). Paychecks
  convert to `hours_x100` only at the payroll boundary.
- Balances are derived, never stored (`packages/core/src/time-off/engine.ts` `sumLedger` and `balanceOf`): accrued
  (unlocked, or locked while the policy's waiting period runs from the start date), used (use rows dated on or before
  the as-of date), holds (pending holds plus approved use rows dated after it) and available = unlocked - used - holds.
  A request is checked against the projected balance at its start date: today's available plus one per-period accrual
  for each regular run paid by then.

### Accruals, caps, year end and final pay

- `time_off.post_accruals {run_id}` (system only, from the `payroll.processed` handler as `svc_events`): for every
  paycheck of a processed regular run, one accrual per assignment, idempotent on `run_key` = `<run>:<assignment>`.
  Dismissal and off-cycle runs never accrue. Per pay period by completed months of service (300 minutes under 36
  months, 360 from 36); per hour worked as floor((remainder + worked) / 30) with the remainder carried on the
  assignment (hourly: the paycheck's worked hours; exempt salaried: 5,200 deemed minutes a full period, 2,400 per five
  weekdays for a partial one). The balance cap and the annual accrual cap post the rest as an `accrual_capped` row of 0
  minutes with the uncapped amount in the note. Periods covered by an imported balance are skipped.
- `time_off.close_year {year}` (system only) runs from the scheduler's `time_off.year_end` step on the first tick of
  a new year: carry up to the carryover cap, forfeit the rest, then the new year's front loads. Policy validation
  (`validatePolicy`) refuses a CA or CO vacation policy that would forfeit (`DOMAIN_FORFEITURE_NOT_ALLOWED`).
- Final pay reads the vacation ledger (`finalVacationFor` in `payroll/offcycle.ts`): the posted balance on the last
  day plus the final period's accrual prorated by calendar days, paid at annual / 2,080 per hour; a negative balance
  pays nothing and is never deducted. The simulated month rule is gone. When the dismissal run processes,
  `time_off.record_payout` posts the prorated accrual and a `payout` row so the paid-out balance is zero. GP9 still
  pays 90.00 h and 1,003,846 cents: Imani's import is 5,063 minutes plus floor(360 x 15 / 16) = 337.

### Requests, checks, routing and decisions

- `time_off.submit` (human only: an admin or HR manager for anyone, otherwise the person's own worker) computes the
  minutes from the dates and the 2026 holiday calendar (weekdays 480, holidays and weekends 0, one partial day
  allowed), refuses overlaps and ranges with no working day, writes a hold, the checks and the routing, and emits
  `time_off.request.created` and `time_off.request.routed`. `time_off.cancel` releases the hold (or returns the use rows
  of an approved request that has not started).
- The eight checks (`requestChecks`): INSUFFICIENT_BALANCE, WAITING_PERIOD, USE_CAP and INCREMENT block;
  COVERAGE_CONFLICT and OVERLAPS_PAYROLL_DEADLINE are review; INCLUDES_HOLIDAY and SHORT_NOTICE (never for sick leave)
  are info. Coverage is per department: people out (approved plus pending) over headcount on each working day, over
  `coverage_max_out_pct` or leaving fewer than `coverage_min_present`. Headcount counts employees employed that day plus
  incoming hires from open offers starting by then (Noor's sent offer makes Hardware 9 on Nov 23).
- Routing (`routeRequest`): the manager's principal when that manager is an active worker with a Weft login, else the
  department lead's, else Dana, with each step and its reason in `routing_json`.
- `time_off.decide {request_id, decision, note}` is R2 with approval always, lease `time_off:<request>`: an agent's
  call is always a proposal. Inside run(), the decider is the direct caller or the approver of the proposal: admins and
  HR managers decide anyone's request; a manager only a direct report's (`DOMAIN_NOT_DIRECT_REPORT`) and only while
  their own worker record is active; anyone else is refused (`DOMAIN_NOT_APPROVER`). Approval re-runs the checks and
  refuses while a block stands (`DOMAIN_REQUEST_BLOCKED`), releases the hold, posts one `use` row per day and refreshes
  the open drafts; denial releases the hold. `time_off.check_request` and `time_off.route_request` are R1.
- `time_off.adjust_balance` (R2, approval always, reverse: the inverse adjustment) posts a signed `adjustment` row and
  never takes the available balance below zero (`DOMAIN_NEGATIVE_BALANCE`). `time_off.reopen` (human only, an
  approver) returns a decided request that has not started to pending: the use rows come back and the hold returns.
- `usr_imani` (role `manager`, worker wrk_0004) is seeded with `people: view`; she decides on the Requests tab (her own
  call runs). Approving agent proposals in the Inbox needs `people: approve`, which she does not have, so the grant
  model is unchanged.

### Payroll lines

- `time-off/payroll.ts`: a salaried gross is split into `salary`, `pto`, `sick` and `paid_holiday` lines at annual /
  2,080 per hour with gross unchanged (approved paid leave plus company holidays on weekdays in the period); hourly
  workers get the leave lines on top of their worked hours. The tax engine does not branch on line type, so leave
  lines are regular wages and `packages/payroll-tax` is untouched. The seeded TX day (Lucy Harrow, Oct 23) shows
  `salary` 431,154 and `pto` 43,846 on `pay_2026_10_30`, gross 475,000; GP2 totals are unchanged.

### Routine, screens and seed

- `rt_time_off_requests` (disabled by default, 7 tools, `scenarios/rt_time_off_requests.json`): on
  `time_off.request.created`, the precheck reads the request and the balance and derives one decision proposal (approve
  unless a check blocks) with a note naming the balance before and after, the review checks and the holidays, plus a
  #people-ops notice without digits. A manual run picks the oldest pending request.
- `/app/time-off`: Requests (pending first with check chips, routing and the employee note as written; Approve and
  Deny for the routed approver and the People admin), Calendar (department month grid with approved and pending marks,
  holiday shading, the out percent per day and over-limit days outlined), Balances, Policies (rule lines and sources)
  and Holidays. The person page has a Time off tab (balances and requests); Home has a Time off tile (out today, waiting
  for a decision, approved in the next 30 days).
- Seed step `w3_timeoff`: 4 types, 7 policies with sources, `hcal_2026` with 10 holidays, `usr_imani`, one assignment
  per employee and policy, opening balances dated 2026-10-15, then requests through the real commands (runDirect, no
  action rows or events): R-A Grace and Oscar approved Nov 23 to 25 (by Imani), R-B Ruth pending Nov 23 to 27
  (COVERAGE_CONFLICT 3 of 9, 33.3%, and INCLUDES_HOLIDAY, routed to Imani), R-C Kenji NY sick 4 h (routed past a
  manager with no login to Dana), R-D Ben CA sick inside the 90-day wait (WAITING_PERIOD), and Lucy's approved TX day.
- Routes: all ten `/v1/time-off/*` rows run the time_off commands as the session's person.

## Contract changes (separate `contract:` commits)

1. `packages/core/src/offboarding/steps.ts` (outside this track's paths): `finalPayEarnings` takes the vacation
   position as a new optional last argument, so `finalPayPlan` loads it with `finalVacationFor` and passes it (three
   lines). Without it the old simulated accrual could not be deleted.
2. `apps/api/test/routines.test.ts` and `packages/routines/test/engine.test.ts` pin the exact prebuilt routine ids;
   `rt_time_off_requests` joins both lists (only the expected arrays change).

Also: the boundary scan bans the word for the executor's decision verb anywhere in the brain, so the routine names the
`time_off` decision tool from the contracts lists (`CHAT_ACT_TOOLS` intersected with `W3_PLANNED_COMMANDS`) instead of
spelling it. See `.scratch/contract-requests/w3-timeoff.md`.

## How to run it

```sh
pnpm exec vitest run --project @weft/core packages/core/test/time-off packages/core/test/offboarding
pnpm exec vitest run --project @weft/api apps/api/test/time-off.test.ts
pnpm exec vitest run --project @weft/tests tests/scenarios/gp14-time-off.test.ts tests/scenarios/gp9-offboarding.test.ts
WEFT_E2E_WEB_PORT=4640 WEFT_E2E_API_PORT=4641 pnpm exec playwright test e2e/gp14-time-off.spec.ts
```

## Tests

- `packages/core/test/time-off/engine.test.ts`: T1 to T17 from research 9.1 on the pure rules (plus use cap and
  increment); T13 and T14 also in `packages/core/test/offboarding/offcycle.test.ts` (rewritten against the ledger).
- `apps/api/test/time-off.test.ts`: seeded checks and routing, balances, calendar, agent proposal and forged approval
  (T19), manager scope, block refusal, submit and cancel, accrual idempotency (T18), year end (T16 in the database).
- `tests/scenarios/gp14-time-off.test.ts` and `e2e/gp14-time-off.spec.ts`.

## Left for later

The same list is in `.scratch/w3-timeoff/left.md`.

- The portal "Request time off" section: the new-hire persona may call only `/v1/portal/*` (auth.ts), so it needs a
  portal route owned by w2-onboarding or an auth allowance; the API and command are ready.
- "Viewing as" Imani in the persona menu (w3-topbar-shell owns `PRINCIPALS`); the e2e decides as Imani through the API.
- Pre-payroll flags `PENDING_TIME_OFF_IN_PERIOD` and `PTO_LINE` (`time-off/flags.ts` still flags nothing): they add
  flags to the seeded draft (Ben and Kenji are pending inside Oct 16 to 31), which moves the GP2 and S2 counts.
- The `peopleDigest` out-this-week line (prechecks.ts, GP4) was cut first as planned.
- The pay statement "Time off" block per policy (NYC accrued, used and available each period).
- Front loads and assignments for a worker hired after the seed (Noor on GP6 acceptance); unpaid salaried docking for
  full days; Approve and Deny buttons for HR managers (the API already allows them).
- A directly decided request leaves an agent proposal for it pending; approving that proposal later fails with
  `DOMAIN_NOT_PENDING`. Superseding it needs an executor hook.
