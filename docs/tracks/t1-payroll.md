# Track t1-payroll: notes for the integrator

Branch `track/t1-payroll`. Round 1 status at the end of the round. Everything below runs on synthetic data and the
synthetic 2026.1 tables.

## What is built

| Area | Where | Tests |
|---|---|---|
| 2026.1 rate data (domain.md section 6), with the SPEC 7.1 reduces sets labeled a modeling choice | `packages/payroll-tax/src/data/2026.ts` | `packages/payroll-tax/test/golden.test.ts` |
| Pure engine: Pub 15-T Worksheet 1A (2020+ and pre-2020, Step 2 tables, Steps 3 and 4, supplemental), FICA with the SS cap and Additional Medicare, FUTA, CA (EDD Method B annualized, SDI, UI and ETT from employer rates), NY (Method II, PFL with the annual cap, DBL with the $1.30 semi-monthly cap), TX, CO (DR 1098, FAMLI from the tables) | `packages/payroll-tax/src/*.ts`, `states/*.ts` | golden cases 1, 2, 4, 7, 9 on every line; extra federal cases 11 and 12; FIT lines of cases 3 and 5; federal lines of case 6; case 10; EDD Example E $4.13; NY Example 1 $8.01; the NY per-period derivation reproduces the published biweekly table II-B and Table A |
| Pay calendar (periods, payday, approval deadline 17:00 PT two business days before, settle at payday 06:00 PT, PDT and PST) | `packages/core/src/payroll/calendar.ts` | `calendar.test.ts` |
| Draft computation (eligibility, salary / 24 prorated by working days, hourly with overtime above 86.67 h, benefits, employer rates at payday, YTD from the ledger) | `compute.ts` | `lifecycle.test.ts` |
| Anomaly rules of SPEC 7.5 (all nine; MISSING_FROM_RUN and TOTAL_CHANGE are run level) | `anomalies.ts` | 4/44 split, GROSS_CHANGE evidence |
| 12 totals and the SPEC 7.4 identities | `totals.ts` | identities on every seeded run, bank batch = net + reimbursements |
| Subject hash for `payroll.submit_run` | `subject.ts` | changes on a direct-deposit change, stable on preview |
| Lifecycle: createDraft, previewRun, submitRun, markProcessed | `lifecycle.ts` | `lifecycle.test.ts` |
| Seed history: opening YTD from start dates, 3 processed runs, the open draft | `history.ts`, `packages/seed/src/payroll.ts` | `seed-step.test.ts`, determinism |
| Commands: list_runs, get_run, preview_run, create_draft, explain_flags, submit_run, mark_processed, mark_failed | `packages/core/src/commands/payroll.ts` | `commands.test.ts` |
| Handlers: `sim.bank_batch_settled`, `sim.bank_batch_returned` as `svc_events` | `packages/core/src/payroll/handlers.ts` | `commands.test.ts` |
| Routes: `/v1/payrolls`, `/v1/payrolls/:id`, `/v1/payrolls/:id/paychecks`, `/v1/paychecks/:id`, preview, submit, drafts | `apps/api/src/routes/payrolls.ts` | `apps/api/test/payrolls.test.ts` |
| S2 scenario body and script | `tests/scenarios/s2-pre-payroll.test.ts`, `tests/scenarios/scripts/s2-pre-payroll.json` | skips itself until the merged world exists |

Until merge 1 the tests run on a local fixture world (`packages/core/test/payroll/fixture-world.ts`) with the SPEC 5.2
counts and the 4 planted anomalies. The route and command tests use small stand-ins for the executor.

## Contract changes (separate commits titled "contract: ...")

1. `packages/core/src/index.ts`: one additive line, `export * as payroll from "./payroll/index";`, so the seed and the
   scenario tests can call the lifecycle and history functions.
2. `packages/core/test/shared.test.ts`: the scaffold asserted that the command and handler arrays are empty, which
   fails as soon as any track appends. It now checks unique command names and callable handlers. Other tracks will
   hit the same assertion; keep one version.

## What the other tracks should know

### T2 (people, benefits, tax seed and simulators)

- Eligible workers: `type = employee` on `ps_us_semimonthly` with status active, onboarding or offboarding (or inactive
  with an end date inside the period), start date on or before period end, end date on or after period start.
- Pay rates: the rate effective on the period end. The NY raise should be a new `pay_rates` row effective 2026-10-16
  with `created_action_seq` set; GROSS_CHANGE evidence reads the action row by that seq and reports its `result_id`.
- Hourly hours: `time_entries` per period; the engine uses `regular_hours_x100 + overtime_hours_x100` as total hours and
  applies 1.5x above 86.67 h itself. Imported periods without an entry assume 86.67 h.
- `tax_profiles.state_filing_status`: CA `single | married | hoh`, NY `single | married`; `state_allowances` is the
  DE 4 or IT-2104 count. CO uses the W-4 filing status.
- `benefit_plans.prices_json` is `{ ee, ee_spouse, ee_children, family }` employee cents per period (or
  `benefit_enrollments.employee_cents` overrides it); `match_json` is `{ employer_cents }` for health plans and
  `{ match_bps, cap_bps }` for the 401(k) (100% up to 4% is `{ match_bps: 10000, cap_bps: 400 }`). `deferral_bps` on the
  enrollment is the employee 401(k) percentage. Camel-case keys are also read.
