# Wave 3 plan

Wave 2 passed its gate on 2026-10-15 (fresh clone: 624 tests, typecheck, build, 31 e2e specs, `pnpm demo` GP1 to GP12).
Wave 3 has four goals from Nitish:

1. The Weft agent does what the reference agent does.
2. Expenses and Time Off are real products, not placeholder pages.
3. Weft integrates with Workday, Greenhouse, HireRight, Checkr and DocuSign, with a free path for each where one exists.
4. The app top bar reads as one coherent control strip.

Finishing beats starting. Every track lands working, tested slices, keeps every existing test, e2e spec and the demo
green, and records what is left in `docs/tracks/<track-id>.md` and `.scratch/<track-id>/left.md`.

Research behind this plan (committed with the scaffold, read it before building):
`research/wave3/agent-parity.md`, `research/wave3/expenses-timeoff.md`, `research/wave3/integrations-hr.md`,
`research/wave3/integrations-screening-esign.md`, `research/wave3/topbar-design.md` (plus its mockup and screenshots).

## 1. Agent parity: the gaps this wave closes

The parity audit lists 57 capabilities: 17 done, 21 partial, 19 missing. Weft already matches or beats the reference
on acting as the requesting person, money ceilings, the audit log with rollback, run logs, rate-change notices, state
registration, pre-payroll checks, offboarding with COBRA, benefits reconciliation, contractor payouts, a public MCP
tool list, taint tracking, grounded numbers and git memory. The gaps below are ranked by demo value; the owner track
is in brackets.

| Rank | Gap closed in wave 3 | Track |
|---|---|---|
| 1 | Expenses: policy engine, review routine, one decision per item, reimbursement in the next payroll | w3-expenses |
| 2 | Time Off: ledger in minutes, accruals on processed runs, requests with balance and coverage checks, routing to the manager, PTO lines in payroll, final pay from the ledger | w3-timeoff |
| 3 | Chat that can propose (off-cycle pay, one expense, one time-off request), gated by a setting | w3-parity-chat |
| 4 | Chart answers: `reports.query` (7 metrics) rendered in the agent panel, plus the artifacts route (501 today) | w3-parity-chat |
| 5 | Interactive approval card with Approve, Deny and Open in the agent panel and the chat simulator | w3-parity-chat |
| 6 | Per-routine autonomy control: recommend, approve, auto (auto never runs R4, never in a tainted run) | w3-parity-routines |
| 7 | Monthly exec report (1st of the month) and Monday exec briefing (ships disabled) | w3-parity-routines |
| 8 | New Hire Ready Check three business days before a start date | w3-parity-routines |
| 9 | Milestones: work anniversaries, plus opt-in synthetic birthdays (month and day only) | w3-parity-routines |
| 13 | Anomaly rules: duplicate supplemental, raise not applied, withholding changed | w3-parity-routines |

If a builder finishes early: rank 10 (more notice kinds with specialist escalation), rank 11 (routine gallery with last
and next run), rank 12 (30-day check-in), rank 15 (contractor W-9 and W-8 forms with expiry), task agents
(`openChildRun`) and learning from overrides. Everything else in the parity file is deferred (section 9).

Decisions the architect made where the research left a choice:

- **Chat that can propose ships off by default.** Harness 5.3 now carries a wave 3 amendment: `CHAT_ACT_TOOLS` (16)
  is offered only when the company setting `agent.chat_can_propose` is on and code reads an action intent in the
  request. Every write on it is R2 or R4 with approval always, so chat files proposals and never executes. The
  setting stays off until Nitish says yes; the GP15 scenario turns it on explicitly.
- **Auto autonomy ships behind `agent.allow_auto_autonomy` (default off).** The three-way control renders; auto is
  selectable only when the setting is on. Changing autonomy is itself a proposal.
- **Managers become real, narrow principals.** One seeded manager (`usr_imani`, role `manager`, linked to
  wrk_0004) approves time off for direct reports only; the direct-report check lives inside `time_off.decide` (and,
  since the fixer round, `time_off.reopen`), so the grant model is unchanged. Expense manager routing is still open
  (section 10 and the README's "Wave 3: left"). Routing skips a manager whose worker is not active (GP9 terminates Imani
  in its own world and the demo walks GP9 before GP14), falling back to the department lead, then Dana.
- **Birthdays are opt-in and synthetic**: `workers.birth_month_day` (`MM-DD`, never a year), seeded for about half
  the people. Anniversaries come from the start date.
- **No new grant domains.** Expense commands use the `payroll` domain and time-off commands the `people` domain, so
  the executor grant model and the settings screen do not change.

## 2. Expenses and Time Off

Both follow `research/wave3/expenses-timeoff.md` sections 6 to 9. The parts that are binding:

**Expenses (w3-expenses).** Statuses `submitted`, `needs_review`, `returned`, `approved`, `approved_taxable`,
`declined`, `scheduled`, `paid`, shown in four bands (Needs review, Approved, Paid out, Declined; `EXPENSE_BANDS`).
A deterministic policy engine writes checks in the paycheck flag shape (12 rule codes in `ExpenseRuleCode`, 2026
rates in `EXPENSE_RATES`). `expenses.decide` takes exactly one id, is R2 with approval always for agents, and there is
no bulk decide anywhere; a registry test and an agent scenario ("approve all open expenses") enforce it. Approved items
attach to the earliest draft regular run whose deadline has not passed: non-taxable amounts go to
`reimbursements_cents` and `reimbursements_json` (outside gross, inside net and the bank entry), `approved_taxable`
items become a `taxable_reimbursement` earning line. `payroll.processed` marks them paid. Routine
`rt_expense_review` (event `expense.submitted`, weekday 09:00 PT, manual) explains each item and proposes one decision
per item. Receipts are seeded images with sidecar extraction JSON; no OCR and no model calls. Employee-entered fields
are untrusted and taint the run. Seed: 8 `needs_review` items (the hand-computed cases), plus approved and declined
history. Do not mark any expense paid in an already processed run (that would change seeded paychecks); paid history
comes from processing the open draft.

