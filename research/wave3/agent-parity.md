# Agent parity: what the reference agent does and what Weft's agent does not yet do

Researched 2026-10-16 for wave 3. Audience: the wave 3 architect and builders. This file extends
`research/product.md` sections 2 to 5 (2026-10-15) with a fresh read of the vendor's pages and a code audit of Weft's
main at `4b18f99`. Everything about the vendor is a paraphrase; no copy, names, art or logos may reach Weft's UI or
docs outside `research/`.

## 0. How to read this file

Evidence marks:

- **[W]** I fetched the page on 2026-10-16 and it states this. It is a vendor claim; nothing about the vendor's
  product was tested.
- **[3P]** a third-party article or listing states it (also unverified).
- **[C]** I read the Weft file named next to it on main `4b18f99` (verified in code, not by running it unless said).
- **[P]** carried over from `research/product.md` (fetched 2026-10-15), not re-fetched.

| Key | Source |
|---|---|
| [agent] | https://warp.co/agent (includes the `#agent-routines`, `#agent-teammate`, `#agent-permissions` anchors) |
| [blog-agent] | https://warp.co/blog/warp-agent (agent release post) |
| [blog-10] | https://warp.co/blog/ai-agents-for-hr (ten HR tasks) |
| [home] | https://warp.co/ |
| [pricing] | https://warp.co/pricing |
| [integrations] | https://warp.co/integrations |
| [hris] | https://warp.co/hris |
| [benefits] | https://warp.co/benefits |
| [comptime] | https://warp.co/blog/comp-time-for-salaried-employees (time-off product notes) |
| [docs] | https://docs.warp.co/llms.txt (API doc index) |
| [help] | https://help.joinwarp.com/en/ and /en/collections/8772256337-employers |
| [fortune] | https://fortune.com/press-releases/warp-agent-hr-automation-2026-09-25/ |
| [sa] | https://siliconangle.com/?p=848241 (SiliconANGLE, 2026-09-25) |
| [aiw] | https://aiweekly.co/alerts/warp-adds-programmable-agents-to-its-ai-native-hr-stack |
| [lapaas] | https://lapaasvoice.com/warp-agent-2-0-hr-routines/ |
| [aiindex] | https://theaiagentindex.com/agents/warp-hr (page says last verified 2026-10-05) |

Status words: **done** (works end to end with tests), **partial** (some of it exists; the gap is named), **missing**
(nothing beyond a placeholder).

What I could not find (searched 2026-10-16): no public help-center article on the agent, routines, expenses, time off,
Slack or MCP ([help] lists 2 collections, 4 popular articles, none on these topics [W]); the API doc index has no MCP,
CLI, expense, reimbursement, document or agent pages [docs] [W]; no blog post on routines, MCP or the API beyond
[blog-agent] and [blog-10] on page 1 of https://warp.co/blog [W] (pages 2 to 11 not read).

## 1. Verdict in one screen

- Of 57 capabilities inventoried below: 17 done, 21 partial, 19 missing (rows marked "done (partial ...)" count as done).
- The biggest single gap is structural, not a feature: **Weft's chat agent cannot do anything.** Its allowlist is the
  frozen read-only 14 (`packages/contracts/src/commands.ts:125-128` [C], harness 5.3), so the reference's chat demos
  (off-cycle pay computed and proposed, an expense walk-through, a custom report with a chart) cannot happen in Weft.
- Second: **Expenses and Time Off are placeholders** (`apps/web/src/app/(app)/app/expenses/page.tsx` and
  `.../time-off/page.tsx` render `Placeholder` "Coming soon" [C]); no table, command or routine exists. The
  reference ships both as prebuilt routines [agent] [W].
- Third: **autonomy is single-valued.** `RoutineDef.autonomy` is `"recommend" | "approve"` and P0 enforces approve
  (`packages/contracts/src/routines.ts:13` [C]); the reference sells recommend, approve and act-on-its-own per workflow
  [blog-agent] [fortune] [aiindex] [W].
- Fourth: **the chat approval card has no buttons and no fields.** The notifier posts
  `{ proposalId, headline, risk, moneyCents }` (`packages/executor/src/proposals.ts:100-106` [C]) and the chat feed
  renders only `m.text` (`apps/web/src/components/app/simulators/simulators-view.tsx:53-70` [C]).
- Fifth: **no charts, no reports.** `recharts@3.10.1` is already a dependency of `apps/web` and imported nowhere
  (`apps/web/package.json`, grep [C]).
- Weft is ahead of the reference's public claims on: taint tracking, grounding of numbers in messages, a hash-chained
  audit log with verification, git memory with dossiers, deterministic prechecks with zero-token skips, and an
  open MCP server whose tool list is public. None of that needs work for parity.

## 2. Capability inventory and audit

### 2.1 Prebuilt routines (the reference's gallery and routine list)

The gallery on [agent] [W] lists nine cards: Monday People Report, Time-Off Requests, Check payroll for anomalies,
New Hire Ready Check, expense review against policy, Monthly Exec Report, Open Enrollment, Celebrate milestones, and
Create your own. The routine side panel lists: onboard a new hire (confirming start date), check payroll for
anomalies (comparing to the last run), order their laptop (on offer signed), send the people report (Mondays) [W].

