# Track t1-payroll: notes for the integrator

Branch `track/t1-payroll`. Status at the end of round 2 (2026-10-15). Everything below runs on synthetic data and the
synthetic 2026.1 tables.

## Round 2 status: checked on a trial merge

Round 2 merged `main` with tracks t1, t2, t3 and t4 in a throwaway clone (outside the repo) and ran the merge 1 gates
there. Results on that trial merge:

- `pnpm db:reset && pnpm db:seed` twice gives the same `db:digest` (`f17234fe...d847`).
- The real seed: `pay_2026_09_15`, `pay_2026_09_30`, `pay_2026_10_15` processed with 45, 45 and 47 paychecks (real
  bank simulator batches `simb_0001` to `simb_0003`); the draft `pay_2026_10_30` with 48: 4 Needs Review (Mira Delgado
  CA Oct 19 hire blocked by MISSING_BANK_ACCOUNT, Lena Brooks NY raise, Owen Mercer NY offboarder, Flora Quinn TX 120 h)
  and 44 Ready.
- `payroll.get_run` concise through the real agent executor: 5,073 characters, and the GROSS_CHANGE evidence for the
  raise carries `created_action_seq: 1` and `action_result_id: res_0001` (the seeded `people.set_pay_rate` action).
- S2 passes 5 of 5 (five repeats, and inside the full suite): the 4/44 split; GP2 (routine run, 4 template
  explanations, one `payroll.submit_run` proposal with `exclude_blocked: true`, approval to `processing`, first tick
  at Fri Oct 30 06:00 PT to `processed` with YTD rows and `payroll.processed`, totals equal to the approved preview);
  `submitted_action_seq` equals the executor's `payroll.submit_run` action row; the STALE_SUBJECT variant (422, run
  stays draft); the bank return fault variant; chain verify.
- `tests/scenarios/scripts/s2-pre-payroll.json` (read flagged rows, explain and propose in one batch, final text; 3
  model steps) also passes through T4's scripted provider when passed as `scenario`. S2 itself uses the routine's
  default script `scenarios/rt_pre_payroll.json`, because `@weft/tests` does not depend on `@weft/agent`.

### For the integrator at merge 1

- `packages/core/src/index.ts` conflicts with t2-world. Keep both lines:
  `export * as payroll from "./payroll/index";` and `export * from "./demo/index";`. Nothing else in t1 conflicts.
- Failures seen on the trial merge that are outside t1 (left alone): `packages/seed/test/seed.test.ts` (its context
  has no `executor`, so `seedGovernance` fails on `ctx.executor.vault.put`), and `apps/api/test/sim.test.ts` (3 tests:
  SQLITE_BUSY_SNAPSHOT on `id_counters` while background agent runs write, then cascading assertions; the same
  routes answer 200 in a fresh world).
- The routines routes are still 501 stubs on t4-agent. S2 calls `POST /v1/routines/rt_pre_payroll/trigger` and falls
  back to `weft.routines.trigger(...)` only while that route answers 501.
- S2 waits on real time for `routine_runs` and `agent_runs` to settle (the agent runs in the background); it does
  not spin scheduler ticks while a run is in flight.

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
  A direct-deposit change can either add a new active row and deactivate the old one or edit last4 or
  `credential_ref` in place: all change the subject hash. With two active rows, payroll uses the highest id;
  `people/queries.ts bankSummary` uses the lowest. Keep one active row per worker so the two agree.
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
- Bank simulator: `submitBatch` gets entries `{ workerId, amountCents: net + reimbursements, accountRef }` where
  `accountRef` is the deposit account's `credential_ref` (a `vault:` name, as the simulator requires), and
  `settleAt` = payday 06:00 PT. A returned batch (fault `return`) is terminal: the simulator never settles it, so
  `payroll.mark_failed` marks the run and every in-flight paycheck `failed` (the returned entry is named in the result)
  and writes no YTD rows. The seed passes the vault name `vault:sim-bank-operating` as `credential` (the seed
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
  `submitted_action_seq` is set to `max(actions.seq) + 1`; confirmed on the trial merge, where it equals the
  `payroll.submit_run` action row the executor appends in the approval transaction (S2 asserts it).
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

## How to run

```sh
pnpm install
pnpm --filter @weft/payroll-tax test     # golden and agency cases
pnpm exec vitest run packages/core/test/payroll apps/api/test/payrolls.test.ts packages/seed
pnpm exec vitest run tests/scenarios/s2-pre-payroll.test.ts   # skips itself until the merged world exists
pnpm typecheck && pnpm test && pnpm lint:prose && pnpm lint:brand
```

## Stubbed or not built

- Until merge 1, the core, route and seed tests run on the local fixture world with an in-memory bank that follows
  the real simulator's input rules and its `return` mode; the S2 tests skip themselves, naming what is missing.
- Cut line, not built: stretch states WA, IL, FL (their federal lines are tested). `get_run` with
  `response_format: "detailed"` only adds the unflagged rows to the concise shape; there is no separate detailed
  layout and no per-line tax trace in it (the trace is on `GET /v1/paychecks/:id`).
- Not modeled: NY Method III, CA supplemental rates, bank holidays in the pay calendar, more than one pay rate inside
  one period, retrying a failed run (a failed run stays failed; a new draft can be created for the period).
