# Track w3-expenses: real Expenses

Branch `track/w3-expenses` (rounds 1 and 2). Implements `research/wave3/expenses-timeoff.md` sections 7 and 8.2 and
GP13 in `docs/wave3.md`: a pure policy engine, one decision per item, a review routine, self-service claims with
receipts, and reimbursement through payroll.

## What exists

| Piece | Where |
|---|---|
| Policy engine: pure, versioned (`EXPENSE_POLICY_V1`, rates from `EXPENSE_RATES`), 12 rule codes, checks in the paycheck flag shape, allowed decisions and a suggested decision per item | `packages/core/src/expenses/policy.ts` |
| Read model and lifecycle writes: bands, attach to the earliest draft before its deadline, schedule waiting items on a new draft, mark paid on processing, reopen until paid | `packages/core/src/expenses/store.ts` |
| Payroll seam: `loadExpensePayrollInputs` and `reimbursementsFor` (non-taxable to `reimbursements_cents` and `reimbursements_json`; approved as taxable to a `taxable_reimbursement` earning inside gross) | `packages/core/src/expenses/payroll.ts`, `payroll/lifecycle.ts` writes `reimbursements_json` |
| `REIMBURSEMENT_SPIKE` pre-payroll rule (over $2,500, or over 3 times the last 3 runs' average when above zero) | `packages/core/src/expenses/flags.ts` |
| Grounded explanations with the template fallback | `packages/core/src/expenses/explain.ts` |
| Commands: `expenses.list`, `get` (concise omits employee text; detailed wraps and taints), `check_policy`, `explain`, `decide` (exactly one id, R2, approval always, lease `expenses:{id}`, ceiling `agent.expense_cents`, `autoEligible` `agent.expense_auto_cents`, reversible by `expenses.reopen`), `reopen`, `submit` and `resubmit` (human only, self-service rule below), `schedule` and `mark_paid` (system only) | `packages/core/src/commands/expenses.ts` |
| Handlers: `payroll.processed` runs `expenses.mark_paid`; `payroll.draft_created` runs `expenses.schedule` | `packages/core/src/expenses/handlers.ts` |
| Seed: policy row, ceilings, E1 to E8 as `needs_review`, 4 approved and 2 declined history items, receipt PNGs with sidecar extraction JSON | `packages/seed/src/w3-expenses.ts` |
| Admin routes: `GET/POST /v1/expenses` (POST takes JSON or multipart with a `receipt` file), `GET /v1/expenses/:id`, `/receipt` (admins only), `/decide`, `/reopen`, `GET /v1/expense-policy`; non-admins see only their own expenses | `apps/api/src/routes/expenses.ts` |
| Portal routes (round 2): `GET /v1/portal/expenses` (the caller's own claims with the approver's note), `POST /v1/portal/expenses` (JSON or multipart, always on the caller's own worker record), `POST /v1/portal/expenses/:id/resubmit` | `apps/api/src/routes/expenses.ts` |
| Routine `rt_expense_review` (weekday 09:00 PT and manual, ships disabled, 8 tools) with checklist predicates `expenses_explained` and `expense_decisions_proposed` | `packages/routines/src/wave3/expenses.ts`, `scenarios/rt_expense_review.json` |
| Chat script that refuses bulk approval and offers a walk-through | `scenarios/chat_expenses_approve_all.json` |
| App screens: `/app/expenses` (four bands with counts, filters, check dots, Review with agent, Add expense with the mileage amount from the IRS rate and an optional receipt file), the drawer (receipt, claim against extraction, checks, explanation, suggestion, decision bar, payment, audit trail including the submit) | `apps/web/src/components/app/expenses/**` |
| Portal My expenses (round 2): own claims with status and pay run, checks that need attention, the return note, a submit form with category fields (attendees for meals, miles with the computed amount for mileage) and a receipt file, Fix and resubmit for returned items | `apps/web/src/components/portal/expenses/section.tsx` |
| Display shapes the API serves (`W3ExpensesRow`, `Page`, `Detail`, `Policy`, `PortalRow`, `PortalPage`) and the test ids | `packages/contracts/src/ext/w3-expenses.ts`, `packages/contracts/src/w3/testids-expenses.ts` |

## Who may file a claim (round 2)

`expenses.submit` and `expenses.resubmit` are `human_only` and declare `people: view` as their floor, then check inside
the command: a person files for the worker record their principal names (the new hire persona from the portal, or any
employee such as Sam for `wrk_0025`), and filing for someone else needs `payroll: edit` (Dana or Theo keying one in).
Otherwise the refusal is `DOMAIN_NOT_OWN_EXPENSE`. The portal routes never take a `workerId` from the body: they use
the caller's own record, and a resubmit of someone else's item answers 404. The persona still reaches only
`/v1/portal/*`, so `/v1/expenses` answers 403 `PORTAL_ONLY` for it.

`expenses.resubmit` works only on a `returned` item: it replaces the claim fields (and the receipt when a new file is
attached), clears the return note and the old explanation, reruns the engine and emits `expense.submitted` again. It
takes no lease, because the approver's decision lease is held for 10 minutes after Return and returned items are not
decidable; the status check runs inside the transaction.

Receipts use the I-9 upload path and limits: 5 MB, PNG, JPEG, WebP or PDF, stored once as `uploads/<sha256>.bin`
(mode 0600) with a masked file name; the command writes the `uploads` row (`purpose = "receipt"`). A refused claim
removes a file it stored. Uploaded receipts have no extraction (the simulated extractor reads only the seeded
sidecars), and the drawer says so.

## How to run it

- Unit and API tests: `pnpm vitest run packages/core/test/expenses apps/api/test/expenses.test.ts tests/scenarios/gp13-expenses.test.ts tests/scenarios/gp13-expenses-chat.test.ts`.
- E2E on this track's ports: `WEFT_E2E_WEB_PORT=4680 WEFT_E2E_API_PORT=4681 WEFT_E2E_RUNNER_PORT=4682 pnpm e2e gp13`
  (two tests: the admin review to reimbursement path, and the portal claim, return and resubmit path).
- In `pnpm dev`: open `/app/expenses` as Dana. For the portal, send an offer, sign the letter as the new hire, open
  `/portal?as=<persona id>` and use My expenses.

## Real versus simulated

- Real: the policy engine and its 2026 rates, the bands, one decision per call with approvals, ceilings and leases,
  reimbursements on the paychecks of the open draft (bank entry, totals and cash requirement), the taxable path inside
  gross, paid on processing, reopen until paid, self-service submit and resubmit, receipt storage.
- Simulated: receipt extraction (sidecar JSON next to each seeded receipt; no OCR, no model), and the bank and payroll
  rails the reimbursement rides (the existing simulators).
- Model calls: none in tests and e2e (scripted provider). `rt_expense_review` with a live model adapts to any number of
  items; the scripted file covers the eight seeded ones.

## Decisions worth knowing

- **Net pay stays the engine's net.** E10 pins gross, taxes and net unchanged; the reimbursement rides
  `reimbursements_cents`, which the bank entry (`net + reimbursements`), `totalCost` and `cashRequirement` include.
- **Statuses.** approve goes `approved` then `scheduled` once attached; approve as taxable stays `approved_taxable`
  with its `payroll_run_id` set; both become `paid`. An item on a paycheck that was excluded at submit goes back to
  approved without a run, so the next draft pays it.
- **Seeded approved history is not on the open draft.** Attaching it would change GP2's draft totals. The four items
  wait for the next draft Weft creates (`expenses.schedule` on `payroll.draft_created`), which the API test shows on
  `pay_2026_11_13`. E7's duplicate target is an approved item (no paid seed exists, per docs/wave3.md).
- **Approve is refused while a block check fires**, and past 60 days only Decline or Approve as taxable are allowed.
  Decline needs a reason code; Return needs a note the employee reads (now shown in the portal).
- **Suggestion order**: duplicate, outside employment, future date, missing receipt, mileage rate, past 60 days, meal
  details, receipt mismatch, per diem, over limit (approve with the human note; California gets the Labor Code 2802
  note), else approve.
- **Software over $50** fires `OVER_CATEGORY_LIMIT` per item, so E7 shows it next to `DUPLICATE`; lodging compares
  against the standard GSA night rate for the transaction date (no locality table), so E5 shows it too.
- **Daily ceiling keys** follow the governance seed's `_day_cents` naming (`agent.expense_day_cents`).
- E11's tax deltas: the engine rounds each paycheck's tax line once, so the change versus the hand values (336 and 79)
  can differ by a cent; the test allows one cent.
- A new hire's claim dated before the start date fires `OUTSIDE_EMPLOYMENT` (block), so only Return or Decline are
  allowed; the portal e2e uses that on purpose to show the engine running on a portal claim.

## Contract changes (separate commits titled "contract: ...")

1. `packages/core/src/index.ts`: `export * as expenses from "./expenses/index"` so the routes and the seed reach the
   read model and the engine.
2. `packages/routines/test/engine.test.ts` and `apps/api/test/routines.test.ts`: `rt_expense_review` added to the
   pinned prebuilt routine lists.
3. `tests/boundaries.test.ts` rule 3 strips quoted `<namespace>.decide` command names before looking for the word
   `decide` in the brain, so a routine's tool list can name `"expenses.decide"`; a call such as `executor.decide(...)`
   still fails it. w3-timeoff's `time_off.decide` benefits too.
4. Round 2: `packages/contracts/src/api.ts` gains three rows in the `expenses` file, owner w3-expenses:
   `GET /v1/portal/expenses`, `POST /v1/portal/expenses`, `POST /v1/portal/expenses/:id/resubmit` (all `ui_only`).
   The persona reaches only `/v1/portal/*`, so My expenses needs its own paths there (the screening track's
   `/v1/portal/esign/url` is the precedent for a portal path in another route file).
5. Additive, owned: `packages/contracts/src/ext/w3-expenses.ts` (adds `W3ExpensesPortalRow` and
   `W3ExpensesPortalPage` in round 2; not yet exported from the contracts index) and the portal test ids in
   `packages/contracts/src/w3/testids-expenses.ts`.

## Requests for the integrator

- `scenarios/chat_approve_all.json` (match `approve (everything|all)`) sorts before `chat_expenses_approve_all.json`
  and wins for "approve all open expenses". Narrow its match or have the scripted provider prefer the longest match;
  the GP13 chat test forces the expenses script until then.
- `packages/core/src/portal/view.ts` line 43 shows the newest upload of any purpose as the I-9 image. Once a new hire
  uploads a receipt, the I-9 card shows the receipt's masked name. Filter it with `eq(uploads.purpose, "i9_id_image")`
  (w2-onboarding's file, not owned here).
- The paycheck drawer (`components/app/payroll/paycheck-drawer.tsx`, not owned) could list `reimbursements_json`
  lines; the API already stores them.
- `apps/api/src/demo.ts` (not owned) processes `pay_2026_10_30` in GP2; a GP13 demo step should run before that, or
  against `pay_2026_11_13`.
- Export `packages/contracts/src/ext/w3-expenses.ts` from the contracts index and add the GET response types to
  `apps/web/src/lib/api/client.ts` Responses.
- Sidebar "soon" badge for Expenses is the w3-topbar-shell track's to drop at merge.

## Left

See `.scratch/w3-expenses/left.md`: the `expense.submitted` event trigger for `rt_expense_review` (RoutineDef takes
one trigger), `notified:{worker_id}` for returned items, second approver enforcement and manager routing, and the
scripted routine file's fixed item count.

## Verification

Round 1: `pnpm test` (662), typecheck, the three lints, `pnpm demo` (GP1 to GP12) and `pnpm e2e` (GP13, GP2, GP5 and
the rest) passed; see the round 1 notes in git history for the dev runner shutdown detail.

Round 2, in the worktree on the final tree:

- `pnpm test`: 124 files, 665 tests passed (before the registry test grew; the expense files pass again after it).
- `pnpm typecheck` (16 of 16 tasks), `pnpm lint:prose`, `pnpm lint:brand` and `pnpm brand:overlap` pass.
- `pnpm e2e` with `WEFT_E2E_WEB_PORT=4680 WEFT_E2E_API_PORT=4681 WEFT_E2E_RUNNER_PORT=4682`: 33 of 33 passed in one
  run, including both GP13 tests, GP2, GP5, GP6 and GP7 (the portal now renders My expenses under the checklist).
- `pnpm demo` (GP1 to GP12) runs in process in `.data-demo` and the audit chain verifies.
- No live model spend: every run used the scripted provider.

## Ports

E2E ran on 4680 (web), 4681 (api) and 4682 (dev runner spec), the range assigned for these rounds; `docs/wave3.md`
lists 4650 and 4651 for this track.
