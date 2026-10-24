# Track rich-seed: data on every screen

Branch `feat/rich-seed`, cut from main at 8e626f0 and kept current with main. The ask (2026-10-18): "make sure nothing
is empty, I want data everywhere", without moving a test, an e2e run, an eval world digest or a golden number.

## The two profiles

- `WEFT_SEED_PROFILE=base|rich` (`packages/seed/src/profile.ts`). `seedWorldProfile(target, "base")` is exactly
  `seedWorld()`; `"rich"` runs `seedWorld()` and then the rich layer in `packages/seed/src/rich/`.
- `pnpm dev` seeds rich by default (`--profile base` opts out). `pnpm dev --e2e`, `pnpm e2e`, `pnpm test`, `pnpm demo`
  and the eval worlds always use base. `pnpm demo:scenario` resets to the running world's own profile (rich under
  `pnpm dev`; `--profile base` opts out). The seed CLI defaults to base.
- A rich world carries a `seed.profile` settings row (base worlds carry none, so the base digest is unchanged).
  `POST /v1/sim/reset` rebuilds the world with the profile it was seeded with, or the one in `{ profile }`.
- Base digest: unchanged by the rich layer (`950933e7ed6a...10d9` when this track landed; re-pinned on 2026-10-23 to
  `dca6930b3d5e...c6c4` by the clean-workspace copy change), checked by `packages/seed/test/digest-hosted.test.ts` and the
  eval suite's pinned digests. The rich digest is the same on every seed; it is not pinned, so the layer can grow.

## Rules the layer keeps

- Planted proposals take their risk class from the command, and the submit and laptop cards come from the command's
  own preview (`Layer.preview`), so a seeded card reads like the live one for the same call. People posts (weekly
  digest, monthly exec report) run after the turnover and quote `reports.query`.

- It only adds rows. Planted rows are byte-identical to base: the four Weft pay runs and their paychecks, every
  current worker's YTD ledger, the base expenses, time-off requests and ledger, Noor's offer, the NY DOL notice, the
  draft filings and calendar items, action #1, workers `wrk_0001` to `wrk_0051` and the open October reconciliation.
- Ids come from the app's id counters, instants are fixed and before the seed time (Mon Oct 26 2026 8:30 PT), and
  nothing calls a model: agent runs are scripted-provider transcripts at $0.00.
- Names of record carry no suffix, every domain is `*.example`, and documents, mail and notices read as the company's own (2026-10-23: the `(demo)` suffix, the DEMO DOCUMENT line and the SIMULATED notice headers were removed).
- Domain math holds: imported runs equal each worker's YTD import code by code and satisfy the SPEC 7.4 totals
  identities; time off is drawn through ledger `use` rows with a balancing import per policy so caps hold; contractor
  payouts convert at the fixed FX table and land two business days after booking.

## What the layer adds, by part

| File | Adds |
| --- | --- |
| `rich/index.ts` | Agent runs with steps (weekly digests, pre-payroll reviews, the Feb 14 NY DOL notice, chat answers including payroll cost by month and the refused approve-all), routine runs, decided and pending proposals with a hash-chained approval audit, hand-offs, about 200 hash-chained actions with one rollback, time-off history (142 requests; 2 people out on Oct 26), onboarding checklists and DEMO documents, the July leaver and Jonah Pell's open resignation, contractor payouts, filed returns with agency mail, more notices, the 2023 registrations, memory pages with wiki links and 30-plus memory commits |
| `rich/motion.ts` | Offers in draft, viewed, accepted, expired and voided states with outbox mail and background checks; Elias Brandt at 5 of 7; the approvals waiting this week; 18 paid expense claims; Greenhouse deliveries and sync items; the September reconciliation finding; device orders; contractor accounts, tablets and agreements |
| `rich/portal-hires.ts` | Odette Marsh, NY, starts Nov 2, 7 of 7 with a bank account, an approved home office claim from the portal and the NY harassment prevention course; Tobias Wren, CA, starts Nov 30, 2 of 7; their offers, mail, checks and devices |
| `rich/turnover.ts` | Six 2026 joiners and leavers (three summer interns, a seasonal Austin Yard technician, a quality inspector and a sales hire), each inactive with documents, a finished checklist, a completed offboarding case and an engine-computed YTD import; the July leaver gets his import here |
| `rich/pay-history.ts` | 16 imported Jan to Aug runs whose paychecks split each worker's YTD import (wage-base codes front-loaded); the paid claims ride the run that reimbursed them (outside gross and net, inside the totals; the one past 60 days is a taxable earning line carved out of the imported gross); monthly federal deposits |