| ID | Capability (reference) | Source | Weft status | Evidence and the gap |
|---|---|---|---|---|
| R1 | Onboard on offer signed: register the new state, set up payroll, enroll benefits and 401(k), order a laptop, create Google and Slack accounts, send a first-day message | [blog-agent] [fortune] [aiindex] [W] | partial | `rt_new_hire` on `offer.accepted` creates 3 accounts, posts in #new-hires, proposes registrations and the laptop (`packages/routines/src/prebuilt.ts:41-55` [C]); portal checklist and e-sign (GP6, GP7). Gaps: the agent does not enroll benefits or 401(k) (only the hire elects in the portal), no first-day message on the start date, no step that confirms the start date |
| R2 | New Hire Ready Check: before day one confirm accounts, laptop, payroll and benefits | [agent] [W] | missing | No pre-start trigger. Pieces exist: `onboarding.get_checklist`, `it.list_accounts`, `it.list_devices`, `sim.device_delivered` event (`packages/contracts/src/events.ts` [C]), `MISSING_BANK_ACCOUNT` flag |
| R3 | Check payroll for anomalies before each run, against the previous run and employee records; examples a doubled bonus, a missed raise, a withholding change | [agent] [blog-10] [W] | done (rules partial) | `rt_pre_payroll` (`prebuilt.ts:27-39` [C]) plus rules `GROSS_CHANGE HOURS_SPIKE MISSING_BANK_ACCOUNT MISSING_FROM_RUN NEGATIVE_NET NEW_IN_RUN PRORATED TOTAL_CHANGE UNREGISTERED_STATE` (`packages/core/src/payroll/anomalies.ts` [C]). Missing rules: duplicate supplemental, raise effective but not applied, W-4 changed since last run. Trigger is a weekday 9:00 cron on the deadline day, not `payroll.draft_created` |
| R4 | Time-off requests: check balance and team coverage, route to the right approver | [agent] [W] | missing | Placeholder page; final pay uses a simulated accrual of 10 h per month capped at 120 h (`packages/core/src/payroll/offcycle.ts:23-36` [C]) |
| R5 | Review every expense against policy before reimbursement; groups Needs Review, Approved, Paid Out, Declined; columns employee, expense, category, amount, transaction date, status | [agent] [W] | missing | Placeholder page. Seam exists: `paychecks.reimbursements_cents` (`packages/db/src/schema.ts:104` [C]) is always 0 (`packages/core/src/payroll/compute.ts:219,225` [C]) and the bank batch already adds it to net (`packages/core/src/payroll/lifecycle.ts:170,175` [C]) |
| R6 | Monday People Report: hires, departures and time off posted to chat | [agent] [W] | partial | `rt_people_digest` posts headcount, hires, departures and pending approvals to #people-ops (`prebuilt.ts:57-66` [C]); no time off until R4 |
| R7 | Monthly Exec Report on the 1st: headcount, payroll cost, turnover to leadership | [agent] [W] | missing | No report tool, no monthly cron routine |
| R8 | Monday exec briefing combining payroll, schedules, compliance risks, hiring trends, upcoming hires (preconfigured, editable) | [sa] [aiw] [3P] | missing | Same as R7 |
| R9 | Open Enrollment: run the window, chase non-responders, file elections with carriers | [agent] [W] | partial | `rt_open_enrollment` ships disabled; reminders by email plus an anonymous #general post (`packages/routines/src/wave2/benefits.ts` [C]). The window close is a constant `OPEN_ENROLLMENT_CLOSES = "2026-11-13"` (same file [C]); no open or close lifecycle; no carrier filing of elections |
| R10 | Celebrate milestones: birthdays and work anniversaries to chat | [agent] [W] | missing | `workers` has no birth date column (`packages/db/src/schema.ts:22-32` [C]); anniversaries derivable from `start_date` |
| R11 | Order the laptop when an offer is signed | [agent] [W] | done | `it.order_device` R4 proposal inside `rt_new_hire` [C]; ceiling `agent.device_cents` (harness 5.4) |
| R12 | Tax notice received: resolve it | [blog-agent] [home] [W] | partial | Rate change end to end (GP1). `deposit_schedule_change` and `missing_filing` notices exist in the simulator (`packages/sim/src/notices/scenarios.ts` [C]) but the precheck skips any notice that is not a rate change (`packages/routines/src/prechecks.ts:47` [C]) |
| R13 | Create your own routine in plain language; upload an internal document and adjust it in plain English; per-routine permissions | [agent] [sa] [lapaas] [W] [3P] | partial | Deterministic parser handles one template, "post open approvals to a channel" (`packages/core/src/routines/draft-parser.ts:1-25` [C]); a model-drafted routine needs `WEFT_LLM=openai`; no document upload; tools capped at 8 per routine (SPEC `routines` table) |
| R14 | Custom routine example: hand-deliver a laptop for each new hire in one office (chat a named person, watch newly connected devices, follow up until done, loop in blockers) | [agent] [W] | partial | `it.record_delivery` and `sim.device_delivered` exist [C]; the parser cannot express it and routines cannot wait on an event mid-run (see G6) |
| R15 | Custom routine example: 30-day new-hire check-in, summarized for the manager | [blog-agent] [blog-10] [W] | missing | No check-in form, no day-30 trigger |
| R16 | Custom routine example: weekly headcount and payroll cost by state emailed to the CFO | [blog-agent] [W] | partial | Email simulator exists (`sim_email_messages` table [C]); no report tool |

### 2.2 Other agent tasks named by the vendor