- Bank accounts: the active row (`status = "active"`, highest id) is the deposit account; the CA Oct 19 hire has none.
  A direct-deposit change can either add a new active row and deactivate the old one or edit last4 in place: both
  change the subject hash.
- Employer rates: the latest `employer_tax_rates` row for (state, code) effective at payday with
  `superseded_action_seq IS NULL`, ties broken by `created_action_seq`. A GP1 rate change followed by
  `payroll.preview_run` changes employer SUI only for the CA workers still under the $7,000 base (tested on the
  fixture: exactly the 3 recent CA hires change, and undo restores the prior numbers). `preview_run` reports a
  paycheck as changed only when an amount changes, not when a rate changes on a line with zero taxable wages.
- UNREGISTERED_STATE: the work state needs an active UI (or combined) account, and CA, NY and CO also an active
  withholding (or combined) account.
- YTD ledger codes: `sui_wages:<ST>`, `ss_wages`, `futa_wages` and `famli_wages:CO` hold taxable (capped) wages, so
  `tax.rate_change_impact` can multiply `sui_wages:CA` by the rate delta directly. Tax amounts are
  `tax:<jurisdiction>:<code>:<payer>`, for example `tax:CA:sui:employer`.
- Bank simulator: `submitBatch` gets entries `{ workerId, amountCents: net + reimbursements, accountRef: <bnk_ id> }` and
  `settleAt` = payday 06:00 PT. The seed passes the vault name `vault:sim-bank-operating` as `credential` (the seed
  cannot resolve secrets) and calls `bank.tick(settleAt)` right after each historic submit; while the bank is a
  scaffold stub it falls back to batch ids `simb_seed_<yyyy_mm_dd>`.

### T3 (executor)

- Commands refuse by throwing `Refused(code, message, extra)` from `amountCents`, `preview` or `run`. `submit_run`
  throws `BLOCKED_LINES` from `amountCents` (so no proposal is created for an unpayable run); its `errorHints` example
  is `{ run_id: "pay_2026_10_30", exclude_blocked: true }`.
- `submit_run.preview().subjectHash` is recomputed from current rows; compare it on approval for `STALE_SUBJECT`.
  `moneyCents` from `run()` equals `amountCents` (totalCost after exclude_blocked).
- `submit_run.run()` calls `deps.resolveCredential("vault:sim-bank-operating")` and `deps.sims.bank.submitBatch`;
  `approved_by` is `proposals.decided_by` when `ctx.approvedProposalId` is set, else the principal.
  `submitted_action_seq` is set to `max(actions.seq) + 1`, assuming the executor appends the action row next in the
  same transaction. Please confirm or tell me how to read the seq.
- Events returned in `CommandOutput.events`: `payroll.draft_created`, `payroll.submitted`, `payroll.processed`.
- `payroll.mark_processed` and `payroll.mark_failed` are `system_only` and belong on the `svc_events` allowlist.
- `explain_flags` keeps the per-paycheck repair count in `settings` under `payroll.explain_attempts.<run_id>`.

### T4 (routines, scripted provider, grounding)

- Precheck for `rt_pre_payroll`: `payroll.get_run { run_id }` gives `counts.needs_review`, `flagged[]` (each with
  `paycheck_id`, flags and evidence, `explanation`) and `excluded_worker_ids`; derived args `{ run_id, exclude_blocked:
  true }`. Checklist `explanations_complete:{run_id}` holds when every `flagged[]` row has a non-null `explanation`.
- `payroll.explain_flags` accepts items without `explanation`, which saves the template (labeled `template`). That is
  the unattended and template-fallback path.
- The S2 script uses `{{derived.run_id}}` and `{{last.payroll__get_run.flagged.N.paycheck_id}}`; adjust the format
  to the scripted provider if it differs.
- Explanations are grounded with `@weft/grounding` `check(text, [each flag's evidence, { gross_cents, net_cents,
  hours_x100 }])`. Evidence money is `*_cents` plus `*_display`; percents are strings such as `"18.0"`.

### T5 (app)

- `GET /v1/payrolls/:id/paychecks?group=needs_review|ready&state=CA&workerId=...` pages `Paycheck` DTOs; flags carry
  `rule`, `severity`, `message`, `evidence`; `explanationSource` is `agent` or `template`.
- `GET /v1/paychecks/:id` adds `trace`, recomputed from current HR data (its first line says so).
- `POST /v1/payrolls/:id/submit { excludeBlocked }` and `POST /v1/payrolls/drafts { payScheduleId, periodEnd }` return
  a `ToolOutcome`, or 422 `{ _tag: "Refused", code, hint, example }`.

## Left for round 2 and merge 1

- Merge 1 gates: `pnpm db:reset && pnpm db:seed` twice with the same `db:digest`, and the 4/44 test on the real seed
  (S2 first test). The fixture version passes now.
- S2 green end to end once the executor, routines and scripted provider land; then check `submitted_action_seq`
  against the real action row.
- `mark_failed` is covered at the command level (one returned entry, the rest settles); the end-to-end fault path
  through the bank simulator's `return` fault waits for T2's simulator.
- Stretch states WA, IL, FL are not encoded (cut line); their federal lines are tested.
- Not modeled: NY Method III, CA supplemental rates, bank holidays in the pay calendar, multi-rate proration inside
  one period.

The relayed request about open-source sandboxes and a Cloudflare free tier is answered in SPEC 9.9 (harness 3);
nothing in this track depends on it.
