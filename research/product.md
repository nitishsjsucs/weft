# Warp (warp.co) product research for Weft

Researched 2026-10-15, 13:05 to 13:40 PDT, for the Weft 9-hour foundation build. Audience: the architect and builders. Everything below is a paraphrase of public pages; no Warp copy, names, art or logos may be reused in Weft (see the brand rules in the task brief). Where Warp's own pages disagree with each other, both values are given.

## 0. How to read this file

Source keys used in brackets throughout. All URLs were read with WebFetch on 2026-10-15 unless marked otherwise.

| Key | Source |
|---|---|
| [home] | https://warp.co/ (and local copy research/design/reference/html/home.html, gitignored) |
| [agent] | https://warp.co/agent (and local copy research/design/reference/html/agent.html, gitignored) |
| [payroll] | https://warp.co/payroll (local copy research/design/reference/html/payroll.html) |
| [hris] | https://warp.co/hris |
| [benefits] | https://warp.co/benefits |
| [compliance] | https://warp.co/compliance |
| [it] | https://warp.co/it |
| [global] | https://warp.co/global-contractors |
| [pricing] | https://warp.co/pricing |
| [security] | https://warp.co/security |
| [integrations] | https://warp.co/integrations |
| [switch] | https://warp.co/switch |
| [calendar] | https://warp.co/tools/compliance-calendar |
| [offerletter] | https://warp.co/tools/offer-letter |
| [spt] | https://warp.co/state-payroll-taxes (hub), [spt-ca] /state-payroll-taxes/california, [spt-ny] /state-payroll-taxes/new-york, [spt-tx] /state-payroll-taxes/texas |
| [vs-gusto] | https://warp.co/versus/gusto |
| [vs-rippling] | https://warp.co/versus/rippling |
| [customers] | https://warp.co/customers |
| [blog] | https://warp.co/blog |
| [blog-agent] | https://warp.co/blog/warp-agent ("Warp 2.0" launch post) |
| [blog-10tasks] | https://warp.co/blog/ai-agents-for-hr |
| [blog-irs] | https://warp.co/blog/how-to-respond-to-an-irs-notice-for-your-business |
| [brand] | https://warp.co/the-next-chapter |
| [eng] | https://www.warp.co/eng |
| [llms] | https://www.warp.co/llms.txt |
| [docs] | https://docs.warp.co (index), [docs-llms] https://docs.warp.co/llms.txt |
| [docs-auth] | https://docs.warp.co/authentication.md |
| [docs-quick] | https://docs.warp.co/quickstart.md |
| [docs-hooks] | https://docs.warp.co/webhooks.md |
| [docs-page] | https://docs.warp.co/pagination.md |
| [docs-rate] | https://docs.warp.co/rate-limiting.md |
| [docs-err] | https://docs.warp.co/errors.md |
| [docs-ts] | https://docs.warp.co/sdks/typescript.md |
| [api-payroll] | https://docs.warp.co/api-reference/payroll/get-payroll.md |
| [api-paycheck] | https://docs.warp.co/api-reference/payroll/get-paycheck.md |
| [api-worker] | https://docs.warp.co/api-reference/workers/get-worker.md |
| [api-offer] | https://docs.warp.co/api-reference/offers/create-offer.md |
| [api-pto] | https://docs.warp.co/api-reference/time-off/list-time-off-requests.md |
| [openapi] | https://api.joinwarp.com/docs/openapi.json (first 100k of 574k chars read) |
| [help] | https://help.joinwarp.com/en/ |
| [help-roles] | https://help.joinwarp.com/en/articles/8668824598-roles-and-permissions-in-warp |
| [help-void] | https://help.joinwarp.com/en/articles/2525276856-payroll-voids-and-reversals-a-guide-for-employers |
| [fortune] | https://fortune.com/press-releases/warp-agent-hr-automation-2026-09-25/ (launch press release) |
| [aiweekly] | https://aiweekly.co/alerts/warp-adds-programmable-agents-to-its-ai-native-hr-stack |
| [aiindex] | https://theaiagentindex.com/agents/warp-hr (third-party review) |
| [yc] | https://www.ycombinator.com/companies/warp |
| [effect] | https://effect.website/podcast/episodes/reliable-payroll-systems-in-typescript-with-effect-with-adam-rankin |
| [instinct] | https://rohanadwankar.github.io/posts/platforms#instinct (the article the user named for the agent) |

Name collisions to avoid when searching further: "Warp" the terminal (warp.dev, has its own MCP docs) and "Warp" the freight company (wearewarp.com, has an MCP server and `warp-agent-mcp` npm package) are unrelated companies. Search results for "Warp MCP" are dominated by them (WebSearch results, 2026-10-15).

Caveat: almost every number on warp.co is a vendor marketing claim (for example "10,000+ jurisdictions" on [home] and [compliance] versus "1,000+" on [eng] and [vs-rippling]). Treat them as product intent, not ground truth.

## 1. Company context (short)