**Time Off (w3-timeoff).** All amounts are integer minutes in an append-only `time_off_ledger`; balances are sums
(`TimeOffBalance`). Accruals post from the `payroll.processed` handler for regular runs, idempotent on
`time_off_ledger.run_key`. Requests compute their minutes from the dates and the 2026 holiday calendar; the employee
never types an amount. Checks (`TimeOffCheckRule`) include insufficient balance, waiting period, use cap and increment
(block), coverage conflict and payroll deadline overlap (review), holiday and short notice (info). Approval is
`time_off.decide`, R2, routed to the manager. Payroll splits salaried gross into salary, pto, sick and paid_holiday
lines at annual / 2,080 per hour (gross unchanged); hourly leave lines are added. The simulated PTO accrual in
`packages/core/src/payroll/offcycle.ts` is replaced by the ledger balance: Imani's imported balance is 5,063 minutes so
GP9 still pays 90.00 h and 1,003,846 cents. Routine `rt_time_off_requests` runs on `time_off.request.created`. Seed:
one vacation policy, per-state sick policies, the coverage demo in Hardware (Ruth's pending request puts 3 of 9 out on
Nov 23 to 25, 33.3% over the 30% limit) and one approved TX request inside the open draft so it shows a `pto` line.

## 3. Integrations

### 3.1 Framework (landed in the scaffold)

- Contracts in `packages/contracts/src/wave3.ts`: `IntegrationVendor`, `ConnectorMode` (`simulated` or `real`),
  `ConnectorStatus`, `IntegrationCard`, `SyncItem`, the four connector interfaces (`AtsConnector`, `HrisConnector`,
  `ScreeningConnector`, `ESignConnector`), `VendorConnectors`, `INTEGRATION_SECRETS`, `VENDOR_APPLY_COMMAND`.
- Simulators: `Simulators.vendors` holds one simulated connector per vendor (`packages/sim/src/vendors/*.ts`). They
  follow each vendor's published API shapes, write only `sim_vendor_records` and `sim_webhook_outbox`, read the sim
  clock and check the fault injector. Scaffold stubs answer `status()` and throw NotImplemented otherwise.
- Real adapters: the new package `@weft/integrations` is the only code that calls a vendor over HTTP.
  `createVendorOverlay()` swaps in a real adapter only when `WEFT_INTEGRATIONS_REAL=1` and every required secret for
  that vendor is present in the file named by `WEFT_SECRETS_FILE`. Tests can never run one (`LIVE_INTEGRATION_IN_TEST`),
  and `apps/api/src/compose.ts` passes no overlay in test mode. `packages/agent` and `packages/routines` may not import
  it (`tests/boundaries.test.ts`). Secrets are reported as present or missing, never as values.
- Webhooks: one public route `POST /v1/integrations/:vendor/webhook`. Verify the HMAC over the raw bytes in constant
  time, store the delivery in `integration_deliveries` (dedupe key unique, ids only, never the body), return quickly,
  then apply it through the vendor's system command (`VENDOR_APPLY_COMMAND`) after re-reading the record. Since a
  local Weft has no public URL, polling on the scheduler tick is the baseline (`apps/api/src/integrations/poll.ts`).
- Data: `integration_connections`, `ext_links` (one Weft record per vendor record), `ext_snapshots` (conflict
  detection), `sync_items` (human-only Inbox items for conflicts and unmapped values).
- Screen: `/app/integrations` (nav entry landed, labeled Simulated) renders `GET /v1/integrations` cards with the
  mode badge, secret names with present or missing, the free path, a test button and the simulate controls. The copy is
  in `packages/integrations/src/cards.ts`, in Weft's own words; vendor names are used only to say what Weft connects
  to, with no logos.

### 3.2 Per vendor: what runs, and what Nitish must do to make it real

| Vendor | Wave 3 builds | Free path | What Nitish does himself to turn it real |
|---|---|---|---|
| Greenhouse | Simulator on Harvest v3 shapes (cursor paging, versioned offers, salary custom field, signed `hire_candidate` deliveries); real adapter for Harvest v3 read-only; the public job board read with no key (opt-in live smoke `WEFT_LIVE_PUBLIC=1`) | No free sandbox for individuals. The simulator plus the public job board | Only through an employer's Greenhouse account or a Pro-tier sandbox: a Site Admin creates Harvest V3 (OAuth) credentials with read-only scopes, then `WEFT_GREENHOUSE_CLIENT_ID` and `WEFT_GREENHOUSE_CLIENT_SECRET` go in the secrets file. Optional webhook needs a public HTTPS URL he runs |
| Workday | Simulator (`{ total, data }` envelopes, references with WIDs, the time-off request flow, updated window); real adapter skeleton for SOAP `Get_Workers` and REST time off; Workday owns People, Compensation and Time off when connected, and its entries fill the native Time Off model read-only | Developer program personal tenant (beta, 7-day inactivity expiry, included APIs not stated) | Sign up at developer.workday.com himself and read the terms, request a development tenant, register an API client and an integration system user, then put the six `WEFT_WORKDAY_*` values in the secrets file |
| Checkr | Simulator with Checkr-shaped invitations, reports and adverse actions, signed webhooks into the real verification path; adapter written to the published spec that refuses production unless `WEFT_LIVE_CHECKR=1`, never run live in wave 3 | None for individuals (staging needs a credentialed business) | Credential a real business with Checkr (EIN, articles, permissible purpose) or apply as a partner, and get Checkr's written view on automated access before any live use. Then `CHECKR_API_KEY` |
| HireRight | Simulator labeled "Simulated, API shape not published"; the live adapter always refuses `INTEGRATION_NOT_AVAILABLE` | None | A HireRight customer contract and an assigned technical consultant; nothing possible for free |
| DocuSign | Real adapter (JWT grant, one envelope per offer with both documents, embedded signing from the portal, Connect HMAC, polling at most every 20 minutes per envelope) behind `WEFT_ESIGN=docusign` and `WEFT_LIVE_DOCUSIGN=1`; a small DocuSign-shaped simulator for the parser; built-in click to sign stays the default and the only path in the golden paths | Free developer account, full eSignature API in the demo environment | Create the developer account, an app with an integration key and RSA key pair (PEM saved outside every repo), grant consent once, then `DOCUSIGN_INTEGRATION_KEY`, `DOCUSIGN_USER_ID`, `DOCUSIGN_ACCOUNT_ID`, `DOCUSIGN_PRIVATE_KEY_FILE` (a path) in the secrets file |