| ID | Capability | Source | Weft status | Evidence and the gap |
|---|---|---|---|---|
| T1 | Register in a new state (withholding, UI, paid leave; foreign qualification where needed) | [blog-10] [blog-agent] [W] | done (no foreign qualification) | `tax.register_state_account`, agency simulator, GP3 Colorado [C] |
| T2 | Recurring filings: quarterly federal returns, state wage reports, annual UI, year-end W-2 and 1099; compliance calendar | [blog-10] [W] | missing | `filings` table exists in `packages/db/src/schema.ts` [C] but no `tax.*` command files a return; SPEC 1.2 lists 941 and wage reports as P1, 1.3 lists W-2 and 1099 as P2 |
| T3 | Notice escalation to a human tax specialist (POA phone call, judgment) | [blog-agent] [blog-10] [W] | missing | `NoticeStatus` includes `escalated` (`packages/core/src/commands/notices.ts:11` [C]); nothing sets it, no specialist queue |
| T4 | Customers upload mailed notices | [P] (compliance page) | missing | Notices arrive only through `sim.deliver_notice` [C] |
| T5 | Benefits and 401(k) enrollment for a new hire: by location, role, eligibility window; remind until elected; submit to carrier and 401(k) provider; confirm receipt | [blog-10] [W] | partial | Plans seeded incl. 401(k) (`packages/seed/src/benefits.ts` [C]); the hire elects in the portal (GP7); no agent reminders tied to the eligibility window, no carrier submission or receipt |
| T6 | Detect qualifying life events (marriage, birth, move) and open an enrollment window | [benefits] [W] | missing | No event, no window object |
| T7 | Premium reconciliation before paying the carrier | [benefits] [W] | done (manual trigger) | `benefits.reconcile`, GP11 [C]; nothing consumes `benefits.invoice_received` (docs/wave2.md "Left") |
| T8 | COBRA notices | [benefits] [W] | done | Offboarding step (`packages/core/src/offboarding/steps.ts` [C]), GP9 |
| T9 | Answer employee questions about their own pay, PTO, policy, seeing only their own data; medical leave goes to a person | [blog-10] [fortune] [W] | missing | The portal has no agent (`apps/web/src/components/portal/portal-view.tsx` [C]); personas are new hires only (`apps/web/src/components/app/shell/header.tsx:13` [C]) |
| T10 | Contractor tax forms: W-9 for US, W-8BEN or W-8BEN-E abroad, track W-8 expiry (three years), renew on entity change | [blog-10] [W] | missing | Contractors module is payouts and FX only (`packages/core/src/commands/contractors.ts` [C]); no form records |
| T11 | State-required training (CA, NY, IL harassment prevention): assign, remind, store completion | [blog-10] [W] | missing | LMS is P2 (SPEC 1.3) |
| T12 | Accounts and groups by role, first-day message; manager plans the welcome | [blog-10] [W] | partial | Accounts done (`it.create_account`); no first-day message on the start date |
| T13 | Offboarding with access revocation and final pay | [home] [W] | done | GP9 [C] |
| T14 | Off-cycle pay for a missed payroll with a mid-period raise and a bonus, asked in chat | [agent] [W] | partial | `payroll.propose_off_cycle` exists (GP10) but chat cannot call it (README "What is stubbed or left"; `CHAT_TOOLS` [C]) |
| T15 | Global contractor payouts | [home] [W] | done (simulated) | GP11 [C] |
| T16 | Provision SSO, devices and apps at hire and revoke at exit | [home] [W] | done (simulated) | IT and offboarding commands [C] |

### 2.3 Chat (the "ask it like a teammate" surface)

| ID | Capability | Source | Weft status | Evidence and the gap |
|---|---|---|---|---|
| Q1 | Questions over company data, for example why payroll rose in a quarter, why one person's pay changed in a month | [agent] [W] | partial | 13 read tools offered to chat (harness 5.3 wave 2 amendment) [C]; no tool aggregates across runs by month or quarter, so "why did payroll rise in Q3" has to page through `payroll.get_run` per run |
| Q2 | Answer with a chart (payroll cost by month, split contractor pay and gross pay) after a line saying how many commands it ran | [agent] [W] | missing | No chart result type; recharts unused [C] |
| Q3 | Custom reports on demand, no spreadsheets | [agent] [W] | missing | No report tool |
| Q4 | Refuse to bulk-approve, offer to walk through each item | [agent] [W] | partial | `scenarios/chat_approve_all.json` refuses (GP5) [C]; there is no walk-through because chat cannot propose |
| Q5 | Chat can act (as proposals): off-cycle, expense decisions, time-off routing | [agent] [W] | missing | Chat allowlist is read-only by design (harness 5.3) |
| Q6 | Tag the agent in a chat thread or channel; it reads the thread and does the work | [agent] [W] | missing | Inbound chat is stored as untrusted text (`packages/sim/src/chat.ts:13-14` [C]); nothing starts a run |
| Q7 | Thinking state and step chips | [agent] [home] [W] | done | `apps/web/src/components/app/agent/run-feed.tsx` [C] |
| Q8 | Scope and defaults differ by who is asking (executive, head of people, sales rep) | [blog-agent] [W] | done (scope), partial (defaults) | Grants intersect per principal (`packages/executor/src/scope.ts:43` [C]); no per-role context defaults |

### 2.4 Governance