- Warp, operated by Poaster Technologies Inc., New York City, founded 2023, YC W23, CEO Ayush Sharma, team about 80, $85M raised including a $60M Series B led by Battery Ventures (June 2026). Formerly joinwarp.com; moved to warp.co in Feb 2026. [yc] [aiindex] [home]
- Started as payroll tax compliance for startups (state registrations, UI accounts, notices), then grew into payroll, HRIS, benefits brokerage, IT and global contractors. [yc] [blog-agent]
- "Warp 2.0" (the [reference phrase removed] and Routines) launched 2026-09-25, rolling out via early access, enabled per company from an "Early Access" tab in settings. [fortune] [aiindex]
- Stack hints: TypeScript, Next.js, Effect (Effect Platform HTTP API, Effect Schema validation of NoSQL data, RPC bridge from a legacy backend, test layers, tagged requests with Redis caching). Error payloads carry an Effect-style `_tag`. [effect] [eng] [docs-err]
- Brand mood (useful for the look, not to copy): black and white base warmed with deep reds, oranges and ambers; editorial type; grainy, tactile texture; "racing garage plus mid-century scientific illustration". [brand] Fonts seen in their bundle: Inter Variable and Berkeley Mono plus a custom sans (research/design/reference/fonts/). Berkeley Mono is commercial; substitute an open mono (for example JetBrains Mono, IBM Plex Mono or Geist Mono). The design researcher owns this topic.

## 2. Feature inventory by module

### 2.1 HRIS and onboarding

- Single employee record shared by HRIS, payroll, benefits, identity and devices; "one system, one database", comp changes hit payroll immediately. [hris] [it]
- Directory cards show: name, title, department icon, manager, location (city), start date, annual compensation, employee ID (format EMP-0042). [hris]
- Features listed: custom fields, org chart, reporting lines, job history, compensation, company directory, PTO, document storage, self-service onboarding. [hris]
- Onboarding: HR sends an invite (card "Onboard a new employee": email field plus "Send Invite"); new hire completes a self-service checklist before day one, claimed under 10 minutes. [hris] [payroll]
- Canonical onboarding checklist (8 to 9 tasks with a progress counter like "2/8" or "4/9"): sign up, sign offer letter, sign confidentiality agreement, federal W-4, state withholding form, direct deposit, I-9, upload government ID, benefits selection. [hris] [home]
- Documents: per-employee library with tabs Tax Forms, Agreements, Benefits, Finance; each document has a date and a status Signed, Sent or Pending; built-in e-signature, versioning. Example doc types: W-4, state withholding (CA), W-9, 1099-NEC copy, I-9, State Disability Insurance, Local Tax Registration, Tax Residency Declaration. [hris]
- Offers: created with candidate, position, worker type, compensation (base, sign-on, relocation, stock options, vesting, cliff), department, workplace, manager, level, expiration; lifecycle draft, sent, viewed, signature requested, accepted, voided, expired. [api-offer] [docs-llms]
- Offer letter generator (free tool): company, candidate name and email, title, base salary, start date, manager, expiration, plus editor for benefits, equity, PTO; output sections include title, comp, start date, reporting line, at-will language, expiration, signature lines. [offerletter]
- Migration: white-glove import from BambooHR, Gusto, Rippling, Justworks, ADP, Paylocity, Paychex, Paycom or CSV; carries YTD payroll so employees get one W-2. Claimed 1 to 2 weeks (other pages say same day or under a week). [hris] [switch] [vs-rippling]

### 2.2 US payroll