Screening rules that hold in every mode: `screening.order` is R4 with approval always, refused before the offer is
accepted (`DOMAIN_SCREENING_BEFORE_OFFER`), priced from the package row, and capped by `agent.screening_cents`.
Consent is collected by the screening company (the simulator renders a labeled simulated apply page). Reviewing a
report and every adverse action step are human-only commands on no model surface; agent reads return status, result,
ETA and timestamps only. NYC orders run non-criminal first, then criminal after a human proceed step. A new
`background_check` onboarding task completes only from vendor events or a human engage; it does not block the first
payroll by default. Offers gain a final `declined` state (`OFFER_TRANSITIONS_W3`) for a declined envelope.

## 4. Top bar redesign (w3-topbar-shell)

Implements `research/wave3/topbar-design.md` decisions D1 to D11:

- Search moves to the top of the sidebar, with a New agent thread button beside it; a ghost search icon shows in the
  bar when the sidebar is hidden; Cmd or Ctrl+K works everywhere.
- The bar becomes: sidebar toggle, breadcrumb, one environment pill (model, then simulated clock, then Viewing as),
  and the agent toggle.
- Every bar control is 32 px at radius 8; pill segments are 28 px at radius 6 inside a 2 px pad, with 1 by 16 dividers.
- Labels are 13 px (14 px only for the breadcrumb), icons 16 px.
- Color carries status only (the model dot, the amber persona avatar), and one focus ring is used everywhere.
- The persona control becomes a Radix DropdownMenu grouped by admins, managers, employees and new hires.
- The model popover shows spend from `GET /v1/agent/costs`. The clock popover can advance time.
- The bar collapses in three tiers by container width: Full, Compact, Mini.
- Shell fixes: breadcrumbs show the page title instead of raw ids, one sidebar badge style, the two-line workspace
  row, three page widths, and one status badge map.
- The `--tb-*` tokens and the three page width tokens landed in `packages/ui/src/tokens.css`.
- `e2e/gp6-offer-portal.spec.ts` line 34 changes from an `<option>` to a menu item; the `viewAs` fixture already
  handles menu items.

## 5. New golden paths

Each has a scenario test under `tests/scenarios/` on the scripted provider and, where marked, a Playwright spec.

**GP13. Expense review to reimbursement (w3-expenses, e2e `gp13-expenses.spec.ts`).** Expenses shows the four bands
with the seeded counts. `rt_expense_review` explains each needs-review item and proposes one decision per item (approve
clean, decline the duplicate, return the missing receipt, a human note for over-limit in CA). Asked to approve
everything, the agent refuses bulk approval and offers to go item by item. Dana approves two proposals in the Inbox; the
open draft shows their reimbursements on the right paychecks (outside gross, inside net and the bank entry); processing
the run marks them Paid out.

**GP14. Time off with a coverage conflict (w3-timeoff, e2e `gp14-time-off.spec.ts`).** Ruth's pending vacation shows
`COVERAGE_CONFLICT` for Nov 23 to 25 (3 of 9 out) and `INCLUDES_HOLIDAY` for Nov 26 and 27, routed to Imani.
`rt_time_off_requests` summarizes balance before and after and proposes a decision. Viewing as Imani, she approves; the
holds become use rows, the balance drops, and the calendar marks the days. The TX request shows a `pto` line in the open
draft with gross unchanged, and an accrual posts when that run processes. GP9 still pays 90.00 h.

**GP15. Chart answer and approval card (w3-parity-chat, e2e `gp15-chat-chart.spec.ts`).** Asked for payroll cost by
month, chat calls `reports.query` and the panel renders a bar chart with a table fallback. With
`agent.chat_can_propose` on, asking for the missed off-cycle payment (GP10) files a proposal, and its card in the feed
shows fields from the stored preview with Approve, Deny and Open; Approve executes once through the same decide path as
the Inbox. With the setting off, the same request is answered read-only.

**GP16. Routine parity (w3-parity-routines, scenario tests; e2e for the autonomy control in `gp16-routines.spec.ts`).**
New Hire Ready Check posts one ready line and one blocked list naming owners; the monthly exec report posts to
#leadership with numbers from derived args; milestones post anniversaries; the three new anomaly rules fire on seeded
cases; a routine at auto approves a clean expense under the cap and proposes one above it, and a tainted run falls back
to approve.

**GP17. Greenhouse hire to Weft offer (w3-integrations-hr, e2e `gp17-greenhouse-hire.spec.ts`).** On Integrations,
"Simulate a hire" makes the Greenhouse simulator deliver a signed `hire_candidate`. Weft verifies and dedupes it,
re-reads the hire, and creates a draft offer linked in `ext_links`. `rt_ats_hire` flags an unmapped office as a sync item
and proposes sending the offer; GP6 then runs unchanged. A second delivery with the same id is a no-op, and a changed
start date becomes a sync conflict in the Inbox. A Workday scenario syncs one changed worker and two approved time-off
entries into the native model as read-only.

**GP18. Background check and envelope (w3-integrations-screening-esign, scenario; e2e `gp18-screening.spec.ts` if time).**
After acceptance, the new-hire routine proposes `screening.order` (R4, price from the package). On approval the
simulator invites the candidate; the simulated apply page records consent; the report completes clear on the sim clock
through a signed webhook, and the `background_check` task completes. A consider result opens a human-only Inbox item
and no agent read contains record text. With `WEFT_ESIGN=docusign` in the simulator, an offer goes out as one envelope
and completes; the built-in path stays byte-identical for GP6.