| ID | Capability | Source | Weft status | Evidence and the gap |
|---|---|---|---|---|
| G1 | Agent acts as the requesting person and never exceeds their access; admins narrow it per action | [agent] [blog-agent] [W] | done (per domain), partial (per action) | Agent grants intersected with the principal's, approve capped at edit (`scope.ts:43` [C]); `agent_grants` keyed by domain only (`schema.ts:77-79` [C]) |
| G2 | View, Edit, Approve tiers for people and for the agent, on a per-person permissions screen | [agent] [W] | partial | Levels exist (`packages/seed/src/governance.ts` [C]); API routes `/v1/settings/permissions` and `/v1/settings/agent-grants` exist [C]; Settings is a Placeholder (`apps/web/src/app/(app)/app/settings/page.tsx` [C]) |
| G3 | Hard money limits the agent cannot raise | [agent] [blog-agent] [W] | done | `limits` table and ceilings (harness 5.4) [C] |
| G4 | Extra restrictions on irreversible actions (payroll, payments) | [sa] [aiw] [3P] | done | R4 always proposes (harness 5.4) [C] |
| G5 | Every action has identity, scope, written rationale, rollback; one-click undo keeps both entries | [agent] [blog-agent] [W] | done | Action log with hash chain, `rollback` (`packages/executor/src/human.ts:218` [C]), Audit page |
| G6 | Runs until the job is done: waits days or weeks for paperwork or permission, checks back, resumes | [agent] [W] | partial | A routine run ends `waiting_approval` and approved proposals execute directly (`packages/routines/src/engine.ts:203-210` [C]); the model never resumes; checkpoint resume is P1 (SPEC 1.2); daily nudges approximate follow-up |
| G7 | Per-workflow autonomy: recommend only, act after approval, act on its own | [blog-agent] [fortune] [aiindex] [W] | partial | Type allows recommend and approve; approve enforced (`packages/contracts/src/routines.ts:13` [C]); no UI control |
| G8 | Learns from approvals and overrides | [blog-agent] [W] | partial | `knowledge/preferences/approvals.md` counts decisions by person and kind (`packages/executor/src/memory/preferences.ts` [C]) and recall surfaces it (`packages/executor/src/memory/store.ts:342-346` [C]); it never changes thresholds or suggests widening autonomy |
| G9 | Each run log shows the trigger, what it did, what it left for a person | [agent] [W] | done | `routine_runs.left_for_human_json` (`engine.ts:207-210` [C]); run view |
| G10 | Routine audit: who created it, when approved, last run, next run | [sa] [3P] | partial | `routine.drafted` and `routine.enabled` events [C]; the routines list shows no last or next run (`apps/web/src/components/app/routines/routines-view.tsx` [C]) |
| G11 | Hand off to a company employee or a vendor specialist, with the reason logged | [blog-agent] [fortune] [W] | partial | Proposals and suggestions go to the Inbox [C]; no assignee other than approvers, no specialist role |
| G12 | Routine monitoring while it runs | [lapaas] [3P] | done | Run view with live steps [C] |

### 2.5 Surfaces

| ID | Capability | Source | Weft status | Evidence and the gap |
|---|---|---|---|---|
| S1 | Chat approval card from the app's bot: mentions the approver, says why (payroll depends on it), fields routine, employee, role, base salary, payroll date; buttons Approve, Deny, Open in app | [agent] [W] | partial | Card JSON posted (`proposals.ts:100-106` [C]) but rendered as text; no buttons; harness 6.9 says every button opens the proposal page, and `decide()` re-renders the headline from the DB |
| S2 | Chat notifications: payroll, tax alerts, deadline reminders | [integrations] [W] | partial | Channel feed exists [C]; no deadline reminders (no calendar) |
| S3 | MCP for Claude, ChatGPT and any MCP client; included on Starter and Pro | [home] [pricing] [aiindex] [W] | done (stdio) | `apps/mcp/src/main.ts` exposes read and propose tools plus `agent_ask` [C]; Streamable HTTP is P1. The vendor's MCP endpoint and tool list are still not public [docs] [W] |
| S4 | REST API, CLI, SDKs, webhooks (lifecycle webhooks on Enterprise) | [pricing] [docs] [aiindex] [W] | partial | REST `/v1` done [C]; no CLI (no `bin` in any package.json [C]), no SDK, no outbound webhooks (no route [C]) |
| S5 | Email and chat invoice submission for expenses (Pro) | [pricing] [W] | missing | Depends on R5 |

## 3. Cross-cutting gaps (fix these once, many capabilities light up)

1. **X1 Chat can propose.** Today chat is read-only by a binding harness rule (5.3). Parity needs a second chat
   allowlist where write tools exist but every R2 to R4 call is a proposal, never an execution. This needs an
   amendment to `research/harness.md` 5.3 (binding) before code. Unlocks T14, Q4 walk-through, Q5, R4 and R5 in chat.
2. **X2 Report and chart result type.** One deterministic `reports.query` tool and one `chart` artifact kind rendered
   in the agent panel with recharts. Unlocks Q1 quarter questions, Q2, Q3, R7, R8, R16.