- W-2 employees in all 50 states and 1099 contractors in the same dashboard; unlimited runs; "3 clicks" or "about 60 seconds" to run; next-day payroll and AutoPay on Starter. [payroll] [pricing] [vs-gusto]
- Calculates gross to net, applies deductions, remits and files federal (income tax, Social Security, Medicare, FUTA), state (income tax, SUI, SDI, PFL, workers' comp) and local taxes. [payroll] [compliance]
- Multiple pay schedules; dashboard shows "US semi-monthly", "US Q2 Bonus" and "Global monthly" runs side by side with "Autopay in 2d". [pricing] [home]
- Payroll object (public API): `type` us or global; `subtype` regular, off_cycle, bonus, invoice, contractor, dismissal, reimbursement, manual; `status` draft, pending, processing, partially_paid, processed, failed, voided; `payday`; `payPeriod` start and end (inclusive); `payFrequency` weekly, biweekly, monthly, semimonthly, quarterly, annually; `approvalDeadline`; `reopenDeadline`; `fundingMethod` ach or wire; `timeline.approvedAt`; `paycheckCount`; `totals` with cashRequirement, grossPay, netPay, reimbursements, workerTaxes, employerTaxes, preTaxDeductions, postTaxDeductions, workerBenefitContributions, employerBenefitContributions, transactionFees, totalCost, each as integer minor units plus a display string. [api-payroll]
- Paycheck object: status draft, pending, processing, debited, credited, partially_paid, processed, failed, voided; paymentMethod direct_deposit or manual; worker type us_w2, us_1099, global_contractor, global_employee; line arrays `earnings` (types hourly, salaried, overtime, double_overtime, paid_holiday, pto, sick, commission, bonus, severance, and imputed types), `reimbursements`, `deductions` (pre_tax or post_tax), `benefits` (category health, retirement, health_savings, commuter, voluntary; types medical, dental, vision, 401k, roth_401k, hsa, fsa_medical, transit, parking and more; worker and employer contribution), `taxes` (payer worker or employer, amount, description), `exchangeRates`, `reportedHours`. [api-paycheck]
- Payroll run review screen (mockup): header "Sep 16 to Sep 30, Semi-monthly US Payroll"; columns Employee, Hours, Gross Pay, Reimbursements, Company Taxes, Employee Taxes, Company Benefits, Net Pay; rows grouped into "Needs Review (2)" and "Ready for Approval (6)"; a Total row (8 or 9 employees, 669.35 hours, $41,150.67 gross, $530.90 reimbursements, $3,785.12 company taxes, $8,507.50 employee taxes, $1,534.00 company benefits, $31,640.07 net). Salaried semi-monthly rows show 86.67 hours. [agent] (agent.html text)
- Voids and reversals: void creates a negative offsetting payroll record (no money moves); reversal pulls net pay back by ACH within 5 business days, ACH only; taxes already deposited are generally not refundable; $100 fee each; requested via support with the payroll URL. Lifecycle stages named: processed (debit not settled), debit settled (funds in flight), net pay delivered, taxes deposited. [help-void]
- Help center also lists articles on manual payrolls, offset paydays, next-day payroll and how earnings are prorated (titles only seen). [help] (WebSearch 2026-10-15)
- Expense reimbursements are paid through payroll. [pricing]

### 2.3 Tax compliance

- Automatic state registration on hire in a new state: identifies agencies, submits applications for withholding, unemployment insurance, workers' comp and paid family leave accounts, stores agency credentials in the dashboard; 5 to 10 business days; "no manual logins to .gov sites". [compliance] [payroll]
- Registration statuses seen: Registered, Pending (registrations table); Active, Filing started, Awaiting state, Needs info (dashboard). [compliance] [home]
- Registrations table columns: State, Last Filed, SUI Rate, Status (for example California, Mar 15 2026, 1.5%, Registered; Oregon, none, 2.4%, Pending). [compliance]
- Filing: tracks deadlines, files quarterly returns, year-end W-2, 1099 and state reconciliations; real-time filing status. [compliance]
- Notices: AI triages notices, researches cause from payroll data and agency rules, drafts responses; "80% resolved automatically", rest escalate to a human tax specialist with context; customers can upload mailed notices; onboarding includes signing IRS Form 8655 (reporting agent authorization). [compliance] [blog-irs]
- Notice taxonomy worth simulating (from Warp's own guide): IRS CP136 deposit schedule change, CP2100/2100A TIN mismatch, 972CG info return penalty (45 days), CP259 unfiled return, CP210/CP220 941 penalty (often a payment applied to the wrong quarter), CP161 balance due, CP504B intent to levy, LT11/Letter 1058 final notice (30 days); state UI rate notices, withholding mismatch, missing return, penalty assessment (state deadlines can be 10 days). [blog-irs]
- Compliance calendar free tool: fixed 2026 calendar, categories Tax Filings, State UI Reports, Reporting Forms, CA/OSHA, Other; month grid; "Add to Google Calendar" and .ics download. Example deadlines: W-2, 1099-NEC, 940 due Feb 2 2026; 941 Q1 Apr 30; 941 Q3 and state UI reports Nov 2; CA DE 9 quarterly; NY NYS-45 quarterly; TX TWC quarterly wage reports; FL new hire report within 20 days. [calendar]
- Per-state data published by Warp (useful seed values for the simulator; Weft labels them synthetic):
  - California: EDD administers UI, ETT, SDI and PIT through one registration (form DE 1, register once quarterly wages exceed $100); SUI new employer 3.4%, range 1.5% to 6.2%, wage base $7,000; ETT 0.1% on $7,000; SDI 1.3% employee-paid, no cap; withholding form DE 4; quarterly returns due Apr 30, Jul 31, Oct 31, Jan 31; new hire report within 20 days. The page lists PFL separately at 1.3%, which double counts (PFL is funded inside SDI) and gives a conflicting top PIT rate of 12.3% vs 13.3%. [spt-ca]
  - New York: Dept of Taxation and Finance plus Dept of Labor; SUI new employer 4.1% (includes 0.075% RSF), wage base $17,600, range 1.7% to 9.5%; PFL 0.432% up to $95,348.76; DBL 0.5% capped at $0.60 per week; NYC resident tax 3.078% to 3.876%; MCTMT employer tax; withholding form IT-2104. [spt-ny]
  - Texas: TWC; no state income tax; SUI new employer 2.7% (or industry average if higher), range 0.23% to 6.23%, wage base $9,000. [spt-tx]
  - The hub links all 50 states plus DC at /state-payroll-taxes/{slug}. [spt]
- Not from Warp (general knowledge, verify before relying on it): CA form DE 2088 is the EDD's annual "Notice of Contribution Rates and Statement of UI Reserve Account", which is exactly the notice in the dashboard mockup. It is the natural first simulated notice.

### 2.4 Benefits

- Warp is a licensed broker in all 50 states (Warp Insurance Services), 30+ carriers, no premium markup, dedicated Benefits Advisor. [benefits] [pricing]
- Types: medical, dental, vision, life (small group, ICHRA, level-funded); 401(k) via partners; HSA, FSA, commuter; STD, LTD, AD&D, voluntary life; workers' comp. [benefits]
- Administration: enrollment during onboarding; elections sent to carriers by EDI; AI detects qualifying life events (marriage, birth, address change) and opens enrollment windows; open enrollment support; employee and employer contributions computed every pay run; deductions synced to payroll; premium reconciliation flags discrepancies before premiums are paid; automatic COBRA notices. [benefits]
- Employee benefits card (mockup): one card per benefit with carrier, plan, detail line, status Active (for example 401(k) 6% employee with 4% match; PPO medical, dental, vision; commuter $125/month; HSA/FSA $125/month). [benefits]
- API: health plans (list, get), retirement plans (list, create, get, update), benefit deductions (list, create, get, update; ID prefix pbdg_; categories as in paychecks). [docs-llms] [openapi]

### 2.5 IT management ("Warp IT")

- Identity: creates Okta account and SSO at hire, maps departments to Okta groups, SCIM lifecycle across Okta's app catalog; Google Workspace account, calendar, Drive and department groups at hire; on termination suspends Google, transfers Drive to the manager. [it]
- Provisioning panel (mockup): employee with per-system rows and status: Google Workspace (address) Ready, Slack (#engineering) Ready, GitHub (org) Provisioning, Okta SSO (group) Provisioning. [it]
- Trigger-based onboarding flow (mockup): trigger "new hire joins engineering" (Slack channel #new-hire-onboarded) then steps: create Google Workspace email, create Slack account, create GitHub account, install the MDM agent. [it] [home]
- In-house MDM (Rust agent, macOS and Windows): enrollment link during onboarding; policy checks firewall, disk encryption, screen lock, Gatekeeper, custom checks; device card shows a counter like "0/4"; remote lock, password reset, wipe; scripts and patching. [it]
- Offboarding: one termination action runs suspend Google, kill sessions, transfer Drive, deactivate Okta, remove groups, revoke SSO apps, lock or wipe devices, all timestamped in an audit log. [it]
- Dashboard IT widget: "3/3 connected", 99% accounts linked, 96% devices compliant; MDM 768/800 compliant, Google Workspace 800/800 linked, Okta SSO 784/800 linked; "16 unlinked, 32 non-compliant". [home]

### 2.6 Global contractors

- 150+ countries (pricing page says 200+), local currency, near mid-market FX with no spread, about 95% same-day, real-time tracking; not an EOR. [global] [pricing]
- Onboarding about 60 seconds: country-specific agreement templates, tax forms (W-8BEN), banking details, signatures. [global]
- Contractor cards (mockup): name, role, city and country, amount in local currency, cadence "every two weeks", payout action. [global]
- Settings toggles: Auto-Pay on scheduled dates, auto-generated 1099s at year end, email confirmations to contractors. Bulk pay in one click; invoices and confirmations auto-generated. [global]
- Funded in USD, converted at payment time; $3 to $5 bank cost per payment; dashboard shows "2 invoices pending, $8,450" next to upcoming global payroll. [global] [home]

### 2.7 Time off, time tracking, expenses, learning, reports

- Time off: policies, assignments, balances, requests (status pending, approved, denied; amounts in minutes; date or datetime ranges); agent checks balance and coverage and routes to the approver. [api-pto] [agent]
- Time tracking add-on: clock in/out, geofencing, shifts, timesheet approvals, overtime, payroll sync. [pricing]
- Expenses: list grouped Needs Review, Approved, Paid Out, Declined; columns Employee, Expense (merchant), Category, Amount, Transaction Date, Status, Submitted; categories Travel, Equipment, Meals, Office, Software, Supplies. [agent] (agent.html text)
- LMS for trainings and document acknowledgements; agent assigns state-required training by location. [pricing] [blog-10tasks]
- Reports: custom HR reports (Pro), agent builds ad hoc reports and charts ("payroll cost by month" split contractors vs gross pay). [pricing] [agent]

### 2.8 Integrations, security, pricing

- Live integrations: QuickBooks, Xero, NetSuite, Rillet (journal entries after each run); Ashby, Lever (hired candidate to employee); Checkr; Human Interest, Accrue, Vestwell, Thatch; Next Insurance; Slack (notifications, approvals); Okta, Google Workspace. Many "coming soon" (BambooHR, HiBob, Workday, Pave, Carta, Vanta, Drata, Oneleet, JumpCloud, Sage Intacct). [integrations]
- Security: AES-256 at rest, TLS 1.2+, RBAC, enforced MFA, SOC 2 Type II with continuous monitoring, US-only AWS with per-tenant isolation, customer data not used for model training. [security] [agent]
- Admin roles (default nine): Admin, HR Manager, Hiring Manager, IT Manager, Accountant, Global Payroll Manager, Full Payroll Manager, Benefits Manager, Compliance Auditor; custom roles; per-area levels None, Read, Write, Manage (Manage includes approvals, exports, config); "Capabilities" bundles (Hire People, Run US Payrolls, Run Global Payrolls, Administer Benefits, Configure Time Tracking, Review Expenses, Provision IT Access, Post Payroll to ERP); role changes need Owner approval; Settings > Admins tabs Admins, Pending Invitations, Roles, Security. [help-roles]
- Pricing: Starter $35/person/month + $89/month platform (up to 3 states, API, CLI and MCP, 30-day audit logs); Pro $50 + $129 (all 50 states, AI notice resolution, SSO, RBAC, custom reports); Enterprise custom (multi-entity, webhooks module, 1-year audit retention). Add-ons: IT $15, time tracking $5. [pricing] Note: older copies call the tiers Pro and Premium. [hris] [llms]

## 3. The [reference phrase removed]

### 3.1 What it does (task list)

From [agent], [blog-agent], [fortune], [blog-10tasks]:

1. Onboard new hires end to end: on offer signed, register the company in the new state, set up payroll, enroll benefits and 401(k), order a laptop, create Google and Slack accounts, send a first-day message. [blog-agent] [fortune]
2. New Hire Ready Check: confirm accounts, laptop, payroll and benefits before day one. [agent]
3. Run payroll and check every run for anomalies by comparing it to the previous run and to employee data, flagging items with explanations before money moves. [agent] [blog-10tasks]
4. Resolve tax notices: read the notice, check it against filings and payments, respond to the agency with documents; escalate to a human tax specialist when a phone call, POA or judgment is needed. [blog-agent] [blog-10tasks]
5. Register in new states and file recurring payroll tax returns on schedule. [blog-10tasks]
6. Benefits: enroll by location, role and eligibility, chase stragglers, file elections with carriers, run Open Enrollment. [agent] [blog-10tasks]
7. Review expenses against policy before reimbursement (will not bulk-approve on the user's behalf; offers to walk through each item). [agent]
8. Time-off requests: check balance and coverage, route to approver. [agent]
9. Answer questions over company data: payroll trends ("How has payroll cost trended this year?" answered with a chart after "Ran 3 commands"), "Why did payroll go up 14% this quarter?", "Why did <employee>'s pay change in March?", off-cycle pay calculation for a missed payroll with a mid-period raise and bonus. Employees can ask about their own pay, PTO and policy and see only their own data. [agent] [blog-10tasks]
10. Reports and Slack posts: Monday people report, monthly exec report on the 1st, birthdays and anniversaries. [agent]
11. Contractor tax forms (W-9 or W-8 variant, track expirations) and state-required training. [blog-10tasks]
12. 30-day new hire check-ins summarized for the manager (custom routine example). [blog-agent]

### 3.2 How it asks for decisions

- When a step needs a decision or access it lacks, it asks the right person, waits (days or weeks if needed), checks back, and resumes after approval. [agent] (agent.html text)
- Approval surfaces: in-app, or a Slack message from the app bot with fields and buttons. Exact mockup: bot message mentions the approver, asks to approve a new hire's base salary "required before payroll", fields Routine (New hire onboarding), Employee (name, title), Base salary ($140,000), Payroll (Oct 31), buttons Approve, Deny, Open in Warp. [agent]
- Per-workflow autonomy: recommend only, act after approval, or act autonomously; most customers start with approval and widen after reviewing the log. [blog-agent] [fortune]
- Escalation targets: a company employee or a Warp specialist (human-in-the-loop service). [blog-agent]
- It learns from approvals and overrides. [blog-agent]

### 3.3 Permissions, limits, logging, rollback

- The agent acts as the requesting user and never has more access than that user; admins scope it down to individual actions. [agent] [blog-agent]
- Permissions screen (mockup): Settings > person > Permissions, two blocks "Human permissions" and "Agent permissions", each with View (see people, payroll, company records), Edit (change them), Approve (approve requests and run payroll). [agent]
- Hard limits on money movement that the agent cannot raise; irreversible actions like payroll runs get extra restrictions. [agent] [blog-agent] [aiweekly]
- Every action records identity, scope, written rationale and a rollback path; run logs show what triggered the run, what it did, and what it left for a person; one-click reverse keeps both original and reversal in the log; UI shows a "Message logged" toast. [blog-agent] [agent]
- Audit log retention: 30 days Starter, 1 year Enterprise. [pricing]

### 3.4 Routines

- Definition: jobs the agent owns end to end, started by an event or a schedule, most enabled by default, each with its own autonomy setting and a log of every run. [agent] [blog-agent]
- Triggers: events (offer signed, new hire in a given office, tax notice received, before each payroll run) and schedules (every Monday, on the 1st). [agent] [blog-agent]
- Prebuilt gallery ("[reference phrase removed]", each with "Try Routine"): Monday People Report (Slack), Time-Off Requests, Check payroll for anomalies, New Hire Ready Check, Review every expense against your policy, Monthly Exec Report, Open Enrollment, Celebrate milestones (Slack), plus "Create your own". [agent]
- Routines list (mockup), name plus live status or trigger line: Onboard a new hire ("Confirming their start date"), Check payroll for anomalies ("Comparing this run to the last"), Order their laptop ("When an offer is signed"), Send the people report ("Every Monday"). [agent]
- Routine builder structure (mockup): a plain-language sentence ("Every new hire in New York, remind <person> to hand-deliver their laptop") compiled into Trigger chips (Routine: New Hire AND office = New York Office) then ordered steps: Slack: message @person; Agent: monitor newly connected devices; Agent: monitor until completion, loop in blockers. [agent] (agent.html text)
- Homepage routine log example: create Google account, create Slack handle, intro in #general, ask HR to hand-deliver laptop, follow up in Slack until payroll-ready. [home]
- Custom examples: 30-day check-in summary to manager; Monday headcount and payroll cost by state to the CFO; preconfigured Monday exec briefing combining payroll, schedules, compliance risks and hiring trends. [blog-agent] [aiweekly]

### 3.5 MCP, CLI and API surface

- MCP: marketed as "use Warp from Claude, ChatGPT or any MCP client", included on Starter and Pro alongside a REST API and CLI. No public MCP endpoint, transport or tool list was found (docs.warp.co has no MCP page; /mcp returns 405). [home] [pricing] [aiindex] [docs]
- REST API: base `https://api.joinwarp.com/v1`; header `x-api-key: wrp_company_...`; JSON; OpenAPI 3.1 at /docs/openapi.json; SDKs `warp-hr` (TypeScript, reads WARP_API_KEY, WARP_WEBHOOK_SECRET, WARP_BASE_URL) and Go. [docs-auth] [docs-quick] [docs] [docs-ts]
- Pagination: cursor via `limit` (default 25, 1 to 100), `afterId`, `beforeId` (not both); response `{ hasMore, count, data }`. [docs-page] [openapi]
- Rate limit 60 requests/min, burst 100; 429 body `{ "_tag": "RateLimitExceeded", "message", "retryAt" }`. Errors are `{ _tag, message, ...extra }` (for example ApiKeyUnauthorized 401, MissingRequiredCompanyPermissions or ApiNotEnabled 403, PayrollNotFoundError 404). [docs-rate] [docs-err] [api-payroll]
- Resources and endpoints: workers (list, get, update, delete, reveal SSNs, create employee, create contractor, invite), departments, workplaces (remote or office), levels (track ic, manager, executive), offers (list, create, void, extend deadline, resend), pay rates (list, get, create regular, delete future), pay splits, bank accounts, I-9 verifications, payrolls and paychecks (read only), time off (policies, assignments, balances, requests), benefits (health plans, retirement plans, deductions), custom fields (fields, options, values), company. [docs-llms] [openapi] [docs-ts]
- ID prefixes: wrk_, dpt_, wkp_, jlvl_, offr_, pay_, pyc_, pyr_, pbdg_, top_, cf_, cfo_, cfv_. Money: integer minor units plus `display` string (and `currency`). [api-worker] [api-payroll] [api-paycheck] [openapi]
- Worker object: id, type employee or contractor, status draft, invited, onboarding, active, offboarding, inactive; names, emails, position, startDate, endDate, manager, department, primaryWorkplace, address, timeZone, compensation {payRateId, per year/month/week/hour, amount, currency, display}, level, customFields, terminationReason, updatedAt. [api-worker]
- Webhooks: Standard Webhooks spec (headers webhook-id, webhook-timestamp, webhook-signature `v1,<base64>`; HMAC-SHA256 over `id.timestamp.body`; secret `whsec_`); envelope `{ id, type, timestamp, data }`; 2xx within 15 s; up to 12 attempts with exponential backoff from 30 s; 410 disables; secret rotation with 24 h dual signing; "Send Test" and "Delivery Logs" in Settings > Developer. Events: offer.created, offer.signature_requested, offer.sent, offer.viewed, offer.accepted, offer.voided, offer.expired; pay_rate.created, pay_rate.deleted; time off request created, reviewed, deleted and time_off.balance.adjusted; worker created, updated, deleted, invite sent, invite accepted, onboarding completed, offboarding started, offboarded, reactivated (exact dotted names for these last groups are inferred from page titles). [docs-hooks] [docs-llms]
- Notably the public API has no write endpoints for running payroll, filing taxes or resolving notices; those stay inside the app and agent. [docs-llms]

### 3.6 Agent architecture hints relevant to Weft

- Warp says its API, permissions model and audit layer were built for agent use first, and it expects most actions on Warp to be taken by agents (including customers' own) within a year. [blog-agent]
- The chat UI shows "Thinking..." and "Ran 3 commands", suggesting the agent works through a command or tool surface over the same API, not bespoke UI scraping. [agent]
- The user-named article [instinct] describes an agent product that keeps the model outside the sandbox, keeps durable state outside the worker (git of Markdown memory), uses short-lived scoped credentials, and exposes about 50 tool namespaces through one self-describing `tools` CLI instead of many MCP servers, with role-specific tool surfaces (main agent vs task sub-agents) and secrets never shown to the model. These map cleanly onto Warp's "acts as the user, scoped, logged, rollback" model and suggest one tool registry that backs the agent, a CLI and the MCP server at once.

## 4. Logged-in app information architecture

### 4.1 Global shell

- Left sidebar with a workspace switcher at top (avatar letter, company name, role "Admin"), then items. Two mockup variants exist:
  - Homepage variant: Dashboard, Payroll, People, Calendar, Products, Benefits, IT, Expenses, Learning Management, Time Off, Time Tracking, Company, Taxes & Compliance, Reports, Contracts, Integrations, Settings. [home] (home.html text)
  - Agent page variant: Dashboard, Payroll, People, Agent, Products, Benefits, IT, Expenses, Learning, Time Off, Time Tracking, Company, Taxes & Compliance, Workplaces, Reports, Accounting, Custom Agreements, Calendar. [agent] (agent.html text)
- Global search "Search for anything..." with a Cmd+K hint. Greeting header "Good afternoon, <first name>". Agent chat available as a right-side panel with input "Ask a question..." or "[reference phrase removed]". [home] [agent]
- Settings areas named in sources: Admins (Admins, Pending Invitations, Roles, Security), Developer (API keys, webhook endpoints, Send Test, Delivery Logs), Early Access tab (enables the agent), per-person Permissions (human and agent). [help-roles] [docs-hooks] [fortune] [agent]

### 4.2 Dashboard widgets (homepage mockup, exact fields) [home]

1. Upcoming Payrolls: rows of period, type and cadence, countdown ("Jun 1 to Jun 15, US, Semi-monthly, Autopay in 2d"; "Jun 16 to Jun 30, US, Q2 Bonus, Upcoming in 12d"; "Jun 1 to Jun 30, Global, Monthly, Upcoming in 17d"); footer "2 invoices pending, $8,450" with Review.
2. Payroll Volume: $15,000,000, US/Global toggle, last 90 days, "Funding via ACH", Manage method.
3. People: total 800 (+26 in 30d); Onboarding 15; Invited 8; [reference phrase removed].
4. New Hires: avatar initials, name, title, status chip Active or Onboarding.
5. Upcoming Events: day and date tiles with "Payroll runs today", birthdays, work anniversaries, PTO.
6. Time Off: 8 out today, 12 pending requests, 34 upcoming (30d), Review.
7. Benefits: "2/2 programs live", [reference phrase removed], 401(k) Live.
8. IT: 3/3 connected, accounts linked %, devices compliant %, per-system x/y counts, unlinked and non-compliant counts, Review.
9. State Tax Registrations: state, age ("3d old"), status (Needs info, Awaiting state, Active).
10. Compliance Status: "28/34 states registered" with breakdown Active 28, Filing started 3, Awaiting state 2, Needs info 1.
11. Agent panel: user asks the agent to look at the CA EDD notice in the inbox; agent acknowledges; step chips "Read CA_EDD_Notice_DE2088.pdf", "[reference phrase removed]"; agent states the notice flags an outdated SUI rate and it needs to update 3.4% to 1.5% for 33 employees; status "Working...". (30 verified vs 33 updated is an inconsistency in their mockup.)

### 4.3 Other key screens seen in mockups

- Background agent panel: title "Background Agent", status "Finished 1m ago", task list: Read CA_EDD_Notice_DE2088_Q2_2026.pdf; [reference phrase removed]; summary (Q2 2026 UI rate change, SUI 3.4% to 1.5% across 3 pay groups, response filed with CA EDD, effective next cycle); pending action "Update CA SUI rate for 44 employees" with status Approved. [payroll] [compliance]
- Payroll run review (4.2 is the dashboard; see 2.2 for columns and grouping). [agent]
- Expenses list (see 2.7). [agent]
- Agent chat with inline chart rendering and step summaries. [agent]
- Onboarding checklist per hire ("<Name>'s Tasks", n/m). [hris]
- Directory cards, document library, benefits cards, IT provisioning panel, device compliance card, contractor payment cards, state tiles grid (state code, "Registered" or "Resolved"), registrations table. [hris] [benefits] [it] [global] [compliance] [home]
- Routines gallery, routines list, routine builder, Slack approval card, permissions screen. [agent]

## 5. End-to-end workflows that feel magical

Each is described as Warp presents it, followed by the minimum Weft simulation needed.

1. New hire in a new state. Offer accepted for a Colorado hire where the company has no presence: agent detects the new work location, opens withholding and UI accounts (plus PFL where required) with the state agencies, stores credentials, sets up payroll and local taxes, enrolls benefits and 401(k), orders a laptop, creates Google and Slack accounts, posts a welcome, and nags until the onboarding checklist is payroll-ready; registration takes 5 to 10 business days and shows Needs info, Awaiting state, Active. [blog-agent] [compliance] [home] Weft: event `offer.accepted` triggers a routine that calls a state agency simulator (registration request, async approval after simulated days with a generated account number), IT simulators (directory, chat), and blocks the first payroll for that worker until the state account is Active or the human acknowledges.
2. Pre-payroll checks. Before each run the agent diffs this run against the last and against HR data (new hires, raises, terminations, hours, reimbursements, missing tax setup), groups rows into Needs Review and Ready for Approval, explains each flag, and asks an approver; salary changes may need explicit approval before payroll. [agent] [blog-10tasks] Weft: deterministic variance rules first (percentage delta thresholds, new or missing employees, missing state registration, negative net), LLM writes the explanations.
3. Tax notice resolution. Notice arrives (agency mail, upload or inbox), agent classifies it, reads amounts and rates, verifies affected employees and filings, proposes the fix (for example SUI 3.4% to 1.5%, effective date, affected pay groups and employee count), gets approval, applies it, files a response with the agency, records rationale and a rollback; complex cases go to a specialist. [home] [payroll] [compliance] [blog-irs] Weft: this is the hero flow and the one shown on the dashboard; simulate the CA EDD DE 2088 rate notice end to end, including recalculating employer SUI on the next run and a one-click rollback.
4. Benefits reconciliation. Elections go to carriers by EDI; each run computes employee and employer contributions; before premiums are paid, the carrier invoice is reconciled against payroll deductions and enrollment, flagging mismatches (terminated employee still billed, missing dependent, wrong tier); open enrollment routine chases stragglers and files elections. [benefits] [agent] Weft: carrier simulator emits a monthly invoice with seeded discrepancies; agent produces a reconciliation report and proposes adjustments.
5. Offboarding with access revocation. One termination action: final pay (dismissal payroll subtype), suspend directory account, kill sessions, transfer Drive to manager, deactivate SSO, remove groups, revoke apps, lock or wipe device, COBRA notice, all timestamped. [it] [benefits] [api-payroll] Weft: simulators for directory, SSO, chat and MDM expose state that flips; audit shows each step.
6. Contractor payments. Invite, country agreement, W-8BEN or W-9, bank details, recurring schedule, bulk pay, FX at payment time, same-day status, invoices and 1099s auto-generated. [global] Weft: fixed synthetic FX table, payment rail simulator with pending, sent, delivered.
7. Off-cycle pay question. A worker missed a payroll and had a raise effective that day plus a bonus; the agent computes the off-cycle amount and proposes an off_cycle payroll. [agent] [api-payroll]
8. Scheduled reports. Monday people report and monthly exec report posted to Slack or email. [agent]

## 6. Ranked recommendation for a 9-hour foundation

Principle: one tenant, one fictional company, a few flows that truly work end to end through the agent with approvals, audit and rollback. Everything external is a simulator in the repo.

### P0: implement for real

1. Domain core and synthetic seed (do first, everything depends on it). Company, workplaces, departments, workers (employees and contractors), pay rates, pay schedules, state tax accounts with SUI rates, benefit plans and deductions, prior payroll history (2 to 3 processed runs so variance checks have a baseline). Adopt the conventions Warp's public API uses because they are sound engineering, not because of compatibility: prefixed IDs, integer minor-unit money with a display string, explicit status enums, inclusive pay periods. Reason: every flow and screen reads this data. [api-worker] [api-payroll] Use an original fictional company and visibly fictional people across about 4 states (for example CA, NY, TX plus one state not yet registered, used by the new-hire flow), about 40 to 60 workers, 2 to 3 global contractors; use a reserved domain such as `.example`. Do not reuse Warp's mockup company or people names.
2. US payroll engine, simplified but real arithmetic. Gross to net per paycheck with earnings lines, pre-tax deductions, federal income tax (simplified table), Social Security, Medicare, FUTA, state income tax (simplified per state), SUI and ETT by state wage base, CA SDI, NY PFL/DBL; payroll lifecycle draft to pending (approval) to processing to processed; totals matching the 12 Warp total fields. Store tax parameters in one versioned table marked synthetic. Reason: pre-payroll checks, notice resolution and off-cycle all need real numbers to change. [api-payroll] [api-paycheck] [spt-ca] [spt-ny] [spt-tx]
3. Agent runtime with approvals, audit and rollback. Provider interface (Claude SDK, local OpenAI-compatible, scripted); one tool registry over domain services; acts-as-user permission checks with View, Edit, Approve levels for human and agent; per-routine autonomy (recommend, approve, autonomous); proposals as typed diffs with rationale; approval queue; audit log entries with actor, on-behalf-of, scope, trigger, rationale, inputs, outputs and an inverse operation; money hard limit enforced in the service layer, not the prompt. Reason: this is the product; Warp's agent claims all center on these guarantees. [agent] [blog-agent]
4. Hero flow: CA EDD rate notice to SUI rate change. Agency simulator drops a DE 2088-style notice (PDF or text) into a notices inbox; agent reads it, verifies affected employees and current rates, proposes the change, waits for approval, applies it to the CA tax account effective next run, files a response with the simulator, logs and can roll back; the next payroll preview shows the employer SUI difference. Reason: it is literally the dashboard's showcase and exercises documents, tax data, payroll and approvals in one path. [home] [payroll] [compliance]
5. Pre-payroll anomaly check routine. Runs on "before each payroll" and on demand; deterministic diff vs last run, grouped Needs Review / Ready for Approval, LLM explanations, approval required to submit the run. Reason: high value, cheap, and makes the payroll screen feel alive. [agent] [blog-10tasks]
6. New hire in a new state routine. Event offer.accepted (or worker created with a new state) triggers state registration with the agency simulator (async, statuses Needs info, Awaiting state, Active), onboarding checklist creation, and directory and chat account creation via IT simulators; first payroll blocked until registration is Active. Reason: the second signature Warp workflow and the clearest routine demo. [blog-agent] [compliance] [it]
7. Routines engine. Schedule triggers (cron-like with a controllable clock for demos) and event triggers from a domain event bus; each routine has trigger, filter, steps or a natural-language goal, autonomy level, enabled flag, and a run log. Ship 3 to 4 prebuilt templates (anomaly check, new hire, notice resolution, Monday report) plus "create your own" from a plain-language prompt compiled into a draft routine the user confirms. Reason: routines are the Warp 2.0 headline. [agent] [blog-agent]
8. Logged-in UI with the Warp look. Shell (sidebar, workspace switcher, Cmd+K, greeting), Dashboard with the widget set in 4.2 backed by real data, People list and person detail, Payroll run review, Taxes and Compliance (registrations table plus notices inbox), Agent panel (chat with step chips) plus Approvals inbox, Routines (gallery, list, run log), Audit log. Reason: the user asked to mirror the look; these screens are the ones the flows touch.
9. Public API and MCP server on the same registry. A small read-mostly REST subset (workers, payrolls, paychecks, notices, approvals) with API keys, cursor pagination and `_tag` errors, plus an MCP server (stdio first) that exposes the agent's tools so Claude or another client can drive Weft. Reason: Warp markets API, CLI and MCP on every tier and the shared registry makes this nearly free. [pricing] [docs]
10. Marketing home page in the Warp look with original copy and original SVG mockups (no Warp text, names or art). One page is enough for the foundation. Reason: user request; keep it to one page.

### P1: stub with honest labels ("Simulated" or "Coming soon" badges)

- Benefits reconciliation (carrier invoice simulator vs deductions); can be promoted to P0 if time remains, since deductions already flow through payroll. [benefits]
- Offboarding sequence across IT simulators plus dismissal payroll. [it]
- Global contractor payments with a fixed FX table and a payment rail simulator. [global]
- Slack approvals: an in-app simulated chat channel that renders the approval card with Approve, Deny, Open buttons. [agent]
- Webhooks with Standard Webhooks signing and a delivery log. [docs-hooks]
- Quarterly filings (941, state UI wage reports) generated as documents into the agency simulator; compliance calendar view. [calendar]
- Time off requests and expenses review routines; Monday people report. [agent]
- Roles beyond a single admin (the nine-role model) and custom roles. [help-roles]

### P2: skip for this session

- Real money movement, ACH, bank verification, real e-signature, real I-9/E-Verify, real EDI 834, real carrier or agency APIs. Reason: out of scope by brief; simulators only.
- LMS, time tracking with geofencing, ATS, background checks, accounting journal sync, MDM agent, multi-entity, SSO/MFA for Weft itself, year-end W-2/1099 generation, voids and reversals, free calculators and generators, state guide content pages, customer stories, versus pages. Reason: breadth without depth; none is on the hero paths.

## 7. Open questions and unknowns

- Warp's MCP server details (endpoint, transport, tool names) and CLI are not public; Weft must design its own tool surface. [docs] [aiindex]
- How Warp renders routine run logs in detail (per-step statuses and timestamps) is not shown; only the builder and list are. [agent]
- Exact agent permission granularity beyond View, Edit, Approve per person, and how per-action scoping is configured, is not shown. [agent]
- Whether notices are ingested by email, agency portal scraping or upload is not stated beyond "inbox" and "upload". [home] [blog-irs]
- No public demo video transcript of the logged-in app was found (the homepage 2-minute tour is a video; YouTube pages returned no transcript).
- Warp's state guide numbers contain errors (CA PFL double counted, CA top rate conflict); Weft's tax tables must be labeled synthetic regardless. [spt-ca]