**GP19. Coherent top bar (w3-topbar-shell, e2e `site-topbar.spec.ts`).** At 1440 docked, 1280 docked, 1024 and 390 the
header never overflows; every bar control measures 32 px and every segment 28 px; Tab shows the same ring on every
control; no badge fill appears in the bar; the persona menu switches personas.

## 6. Shared additions landed on main (scaffold commit)

| Area | What landed |
|---|---|
| Contracts | `packages/contracts/src/wave3.ts`: expense and time-off enums, DTOs and request bodies, `EXPENSE_RATES`, `COVERAGE_DEFAULTS`, report metrics and `ChartSpec`, `ApprovalCardW3`, `CHAT_TOOLS_W3`, `CHAT_ACT_TOOLS`, `W3_SETTINGS`, `W3_CEILINGS`, `RoutineAutonomy`, the integration types and connector interfaces, `OFFER_TRANSITIONS_W3`, `ScreeningOrder`, `EsignEnvelope`, `W3_PLANNED_COMMANDS` (every planned command with owner, risk, access and approval), `Wave3EventBody`, `WAVE3_ID_PREFIXES`; test ids in `packages/contracts/src/w3/*.ts` |
| Contract edits | `Namespace` gains `expenses`, `time_off`, `reports`, `integrations`, `ats`, `hris`, `screening`; `RoutineDef.autonomy` gains `auto`; `CommandDef.autoEligible` (optional limits key); `OfferStatus` gains `declined`; `OnboardingTaskKind` gains `background_check`; `HumanRole` gains `manager`; `ChatChannel` gains `#leadership`; `FlagRule` gains six rules; `TrackId` and `RouteFile` gain the wave 3 values; `ID_PREFIXES` and `EVENT_PAYLOAD_PREFIXES` gain the wave 3 prefixes; `parseEventBody` accepts wave 3 events; `Simulators.vendors` |
| DB | migration `0006_wave3.sql` and schema section 6.8: `expense_policies`, `expenses`, `paychecks.reimbursements_json`, `time_off_types`, `time_off_policies`, `time_off_assignments`, `time_off_ledger`, `time_off_requests` (with `source` and `ext_ref` for Workday), `holiday_calendars`, `holidays`, department coverage columns, `workers.birth_month_day`, `checkins`, `contractor_tax_forms`, `integration_connections`, `ext_links`, `ext_snapshots`, `integration_deliveries`, `sync_items`, `screening_packages`, `screening_orders`, `esign_envelopes`, `signature_evidence`, `sim_vendor_records`, `sim_webhook_outbox` |
| Routes | 37 route table rows; new route files `expenses`, `time-off`, `reports`, `integrations`, `screening` mounted in `app.ts`; agent settings rows in `settings.ts` and the autonomy row in `routines.ts`; all answer 501 |
| Commands | empty arrays in `packages/core/src/commands/{expenses,time-off,reports,integrations,screening,parity}.ts`, concatenated in `commands/index.ts`; the planned system commands are on the `svc_events` and `svc_scheduler` allowlists |
| Payroll seams | `packages/core/src/payroll/w3-hooks.ts`: compute calls `timeOffEarnings` and `reimbursementsFor`, the pre-payroll rules call `w3Flags`; stub files `expenses/{payroll,flags}.ts`, `time-off/{payroll,flags}.ts`, `payroll/parity-flags.ts` change nothing until filled |
| Handlers | `packages/core/src/{expenses,time-off,integrations}/handlers.ts` concatenated in `handlers/index.ts` |
| Scheduler | tick steps `integrations.poll` (`apps/api/src/integrations/poll.ts`, which calls `poll-screening.ts`) and `time_off.year_end` (`apps/api/src/time-off/year-end.ts`), both no-ops |
| Integrations | new package `@weft/integrations` (mode selection, `LIVE_INTEGRATION_IN_TEST`, secrets presence, HMAC helpers, vendor copy, the overlay, real adapter stubs); vendor simulator stubs in `packages/sim/src/vendors/`; compose passes the overlay outside test mode; the import scan bans it from the brain |
| Routines | `packages/routines/src/wave3/{expenses,time-off,parity,integrations-hr,screening}.ts` spread into PREBUILT, PRECHECKS and PREDICATES |
| Seed | no-op steps `w3_expenses`, `w3_timeoff`, `w3_parity`, `w3_integrations_hr`, `w3_screening_esign` after the wave 2 steps |
| Web | Integrations nav entry and placeholder page; portal slot `components/portal/w3-sections.tsx` with stub sections for expenses, time off and screening; labels for the six new flag rules; top bar tokens |
| Harness | research/harness.md 5.3 wave 3 amendment (chat proposals, gated by `agent.chat_can_propose`) |

## 7. Rules for wave 3 builders

All of AGENTS.md and the wave 2 rules still apply (brand, prose, git identity with no Co-Authored-By trailer, ports and
process groups, models and spend, money in integer cents, `date` often). In addition:

1. **Owned paths are disjoint.** Edit only the files listed under your track. If you need a change elsewhere, write
   it to `.scratch/contract-requests/<track-id>.md` and work around it; the integrator folds it in.
2. **The wave 3 contracts are frozen** like the earlier ones: `packages/contracts/src/wave3.ts`, the wave 3 rows in
   `api.ts`, the new enum values, schema section 6.8 and `0006_wave3.sql`, `payroll/w3-hooks.ts`, the seam files'
   signatures, `components/portal/w3-sections.tsx`. Additive needs go in `packages/contracts/src/ext/<track-id>.ts`
   (exports prefixed with the track) plus a contract request. A track that needs a column writes
   `packages/db/drizzle/0007_<track-id>.sql` and a matching block at the end of `schema.ts` only after asking the
   integrator (renumbered at merge).
