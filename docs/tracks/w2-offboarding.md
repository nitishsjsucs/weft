# Track w2-offboarding: termination, access revocation, COBRA notice, off-cycle pay

Branch `track/w2-offboarding`, cut from main at 9b88e26. Golden paths GP9 (termination with access revocation) and GP10 (off-cycle pay), docs/wave2.md.

## What exists

### Termination and the offboarding case (GP9)

- **Terminate.** `POST /v1/workers/:id/terminate` (body `TerminationInput`, `not_mcp`) runs `offboarding.terminate` as the person: it checks the worker is an active or onboarding employee with no open case and a last day on or after the start date, sets the worker to `offboarding` with `end_date` the last day (and refreshes the open regular drafts from the last day's period, so none pays past it), emits `worker.terminated`, and opens a case with the eight steps in `OFFBOARDING_STEP_ORDER`. A step with nothing to act on starts `skipped` with the reason as its detail (no SSO account, no device, no Google Workspace account, no app accounts).
- **Proposal steps.** The route then files `final_pay`, `directory_suspend`, `sso_deactivate` and `device_lock` through `HumanExecutor.propose` (see contract changes): each is a pending proposal with a preview, on the person's behalf and untainted. Approving one runs its command, which calls the simulator and marks the step done.
  - `offboarding.final_pay` (R4, approval always, amount against `agent.payroll_run_cents`): a `dismissal` run for the period that holds the last day. Salary is prorated by working days through the last day (the wave 1 rule); unused PTO is paid at salary / 2,080 per hour when `pay_unused_pto` (default true). The preview lists each earning line, gross, employee taxes, pre-tax deductions and net. Approval creates the run, submits it to the bank simulator through `submitRun` (payday is the last day or the next business day, settling 06:00 PT), and refreshes the open regular drafts of the period.
  - `offboarding.suspend_directory` and `offboarding.deactivate_sso` (R3, approval always): `sims.idp.suspend` on the `google_ws` and `sso` accounts; `it_accounts` mirrors the status.
  - `offboarding.lock_device` (R3, approval always): the device simulator's new remote lock (fault target `devices.lock`) for each assigned or delivered device; the lock references go into the step detail.
- **Direct steps.** `offboarding.run_step` with `step` one of `group_removal` (IdP `clearGroups` on every account), `app_removal` (suspends GitHub and chat), `cobra_notice` (a `cobra_notice` email through `sims.email` from `benefits@larkspur.example`, template text naming the plans, the coverage end date and the 60-day election window) and `benefits_terminate` (enrollments `terminated`, `effective_to` the end of the last day's month). It refuses with `DOMAIN_FINAL_PAY_PENDING` until final pay is done. A person runs it directly; an agent's call is a proposal (approval always, R2 for benefits, R3 for the rest).
- **Skip.** `offboarding.skip_step` (R2, approval always, so an agent's call is a proposal; a person runs it directly) marks a pending step skipped with a reason. The free-text reason stays in the call's arguments and the action row; the step detail only points at the action, so case reads stay free of untrusted text. The case view has Skip on every pending step. A step skipped while its proposal is pending leaves that proposal in the inbox, and approving it later fails with `DOMAIN_STEP_DONE`.
- **Audit.** Every step is finished by exactly one executor call, so each step has its own action row (`actionSeq` on the step) and its own `offboarding.step_done` event. When every step is done or skipped the case turns `complete` and the worker `inactive` with `end_date` set to the last day.
- **Final period paid once.** Final pay leaves out wages that a submitted regular run already paid for the period (the PTO payout still goes, and if nothing is left it refuses with `DOMAIN_NOTHING_TO_PAY`). Once final pay is submitted, `writePaychecks` leaves the worker out of any regular draft whose period overlaps a live dismissal paycheck (`dismissedWorkerIds` in `payroll/lifecycle.ts`, a no-op when no dismissal run exists).
- **Reads.** `GET /v1/offboarding` (`OffboardingCase[]`) and `GET /v1/offboarding/:id`. A step's `proposalId` is derived from the latest proposal whose subject is the step id, and a pending step with a pending proposal reads `proposed`. The agent has `offboarding.list_cases` and `offboarding.get_case`.
- **UI.** The person header shows Terminate (kind, last day, note, PTO payout) for active and onboarding employees (never contractors), and a link to the case once offboarding or inactive. `/app/offboarding` lists cases with finished-step counts. `/app/offboarding/[id]` shows the eight steps (status, detail, action seq, proposal link), renders each pending proposal as the inbox approval card, and has Run remaining steps once final pay is done. A proposal step left pending (its proposal refused, denied or expired) shows Run now, which runs the step as the person, the way a person runs any command (wave 1 routes such as payroll submit do the same). Test ids are in `packages/contracts/src/w2/testids-offboarding.ts`.

### Off-cycle pay (GP10)

- `payroll.propose_off_cycle` (defined in `commands/payroll.ts`, registered through `offboardingCommands` so the wave 1 payroll array and its registry test stay as they were): R4, approval always, `mcp: "propose"`, total cost from the plan against the off-cycle ceilings of harness 5.4 (`agent.off_cycle_cents` $10,000.00 per call, `agent.off_cycle_day_cents` $20,000.00 per day; over them the call is refused with `OVER_CEILING`, not proposed). The ceilings bind the gated path, so a person's proposal and its approval are held to them too. Input mirrors `OffCycleRequest` in snake case.
- `packages/core/src/payroll/offcycle.ts`: salary for the period is split by calendar days between the rates in effect (`proratedSalaryLines`: annual / 24 x days / period days, decimal.js, one half-up rounding per line). The bonus is a `bonus` earning line passed to the engine as supplemental wages. Hourly pay comes from the period's time entry: each rate gets its calendar-day share of the regular and overtime hours, overtime at 1.5x (`proratedHourlyLines`); no time entry refuses with `DOMAIN_NO_TIME_ENTRY`, and a switch between salary and hourly inside the period with `DOMAIN_MIXED_PAY_KINDS`. Each line divides once at the end (annual x days / (24 x period days)), so half-cent boundaries round exactly. Reason `bonus` pays only the bonus. The preview lists every earning line, federal income tax and net per worker.
- Approval creates an `off_cycle` run and submits it to the bank simulator like a regular run; `markProcessed` records the bonus as `supplemental` YTD wages for off-cycle runs.
- `POST /v1/payrolls/off-cycle` (body `OffCycleRequest`) files it as the person's proposal; the person header's Off-cycle pay drawer (period defaulting to the previous semi-monthly period, payday, reason, bonus in dollars) posts it and shows the proposal card in place. An MCP agent proposes it through `POST /v1/tools/payroll.propose_off_cycle` with the mcp key.
- `packages/payroll-tax`: an additive `supplementalCents` input. Federal income tax withholds the regular method on the rest of the wages and the optional flat 22 percent on the supplemental part (pre-tax deductions reduce the regular part first); YTD gains `supplemental`. Without the field every output is unchanged, and the golden tests pass as before.

## How to run it

```sh
pnpm exec vitest run --project @weft/tests tests/scenarios/gp9-offboarding.test.ts tests/scenarios/gp10-off-cycle.test.ts
pnpm exec vitest run --project @weft/api apps/api/test/offboarding.test.ts
pnpm exec vitest run --project @weft/core packages/core/test/offboarding
WEFT_E2E_WEB_PORT=4320 WEFT_E2E_API_PORT=4321 pnpm exec playwright test e2e/gp9-offboarding.spec.ts e2e/gp10-off-cycle.spec.ts
```

In the app: open a person (for example `/app/people/wrk_0004`), click Terminate, approve the cards in the case view (three, or four once the person has an SSO account), then Run remaining steps. For off-cycle pay, open `/app/people/wrk_0042` and use Off-cycle pay. GP9 gives Imani an SSO account first (`POST /v1/tools/it.create_account` with `system: "sso"`), because the seed has none.

## Tests

- `tests/scenarios/gp9-offboarding.test.ts`: the whole GP9 path over HTTP, including the dismissal run in the bank simulator, the suspended IdP accounts, the cleared groups, terminated enrollments, the COBRA email, one action row and one `offboarding.step_done` per step, the regular draft no longer paying the worker, and refusals for a second termination and a contractor.
- `tests/scenarios/gp10-off-cycle.test.ts`: the MCP agent proposes for Hollis (raise from $76,000.00 to $82,000.00 on Oct 6), the preview shows $1,055.56 and $2,277.78 for the 5 and 10 days on either side of the raise and the $1,500.00 bonus, Dana approves, the batch total equals net pay, the run settles on payday and the ledger records the bonus as supplemental; an off-cycle over $10,000.00 is refused with `OVER_CEILING`.
- `packages/core/test/offboarding/offcycle.test.ts`: salary and hourly proration (half-cent cases), the 22 percent split and the PTO accrual, exact to the cent.
- `apps/api/test/offboarding.test.ts`: route validation, the `not_mcp` refusal, skipped steps, untainted proposals on the person's behalf, final pay after a submitted regular run.
- `e2e/gp9-offboarding.spec.ts`: the GP9 path in the browser.
- `e2e/gp10-off-cycle.spec.ts`: Off-cycle pay from Hollis's header becomes a proposal whose card lists the earning lines; approving it submits the `off_cycle` run.

## Stubbed or simplified

- PTO is a simulated accrual (10 hours per whole calendar month worked in the year, cap 120, no time taken) because Time Off is a stub.
- The final payday is the last day or the next business day; state final-pay deadlines are not modeled. PTO is paid as regular wages in the same check (aggregate method).
- Device lock has no device status of its own (`DeviceStatus` has no `locked`); the lock reference lives in the step detail and the action row.
- The seed has no SSO accounts (wave 1 tests pin the `it_accounts` counts), so `sso_deactivate` starts skipped unless one is created first.
- The COBRA notice goes to the personal email when there is one, else to the work address.
- State taxes on a bonus use the regular method on total wages (CA and NY supplemental rates are deferred).
- Chat agents cannot propose off-cycle pay: `CHAT_TOOLS` is the frozen read-only set of 14. MCP agents can.
- No case cancel and no retry state: `failed` is never set (a simulator fault fails the call and the step stays pending, with Run now in the case view).
- The `w2_offboarding` seed step stays a no-op.

## Contract changes

1. `contract: parseEventBody accepts the wave 2 event bodies` (packages/contracts/src/events.ts). Cherry-picked unchanged from w2-onboarding's 98c91b7, so the two branches carry the identical diff. Without it `worker.terminated` and `offboarding.step_done` could not be emitted.
2. `contract: HumanExecutor.propose files a person's own call as an untainted proposal` (packages/contracts/src/commands.ts, optional method; packages/executor/src/human.ts, about ten lines). It runs the gated (mcp caller) path with the session's own surface and no taint. Before it, the only way for a person to file a proposal was an mcp-scoped session, which marked the proposal tainted by mcp and showed the untrusted-content banner.
3. Additive, in owned files: `packages/contracts/src/ext/w2-offboarding.ts` describes the new simulator methods (`IdpSim.clearGroups`, `DeviceSim.lock`) for the integrator to fold into `sim.ts`; `PaycheckInput.supplementalCents` in payroll-tax.

Integrator requests are in `.scratch/contract-requests/w2-offboarding.md`.
