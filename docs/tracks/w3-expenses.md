# Track w3-expenses: real Expenses

Branch `track/w3-expenses` (round 1 of 2). Implements `research/wave3/expenses-timeoff.md` sections 7 and 8.2 and
GP13 in `docs/wave3.md`.

## What landed

| Piece | Where |
|---|---|
| Policy engine: pure, versioned (`EXPENSE_POLICY_V1`, rates from `EXPENSE_RATES`), 12 rule codes, checks in the paycheck flag shape, allowed decisions and a suggested decision per item | `packages/core/src/expenses/policy.ts` |
| Read model and lifecycle writes: bands, attach to the earliest draft before its deadline, schedule waiting items on a new draft, mark paid on processing, reopen until paid | `packages/core/src/expenses/store.ts` |
| Payroll seam: `loadExpensePayrollInputs` and `reimbursementsFor` (non-taxable to `reimbursements_cents` and `reimbursements_json`; approved as taxable to a `taxable_reimbursement` earning inside gross) | `packages/core/src/expenses/payroll.ts`, `payroll/lifecycle.ts` writes `reimbursements_json` |
| `REIMBURSEMENT_SPIKE` pre-payroll rule (over $2,500, or over 3 times the last 3 runs' average when above zero) | `packages/core/src/expenses/flags.ts` |
| Grounded explanations with the template fallback | `packages/core/src/expenses/explain.ts` |
| Commands: `expenses.list`, `get` (concise omits employee text; detailed wraps and taints), `check_policy`, `explain`, `decide` (exactly one id, R2, approval always, lease `expenses:{id}`, ceiling `agent.expense_cents`, `autoEligible` `agent.expense_auto_cents`, reversible by `expenses.reopen`), `reopen` and `submit` (human only), `schedule` and `mark_paid` (system only) | `packages/core/src/commands/expenses.ts` |
| Handlers: `payroll.processed` runs `expenses.mark_paid`; `payroll.draft_created` runs `expenses.schedule` | `packages/core/src/expenses/handlers.ts` |
| Seed: policy row, ceilings, E1 to E8 as `needs_review`, 4 approved and 2 declined history items, receipt PNGs with sidecar extraction JSON | `packages/seed/src/w3-expenses.ts` |
| Routes: `GET/POST /v1/expenses`, `GET /v1/expenses/:id`, `/receipt` (admins only), `/decide`, `/reopen`, `GET /v1/expense-policy`; non-admins see only their own expenses | `apps/api/src/routes/expenses.ts` |
| Routine `rt_expense_review` (weekday 09:00 PT and manual, ships disabled, 8 tools) with checklist predicates `expenses_explained` and `expense_decisions_proposed` | `packages/routines/src/wave3/expenses.ts`, `scenarios/rt_expense_review.json` |
| Chat script that refuses bulk approval and offers a walk-through | `scenarios/chat_expenses_approve_all.json` |
| Screens: `/app/expenses` (four bands with counts, filters, check dots), the drawer (receipt, claim against extraction, checks, explanation, suggestion, decision bar, payment, audit trail), portal My expenses | `apps/web/src/components/app/expenses/**`, `apps/web/src/components/portal/expenses/section.tsx` |
| Display shapes the API serves | `packages/contracts/src/ext/w3-expenses.ts` |

Tests: `packages/core/test/expenses/policy.test.ts` (E1 to E9, E10 and E11 at the seam, E13 registry),
`apps/api/test/expenses.test.ts` (seeded world: bands, GP2 unchanged, E10, E11, reopen, processing marks paid, E12,
E14, viewer scope, receipt), `tests/scenarios/gp13-expenses.test.ts` (routine proposes eight single-item decisions,
nothing executes, Dana approves two, paid on processing), `tests/scenarios/gp13-expenses-chat.test.ts` (E13 chat),
`e2e/gp13-expenses.spec.ts`.

## Decisions worth knowing

- **Net pay stays the engine's net.** E10 pins gross, taxes and net unchanged; the reimbursement rides
  `reimbursements_cents`, which the bank entry (`net + reimbursements`), `totalCost` and `cashRequirement` include.
  The engine and the totals identities are unchanged.
- **Statuses.** approve goes `approved` then `scheduled` once attached; approve as taxable stays `approved_taxable`
  with its `payroll_run_id` set (the status carries the taxability); both become `paid`. An item on a paycheck that
  was excluded at submit goes back to approved without a run, so the next draft pays it.
- **Seeded approved history is not on the open draft.** Attaching it would change GP2's draft totals. The four items
  are marked as imported approved and wait for the next draft Weft creates (`expenses.schedule` on
  `payroll.draft_created`), which the API test shows on `pay_2026_11_13`. E7's duplicate target is an approved item
  (no paid seed exists, per docs/wave3.md).
- **Approve is refused while a block check fires**, and past 60 days only Decline or Approve as taxable are allowed.
  Decline needs a reason code; Return needs a note the employee reads.
- **Suggestion order**: duplicate, outside employment, future date, missing receipt, mileage rate, past 60 days, meal
  details, receipt mismatch, per diem, over limit (approve with the human note; California gets the Labor Code 2802
  note), else approve.
- **Software over $50** fires `OVER_CATEGORY_LIMIT` per item, so E7 shows it next to `DUPLICATE`; lodging compares
  against the standard GSA night rate for the transaction date (no locality table), so E5 shows it too.
- **The scripted routine run covers the seeded world** (eight items). A live model adapts to any count; the scripted
  file has one decide step per seeded item and fails loudly with fewer.
- **Daily ceiling keys** follow the governance seed's `_day_cents` naming (`agent.expense_day_cents`), which the
  executor resolves.
- E11's tax deltas: the engine rounds each paycheck's tax line once, so the change versus the hand values (336 and 79)
  can differ by a cent; the test allows one cent.

## Contract changes (separate commits titled "contract: ...")

1. `packages/core/src/index.ts`: `export * as expenses from "./expenses/index"` so the routes and the seed reach the
   read model and the engine.
2. `packages/routines/test/engine.test.ts` and `apps/api/test/routines.test.ts`: `rt_expense_review` added to the
   pinned prebuilt routine lists.
3. Additive display shapes in `packages/contracts/src/ext/w3-expenses.ts` (not yet exported from the index; the web
   app and tests import them by relative path, type only in the web app).

## Requests for the integrator

- `scenarios/chat_approve_all.json` (match `approve (everything|all)`) sorts before `chat_expenses_approve_all.json`
  and wins for "approve all open expenses". Either narrow its match to exclude expenses or have the scripted provider
  prefer the longest match; the GP13 chat test forces the expenses script until then.
- The paycheck drawer (`components/app/payroll/paycheck-drawer.tsx`, not owned) could list `reimbursements_json`
  lines; the API already stores them.
- `apps/api/src/demo.ts` (not owned) processes `pay_2026_10_30` in GP2; a GP13 demo step should run before that, or
  against `pay_2026_11_13`.
- Sidebar "soon" badge for Expenses is the w3-topbar-shell track's to drop at merge.

## Ports

E2E ran on 4680 (web) and 4681 (api), the pair assigned for this round; `docs/wave3.md` lists 4650 and 4651 for this
track.