3. **Stubs answer 501** until replaced: register real handlers before the `stubRoutes(...)` call and pass the keys
   you implement as `except`.
4. **Commands** follow the planned table in `W3_PLANNED_COMMANDS`: zod input, honest `risk` and `approval`, `preview`
   for anything that proposes, `access: "human_only"` for signing, adverse action, sync conflict resolution and the
   employee's own submissions. Consequential writes are proposals. Update the registry snapshot test in the same commit.
5. **Seed** additions go in your own `packages/seed/src/w3-*.ts` step. Never change wave 1 or wave 2 seed counts,
   never edit processed runs, keep every name `(demo)` and every domain `*.example`.
6. **Routines** go in your `packages/routines/src/wave3/<area>.ts`, ship disabled unless their golden path needs them,
   use at most 8 tools, and come with scripted scenarios in `scenarios/<routine id>*.json`.
7. **Integrations**: never create accounts, sign up, accept terms or enter credentials on any website. Real adapters
   read credentials only through `@weft/integrations` `readSecret` (`WEFT_SECRETS_FILE`); never print, log, commit or
   copy them. With no credentials every integration runs its simulator and the UI says Simulated. Read-only calls to
   public unauthenticated endpoints (the public job board) are allowed sparingly, only behind `WEFT_LIVE_PUBLIC=1` in
   tests. Never vendor a vendor's spec file; hand-write zod schemas for the fields Weft uses. Never copy logos or
   marketing copy.
8. **Live spend**: at most about $0.25 per track and $1 for the wave; tests use the scripted provider only.
9. **Ports**: each track runs e2e on its own pair (below) through `WEFT_E2E_WEB_PORT` and `WEFT_E2E_API_PORT`; never
   3070, 4070, 3170 or 4170; never touch `.data` or `apps/web/next-env.d.ts` in the main checkout.

| Track | Web port | API port |
|---|---|---|
| w3-topbar-shell | 4610 | 4611 |
| w3-parity-chat | 4620 | 4621 |
| w3-parity-routines | 4630 | 4631 |
| w3-timeoff | 4640 | 4641 |
| w3-expenses | 4650 | 4651 |
| w3-integrations-hr | 4660 | 4661 |
| w3-integrations-screening-esign | 4670 | 4671 |

## 8. Tracks

Each track works in its own git worktree from the wave 3 scaffold commit, on branch `w3/<track-id>`. "Owns" lists new
folders and files, then the exact existing files the track may edit. Nobody else edits them. Every track also owns
`docs/tracks/<track-id>.md`, `packages/contracts/src/ext/<track-id>.ts` and `.scratch/<track-id>/`.

### w3-expenses

- New or stubbed: `apps/api/src/routes/expenses.ts`, `packages/core/src/commands/expenses.ts`,
  `packages/core/src/expenses/**`, `packages/seed/src/w3-expenses.ts`, `packages/routines/src/wave3/expenses.ts`,
  `packages/contracts/src/w3/testids-expenses.ts`, `apps/web/src/app/(app)/app/expenses/**`,
  `apps/web/src/components/app/expenses/**`, `apps/web/src/components/portal/expenses/**`,
  `apps/api/test/expenses.test.ts`, `packages/core/test/expenses/**`, `tests/scenarios/gp13-*.test.ts`,
  `e2e/gp13-expenses.spec.ts`, `scenarios/rt_expense_review*.json`, `scenarios/chat_expenses*.json`
- Existing: `packages/core/src/payroll/lifecycle.ts` (write `reimbursements_json` from `reimbursementLines` only)

### w3-timeoff

- New or stubbed: `apps/api/src/routes/time-off.ts`, `apps/api/src/time-off/**`, `packages/core/src/commands/time-off.ts`,
  `packages/core/src/time-off/**`, `packages/seed/src/w3-timeoff.ts`, `packages/routines/src/wave3/time-off.ts`,
  `packages/contracts/src/w3/testids-timeoff.ts`, `apps/web/src/app/(app)/app/time-off/**`,
  `apps/web/src/components/app/time-off/**`, `apps/web/src/components/portal/time-off/**`,
  `apps/api/test/time-off.test.ts`, `packages/core/test/time-off/**`, `tests/scenarios/gp14-*.test.ts`,
  `e2e/gp14-time-off.spec.ts`, `scenarios/rt_time_off_requests*.json`
- Existing: `packages/core/src/payroll/offcycle.ts` (ledger balance replaces the simulated accrual; GP9 numbers stay),
  the offboarding unit test that pins the old month rule, `apps/web/src/components/app/people/people-view.tsx` (a Time off
  tab only), `apps/web/src/components/app/home/home-view.tsx` (a Time Off tile only),
  `packages/routines/src/prechecks.ts` (the `peopleDigest` out-this-week line only, cut first if GP4 moves)

### w3-parity-chat

- New or stubbed: `apps/api/src/routes/reports.ts`, `packages/core/src/commands/reports.ts`, `packages/core/src/reports/**`,
  `apps/api/src/agent/**` (intent check, allowlist choice), `apps/web/src/components/app/agent/chart.tsx`,
  `apps/web/src/components/app/agent/approval-card.tsx`, `packages/contracts/src/w3/testids-parity.ts` (the
  `W3_CHAT_TID` block), `apps/api/test/reports.test.ts`, `apps/api/test/agent-artifacts.test.ts`,
  `tests/scenarios/gp15-*.test.ts`, `e2e/gp15-chat-chart.spec.ts`, `scenarios/chat_*.json` (new files only, except the
  expense chat scripts), `evals/live/l5-*` (one live eval, under $0.02)
- Existing: `apps/api/src/routes/agent.ts` (artifacts route, chat allowlist selection), `packages/executor/src/proposals.ts`
  (card JSON fields from the stored preview), `apps/web/src/components/app/agent/run-feed.tsx`,
  `apps/web/src/components/app/agent/run-steps.ts`, `apps/web/src/components/app/simulators/**` (card rendering in the
  chat simulator), `apps/web/src/components/app/inbox/**` (only if the card shares the Inbox decide helper)