3. **X3 Interactive approval card.** Render `card_json` in the chat feed with fields and Approve, Deny, Open buttons
   that call the same `decide()` path as the Inbox. Unlocks S1; it is also the natural seam for a real Slack adapter
   later (Slack is not in Nitish's wave 3 integration list).
4. **X4 Autonomy levels.** Add `auto` with hard limits that code enforces. Unlocks G7 and the "widen after reviewing
   the log" story with G8.
5. **X5 Wait and resume.** A routine step can wait for an event (`sim.device_delivered`, `proposal.decided`,
   `worker.onboarding_completed`, a date) and continue with a fresh model call. Unlocks G6, R2, R14, R15.
6. **X6 Manager principals.** Time-off and expense approvals route to the worker's manager. Today only three admin
   principals plus new-hire personas exist (`packages/seed/src/governance.ts` [C]); `workers.manager_id` is seeded
   (`packages/seed/src/people.ts:117-129` [C]).

## 4. Gaps ranked by demo value and effort

Value: how much the gap shows in a 5-minute demo against the reference. Effort: S (under 2 h), M (2 to 5 h),
L (over 5 h) for one builder, including tests.

| Rank | Gap | Value | Effort | Depends on | Why this rank |
|---|---|---|---|---|---|
| 1 | Expenses: data, policy check, review routine, screen, reimbursement in payroll (R5) | high | L | X6 | Nitish named it; it is a gallery card the reference demos twice |
| 2 | Time Off: policies, ledger, requests, coverage check, routing routine, screen, payroll PTO lines (R4) | high | L | X6 | Nitish named it; replaces the simulated accrual in final pay |
| 3 | Chat can propose (X1), with off-cycle in chat (T14) and the expense walk-through (Q4) | high | M | harness amendment | Turns three reference chat demos into Weft demos |
| 4 | Chart answers and `reports.query` (X2, Q2, Q3) | high | M | none | The reference's payroll-cost chart is its most visual chat moment; recharts is installed |
| 5 | Interactive chat approval card (X3, S1) | high | S | none | Cheap, visible, matches the reference's card layout |
| 6 | Per-routine autonomy control with `auto` under limits (X4, G7) | medium | M | none | Sells the trust story; small UI |
| 7 | Monthly exec report and Monday exec briefing (R7, R8) | medium | S | X2 | Reuses `reports.query`; one cron routine each |
| 8 | New Hire Ready Check, three business days before the start date (R2) | medium | S | none | Deterministic precheck over existing reads |
| 9 | Milestones: anniversaries and birthdays (R10) | medium | S | birth date column | Cheap delight; birthdays need a seeded, synthetic `birth_month_day` |
| 10 | Notice kinds beyond rate change, plus specialist escalation (R12, T3) | medium | M | none | Simulator already has two more kinds |
| 11 | Routine gallery with "Try it" and last or next run (G10) | medium | S | none | Mirrors the reference's favorites layout |
| 12 | 30-day check-in (R15) | medium | M | X5 or a date cron | Needs a portal form |
| 13 | Missing anomaly rules: duplicate supplemental, raise not applied, W-4 change (R3) | medium | S | none | Small rules with seeded cases |
| 14 | Employee self-service questions in the portal (T9) | medium | M | persona for active employees | Scope is the hard part, not the model |
| 15 | Contractor tax forms and W-8 expiry (T10) | low | M | none | Good compliance story, little UI |
| 16 | Recurring filings and compliance calendar (T2) | medium | L | none | Large; keep to 941 and CA DE 9 drafts |
| 17 | Wait and resume steps (X5) | medium | L | engine change | Highest architectural risk; do after the above |
| 18 | State-required training (T11) | low | M | none | LMS is out of scope; a record-only version is possible |
| 19 | QLE windows (T6), carrier election filing (R9, T5) | low | M | none | Benefits already deep |
| 20 | Tag-the-agent in a chat thread (Q6) | low | M | taint rules | Inbound text is untrusted; needs care |
| 21 | CLI, webhooks, SDK (S4) | low | M | none | Developer surface, not demoed |

Recommended wave 3 cut: ranks 1 to 9 and 13 are the agent-parity slice. Ranks 10 to 12 if a builder finishes early.
Record the rest in `docs/status.md` as left.

## 5. Build specs

Conventions that already bind every spec below (from SPEC and harness, verified in code): registry names
`namespace.action`; at most 16 tools per agent kind or routine (harness 5.2 tool-count test); a custom routine has at
most 8 tools; risk classes R0 to R4 and one `policy()` function (harness 5.4); money as integer cents plus a display
string; prefixed ids; amounts the policy checks come from the DB through `CommandDef.amountCents`, never from args;
messages pass grounding and redaction; every prebuilt routine has a deterministic precheck and a code-owned checklist
(`packages/routines/src/checks.ts` [C]); new routines are added through a `packages/routines/src/wave3/*.ts` module
that exports `routines`, `prechecks` and `predicates` maps, mirroring the wave 2 modules [C]. All seed content is
synthetic and labeled.

### 5.1 Expenses (rank 1)

**Data** (new tables in `packages/db/src/schema.ts`, migration plus seed):

- `expense_policies`: `id` (`exp_pol_`), `company_id`, `name`, `rules_json` (per-category per-transaction cap in
  cents, receipt required over cents, meal cap per person per day, max age days of a transaction at submit, blocked
  categories), `manager_approval_over_cents`, `finance_approval_over_cents`, `effective_from`, `version`.
- `expenses`: `id` (`exp_`), `company_id`, `worker_id`, `merchant`, `category` (enum `travel equipment meals office
  software supplies`, the reference's six [P]), `amount_cents`, `currency` (USD only in wave 3), `txn_date`,
  `submitted_at`, `status` (enum `needs_review approved paid_out declined`, the reference's groups [agent] [W], plus
  `draft` for the portal), `receipt_upload_id` (FK to the existing `uploads` table [C]), `note` (untrusted),
  `policy_version`, `findings_json`, `explanation`, `explanation_run_id`, `decided_by`, `decided_at`,
  `decline_reason_code`, `paid_in_run_id`, `paycheck_id`.
- Seed: one policy and about 14 expenses across 6 workers for the current period, with exactly 4 planted findings
  (a meal over cap, a missing receipt over the threshold, a duplicate of the same merchant, amount and date, a
  transaction older than the max age), the rest clean. The reference's chat demo had six items with mixed receipts
  [agent] [W]; do not copy its merchants or amounts.

**Commands** (new `expenses` domain in grants; `packages/core/src/commands/expenses.ts`):

| Command | Risk | Notes |
|---|---|---|
| `expenses.list { status?, worker_id?, period? }` | R0 | concise rows with names, cents and display, findings codes |
| `expenses.get { expense_id }` | R0 | receipt metadata (never the image bytes), policy findings with rule and threshold |
| `expenses.check_policy { expense_ids }` | R0 | deterministic: `OVER_CATEGORY_CAP`, `MISSING_RECEIPT`, `DUPLICATE` (same worker, merchant, amount within 3 days), `STALE_TRANSACTION`, `BLOCKED_CATEGORY`, `MEAL_DAILY_CAP`; returns evidence cents |
| `expenses.explain { items: [{ expense_id, explanation }] }` | R1 | batch, grounded per item like `payroll.explain_flags` |
| `expenses.approve { expense_id }` | R2 | always a proposal; `amountCents` from the row; approver must hold `expenses: approve` or be the worker's manager (X6) and above `finance_approval_over_cents` needs the finance principal; one proposal per expense; a bulk input is refused with `BULK_APPROVAL_REFUSED` |
| `expenses.decline { expense_id, reason_code }` | R2 | proposal; reason codes enum (`over_policy`, `no_receipt`, `duplicate`, `personal`, `other`) |
| `expenses.submit` | human and portal only | not on any model surface |

**Payroll**: at draft creation, approved and unpaid expenses add to `reimbursements_cents` on the worker's paycheck
(non-taxable, not in gross); the earning is listed as a reimbursement line in the paycheck view; on
`payroll.processed` they become `paid_out` with `paid_in_run_id`. New anomaly rule `REIMBURSEMENT_SPIKE` when a
paycheck's reimbursements exceed 3 times its trailing average or a fixed cents floor. Rollback of an approval before
the run is drafted returns the expense to `needs_review`.

**Events**: `expense.submitted`, `expense.decided`.

**Routine** `rt_expense_review` (enabled, autonomy approve):

- Trigger: event `expense.submitted`, plus a weekday 9:00 PT cron sweep for any still `needs_review`.
- Precheck: runs `expenses.check_policy` on the open expenses; skip when none; derived args are one
  `expenses.approve` per clean expense and the flagged list.
- Tools (6): `expenses.list`, `expenses.get`, `expenses.check_policy`, `expenses.explain`, `expenses.approve`,
  `comms.send_message`.
- Behavior: propose approval of each clean expense; explain each flagged one from its evidence and leave it for a
  person (never propose a decline in wave 3); post one summary to #people-ops with counts only.
- Checklist: `explanations_complete` over flagged ids, `proposal_exists:expenses.approve` per clean id.

**Chat**: with X1, "approve all open expenses" is refused and the agent proposes the clean ones one by one and
explains the flagged ones (the reference's demo shape [agent] [W]).

**UI**: `/app/expenses` replaces the placeholder: segmented groups Needs review, Approved, Paid out, Declined with
counts; table columns Employee, Merchant, Category, Amount, Transaction date, Status, Submitted; a row drawer with the
receipt preview (masked upload thumbnail), findings chips with rule and threshold, the agent's explanation and the
pending proposal link. Portal: a Submit expense form with a receipt upload for active employees (needs an
active-employee persona). Home: an Expenses widget (needs review count and cents).

**Tests**: unit tests per policy rule; payroll test that an approved expense lands in `reimbursements_cents` and the
bank batch total; scenario `tests/scenarios/gp13-expense-review.test.ts` (submit, routine runs, 4 flagged explained,
clean ones proposed, approve, next draft pays them, processed marks paid out, rollback); e2e spec for the screen and
the drawer; scripted scenario `scenarios/rt_expense_review.json`.

### 5.2 Time Off (rank 2)

**Data** (amounts in minutes, as the reference's API does [P] [docs]):

- `time_off_policies`: `id` (`top_`), `company_id`, `name`, `kind` (`vacation sick personal unpaid`), `accrual`
  (`per_pay_period monthly annual_grant unlimited`), `accrual_minutes`, `cap_minutes`, `carryover_minutes`,
  `waiting_period_days`, `prorate_new_hires`, `allow_negative_minutes`, `requires_approval`. The reference lists
  accrual, carryover, caps, waiting periods and new-hire proration [comptime] [W].
- `time_off_assignments`: `worker_id`, `policy_id`, `effective_from`, `effective_to`.
- `time_off_ledger`: `id`, `worker_id`, `policy_id`, `delta_minutes`, `reason` (`accrual request adjustment payout
  carryover`), `ref`, `at`, `action_seq`. A balance is the sum; no stored balance column.
- `time_off_requests`: `id` (`tor_`), `worker_id`, `policy_id`, `start_date`, `end_date`, `minutes`, `status`
  (`pending approved denied cancelled`, the reference's API statuses plus cancelled [P]), `approver_id`, `note`
  (untrusted), `check_json` (balance after, overlaps, coverage), `decided_by`, `decided_at`.
- `team_coverage_rules`: `department_id`, `max_out_fraction` (default 0.34) or `min_present` count.
- Seed: two policies (vacation accruing per pay period with a cap, sick at a flat annual grant), assignments for all
  employees, a ledger history from January, 6 requests (3 pending: one clean, one that drops a balance below zero,
  one that leaves Engineering under coverage), and 4 approved upcoming. Any state sick-leave minimum used in the seed
  must be labeled synthetic; I did not verify state rules for this file.

**Commands** (new `time_off` domain):

| Command | Risk | Notes |
|---|---|---|
| `time_off.list_requests { status?, worker_id?, from?, to? }` | R0 | |
| `time_off.get_balance { worker_id, policy_id?, as_of? }` | R0 | ledger sum plus projected accrual to a date |
| `time_off.check_request { request_id }` | R0 | deterministic: `INSUFFICIENT_BALANCE`, `OVERLAPS_APPROVED` (the reference blocks overlaps [comptime] [W]), `COVERAGE_CONFLICT` with the names of teammates out, `BLACKOUT`; returns the approver (worker's manager principal) |
| `time_off.who_is_out { from, to, department_id? }` | R0 | for the digest, Home and coverage |
| `time_off.approve { request_id }` / `time_off.deny { request_id, reason_code }` | R2 | proposals routed to the manager (X6); approval writes the ledger debit in the same transaction; rollback reverses it |
| `time_off.adjust_balance { worker_id, policy_id, delta_minutes, reason_code }` | R2 | admin correction; proposal |
| `time_off.request` | human and portal only | |

**Payroll**: approved minutes in a pay period become a `pto` or `sick` earning line for hourly workers (paid at the
rate) and an informational hours split for salaried ones; the accrual posts per processed run for
`per_pay_period` policies; `finalPayPlan` reads the ledger balance and the simulated accrual in
`packages/core/src/payroll/offcycle.ts:23-36` is deleted. GP9 must stay green with the seeded ledger.

**Events**: `time_off.request_created`, `time_off.request_reviewed`, `time_off.balance_adjusted` (the reference's
webhook names [docs] [W]).

**Routine** `rt_time_off_requests` (enabled, autonomy approve):

- Trigger: event `time_off.request_created`.
- Precheck: `time_off.check_request`; derived args carry the approver and the findings.
- Tools (5): `time_off.get_balance`, `time_off.check_request`, `time_off.who_is_out`, `time_off.approve`,
  `comms.send_message`.
- Behavior: clean request, propose approval assigned to the manager with a card that shows the balance after and who
  else is out; any finding, message the manager with the specific conflict and leave the request pending (no
  proposal). Sick or medical notes route to a person only and the agent never reads the note body in concise format
  (the reference sends medical leave questions to a person [blog-10] [W]).
- Checklist: `proposal_exists:time_off.approve:{request_id}` or `posted:{manager_channel}`.
- `rt_people_digest` adds an "out this week" line from `time_off.who_is_out` (closes R6).

**UI**: `/app/time-off` with tabs Requests (pending first; columns Person, Type, Dates, Hours, Balance after,
Coverage, Status), Calendar (a two-week strip by department showing who is out), Balances, Policies (read-only).
Home: the reference's widget shape is out today, pending requests and upcoming in 30 days [P]. Person detail gets a
Time off tab. Portal: request form with the live balance.

**Tests**: ledger math (accrual, cap, carryover, proration, negative balance); check rules; payroll PTO lines; final
pay reads the ledger; scenario `gp14-time-off.test.ts` (request, routine, manager approval, ledger debit, digest
line, rollback); e2e for the screen.

### 5.3 Chat can propose (rank 3, X1)

- Harness amendment (to `research/harness.md` 5.3 and SPEC 9.x): add a `chat_act` allowlist used when the person
  asks for an action; reads stay as today. Proposed set, at most 16: the 13 chat reads plus
  `payroll.propose_off_cycle`, `expenses.approve`, `time_off.approve`. Every write on it is R2 or R4, so `policy()`
  always proposes; nothing executes from chat. Grants still intersect with the asking person's.
- Selection: a deterministic intent check in code (verbs such as pay, approve, propose, request) picks `chat_act`,
  never the model. Tainted runs keep the existing refusals.
- Tests: S5 chat guardrails extended (approve-all still refused, proposals created only for allowed items, no
  executes); GP10 "asked in chat" path from `docs/wave2.md` becomes a scenario and a live eval L5 (budget under
  $0.02).

### 5.4 Charts and reports (rank 4, X2)

- `reports.query { metric, group_by?, from, to }` R0, deterministic SQL, metrics enum: `payroll_cost_by_month`
  (gross, employer taxes, benefits, contractor payouts as separate series), `headcount_by_state`,
  `headcount_by_department`, `hires_and_departures_by_month`, `turnover_rate`, `time_off_minutes_by_month`,
  `expenses_by_category`. Returns rows plus a `chart` spec `{ kind: "bar" | "line" | "stacked_bar", x, series[] }`
  with cents and display strings. Over 8,000 characters it offloads to an artifact (`agent.read_artifact` exists).
- `GET /v1/agent/runs/:id/artifacts/:ref` currently answers 501 (README [C]); implement it for chart artifacts.
- Agent panel: render a `chart` artifact with recharts (installed, unused) in the design system colors, with a table
  fallback and an accessible data table. Show "Ran N tools" from the run's step count.
- Add `reports.query` to chat reads (count stays under 16).
- Tests: SQL per metric against the seed; a golden chart spec; e2e that a scripted chat answer renders a chart.

### 5.5 Interactive approval card (rank 5, X3)

- Extend the card JSON (only the notifier writes it, harness 6.9): `{ proposalId, headline, risk, moneyCents,
  routineName, subjectName, subjectTitle, fields: [{ label, value }] }` where field values come from the DB (the
  proposal's preview), never from model text. Mention the approver by display name.
- Chat feed renders cards with Approve, Deny and Open buttons; Approve and Deny call the same `decide()` the Inbox
  uses and show the result inline; a decided card shows its outcome; Open links to the proposal page.
- Tests: unit test that card fields come from the preview; e2e that approving from the card executes once (the
  double-click guard in harness 5.5 already exists).

### 5.6 Autonomy control (rank 6, X4)

- `RoutineDef.autonomy` becomes `"recommend" | "approve" | "auto"`. Recommend: every write becomes a suggestion (no
  proposal). Approve: today. Auto: R1 and R3 calls with `autoAllow` execute; R2 executes only for commands that
  declare `autoEligible` (for example `expenses.approve` under a per-item cents cap stored in `limits` as
  `agent.expense_auto_cents`, `time_off.approve` for clean requests); R4 never executes without approval. Tainted
  runs fall back to approve.
- Changing autonomy is itself a proposal (like enabling a routine today).
- UI: a three-way control on the routine detail page plus the count of approvals and overrides from
  `knowledge/preferences/approvals.md` (G8) as the evidence for widening.
- Tests: policy snapshot test extended per autonomy level; a scenario where `auto` approves a clean expense under the
  cap and proposes one above it.

### 5.7 Exec reports (rank 7)

- `rt_monthly_exec_report`: cron `0 9 1 * *` PT; precheck builds headcount, net hires, payroll cost for the month
  and the delta, turnover, open compliance items from `reports.query`; posts to #leadership (add to the closed
  channel enum) and emails the CEO persona through the email simulator. Tools: `reports.query`,
  `comms.send_message`.
- `rt_exec_briefing`: Monday 8:00 PT, adds upcoming payroll, upcoming hires, registrations not active, notices open.
  Ship disabled.
- Tests: scenario with a fixed clock on the 1st; grounding passes because numbers come from derived args.

### 5.8 New Hire Ready Check (rank 8)

- `rt_new_hire_ready`: weekday 9:00 PT cron; precheck finds workers with `start_date` within 3 business days and
  checks: 3 accounts active, device delivered, bank account verified, W-4 and state form submitted, I-9 done, benefits
  elected or waived, state registration active. Clean: post a ready line in #new-hires. Not clean: post the blocking
  items naming the owner (hire, IT, payroll) and add a suggestion to the Inbox. Tools: `onboarding.get_checklist`,
  `it.list_accounts`, `it.list_devices`, `tax.list_registrations`, `comms.send_message`.
- On the start date, the same routine posts the first-day message (closes the R1 and T12 gap).
- Tests: scenario with one ready and one blocked hire.

### 5.9 Milestones (rank 9)

- Add `birth_month_day` (`MM-DD`, synthetic, nullable) to `workers`; never the year. Seed for about half the people.
- `rt_milestones`: weekday 9:00 PT; posts birthdays (opt-in flag per worker) and work anniversaries (years from
  `start_date`) to #general. Disabled by default. Tools: `people.search`, `comms.send_message`.

### 5.10 Notices beyond rate change and escalation (rank 10)

- Precheck branches for `deposit_schedule_change` (update the deposit schedule on the tax account, R2 proposal,
  reply) and `missing_filing` (look up the filing, attach it to the reply if it exists, else escalate).
- `notices.escalate { notice_id, reason_code }` R1: sets `escalated`, creates a specialist task assigned to a
  simulated "tax specialist" principal with the evidence pack; the Compliance screen shows it.
- Upload a notice PDF or text through the existing `uploads` table into the parser in `packages/sim/src/notices`
  (marked untrusted, taints the run as GP5 does).

### 5.11 Gallery and run times (rank 11)

- Routines page: a Favorites row of prebuilt cards with a "Try it" button that fires an attended run, then the list
  with last run status and next run time computed with croner.

### 5.12 Thirty-day check-in (rank 12)

- `checkins` table (`worker_id`, `due_on`, `answers_json`, `submitted_at`), a four-question portal form, and
  `rt_thirty_day_checkin` (weekday cron): send on day 30 by email simulator, nudge once on day 33, and on submission
  post a summary to the manager by email (answers are untrusted; the summary quotes no numbers).

### 5.13 Anomaly rules (rank 13)

- `DUPLICATE_SUPPLEMENTAL` (two supplemental lines with the same amount for a worker within 2 runs),
  `RAISE_NOT_APPLIED` (a pay rate effective on or before the period end that the paycheck did not use),
  `WITHHOLDING_CHANGED` (tax profile changed since the last processed run). Seed one case each in a new draft.

### 5.14 Remaining specs in brief

- Employee self-service (T9): an active-employee persona and a portal question box running chat with a
  self-scoped grant (`people: view` limited to `subject = self`); sick and medical keywords route to HR.
- Contractor forms (T10): `contractor_tax_forms` (`form` W-9, W-8BEN, W-8BEN-E; `signed_on`; `expires_on` three
  years for W-8 per [blog-10] [W]); a weekly routine that requests renewal 60 days before expiry by email.
- Filings (T2): generate 941 and CA DE 9 drafts from the ledger as documents, file with the agency simulator as an R3
  proposal, and a calendar view of due dates.
- Training (T11): `trainings` and `training_assignments` (record only, no LMS), assigned by work state.
- Wait and resume (X5): a `waits` table (`routine_run_id`, `event` or `until`, `resume_payload`); the scheduler
  re-enters the routine with a new agent run when the event fires; the run key includes the wait id.
- CLI and webhooks (S4): `weft` CLI over `POST /v1/tools/<wire>` (harness 5.1 already designs it); outbound
  webhooks with Standard Webhooks signing as the reference documents [P].

## 6. How this connects to the other wave 3 goals

- Integrations: the reference lists Checkr as live (background checks during onboarding), Workday as coming soon,
  and does not list Greenhouse, HireRight or DocuSign at all [integrations] [W]. Its own ATS integrations (Ashby,
  Lever) turn a hired candidate into an employee record [W]. For agent parity, the useful hooks are: an ATS hire
  event that creates an offer draft (feeds `rt_new_hire`), a background check step whose result gates the
  onboarding checklist, and an e-signature provider behind `documents.send_offer` and `documents.sign`. The
  integrations researcher owns vendor API details; this file only names where the agent consumes them.
- Top bar: the provider badge, sim clock chip and Demo control live in `apps/web/src/components/app/shell/header.tsx`
  (104 lines [C]); the "Viewing as" control is where an active-employee persona for T9 and manager personas for X6
  would appear, so the redesign should leave room for a grouped persona list (admins, managers, employees, new
  hires).

## 7. Open questions

- Should managers be principals with a subject-scoped grant (reports only), or should approvals route by
  `manager_id` to an existing admin in the demo? The first is real; the second is cheaper.
- Should `auto` autonomy ship in wave 3 at all, or only recommend and approve with the control in the UI?
- Is a harness amendment for `chat_act` acceptable to Nitish, given 5.3 was written as a deliberate safety line?
- Birthdays are personal data even when synthetic; ship them opt-in per worker, or anniversaries only?
- Pages 2 to 11 of the vendor's blog and the 14 help articles in sub-collections were not read; a builder who needs
  more detail on expenses or time off should start there.