Jan to Aug runs are shown as Imported (`taxDataVersion "imported"`, no approver, no bank batch): the base seed says
Larkspur ran payroll on a previous provider until Aug 31, so Weft never ran them.

## Story beats left for the tour

DE 2088 is not delivered, the October reconciliation is not run, the 8 expenses are still in review, Noor's offer is
still Sent, Colorado is not registered (no registration is planted: accepting Noor's offer files both, per tax account),
and the pay_2026_10_30 submit waits for Theo (its proposal has `subjectHash: null`, so approving it runs the submit
fresh). `pnpm demo:scenario` resets to the world's own profile and counts these seeded pending proposals as clean; it
refuses only a pending proposal newer than the seed.

## App changes that came with the data

- Home and Payroll fetch every run, so a year of history no longer hides the open draft; Payroll lists newest first
  with an Imported badge. Home counts time off from today, shows the time-off decisions routed to the viewer beside
  Approvals waiting, and shows a manager (Imani) a Your team card: reports out today, decisions for her, approved
  time off ahead and the hires joining her team.
- The run view has a not-found state. The agent panel has page-aware prompts and recent answers.
- A contractor's Pay and tax tab describes the payment rail and the W-8BEN instead of the paycheck block.
- Settings drops the "come next" line and links Permissions, Integrations and Routines.
- The audit table no longer needs a sideways scroll at 1440 px (the Summary column takes the free width, the
  command wraps, the run id truncates).
- Portal: training calls the API as the portal persona, so a new hire no longer sees or completes Vic's course.
  The portal's time off is the Request time off section in `components/portal/w4-people.tsx` (balances, the form
  and the person's own requests from `GET /v1/portal/time-off`); the wave 3 slot `components/portal/time-off/section.tsx`
  stays empty on purpose so there is one section, not two.
- Chain status after a restart: an API process that did not seed found the memory repo lazily and never read its
  chain head, so once anything read memory, verify reported a git lag of the whole log ("Chain broken" on the audit
  page). Base worlds hid it (a lag of 1 is tolerated). `ensureRoot` in `packages/executor/src/memory/store.ts` now
  reads the head when it finds the repo.

## Tests

- `packages/seed/test/profile.test.ts`: base equals `seedWorld()`; rich is deterministic, its planted rows equal base,
  the action chain verifies with no git lag, imported gross equals the YTD import per worker, every 2026 departure is
  an inactive worker with a completed case and imported pay, there are hires before October in four or more months,
  reimbursements on imported runs equal their paychecks, the totals identities hold and no paid claim is unlinked.
- `apps/api/test/rich-portal.test.ts`: personas at 0, 2, 5 and 7 of 7; the policies the portal's time-off section
  offers NY and CA hires; the persona's own claim and training; a second process on the same rich data keeps the
  chain valid after a memory read.
- `apps/api/test/sim-reset-profile.test.ts` and `tests/demo-scenario.test.ts`: reset keeps or picks the profile.
- `e2e/rich-data.spec.ts` (`pnpm e2e:rich`, `playwright.rich.config.ts`): seeds rich fresh, visits every audited
  route, clicks each top-level tab and fails on an empty-state line or missing content; checks the Reports hires,
  departures, reimbursements and contractor series through the API, the audit table's overflow, a manager's Home and
  Odette's portal (time off, NY training, her claim).

Run it on other ports with `WEFT_RICH_WEB_PORT`, `WEFT_RICH_API_PORT` and `WEFT_RICH_DATA_DIR`.

## Known gaps

- Headcount in Reports starts at 45 plus the leavers in January, not about 38: the base YTD import puts the 45 current
  employees on payroll from Jan 1, and their start dates are planted. The joiners and leavers give the hires and
  departures chart its curve instead.
- The device status enum has no repair or returned state, so a leaver's returned laptop is told in the offboarding
  step, not on IT. The base laptops are all one model; the rich layer adds a workstation, field tablets and a
  delivered laptop for the new hires.
- Most routines stay disabled: enabling them in a dev world would spend on live runs. Every routine the gallery shows
  has at least one scripted past run, and the folded `rt_compliance_notices` is left out of `GET /v1/routines`
  (`?include=retired` returns it).
- Odette's home office claim is a pre-start equipment stipend (its purpose and decision note say so). It has its
  receipt but no stored checks: the policy engine flags an expense dated before the start date as outside employment.
  The profile test fails any other claim dated before its worker's start.
- August reconciliation has no row type for "clean"; September shows a resolved finding, October stays un-run.
- Base chat messages are re-dated in the rich layer to the day each one talks about (Ana and Ben's welcome on Oct 1,
  the Oct 15 settlement on Oct 15); a channel lists in time order.
- Workday stays unsynced on purpose: a sync hands People, Compensation and Time off to Workday.

## Demo round 2 (dp/r2-data-and-seed)

- Greenhouse: the seeded sync items use the engine's detail shapes (`label`, `weft_value`, `vendor_value`,
  `offer_version`, `application_ref`), so step 19 reads "Start date changed in Greenhouse (offer version 2): Weft has
  Nov 16, 2026, Greenhouse has Nov 23, 2026" on Marisol Quint's offer, and Take Greenhouse value applies a date.
