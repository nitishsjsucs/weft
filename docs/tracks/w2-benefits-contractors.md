# Track w2-benefits-contractors: notes for the integrator

Branch `track/w2-benefits-contractors`, cut from the wave 2 scaffold (`9b88e26`). Carrier reconciliation, open
enrollment and contractor payouts (GP11). Everything runs on synthetic data and the in-repo simulators.

## What exists

| Area | Where | What it does |
|---|---|---|
| Carrier simulator | `packages/sim/src/carrier.ts` | `invoice(month)` bills every medical, dental and vision enrollment of Juniper Mutual (sim) at the enrolled tier price per semi-monthly period of coverage, stores the invoice in `sim_carrier_invoices` once per month (`simv_` ids) and returns the stored copy afterwards. Fault target `carrier.invoice`. |
| Planted errors | same file | (1) the carrier is never told about terminations, so Owen Mercer (demo), last day 2026-10-23, stays billed for the full month; (2) the first single-coverage medical member with no dependent on file is billed at `family`; (3) the first `family` medical enrollment is billed at `ee`. Deterministic, no extra seed rows. |
| Reconciliation | `packages/core/src/benefits/recon.ts` | `computeFindings` compares invoice lines with enrollments, worker end dates and the month's paycheck deductions (`benefitsJson` of processed and draft runs with a payday in the month); `storeFindings` keeps `benefit_recon_findings` idempotent per month and carrier (same key keeps its id and status, amounts refresh, stale open findings turn `resolved`). Kinds: `terminated_but_billed` (one per worker, `planId` null, summed over plans), `missing_dependent`, `wrong_tier`, `billed_not_enrolled`, `enrolled_not_billed`, `amount_mismatch`. |
| Commands | `packages/core/src/commands/benefits.ts` | `benefits.reconcile` (write, R1, no approval; month defaults to the sim month; emits `benefits.invoice_received` the first time a month's invoice is issued), `benefits.list_findings` (R0), `benefits.dispute_finding` (R3, approval always: the preview carries the full templated carrier message; execution sends it through the email simulator to `billing@juniper-mutual.example` and marks the finding `disputed`), `benefits.list_open_enrollment` (R0), `benefits.nudge_open_enrollment` (R3, approval always, posts one reminder in #general and counts a nudge per person). |
| Open enrollment | `packages/core/src/benefits/enrollment.ts`, seed step | One `open_enrollment` row per eligible employee for plan year 2027 (active or onboarding, no end date: 47 of 48), deterministic statuses from the worker number. Deadline 2026-11-13. |
| Chase routine | `packages/routines/src/wave2/benefits.ts` | `rt_open_enrollment`: weekdays 10:00 PT, disabled, tools `benefits.list_open_enrollment` and `comms.send_message`. The precheck `open_enrollment` names everyone not started or in progress (names only, no digits, so grounding passes) and skips when nobody is left, after the deadline, or when everyone left was reminded today. **Defined but not yet in PREBUILT** (see contract changes). |
| FX table | `packages/sim/src/fx.ts` (unchanged), seed step | `fx_rates` seeded from `FX_USD_PER_UNIT` as of 2026-01-01 with the synthetic label. |
| Payouts | `packages/core/src/contractors/index.ts`, `packages/core/src/commands/contractors.ts` | `contractors.schedule_payouts` (R4, approval always, `amountCents` from DB rows): each active contractor's `contract_monthly` rate, the fixed FX rate, `decimal.js` half up to USD cents (EUR 6,500.00 is $7,020.00, INR 410,000.00 is $4,920.00, CAD 9,800.00 is $7,154.00). Refuses non-contractors and a second payout for the same date. Approval writes `contractor_payments` and books each on the rail. Also `contractors.list_payouts` and `contractors.list_fx_rates` (R0). |
| Rail simulator | `packages/sim/src/rail.ts` | `send` books `pending` (one per payment id), `tick(now)` moves pending to `sent` and delivers sent transfers two business days after booking (PT), returning `sim.rail_delivered`. Fault target `rail.send`. |
| Rail sync | `syncRail` in `packages/core/src/contractors/index.ts` | Ticks the rail and mirrors `rail_status`, `sent_at`, `delivered_at` onto `contractor_payments` (delivered turns `status` to `paid`) and appends `sim.rail_delivered` events (validated against `Wave2EventBody`, appended directly because `emitEvent` only takes the frozen union). Called by `GET /v1/contractors/payouts` when a payout is pending or sent (no action row, like a sim tick). |
| API | `apps/api/src/routes/benefits.ts`, `contractors.ts` | `GET /v1/benefits/reconciliation?month&status`, `POST /v1/benefits/reconciliation/run {month}`, `GET /v1/benefits/open-enrollment?status`, `GET|POST /v1/contractors/payouts`, `GET /v1/contractors/fx`. Disputes go through `POST /v1/tools/benefits.dispute_finding`. |
| Web | `apps/web/src/components/app/benefits/**`, `contractors/**`, `products/products-view.tsx` | Benefits gets Plans, Reconciliation and Open enrollment tabs; Contractors gets Payouts (amount, FX, USD, rail badge with time) and the FX table. Simulated badges stay. Test ids in `packages/contracts/src/w2/testids-benefits.ts`. |

Proposal semantics: an agent or API key caller gets a proposal for `benefits.dispute_finding`,
`benefits.nudge_open_enrollment` and `contractors.schedule_payouts`; a person clicking in the UI executes directly,
since the executor treats a human session's own call as the approval (wave 1 policy).

## How to run it

- `pnpm vitest run apps/api/test/benefits-recon.test.ts apps/api/test/contractors.test.ts packages/core/test/benefits packages/sim/test/carrier.test.ts packages/sim/test/rail.test.ts tests/scenarios/gp11-benefits-contractors.test.ts`
- E2E on the track ports: `WEFT_E2E_WEB_PORT=4342 WEFT_E2E_API_PORT=4343 npx playwright test e2e/gp11-benefits-contractors.spec.ts`
- In the app: Benefits, Reconciliation, Run reconciliation (October); Contractors, Pay 3 contractors; then advance the
  clock two business days on Simulators and reopen Contractors.

Seeded October numbers: Owen Mercer billed $212.00, expected $106.00 (coverage through the last full period worked),
deducted $212.00; missing dependent billed $620.00, expected and deducted $190.00; wrong tier billed $190.00,
expected and deducted $620.00.

## Stubbed or simplified

- No dependents table: "dependent on file" means an active enrollment at a tier that covers dependents.
- Coverage ends with the last semi-monthly period worked in full; the carrier bills the employee share only.
- `rt_open_enrollment` is not in PREBUILT on this branch; the GP11 scenario installs its row the way the engine would.
- The routine's reminders through `comms.send_message` do not bump `open_enrollment.nudges`; the screen's reminder
  button (`benefits.nudge_open_enrollment`) does.
- Rail state advances on `GET /v1/contractors/payouts`, not in the scheduler tick (see contract changes).
- No `returned` transfers yet (the status and UI badge exist; the simulator never returns).

## Contract changes

None to frozen files. Additive: `packages/contracts/src/ext/w2-benefits-contractors.ts` defines
`W2BenefitsOpenEnrollmentRow` and `W2BenefitsFxRate`, the response shapes the route table names as
`OpenEnrollmentRow[]` and `FxRate[]` (tests parse responses with them; exporting them from the contracts index is
optional). Requests for the integrator (also in `.scratch/contract-requests/w2-benefits-contractors.md`):

1. `packages/routines/test/engine.test.ts` asserts exactly the four wave 1 routine ids. Once it accepts wave 2
   routines, change `routines` in `packages/routines/src/wave2/benefits.ts` to `[RT_OPEN_ENROLLMENT]`.
2. Scheduler hook for the rail: `sims.tick` persists events through `emitEvent`, whose `parseEventBody` rejects wave 2
   types, so adding `rail.tick` to `packages/sim/src/index.ts` would fail the whole sim tick step. Either teach
   `emitEvent` the `Wave2EventBody` union or call `syncRail(tx, sims, now)` from the scheduler; the payouts GET
   already does it lazily.
3. Optional: `apps/api/test/offers.test.ts` builds all-null samples for every `benefits.*` command, which is why
   `benefits.reconcile.month` and `benefits.dispute_finding.finding_id` are optional with a refusal when missing.
   Adding them to its `required` map would let both be required again.
4. `e2e/gp11-benefits-contractors.spec.ts` is a new file outside the listed paths (the brief asks for a spec per
   new golden path); nothing else touches it.