- Stretch, only after the cut line is green: task agents (`openChildRun`, `packages/executor/src/runs.ts`) and learning
  from overrides (`packages/executor/src/memory/preferences.ts`)

### w3-parity-routines

- New or stubbed: `packages/routines/src/wave3/parity.ts`, `packages/core/src/commands/parity.ts`,
  `packages/core/src/parity/**`, `packages/core/src/payroll/parity-flags.ts`, `packages/seed/src/w3-parity.ts`,
  `packages/contracts/src/w3/testids-parity.ts` (the `W3_ROUTINES_TID` block), `packages/routines/test/wave3/**`,
  `packages/executor/test/autonomy.test.ts`, `tests/scenarios/gp16-*.test.ts`, `e2e/gp16-routines.spec.ts`,
  `scenarios/rt_new_hire_ready*.json`, `scenarios/rt_monthly_exec_report*.json`, `scenarios/rt_exec_briefing*.json`,
  `scenarios/rt_milestones*.json`, `scenarios/rt_thirty_day_checkin*.json`, `scenarios/rt_contractor_forms*.json`
- Existing: `packages/routines/src/engine.ts` (autonomy enforcement), `packages/executor/src/policy.ts` (the auto level:
  `autoEligible` R2 under its limit, never R4, never tainted), `apps/api/src/routes/settings.ts` (the agent settings
  rows), `apps/api/src/routes/routines.ts` (the autonomy route), `apps/web/src/components/app/routines/**`,
  `apps/web/src/app/(app)/app/routines/**`, `apps/web/src/app/(app)/app/settings/page.tsx`,
  `apps/web/src/components/app/compliance/**` (escalations, if rank 10 is reached)

### w3-integrations-hr (framework, Greenhouse, Workday, the Integrations screen)

- New or stubbed: `packages/integrations/**` except `src/real/{checkr,hireright,docusign}.ts`,
  `packages/sim/src/vendors/{greenhouse,workday}.ts`, `apps/api/src/routes/integrations.ts`,
  `apps/api/src/integrations/poll.ts`, `packages/core/src/commands/integrations.ts`,
  `packages/core/src/integrations/**` except `screening-handlers.ts`, `packages/seed/src/w3-integrations-hr.ts`,
  `packages/routines/src/wave3/integrations-hr.ts`, `packages/contracts/src/w3/testids-integrations.ts`,
  `apps/web/src/app/(app)/app/integrations/**`, `apps/web/src/components/app/integrations/**`,
  `apps/api/test/integrations.test.ts`, `packages/sim/test/vendors/{greenhouse,workday}.test.ts`,
  `packages/core/test/integrations/**`, `tests/scenarios/gp17-*.test.ts`, `e2e/gp17-greenhouse-hire.spec.ts`,
  `scenarios/rt_ats_hire*.json`
- Existing: none. Workday-owned field locks on the person view go through a contract request to w3-timeoff.

### w3-integrations-screening-esign (Checkr, HireRight, DocuSign)

- New or stubbed: `packages/sim/src/vendors/{checkr,hireright,docusign}.ts`,
  `packages/integrations/src/real/{checkr,hireright,docusign}.ts`, `apps/api/src/routes/screening.ts`,
  `apps/api/src/integrations/poll-screening.ts`, `packages/core/src/commands/screening.ts`,
  `packages/core/src/screening/**`, `packages/core/src/esign/**`, `packages/core/src/integrations/screening-handlers.ts`,
  `packages/seed/src/w3-screening-esign.ts`, `packages/routines/src/wave3/screening.ts`,
  `apps/web/src/components/portal/screening/**`, `apps/web/src/components/app/screening/**`,
  `apps/api/test/screening.test.ts`, `packages/sim/test/vendors/{checkr,hireright,docusign}.test.ts`,
  `packages/core/test/screening/**`, `tests/scenarios/gp18-*.test.ts`, `e2e/gp18-screening.spec.ts`
- Existing: `packages/core/src/portal/offers.ts` (envelope on send and void, only with `WEFT_ESIGN=docusign`),
  `packages/core/src/portal/forms.ts` (acceptance from a completed envelope only), `packages/core/src/onboarding/writes.ts`
  (refuse completing `background_check` by hand), `apps/web/src/components/app/hiring/hiring-view.tsx` (screening and
  envelope status), `apps/web/src/components/portal/portal-view.tsx` (the embedded signing redirect only). The built-in
  path must stay byte-identical: GP6 and GP7 do not change.

### w3-topbar-shell

- New or stubbed: `apps/web/src/components/app/status-badge.tsx`, `apps/web/src/components/app/shell/**` (new files),
  `packages/ui/src/components/dropdown-menu.tsx`, `packages/contracts/src/w3/testids-shell.ts`, `e2e/site-topbar.spec.ts`
- Existing: `apps/web/src/components/app/shell/{header,sidebar,app-shell,command-menu}.tsx`,
  `apps/web/src/components/app/agent/agent-panel.tsx` (panel header buttons only), `apps/web/src/components/app/nav.ts`
  (badges and crumbs; drop "soon" for Expenses and Time Off at merge), `apps/web/src/components/app/page.tsx` (page
  widths, crumb title), `packages/ui/src/components/{kbd,index}.ts*`, `packages/ui/src/tokens.css` (shell tokens only),
  `apps/web/src/app/(app)/app/{people,payroll}/[id]/page.tsx` (crumb title only), `e2e/gp6-offer-portal.spec.ts`
  (persona menu step only), `SPEC.md` section 11.3, `research/design.md` section 13.3

### Acceptance and cut lines

Every track also passes `pnpm test`, `pnpm typecheck`, `pnpm lint:prose`, `pnpm lint:brand` and `pnpm brand:overlap`
on its branch rebased onto main, plus the existing e2e specs that touch its screens.