- Offers: every sent, viewed, accepted, expired or voided offer's letter and agreement come from core's
  `offerLetterFor` and `confidentialityText`, as `documents.send_offer` writes them. Only accepted offers have a
  background check; the follow-up routine names Tobias Wren's pending check (estimate Oct 30).
- Routine runs: every seeded run of a cron routine sits at a slot its own cron produces (`cronSlot` reads the PREBUILT
  trigger) with the engine's `cron:<slot>` ref; event routines carry `event:<name>:<subject>`. The Austin office laptop
  routine names Lucia Ferrante, its one Austin hire; the life-event routine reads a closed marriage window.
- Owen Mercer: his last day (Oct 23) is planted in base; the rich layer offboards him (open case, everything
  done but final pay on the Oct 30 run, status offboarding, accounts suspended, enrollments ended through Oct 31), so
  Home, People, Offboarding and Reports agree on 47 employees.
- Benefits in the imported history: the salaried leavers (Rafael Ostrander, Wen Talbot, Dorian Pike) carry their
  enrollments, 401(k) included, on their imported paychecks until they leave; the enrollments end through the month
  of the last day. Employer benefits per month now move with them. Employer health contributions stay $0 because the
  engine prices only the 401(k) match (a base engine behavior, unchanged here).
- The July leaver's final pay is on the Jul 31 regular run; offboarding step details read days and the IT system
  names (Workspace, Chat); the quality inspector leaver is Wen Talbot, not a second Calloway.
- Audit log: the base world's #1 (Lena's raise, Oct 9) precedes ten months of imported history by sequence. The seq
  stays as recorded (the memory timeline, the pay rate and the Oct 30 flag evidence all cite #1); the page lists by
  time (`GET /v1/actions?order=time`), shows each row's #, has Show older, and an `#audit-N` link pages back until
  that row has loaded.
- Not done here: the Weekly people digest description still reads "9:00 PT"; the routine rows are in every eval world,
  so that word moves all 110 eval digests and waits for a deliberate re-pin.