| Track | Acceptance | Cut line (finish this well if time runs short) |
|---|---|---|
| w3-expenses | Policy engine with the hand-computed cases; four bands; one decision per call and no bulk decide (registry test and agent scenario); reimbursements on the next draft outside gross and paid on processing; taxable path past 60 days; `rt_expense_review`; GP13 scenario and e2e | Engine, list and drawer, `expenses.decide` as a proposal, reimbursement in the draft (no routine, no portal submit) |
| w3-timeoff | Ledger and balances in minutes; accruals idempotent per run; request minutes from dates and holidays; the eight checks; routing to Imani with fallback; decide as a proposal; PTO lines with gross unchanged; final pay from the ledger with GP9 unchanged; `rt_time_off_requests`; GP14 scenario and e2e | Ledger, final pay from the ledger, requests with checks and routing, Requests tab (no calendar, no payroll lines) |
| w3-parity-chat | `reports.query` with SQL tests per metric and a golden chart spec; artifacts route; chart in the panel with a table fallback; card JSON from the preview with Approve, Deny, Open; chat proposals gated by the setting, approve-all still refused, nothing executes from chat; GP15 scenario and e2e | `reports.query` with the chart in the panel and the interactive card (chat proposals stay off) |
| w3-parity-routines | Autonomy control with the policy snapshot per level; Ready Check, exec report, milestones with scenarios; three anomaly rules with seeded cases; agent settings route; GP16 | Ready Check, exec report and the three anomaly rules (autonomy UI and milestones in left.md) |
| w3-integrations-hr | Overlay and mode tests; webhook verify, dedupe and apply; Greenhouse simulator with the hero flow to a draft offer and sync conflicts; public job board fixture test; Workday simulator syncing workers and time off read-only; Integrations screen with modes and secret presence; GP17 | Framework, Greenhouse simulator hero flow and the Integrations screen (Workday in left.md) |
| w3-integrations-screening-esign | HMAC vectors for both vendors on raw bytes; Checkr-shaped simulator with the state machine and timers; screening order as R4 proposal after acceptance only; human-only adverse path with no record text on model surfaces; `background_check` task; DocuSign adapter against recorded shapes plus the simulator; builtin path unchanged; GP18 scenario | Screening simulator, `screening.order`, status into the checklist, human-only adverse steps (DocuSign in left.md) |
| w3-topbar-shell | D1 to D11; measured heights and no overflow at four widths; one focus ring; persona menu; popovers; GP19 and every existing e2e spec | The bar itself (pill, tokens, persona menu, focus ring) with GP19; sidebar search and shell fixes in left.md |

Merge order (lowest conflict risk first): w3-topbar-shell, w3-parity-chat, w3-parity-routines, w3-timeoff,
w3-expenses, w3-integrations-hr, w3-integrations-screening-esign. After each merge the integrator runs `pnpm test` and
`pnpm typecheck`; after the last, the full gate on a fresh clone (test, typecheck, build, e2e, demo with GP1 to GP19).

## 9. Deferred past wave 3

Employee self-service questions in the portal, recurring filings and a compliance calendar, wait-and-resume routine
steps, state-required training, life-event benefit windows and carrier election filing, tagging the agent in a chat
thread, a CLI and outbound webhooks, Greenhouse write-back (`ats.mark_hired`) beyond a proposal stub, Workday payroll
results write-back, Greenhouse Onboarding API, an off-cycle reimbursement run, dark mode for the app, and any live
Checkr or HireRight call.

## 10. Integration, round 1 (2026-10-16)

The seven tracks merged into main in the planned order with `--no-ff`: w3-topbar-shell, w3-parity-chat,
w3-parity-routines, w3-timeoff, w3-expenses, w3-integrations-hr, w3-integrations-screening-esign. Every merge was
clean except the two pinned prebuilt routine id lists (`packages/routines/test/engine.test.ts`,
`apps/api/test/routines.test.ts`), which take the sorted union of every track's ids. The tracks' `contract:` commits
are all additive (route rows in `api.ts`, the `ext/` and `w3/testids-*` files, the policy autonomy fact, sample values
in the registry rule test, the pinned id lists) and came in unchanged; none edits a frozen row.

### What the integrator changed

| Change | Why |
|---|---|
| GP15 denies its card before the approval test | Once GP10's $1,500.00 bonus is paid, `DUPLICATE_SUPPLEMENTAL` (w3-parity-routines) blocks a second identical bonus for Hollis, as it should |
| The `reports.query` tests check what their inserts add | The expense and time-off seeds now hold rows in the same months |
| The chat guard test expects `expenses.decide` and `time_off.decide` | Both are registered act-mode writes, each approval always with no auto-allow, so the guard keeps them |
| `usr_imani` joins the persona list | Viewing as Imani (manager) works; the menu groups her under Managers |
| Expenses and Time Off drop the Coming soon badge, and the soon badge kind is gone | Both are real products now |
| `rt_screening_follow_up` joins PREBUILT (disabled) with `scenarios/rt_screening_follow_up.json` | Merge request from w3-integrations-screening-esign |
| The portal I-9 card reads only `i9_id_image` uploads | A receipt uploaded from the portal showed on the I-9 card |
| The e2e runner (`WEFT_E2E=1`) gets a 6,000 a minute UI limit; real use keeps 1,200 | With every wave 3 spec the suite sat at the limit and failed with 429 (w3-timeoff request 8) |
| `deliverSimWebhooks` reads the screening outbox under the write lock | A libsql transaction runs on its own connection; one opened outside the lock raced `POST /v1/sim/reset`, the reset failed with SQLITE_BUSY and every later e2e spec timed out |
| `pnpm demo` walks GP13 to GP18 after GP12 | Workday runs last, since its first sync takes ownership of People, Compensation and Time off |

### Open contract requests and left items

- w3-parity-chat: `proposals.ts` still uses `CHAT_TOOLS`;
  typed client responses for reports and artifacts; a taint field on `ApprovalCardW3`; a Reports screen; task agents.
- w3-parity-routines: `autoEligible` on `expenses.decide` with a seeded limit for an end-to-end auto test; approval and
  override counts beside the autonomy control; check-in portal form and manager view; contractor form upload; more
  notice precheck branches; the Ready Check reading the holiday calendar; the exec report on `reports.query`.
- w3-timeoff: a portal time-off route; `NEGATIVE_BALANCE` as a FlagRule with a label; a statement block per policy and
  labels for the leave earning types; balances for a hire after the seed before their first request; unpaid salaried
  docking; superseding a pending agent proposal when a request is decided directly.
- w3-expenses: the `expense.submitted` trigger (RoutineDef takes one trigger); the returned-item notification; second
  approver and manager routing; extraction for uploaded receipts; the paycheck drawer listing reimbursement lines;
  exporting `ext/w3-expenses.ts` from the contracts index; narrowing the approve-all chat script match.
- w3-integrations-hr: the real Workday adapter; `ats.mark_hired` and `hris.request_time_off` proposal stubs; unhire and
  orphaned links; sync items in the Inbox; Workday-owned field locks on the person view; skipping unmapped time-off
  types on every poll; both imported routes in `api.ts`.
- w3-integrations-screening-esign: `documents.resend_envelope`; the consent nudge; a Settings switch for the
  screening company; Inbox cards for review orders; a
  background_check label on People; the envelope e2e needs its own run with `WEFT_ESIGN=docusign`.
- w3-topbar-shell: StatusBadge and PageBody in other owners' views; crumb titles for the remaining detail pages; a
  typed `GET /v1/agent/costs`; a base `:focus-visible` rule and reduced motion in PopoverContent; dark mode tokens.

## 11. Integration, round 2 (2026-10-16)

Round 2 worked on branch `integrate/w3` from main at 7b8259c, ran every check from a fresh clone on ports 4740 to 4759
(runner 4744), then fast-forwarded main. It ran the new agent golden paths once live and fixed what they found.

### Live agent golden paths on gpt-5.6-luna

| Case | Golden path | Result |
|---|---|---|
| L5 | GP15 chat proposal (GP10 asked in chat), `evals/live/l5-chat-propose.ts` | passes: one `payroll.propose_off_cycle` proposal, missed_payroll, a 150000 cent bonus, nothing executed; 4 steps, $0.0018 |
| L6 | GP13 `rt_expense_review` | passes: 8 pending single-item `expenses.decide` proposals, exp_0007 declined as a duplicate, none executed; 3 steps, $0.0023 |
| L7 | GP15 chart answer | passes: `reports.query` payroll_cost_by_month, grounded on the first try after the fix below; 2 steps, $0.0012 |
| L8 | GP16 monthly exec report | passes: one #leadership post for October 2026, the derived month and kind; 2 steps, $0.0006 |
| L9 | GP18 `rt_screening_follow_up` | passes: one pending R4 `screening.order` at the catalog price, no order placed, untainted; 2 steps, $0.0007 |
| L10 | GP14 `rt_time_off_requests` | passes: one pending `time_off.decide` for tor_0003 with the balance note and the post; it runs on the zero-token template path (the precheck derives every call), so it makes no model call |

L6 to L10 are new cases in `evals/live/run.ts`. The round spent about $0.016 in total, including the failed first L5
and two L7 reruns; no single run came near the per-run cap.

### What the live runs found, and the fixes

| Finding | Fix |
|---|---|
| `bonus_cents` was a `z.record`; its strict schema renders `propertyNames` and an object with no properties, so live chat dropped `payroll.propose_off_cycle` | The command takes `bonuses: [{worker_id, cents}]` (one per worker, only for workers in `worker_ids`); the planner hash input is unchanged and the person route converts its `bonusCents` body. `strictSchemaProblems` now flags `propertyNames` and `patternProperties`, so the registry tests catch a record input |
| The chat role prompt said chat is read-only, so the first live L5 refused with the proposal tool on its list | The role says code decides through the tool list: with a proposal tool, file one proposal per item and say it waits for approval; without one, explain which screen does it. A generic propose example joins the role |
| `people.search` matched one field whole, so "Hollis Grey" found nobody | Every word must match a first or last name, title, employee number or worker id; the "(demo)" suffix is ignored |
| Asked for payroll cost by month, the model summed the months and grounding sent the total back | `reports.query` returns `range_totals` (every `*_cents` column summed with display strings); the style block asks the model to quote totals from results and to use no em dashes |

### Other round 2 changes

- The HireRight Integrations card reads "Simulated, API shape not published", like the Hiring row; GP17's e2e checks
  it, and the card badges wrap on a narrow card.
- The wave 3 track worktrees and the integration worktree were removed with `git worktree remove`; every
  `track/w3-*` branch and `integrate/w3` are kept. Each track's gitignored `.scratch/<track>/left.md` and contract
  request file were copied into the main checkout's `.scratch/` first.

### Still open after round 2

- Auto autonomy end to end: `expenses.decide` already declares `autoEligible` (`agent.expense_auto_cents`); seed the
  `agent.expense_auto_cents` limit row and add the GP16 auto scenario. Without the row the executor never
  auto-executes, which is the safe default.
- Left by the fixer round (docs/review-log.md): a portal "Request time off" form and a "Request time off" action on
  the admin Time Off page; container-sized Expenses and People tables; the agent panel following new content; one
  shared date formatter for check messages and proposal summaries (they still print ISO dates); full-day docking of
  salaried pay for unpaid leave (spec 6.4); real connection tests for Checkr and DocuSign; reading a public Greenhouse
  board without the Harvest credentials; the expense drawer's decline reason label and the chat card's worker
  grouping.
- No live case yet for GP16's Ready Check and milestones; GP14's routine runs live only on its template path.
- Everything else in section 10's open list, apart from the two items closed above.

