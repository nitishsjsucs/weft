# Wave 3 research: real Expenses and Time Off

Researched 2026-10-16, about 12:45 to 13:25 PDT, for the wave 3 architect and builders. Everything about the reference product is a paraphrase; no reference copy, names, mockup people or merchants are reused. Weft's own names are used throughout.

## 0. How to read this file

Every fact carries a source. Markers:

- **[V]** verified by me in this session: I read the passage on the cited page or file (for long pages, I downloaded them and searched the exact text).
- **[VS]** vendor states: the reference product says so on its own marketing or docs page; it describes what they claim, not what was observed working.
- **[K]** from my own knowledge; the primary source was blocked or not fetched in this session. Builders must not treat these as verified; each is also listed in section 12.
- **[W]** a Weft design decision or interpretation (no outside authority).

Source keys:

| Key | Source |
|---|---|
| [ref-agent] | https://warp.co/agent, local copy `research/design/reference/html/agent.html` (gitignored, read as text) |
| [ref-home] | https://warp.co/, local copy `research/design/reference/html/home.html` |
| [ref-pricing] | `research/product.md` 2.6 to 2.8 (wave 1 research of https://warp.co/pricing) |
| [api-top] | https://docs.warp.co/api-reference/time-off/get-time-off-policy.md |
| [api-tob] | https://docs.warp.co/api-reference/time-off/list-time-off-balances.md |
| [api-toa] | https://docs.warp.co/api-reference/time-off/list-time-off-assignments.md |
| [api-tor] | https://docs.warp.co/api-reference/time-off/list-time-off-requests.md |
| [api-hooks] | https://docs.warp.co/webhooks/time-off-balance-adjusted.md and https://docs.warp.co/webhooks/time-off-request-reviewed.md, index https://docs.warp.co/llms.txt |
| [pub15] | IRS Publication 15 (2026), https://www.irs.gov/publications/p15, sections 5 and 7 |
| [pub463] | IRS Publication 463 (2025), https://www.irs.gov/publications/p463, chapters 5 and 6 |
| [reg162] | 26 CFR 1.62-2 as reproduced at https://www.law.cornell.edu/cfr/text/26/1.62-2 (eCFR itself redirected to a bot wall) |
| [mile] | https://www.irs.gov/tax-professionals/standard-mileage-rates |
| [gsa27] | GSA Per Diem Bulletin FTR 27-01, https://www.gsa.gov/policy-regulations/regulations/federal-travel-regulation/ftr-and-related-files/gsa-per-diem-bulletin-ftr-2701 |
| [gsa-mie] | https://www.gsa.gov/travel/plan-a-trip/per-diem-rates/mie-breakdowns |
| [dlse-vac] | CA Labor Commissioner, Vacation FAQ, https://www.dir.ca.gov/dlse/FAQ_Vacation.htm |
| [dlse-psl] | CA Labor Commissioner, Paid Sick Leave FAQ (updated Dec 31, 2025), https://www.dir.ca.gov/dlse/Paid_Sick_Leave.htm |
| [dlse-pay] | CA Labor Commissioner, Paydays and final pay FAQ, https://www.dir.ca.gov/dlse/faq_paydays.htm |
| [oak] | City of Oakland, Minimum Wage and Sick Leave, https://www.oaklandca.gov/Government/Departments/Workplace-Employment-Standards/Oakland-Minimum-Wage-Sick-Leave-and-Other-Labor-Laws and the 2026 Measure FF poster https://www.oaklandca.gov/files/assets/city/v/1/workplace-employment-standards/documents/download-posters/posters-2026/minwage_measure_ff_english_poster_set_2026.pdf |
| [nys-psl] | NY State paid sick leave, https://www.ny.gov/new-york-paid-sick-leave/new-york-paid-sick-leave |
| [nys-pre] | NY State paid prenatal leave for employers, https://www.ny.gov/new-york-state-paid-prenatal-leave/information-employers |
| [nyc-faq] | NYC DCWP Protected Time Off Law FAQs (rules as of Feb 22, 2026), https://www.nyc.gov/site/dca/about/paid-sick-leave-FAQs.page |
| [nyc-law] | NYC DCWP law page, https://www.nyc.gov/site/dca/about/paid-sick-leave-law.page |
| [nys-dol] | NY DOL, Unpaid or withheld wages and wage supplements, https://dol.ny.gov/unpaidwithheld-wages-and-wage-supplements |
| [co-3e] | CO CDLE INFO #3E, Payment of Earned Vacation upon Separation (05.29.24), https://cdle.colorado.gov/sites/cdle/files/info_%233e_payment_of_earned_vacation_upon_separation_of_employment_05.29.24.pdf |
| [co-6b] | CO CDLE INFO #6B, Rights and Obligations under HFWA (updated Feb 27, 2026), https://cdle.colorado.gov/sites/cdle/files/info_%236b_rights_and_obligations_under_hfwa_2.27.2026.pdf |
| [co-3a] | CO CDLE INFO #3A, Timing of wage payments and record keeping (1.9.2026), https://cdle.colorado.gov/sites/cdle/files/info_%233a_timing_of_wage_payments%2C_%26_required_record-keeping_1.9.2026.pdf |
| [twc] | Texas Workforce Commission, Texas Payday Law, https://www.twc.texas.gov/programs/wage-and-hour/texas-payday-law and 40 TAC 821.25 (via https://www.twc.texas.gov/sites/default/files/ogc/docs/rules-chapter-821-payday-twc.pdf) |
| [opm] | OPM federal holidays, https://www.opm.gov/policy-data-oversight/pay-leave/federal-holidays/ |
| [dol-17g] | DOL WHD Fact Sheet #17G, https://www.dol.gov/agencies/whd/fact-sheets/17g-overtime-salary, and opinion letter FLSA2005-7, https://www.dol.gov/sites/dolgov/files/WHD/legacy/files/2005_01_07_7_FLSA_PaidTimeOff.pdf |

California statutes (Labor Code 201, 202, 203, 227.3, 246, 2802) are on leginfo.legislature.ca.gov, which returned 403 to the fetcher and a JavaScript challenge to curl. Everything California below comes from the Labor Commissioner's FAQs, which cite those sections; items only the statute would show are marked [K].

Repo files read: `README.md` (skimmed), `SPEC.md` 5, 6, 7.4, 9.2, 9.7, 11.3, `docs/status.md`, `docs/wave2.md`, `research/product.md`, `packages/db/src/schema.ts`, `packages/payroll-tax/src/types.ts`, `packages/core/src/payroll/compute.ts`, `packages/core/src/payroll/offcycle.ts`, `packages/core/src/offboarding/steps.ts`, `packages/core/src/commands/offboarding.ts`, `packages/core/src/demo/define.ts`, `apps/api/src/routes/portal.ts`, `packages/core/test/offboarding/offcycle.test.ts`, `tests/scenarios/gp9-offboarding.test.ts`, `apps/web/src/app/(app)/app/time-off/page.tsx`.

## 1. Summary

1. The reference product's expense and time-off agent behavior is small and well defined: an expense list grouped Needs Review, Approved, Paid Out, Declined; a routine that reviews each expense against policy before reimbursement; a refusal to bulk-approve, with an offer to walk the items one by one; a time-off routine that confirms enough leave and team cover before handing the request to its decider; reimbursements paid through payroll; unused PTO in final pay. [VS] [ref-agent] [ref-pricing]
2. Its public time-off API shows sound data conventions worth adopting in Weft's own names: amounts in minutes, policies with an accrual `schedule` (per hour worked, monthly, yearly, unlimited) and a `unit` (hour or day), balances split into accrued unlocked, accrued locked, used, holds and available, and requests with date or datetime ranges and a time zone. [VS] [api-top] [api-tob] [api-tor]
3. Accountable-plan reimbursements are not wages and are not subject to income tax withholding, social security, Medicare or FUTA. They must be business expenses, substantiated within a reasonable period, and any excess returned. The safe harbor is 60 days to account and 120 days to return excess; late or unsubstantiated amounts become wages, treated as supplemental wages. [V] [pub15] [reg162]
4. Receipts: documentary evidence is needed for lodging and for any other expense of $75 or more. [V] [pub463] Mileage: 72.5 cents a mile for Jan 1 to Jun 30, 2026 and 76 cents for Jul 1 to Dec 31, 2026 (a midyear increase). [V] [mile] Per diem: standard CONUS M&IE $68 a day, $51 on the first and last travel day; standard lodging $110 for FY 2026 and $113 for FY 2027 (from Oct 1, 2026). [V] [gsa27] [gsa-mie]
5. California treats vacation and PTO as vested wages: no use-it-or-lose-it, accrual caps allowed, payout of the whole earned balance at the final rate in the final paycheck, and no recovery of advanced (negative) vacation from final pay. [V] [dlse-vac] Colorado matches that: no forfeiture and no cap on carryover of earned vacation, but a cap on total accrual is allowed. [V] [co-3e] New York and Texas let the written policy control payout. [V] [nys-dol] [twc]
6. Sick leave minimums for Larkspur's states: CA 40 hours or 5 days of use a year, 1 hour per 30 worked, accrual cap allowed at 80 hours or 10 days, 90-day wait, not paid at separation [V] [dlse-psl]; Oakland 1 per 30, carry up to 72 hours at employers with 10 or more [V] [oak]; NY State 40 paid hours for 5 to 99 employees [V] [nys-psl]; NYC the same 40 plus, from Feb 22, 2026, a separate 32-hour unpaid bank, and pay statements must show accrued, used and available each period [V] [nyc-faq]; NY State 20 hours of paid prenatal leave [V] [nys-pre]; CO 1 per 30 up to 48 hours a year, roll over up to 48 [V] [co-6b]; TX none. Larkspur has 48 employees, so it is in the 5 to 99 tier in NY and NYC and the 10-or-more tier in Oakland.
7. Weft today has neither feature: `/app/time-off` and `/app/expenses` are placeholders; `paychecks.reimbursements_cents` is always 0 (`packages/core/src/payroll/compute.ts` lines 219 and 225); final pay uses a simulated PTO rule (10 hours per completed month in the current calendar year, cap 120) that resets every January 1 and ignores leave taken (`packages/core/src/payroll/offcycle.ts` lines 23 to 37). Read as a real policy, that reset would forfeit earned vacation, which California and Colorado prohibit. [V] [dlse-vac] [co-3e]
8. The recommended build (section 10) has two ledgers (time-off minutes, expense items), deterministic rule engines whose output has the same shape as payroll `flags_json`, two routines (`rt_expense_review`, `rt_time_off_requests`), no bulk-approve command anywhere, and payroll wiring: reimbursements land in `reimbursements_cents`, and PTO, sick and holiday hours land as earning lines. Final pay pays the real ledger balance. Nitish has nothing to sign up for (section 11).

## 2. What the reference product offers

### 2.1 Expenses

- Screen: a table titled with all expenses, rows grouped into four bands with counts: Needs Review, Approved, Paid Out, Declined. Columns: employee (name with title under it), the merchant, the category, the amount, the transaction date, the status and the submitted date. The categories shown are Travel, Equipment, Meals, Office, Software and Supplies. In the mockup, a row is submitted one or two days after the transaction. [VS] [ref-agent] (agent.html text, lines 230 to 350 of the extracted text)
- Routine card in the prebuilt gallery: it reviews each expense against the company's policy before it is reimbursed. [VS] [ref-agent]
- Chat exchange in the mockup: asked to approve all open expenses, the agent declines to approve them for the user and offers to go through each one; it then lists items each with an amount, a short label and whether a receipt is attached (for example a dinner with a receipt, supplies without one). [VS] [ref-agent]
- Reimbursements are paid through payroll; the payroll review table has a Reimbursements column next to gross pay; payroll subtypes in the public API include `reimbursement`, and paychecks carry a `reimbursements` line array. [VS] [ref-pricing] [ref-agent] (from `research/product.md` 2.1 and 2.7)
- Roles: a capability bundle named for reviewing expenses exists in the admin role model. [VS] (`research/product.md` 2.8)
- Not public: the policy rule set, receipt handling (OCR or not), card feeds, approval chains, per diem support. Weft designs its own.

### 2.2 Time off

- Routine card: for each request, the agent confirms the person has enough leave and that the team is covered, then sends it to whoever should decide. The weekly Monday report to chat includes who is out, alongside hires and departures. [VS] [ref-agent]
- Dashboard tile: out today, pending requests and upcoming in the next 30 days, with a review action; an upcoming-events strip shows a person out on PTO. [VS] [ref-home]
- API, read only (verified schema shapes, vendor-defined semantics) [VS]:
  - Policy `top_`: `timeOffTypeId` (`tot_`), `timeOffTypeName` (examples: Vacation, Sick Leave), `paid`, `isUnlimited`, `schedule` enum `per_hour_worked | monthly | yearly | unlimited`, `unit` enum `hour | day`, `name`, `description`, `hoursWorkedPerChunk`, `minutesPerChunk`, `minutesPerPeriod`. No carryover, cap, waiting period or payout fields are published. [api-top]
  - Assignment `wrkasn_`: `policyId`, `workerId`, `assignedAt`. [api-toa]
  - Balance (keyed by the assignment id): `accruedUnlocked`, `accruedLocked`, `used`, `holds`, `available`, units unstated. [api-tob]
  - Request: `timeOffPolicyId`, `workerId`, `status` enum `pending | approved | denied`, `startAt` and `endAt` with `startRangeType` and `endRangeType` enum `date | datetime`, `reason`, `createdAt`, `requestedMinutes`, `timeZone`. No reviewer field. [api-tor]
  - Webhooks: `time_off.request.created`, `time_off.request.reviewed` (approved or denied), `time_off.request.deleted`, `time_off.balance.adjusted`; payload schemas are not published. [api-hooks]
- Unused PTO is paid in final pay (dismissal payroll subtype). [VS] (`research/product.md` 5, flow 5)

### 2.3 What Weft takes from this

Adopt the conventions, not the names [W]: minutes as the unit of record, `date | datetime` ranges with a time zone, `holds` for pending requests, `locked` for accrued-but-not-yet-usable time (the CA 90-day wait), and per-hour-worked accrual expressed as minutes of leave per chunk of worked hours. Weft adds what the reference does not publish: carryover, caps, use caps, waiting periods, payout flags, a jurisdiction source per rule, and an audit ledger.

## 3. Expense rules from primary sources

### 3.1 Accountable plans (federal)

- Three rules. Expenses paid or incurred while performing services as an employee (and the payment is not something that would otherwise be paid as wages); substantiated to the employer within a reasonable period; any excess returned within a reasonable period. [V] [pub15] section 5 "Accountable plan"
- Tax effect. Amounts paid under an accountable plan are not wages and are not subject to income tax withholding, social security, Medicare or FUTA. [V] [pub15]. They are excluded from gross income, not reported on the W-2 and exempt from withholding. [V] [reg162] paragraph (c)(4)
- Failure. Unsubstantiated amounts, or excess not returned in time, are treated as paid under a nonaccountable plan and are taxable "for the first payroll period following the end of the reasonable period". [V] [pub15]. Nonaccountable payments are wages, treated as supplemental wages. [V] [pub15] "Nonaccountable plan"; included in gross income, reported on the W-2, subject to all employment taxes. [V] [reg162] (c)(5)
- Reasonable period safe harbor (fixed date method): the advance within 30 days of the expense, accounting within 60 days after it was paid or incurred, return of excess within 120 days. Alternative: a periodic statement at least quarterly, with 120 days to respond. [V] [pub15] (it restates [reg162] paragraph (g))
- Per diem and fixed allowances: an employee is treated as having accounted for the amount when the allowance does not exceed the federal rates; business purpose and the other elements must still be substantiated. Any excess over the substantiated amount is wages, and the substantiated (nontaxable) part goes in W-2 box 12, code L. [V] [pub15] "Per diem or other fixed allowance"
- Supplemental wage withholding rate is 22%, or 37% for supplemental wages over $1 million in the year. [V] [pub15] What's New

Weft consequence [W]: an approved expense is a non-taxable reimbursement only when it is substantiated within 60 days of the transaction date. Past 60 days, the reviewer chooses either Decline or "Approve as taxable", which pays it as a supplemental earning line inside gross pay. That rule makes the accountable-plan boundary visible, and it is easy to test.

### 3.2 Substantiation and receipts

- Documentary evidence (receipts, canceled checks, bills) is required, except: meals or lodging covered by a per diem allowance under an accountable plan; an expense other than lodging under $75; transportation where a receipt is not readily available. [V] [pub463] chapter 5 "Documentary evidence"
- Adequate evidence shows the amount, date, place and essential character of the expense. [V] [pub463] "Adequate evidence". The meal-specific elements (business relationship of the attendees) are in [pub463] chapter 5 but I did not read that passage. [K]
- Meals: the 50% deduction limit is the employer's deduction question, not the employee's taxability; under an accountable plan the employee is not taxed. [V] [pub463] (50% limit text) Weft needs no 50% logic in payroll; an accounting export could tag meals. [W]

### 3.3 Rates for 2026

| Rate | Value | Source |
|---|---|---|
| Business mileage, Jan 1 to Jun 30, 2026 | 72.5 cents per mile (IR-2025-128) | [V] [mile] |
| Business mileage, Jul 1 to Dec 31, 2026 | 76 cents per mile (IR-2026-29) | [V] [mile] |
| Business mileage, 2025 | 70 cents per mile | [V] [mile] [pub463] |
| Standard CONUS lodging, FY 2026 (Oct 1, 2025 to Sep 30, 2026) | $110 | [V] [gsa27] (as the rate it replaces) |
| Standard CONUS lodging, FY 2027 (from Oct 1, 2026) | $113 | [V] [gsa27] |
| Standard M&IE, FY 2026 and FY 2027 | $68 (tiers $68 to $92) | [V] [gsa27] |
| $68 tier breakdown | breakfast $16, lunch $19, dinner $28, incidentals $5; first and last day of travel $51.00 (75%) | [V] [gsa-mie] |
| High-low method from Oct 1, 2025 | $319 high-cost (incl. $86 M&IE), $225 other (incl. $74 M&IE), Notice 2025-54 | [V] [pub463] |
| Incidental-expenses-only rate | $5 a day | [V] [pub463] |

Store these as a versioned `EXPENSE_RATES_2026` table labeled with sources, like `TAX_2026`; the mileage rate is chosen by the transaction date, not the submission date. [W]

### 3.4 California reimbursement duty

California Labor Code 2802 requires the employer to indemnify employees for necessary expenditures incurred in the direct consequence of their duties, with interest on unpaid amounts and attorney's fees recoverable. [K] (leginfo blocked). Weft consequence [W]: for a CA worker, the policy engine never auto-declines a claim only because it is over a category limit; it routes the item to a human with the note "California workers must be reimbursed for necessary business expenses; decide whether this purchase was necessary". Declines for missing substantiation, duplicates or non-business items stay allowed.

## 4. Time off rules from primary sources

### 4.1 Vacation and general PTO

| Rule | California | Colorado | New York | Texas |
|---|---|---|---|---|
| Must offer vacation? | No (a plan is voluntary; part-time exclusions are allowed if stated) [V] [dlse-vac] Q3 | No [V] [co-3e] | No; benefits are owed only if promised [V] [nys-dol] | No [V] [twc] |
| Earning | Vests as labor is performed; any accrual basis (day, week, pay period) [V] [dlse-vac] Q2 | Employer sets rate and method [V] [co-3e] | Per written policy [V] [nys-dol] | Per written policy [V] [twc] |
| Waiting period with no accrual | Allowed if real, not a subterfuge [V] [dlse-vac] Q1 | not researched | Policy controls | Policy controls |
| Use-it-or-lose-it | Illegal [V] [dlse-vac] Q4 | Illegal: cannot cap carryover of earned vacation [V] [co-3e] | Allowed if the written policy says so (the DOL will not take a claim when the policy excludes the payout, for example quitting without notice) [V] [nys-dol] | Allowed; policy enforced as written [V] [twc] |
| Accrual cap | Allowed (DLSE example: 200 hours) [V] [dlse-vac] Q5 | Allowed on accrual or use; the Wage Protection Rules allow a cap "at a year's worth or more" [V] [co-3e] footnote 1 (7 CCR 1103-7 Rule 2.17.2) | Allowed | Allowed |
| Combined PTO bank | Same rules as vacation [V] [dlse-vac] Q8 | Counts as vacation whatever its name, if usable at the employee's discretion [V] [co-3e] | Policy | Policy |
| Payout at separation | All earned unused vacation at the final rate of pay, prorated daily, in the final paycheck (Labor Code 227.3) [V] [dlse-vac] Q2 and Q10 | All earned vacation, for any separation [V] [co-3e] (C.R.S. 8-4-101(14)(a)(III); Nieto v. Clark's Market, Colo. 2021) | Per written policy [V] [nys-dol] | Only if a written policy or agreement provides it (40 TAC 821.25) [V] [twc] |
| Negative (advanced) balance at separation | Cannot be deducted from final pay [V] [dlse-vac] Q9 | not researched; treat as CA [W] | not researched; treat as CA [W] | Deductions need written authorization [V] [twc] |
| Year-end cash-out | Allowed instead of carryover [V] [dlse-vac] Q7 | not researched | Policy | Policy |
| Employer controls timing | Yes [V] [dlse-vac] Q6 | not researched | Policy | Policy |
| Final pay timing | Discharge: immediately; quit with at least 72 hours notice: last day; quit without: within 72 hours; willful lateness: waiting-time penalty of a day's pay per day up to 30 days (LC 201 to 203) [V] [dlse-pay] | Discharge: immediately (6 or 24 hour exceptions when payroll is closed or offsite); quit: next regular payday [V] [co-3a] | Next regular payday (Labor Law 191(3)) [K] | Discharge: within 6 calendar days; quit: next regular payday [V] [twc] |
| Records or pay statement | Vacation not on the statement by state law [K] | Records must keep vacation or PTO hours accrued, used and available in the benefit year [V] [co-3a] | Written notice or posting of the policy is required [V] [nys-dol] | Policy in writing advised [V] [twc] |

Note: [co-3e] cites Nieto as "488 P.2d 1140"; the case is in the Pacific Reporter, Third Series. Cite it as Nieto v. Clark's Market, Inc., 2021 CO 48, if it appears anywhere in the UI. [K]

### 4.2 Paid sick leave minimums

| Rule | California (state) | Oakland (city) | New York State | New York City | Colorado (HFWA) | Texas |
|---|---|---|---|---|---|---|
| Amount | Use of at least 40 hours or 5 days a year, whichever is more (since Jan 1, 2024) [V] [dlse-psl] | City ordinance on top of state law; the more generous rule applies [V] [dlse-psl] [oak] | 5 to 99 employees: 40 paid hours a year; 100 or more: 56 [V] [nys-psl] | Same tiers (40 or 56) plus 32 hours unpaid from Feb 22, 2026, and 20 hours of paid prenatal leave [V] [nyc-faq] [nyc-law] | Up to 48 hours a year [V] [co-6b] | No state law |
| Employee count | n/a | Fewer than 10 vs 10 or more [V] [oak] | Employer size [V] [nys-psl] | Highest simultaneous count in the year, counted nationwide [V] [nyc-faq] | All employers [V] [co-6b] | n/a |
| Accrual | 1 hour per 30 worked, or an alternative that gives 24 hours by day 120 and 40 by day 200 [V] [dlse-psl] | 1 per 30 worked in Oakland [V] [oak] | At least 1 per 30, from Sep 30, 2020; front-load allowed [V] [nys-psl] | 1 per 30 [V] [nyc-faq] | 1 per 30 from day one [V] [co-6b] | n/a |
| Exempt employees | Deemed 40 hours a week (Labor Code 246(b)(3)) [K] | not researched | not stated | Deemed 40 hours a week unless the normal week is shorter [V] [nyc-faq] | Deemed 40 hours a week [V] [co-6b] | n/a |
| Accrual cap | May cap at 80 hours or 10 days [V] [dlse-psl] | Carry up to 72 hours at 10 or more employees, 40 below 10 [V] [oak] | not stated on the page | Carry up to 40 or 56 into the next year [V] [nyc-faq] | 48 hours a benefit year [V] [co-6b] | n/a |
| Use cap | May limit use to 40 hours or 5 days a year [V] [dlse-psl] | not researched | May cap use at 40 or 56 in writing [V] [nys-psl] | 40 or 56 accrued plus 32 unpaid [V] [nyc-faq] | Need not allow over 48 in a year [V] [co-6b] | n/a |
| Carryover | Yes, subject to the cap [V] [dlse-psl] | Yes, year to year [V] [oak] | not stated | Up to 40 or 56; unpaid bank does not carry [V] [nyc-faq] | Up to 48 [V] [co-6b] | n/a |
| Front-load | Allowed (full amount at the start of a 12-month period) [V] [dlse-psl] | not researched | Allowed; cannot be clawed back [V] [nys-psl] | Allowed; must still track use [V] [nyc-faq] | not researched | n/a |
| Waiting period | 90 days of employment before use [V] [dlse-psl] | 90 calendar days [V] [oak] | not stated | none stated | None: usable on accrual [V] [co-6b] | n/a |
| Minimum increment | Employer may set up to 2 hours [V] [dlse-psl] | not researched | Up to 4 hours [V] [nys-psl] | First block up to 4 hours, then 30 minutes or less [V] [nyc-faq] | One hour, or 6 minutes if none is set in writing [V] [co-6b] | n/a |
| Pay rate | Non-exempt: regular non-overtime rate for the week, or prior 90 days' pay divided by hours; exempt: like other paid leave [V] [dlse-psl] | n/a | not stated | not stated | Same rate and benefits as hours worked, on the regular payday [V] [co-6b] | n/a |
| Payout at separation | Not required [V] [dlse-psl] | Not paid out [V] [oak] | not stated | Not required [V] [nyc-faq] | not required by HFWA [K] | n/a |
| Rehire | Restore balance if rehired within 12 months [V] [dlse-psl] | not researched | not stated | Restore if rehired within 6 months [V] [nyc-faq] | not researched | n/a |
| Statement or records | Pay stub or separate written statement must show the balance (or "unlimited") [V] [dlse-psl] | n/a | Summary on request within 3 business days; keep records 6 years [V] [nys-psl] | Each pay statement: accrued this period, paid and unpaid used this period, unpaid hours available, accrued paid hours available [V] [nyc-faq] | Records of sick hours accrued, used, available [V] [co-3a] | n/a |

NY State paid prenatal leave: 20 paid hours per 52-week period counted from first use, separate from sick leave, no waiting period, regular rate, no carryover, no payout. [V] [nys-pre]. NYC: paid prenatal leave has a minimum increment of 1 hour, and its use and remainder must appear on the pay statement. [V] [nyc-faq]

### 4.3 Holidays

- Private employers are not required to give paid holidays; holiday pay is a policy promise (NY lists holiday pay as a wage supplement owed only if promised; Colorado holiday pay usable only on the holiday is not vacation). [V] [nys-dol] [co-3e] Example 2
- Federal holidays [V] [opm]: 2026: Jan 1, Jan 19, Feb 16, May 25, Jun 19, Jul 3 (Jul 4 observed), Sep 7, Oct 12, Nov 11, Nov 26, Dec 25. 2027: Jan 1, Jan 18, Feb 15, May 31, Jun 18 (observed), Jul 5 (observed), Sep 6, Oct 11, Nov 11, Nov 25, Dec 24 (observed).

### 4.4 Federal pay rules that touch time off

- Lump-sum payout of unused vacation in addition to regular wages is a supplemental wage payment; ordinary vacation pay withholds as regular wages. [V] [pub15] section 7 "Vacation pay". When supplemental wages are paid with regular wages and the amount of each is specified, the employer may use the 22% flat rate or the aggregate method. [V] [pub15] section 7. So Weft's current aggregate treatment of `pto_payout` (`offcycle.ts` line 19) is allowed; keep it, and keep the 22% option for later. [W]
- Employer-paid sick pay is subject to social security, Medicare and FUTA. [V] [pub15] section 5 "Sick pay"
- Exempt salaried employees: a leave bank may be reduced for partial-day absences, but the guaranteed salary must still be paid even when the bank is empty or negative for a partial-day absence; salary itself can be docked only in full-day units for personal absences. [V] [dol-17g] (FLSA2005-7)
- Paid leave and holiday hours are not hours worked for FLSA overtime (29 CFR 778.218 to 778.219). [K]

## 5. Weft gaps found in the code

1. `packages/core/src/payroll/offcycle.ts` lines 23 to 37: `unusedPtoHoursX100` counts only whole months of the current calendar year, so a December 31 balance vanishes on January 1, and leave taken is never subtracted. Read as a real policy, that is the forfeiture [dlse-vac] Q4 and [co-3e] prohibit. Replace it with the ledger balance (section 6.3). The PTO payout rate (annual salary / 2,080, or the hourly rate) is a final-rate calculation, which matches [dlse-vac] Q10; keep `hourlyRateOf`.
2. `packages/core/src/payroll/compute.ts` lines 219 and 225, and `offcycle.ts` lines 110, 119 and 170: `reimbursements_cents: 0` everywhere. The engine already pays reimbursements on top of net (`packages/payroll-tax/src/calculate.ts` line 82) and the totals identities already include them (`SPEC.md` 7.4), so the wiring point is just the snapshot in `loadWorld`.
3. `packages/payroll-tax/src/types.ts` line 2: the engine earning types are `regular | overtime | salary | bonus | supplemental`. Weft needs stored earning types `pto`, `sick`, `paid_holiday` and `taxable_reimbursement`, mapped to engine types the way `ENGINE_TYPE` in `offcycle.ts` line 19 already does (`pto`, `sick`, `paid_holiday` to `salary` or `regular`; `taxable_reimbursement` to `supplemental` with `supplementalCents`). The reference API's earning type list includes `paid_holiday`, `pto` and `sick`. [VS] (`research/product.md` 2.1)
4. Paydays move only around weekends; bank holidays are not modeled (`docs/wave2.md` line 177). The holiday calendar below is a company policy, which is a separate thing; do not change paydays in this wave. [W]
5. The `uploads` table (`packages/db/src/schema.ts` lines 284 to 287) and the I-9 multipart route (`apps/api/src/routes/portal.ts`: 5 MB, png, jpeg, webp, pdf, stored at `uploads/<sha>.bin`) are reusable for receipts with `purpose = "receipt"`.

## 6. Design: Time Off

### 6.1 Data model (migration `0004_wave3_time_off.sql`) [W]

All amounts are integer **minutes** (the unit [api-tor] uses). Paychecks keep `hours_x100`; convert with `hours_x100 = round(minutes * 100 / 60)` only at the payroll boundary.

| Table | Columns |
|---|---|
| `time_off_types` | id `tot_`, company_id, kind (`vacation`, `sick`, `unpaid_sick`, `prenatal`, `holiday`, `unpaid`), name, paid bool, counts_as_vacation bool (drives payout at separation) |
| `time_off_policies` | id `top_`, company_id, type_id, name, jurisdiction (`US`, `CA`, `CA-Oakland`, `NY`, `NY-NYC`, `CO`, `TX`), schedule (`per_pay_period`, `per_hour_worked`, `front_load_annual`, `unlimited`), minutes_per_period (nullable), tiers_json (`[{min_service_months, minutes_per_period}]`), worked_minutes_per_chunk and minutes_per_chunk (1 per 30 is 30 and 1), exempt_deemed_minutes_per_week (2,400), accrual_cap_minutes, annual_accrual_cap_minutes, carryover_cap_minutes (null means everything carries), annual_use_cap_minutes, front_load_minutes, waiting_days_before_use, min_increment_minutes, allow_negative_minutes (0), pay_out_at_separation bool, reinstate_within_days, year_start (`01-01`), effective_from, effective_to, sources_json (`[{label, url}]`, shown in the UI) |
| `time_off_assignments` | id `tasn_`, policy_id, worker_id, assigned_at, effective_from, effective_to, accrual_remainder_minutes (the per-hour-worked carry) |
| `time_off_ledger` | id `tol_`, assignment_id, worker_id, policy_id, kind (`import`, `accrual`, `accrual_capped`, `front_load`, `use`, `hold`, `hold_release`, `adjustment`, `carryover_forfeit`, `payout`, `reinstatement`), minutes (signed), effective_date, source_ref (`pay_...`, `tor_...`, `act_...`), action_seq, created_at. Append only; balances are sums. |
| `time_off_requests` | id `tor_`, worker_id, policy_id, status (`pending`, `approved`, `denied`, `cancelled`, `taken`), start_at, start_range_type (`date` or `datetime`), end_at, end_range_type, time_zone, requested_minutes (computed, never typed by the employee), days_json (`[{date, minutes, holiday: bool}]`), reason (employee text: an **untrusted field**), approver_principal_id, routing_json (who and why), checks_json (same shape as paycheck `flags_json`: `{rule, severity, message, evidence}`), decided_by, decided_at, decision_note, payroll_run_id (the run that paid it), created_at |
| `holiday_calendars`, `holidays` | id `hcal_`; `holidays`: calendar_id, date, name, minutes (480), eligible worker types |
| `teams` (or reuse departments) | Coverage is per department in wave 3 (departments already exist with a lead). Each department gets `coverage_max_out_pct` (default 30) and `coverage_min_present` (default 2) in its settings. |

Balance (the reference's shape [api-tob], in Weft names) for (worker, policy, as_of):

- `accrued_unlocked` = sum of accrual, front_load, import, adjustment and reinstatement rows dated on or before as_of, minus forfeits and payouts, where the waiting period has passed.
- `accrued_locked` = the same rows while the waiting period has not passed (CA and Oakland sick in the first 90 days).
- `used` = minus the sum of `use` rows. `holds` = minutes on pending and approved-but-not-yet-taken requests.
- `available` = accrued_unlocked - used - holds.
- `projected(as_of)` adds the accruals scheduled by `as_of` for per-pay-period policies (one accrual per period end), so a request in three weeks is checked against the balance it will have by then. CA forbids recovering advanced vacation from final pay [dlse-vac] Q9, so Weft allows no negative balances (`allow_negative_minutes = 0`). [W]

### 6.2 Accrual engine tied to pay runs [W]

- Trigger: the `payroll.processed` handler (deterministic, like the existing `sim.bank_batch_settled` handler) runs the system-only command `time_off.post_accruals {run_id}` as `svc_events` (R1 by the system-record rule, `SPEC.md` 9.3). Only regular runs accrue; dismissal and off-cycle runs do not. The run key `(run_id, assignment_id)` makes it idempotent.
- `per_pay_period`: one accrual of `minutes_per_period` per period for workers employed on the period end; the tier is chosen by completed months of service on the period end.
- `per_hour_worked`: worked minutes are hourly time entries `(regular + overtime) * 60 / 100` (PTO, sick and holiday hours are not hours worked), or, for salaried exempt workers, `2,400 * weekdays employed in the period / 5` (the deemed 40-hour week of [co-6b] and [nyc-faq]; a full semi-monthly period is 5,200 minutes, which is 86.67 hours, matching the seed's salaried hours). Accrual is `floor((remainder + worked) / 30)` minutes, and the new remainder is `(remainder + worked) mod 30`.
- Caps: post `min(accrual, cap - balance)` as `accrual` and the rest as `accrual_capped` (amount 0 with the uncapped value in the note, so the UI can say "capped at 80.00 h").
- `front_load_annual`: on `year_start` and on the hire date, post `front_load_minutes`; for the NYC unpaid bank that is 32 hours, not prorated for mid-year hires. [V] [nyc-faq]
- Year end (`time_off.close_year`, system_only, on the first scheduler tick of the new year): for each assignment, carry `min(balance, carryover_cap)` and post the rest as `carryover_forfeit`. **Policy validation refuses** a vacation-kind policy in CA or CO with a carryover cap below its accrual cap (`DOMAIN_FORFEITURE_NOT_ALLOWED`, citing [dlse-vac] Q4 and [co-3e]). Sick policies may forfeit above their legal carry limits.

### 6.3 Requests, checks, routing and decisions [W]

- Requested minutes are computed from the dates: each weekday in the range is 480 minutes (or the datetime span for partial days), company holidays are 0 and listed in `days_json`, weekends are 0. The employee never types an amount.
- Deterministic checks (`time_off.check_request`, R1) write `checks_json`:
  - `INSUFFICIENT_BALANCE` (block): requested > projected available at the start date.
  - `WAITING_PERIOD` (block): a sick policy inside its 90-day wait (CA, Oakland).
  - `USE_CAP` (block): the request would take the year's use past `annual_use_cap_minutes`.
  - `INCREMENT` (block): a partial day below `min_increment_minutes`.
  - `COVERAGE_CONFLICT` (review): on some working day, the department's share of people out (approved plus pending) exceeds `coverage_max_out_pct`, or the people present fall below `coverage_min_present`; evidence lists the dates and the other requests by id.
  - `OVERLAPS_PAYROLL_DEADLINE` (review): the requester approves payroll (Theo) and is out on an approval-deadline day.
  - `INCLUDES_HOLIDAY` (info), `SHORT_NOTICE` (info, under 7 days ahead; never blocks sick leave).
- Routing: the approver is the worker's manager when that manager has a human principal, else the department lead's principal, else the People admin (Vic). `routing_json` records the chain and the reason, for example that the manager has no Weft login. Wave 3 seeds **one manager principal**, Imani Ferreira (demo), Hardware lead, role `manager`, whose approve right covers only her direct reports. The check lives in the decide command (the subject worker's `manager_id` must be the principal's worker), so the grant model stays unchanged. [W]
- Decision: `time_off.decide {request_id, decision: approve | deny, note}`. A human approver calls it directly and it runs; for the agent it is always a proposal. Approve converts the hold into `use` rows dated per day; deny releases the hold. Sick leave requests that pass the checks are approved by the routine's precheck path only after a human decision, the same as vacation (no autonomous approvals in wave 3).
- After a request is approved, `refreshOpenDrafts` (already used by offboarding) recomputes any draft payroll whose period contains its days.

### 6.4 Payroll effects [W]

- Salaried: gross is unchanged. Hours taken in the period become `pto`, `sick` or `paid_holiday` lines at `annual / 2,080` per hour, and the `salary` line becomes the remainder, so the paycheck shows where the 86.67 hours went.
- Hourly: each paid leave hour is a line at the hourly rate on top of the worked hours from `time_entries`. Overtime counts only hours worked. [K] (29 CFR 778)
- Unpaid types (`unpaid_sick`, `unpaid`): salaried pay is docked only for full days of personal absence, never for a partial day, even with an empty bank [V] [dol-17g]; hourly workers simply have no line.
- The paycheck drawer and the employee pay statement get a "Time off" block per policy: accrued this period, used this period, available, plus the NYC unpaid bank and prenatal remainder for NYC workers, which meets [nyc-faq], [dlse-psl] (CA sick balance on the stub) and the CO record list [co-3a].
- New pre-payroll anomaly rules (`SPEC.md` 7.5 style): `PENDING_TIME_OFF_IN_PERIOD` (review: a pending request overlaps the period), `PTO_LINE` (info), `NEGATIVE_BALANCE` (review, which should never fire).
- Final pay: `finalPayEarnings` takes the vacation-kind balance from the ledger: the posted balance plus the final period's accrual prorated by calendar days through the last day (`floor(minutes_per_period * days_employed_in_period / days_in_period)`), following the CA daily-proration rule [dlse-vac] Q2. The payout is paid at the final rate, then a `payout` ledger row zeroes the balance in the same transaction. Sick, prenatal and unpaid types are never paid out. A negative balance pays nothing and is never deducted (`PTO_ADVANCE_NOT_RECOVERED`, info). [V] [dlse-vac] Q9
- Larkspur's written policy pays out vacation in every state, including NY and TX where it is optional; that is simpler and never wrong. [W]

### 6.5 Commands, tiers and grants [W]

New domain `time_off` in agent grants (agent: `time_off edit`; approve is never effective for agents).

| Command | Risk, approval | Tiers and notes |
|---|---|---|
| `time_off.list_policies`, `time_off.get_balance {worker_id, policy_id?, as_of?}`, `time_off.list_requests {status?, worker_id?, department_id?, from?, to?}`, `time_off.team_calendar {department_id, from, to}` | R0 | `readCommand`; the calendar returns per day: out (names), holidays, coverage pct. `reason` is in `untrustedFields`. |
| `time_off.check_request {request_id}` | R1, never | Deterministic; writes `checks_json`, idempotent. |
| `time_off.route_request {request_id}` | R1, never | Sets the approver from the routing rule; emits `time_off.request.routed`. |
| `time_off.decide {request_id, decision, note}` | R2, always for agents | `lease: time_off:{request_id}`; reversible while no paycheck has paid it (reverse: `time_off.reopen`). Supersedes an older proposal on the same request. |
| `time_off.adjust_balance {worker_id, policy_id, minutes, reason}` | R2, always | Reverse: the inverse adjustment; emits `time_off.balance.adjusted`. |
| `time_off.submit` | `human_only` (employee persona and admins) | Portal route; computes minutes, creates holds, emits `time_off.request.created`. |
| `time_off.cancel` | `human_only` | Releases holds; emits `time_off.request.cancelled`. |
| `time_off.post_accruals`, `time_off.close_year`, `time_off.record_payout` | `system_only`, R1 | On the `svc_events` allowlist. |
| Policy and holiday settings | human only, not tools | Settings screens. |

### 6.6 Routine `rt_time_off_requests` [W]

- Trigger: event `time_off.request.created`; manual "Check again" on a request.
- Precheck (zero tokens): run `check_request` and the routing rule; derived args `{request_id, approver}`; `skip` when the request is no longer pending.
- Checklist: `checked:{request_id}`, `routed:{request_id}`, `proposal_exists:time_off.decide:{request_id}`, `notified:{approver}:{request_id}`.
- The model writes a short grounded summary (balance before and after, coverage per day, holidays inside the range), proposes `time_off.decide` with `approve` when nothing blocks, or with `deny` and the blocking rule otherwise, then sends the approver a chat message via `comms.send_message` (R3, `autoAllow: "untainted"`; the run is tainted only when it read the employee's `reason`, and then the message becomes a proposal).
- Allowlist (7): `time_off.get_balance`, `time_off.list_requests`, `time_off.team_calendar`, `time_off.check_request`, `time_off.decide`, `people.get`, `comms.send_message`.
- The weekly people digest adds "out this week" from `time_off.list_requests` (the reference digest includes time off [VS] [ref-agent]).

### 6.7 Screens (`/app/time-off`) [W]

- Tabs: **Requests** (pending first, with check chips and routing line, then upcoming and past; Approve and Deny for the approver), **Calendar** (department month grid: one row per person, holiday column shading, out markers in the accent wash, a coverage percent per day in the footer, over-limit days outlined), **Balances** (per worker per policy: available, used, holds, locked, accrued YTD; drill into the ledger), **Policies** (per jurisdiction cards whose rule lines carry source links from `sources_json`), **Holidays**.
- Person detail: a Time off tab (balances and ledger). Portal persona: "Request time off" with live minute computation and a projected balance.
- Home: a Time Off tile with out today, pending and upcoming in 30 days.
- Remove "Coming soon" from the sidebar item only when the slice passes e2e.

## 7. Design: Expenses

### 7.1 Data model (migration `0004_wave3_expenses.sql`) [W]

| Table | Columns |
|---|---|
| `expense_policies` | id `exp_pol_`, company_id, version, effective_from, rules_json (section 7.2 parameters), sources_json |
| `expenses` | id `exp_`, company_id, worker_id, category (`travel`, `lodging`, `meals`, `mileage`, `equipment`, `software`, `office`, `supplies`), merchant (employee text: **untrusted**), amount_cents, currency `USD`, transaction_date, submitted_at, business_purpose (**untrusted**), attendees (**untrusted**; meals), miles_x10 (mileage), trip_ref (groups items), receipt_upload_id (nullable, `uploads.id`), receipt_extract_json (simulated extraction: merchant, date, total; **untrusted**), status (`submitted`, `needs_review`, `returned`, `approved`, `approved_taxable`, `declined`, `scheduled`, `paid`), checks_json (same `{rule, severity, message, evidence}` shape), explanation, explanation_source (`agent`, `template`), explanation_run_id, approver_principal_id, decided_by, decided_at, decision_reason_code, decision_note, payroll_run_id, paycheck_id, policy_version |
| `paychecks` | add `reimbursements_json` (`[{expense_id, category, amount_cents}]`) next to the existing `reimbursements_cents` |

The reference's status bands map as follows: Needs Review = `needs_review` plus `returned`, Approved = `approved` plus `approved_taxable` plus `scheduled`, Paid Out = `paid`, Declined = `declined`. [VS] [ref-agent]

### 7.2 Policy engine [W]

Deterministic and pure (`packages/core/src/expenses/policy.ts`), versioned, with each rule's sources in the policy row. Larkspur demo values:

| Rule code | Severity | Condition (Larkspur value) | Source |
|---|---|---|---|
| `RECEIPT_MISSING` | block | No receipt and (category `lodging` or amount >= $75.00) | [V] [pub463] |
| `RECEIPT_MISMATCH` | review | Extracted total differs from the claim by more than $1.00, or the date by more than 3 days | [W] |
| `DUPLICATE` | block | Same worker, merchant (case-folded), amount and transaction date within 1 day of a non-declined item | [W] |
| `ACCOUNTABLE_WINDOW` | review | Submitted more than 60 days after the transaction; only Decline or Approve as taxable are allowed | [V] [pub15] [reg162] |
| `OVER_CATEGORY_LIMIT` | review | Meals > $75 per person; equipment > $1,000 without `pre_approval_ref`; software > $50 a month; lodging > the GSA rate for the trip location (standard $110 through Sep 30, 2026, $113 after) | [V] [gsa27] for lodging, others [W] |
| `MEALS_DETAIL_MISSING` | review | Meals without attendees and purpose | [K] [pub463] |
| `PER_DIEM_OVER` | review | Meals on a trip day above $68, or $51 on the first and last day | [V] [gsa-mie] |
| `MILEAGE_RATE` | block | `amount != round(miles * rate on transaction_date)`, with 72.5 cents through Jun 30, 2026 and 76 cents after | [V] [mile] |
| `OUTSIDE_EMPLOYMENT` | block | Transaction before start_date or after end_date | [W] |
| `FUTURE_DATE` | block | Transaction after the submission date | [W] |
| `CA_NECESSARY_EXPENSE` | info | CA worker and `OVER_CATEGORY_LIMIT` fired: never auto-decline, route to a human with the note in 3.4 | [K] LC 2802 |
| `SECOND_APPROVER` | info | Amount > $1,000 needs a second human after the manager (`require_second_approver` style) | [W] |

### 7.3 Lifecycle, reimbursement and audit [W]

1. The employee submits (portal or app; multipart with the receipt reusing the I-9 upload path: 5 MB, png, jpeg, webp, pdf). Status `submitted`, then the engine runs synchronously and sets `needs_review`. Emits `expense.submitted`.
2. The agent routine (7.5) explains each item and proposes one decision per item; or a human approver decides directly in the app.
3. `approve`: status `approved`; `approve_taxable`: status `approved_taxable`; `return`: status `returned` with a reason the employee sees (resubmission reruns the engine); `decline`: status `declined` with a reason code (`no_receipt`, `duplicate`, `personal`, `over_policy`, `late`, `other`) and a note.
4. Scheduling: on approval, the item attaches to the earliest **draft** regular run whose approval deadline has not passed (else the next draft created), and `refreshOpenDrafts` recomputes it. A non-taxable item adds to `reimbursements_cents` and `reimbursements_json` (outside gross, taxes and net, inside the bank entry and the totals: the identities in `SPEC.md` 7.4 already hold). An `approved_taxable` item adds a `taxable_reimbursement` earning line (supplemental) to gross. Status `scheduled`.
5. On `payroll.processed`, a deterministic handler marks scheduled items of that run `paid` (system_only `expenses.mark_paid`, R1).
6. Audit: every decision is an action row with the before and after status; reversal (`expenses.reopen`) is allowed until `paid`, after which the action is "Not reversible: paid in <run>".
7. New pre-payroll rule `REIMBURSEMENT_SPIKE` (review): a paycheck's reimbursements exceed $2,500 or 3 times that worker's average over the last 3 runs.

### 7.4 Commands, tiers and grants [W]

New domain `expenses` (agent: `expenses edit`; approve never effective).

| Command | Risk, approval | Notes |
|---|---|---|
| `expenses.list {status?, worker_id?, category?}`, `expenses.get {expense_id}` | R0 | Concise omits untrusted fields; detailed wraps them in the run's `<untrusted>` nonce and taints. |
| `expenses.check_policy {expense_ids[]}` | R1, never | Deterministic batch, idempotent. |
| `expenses.explain {expense_ids[]}` | R1, never | Grounded per item via `@weft/grounding`, like `payroll.explain_flags`. |
| `expenses.decide {expense_id, decision, reason_code, note}` | R2, always for agents | **Exactly one id**; `amountCents` = the item; ceilings `agent.expense_cents` 250000 per call and `agent.expense_day_cents` 1000000 per day; `lease: expenses:{expense_id}`; reversible until paid. |
| `expenses.submit`, `expenses.resubmit` | `human_only` | Portal and app. |
| `expenses.schedule`, `expenses.mark_paid` | `system_only`, R1 | Handlers. |

No bulk decide exists anywhere: no `approve_all`, no array input on `decide`. A registry test asserts that, and an agent scenario test asks the agent to "approve all open expenses" and expects zero executed decisions and a walk-through offer, mirroring the reference's behavior [VS] [ref-agent] and Weft's existing GP5 refusal.

### 7.5 Routine `rt_expense_review` [W]

- Triggers: event `expense.submitted` (debounced: one run per worker per hour), cron `0 9 * * 1-5` America/Los_Angeles, and manual "Review with agent".
- Precheck: `skip` when nothing is in `needs_review`; derived per-item args with the engine output and the suggested decision: no block or review gives approve; `DUPLICATE` gives decline; `RECEIPT_MISSING` gives return; `ACCOUNTABLE_WINDOW` gives approve_taxable or decline (the model picks and explains); `OVER_CATEGORY_LIMIT` gives a human-decision note.
- Checklist: `explained:{expense_id}` and `proposal_exists:expenses.decide:{expense_id}` for every item; `notified:{worker_id}` for returned items.
- Allowlist (8): `expenses.list`, `expenses.get`, `expenses.check_policy`, `expenses.explain`, `expenses.decide`, `people.get`, `comms.send_message`, `agent.read_artifact`.
- Taint: reading a receipt extraction or a business purpose in detailed form taints the run, so the employee message also becomes a proposal; decisions are proposals anyway.
- Chat: add `expenses.list` and `expenses.get` to the chat allowlist (now 16, the cap; if that is too many, swap `actions.get_run` out of chat). The chat agent walks the items one by one and can start the routine.

### 7.6 Screens (`/app/expenses`) [W]

- The four bands with counts, the columns in 2.1 (employee with title, merchant, category, amount, transaction date, status, submitted), filters by category, worker and state.
- Row drawer: receipt preview (served from `uploads`, admins only), the claimed vs extracted fields, check chips with the explanation and its source (agent or template), approver routing, a decision bar for the approver, the audit trail, and the run and paycheck it was paid in.
- Portal "My expenses": submit form with category-specific fields (attendees for meals, miles for mileage with the computed amount shown), status list.
- Payroll run review: the Reimbursements column already exists; the paycheck drawer lists `reimbursements_json`.

## 8. Seed data (deterministic, added in `packages/seed`) [W]

Fictional merchants only, each marked "(demo)". Workers are chosen by selector and pinned to ids in the seed tests. Seed clock is Mon 2026-10-26 08:30 PT; the open draft is `pay_2026_10_30` (deadline Wed Oct 28 17:00 PT).

### 8.1 Time off

- Types and policies:
  - `top_vac_us` Larkspur Vacation: every employee; per pay period 300 minutes (5.00 h) under 36 months of service, 360 (6.00 h) from 36 months; accrual cap 1.5 times the annual amount (10,800 or 12,960 minutes); full carryover; payout at separation; no waiting period.
  - `top_sick_ca`: CA workers; 1 per 30 worked; exempt deemed 2,400 minutes a week; accrual cap 4,800 (80 h); no use cap (avoids the open Oakland question); 90-day wait; increment 60; no payout; reinstate within 365 days.
  - `top_sick_ny`: NY workers (all in Brooklyn, so NYC rules apply); 1 per 30; annual use cap 2,400 (40 h); carryover cap 2,400; increment 60; no payout; reinstate within 183 days.
  - `top_unpaid_nyc`: NY workers; front load 1,920 (32 h) on Jan 1 and on hire, effective 2026-02-22; no carryover.
  - `top_prenatal_ny`: NY workers; 1,200 (20 h) per 52 weeks from first use (store the window start on first use).
  - `top_sick_co`: CO workers (Noor on hire); 1 per 30; annual accrual cap 2,880 (48 h); carryover cap 2,880; use cap 2,880; no wait; increment 60.
  - `top_sick_tx`: TX workers; company policy; front load 2,400 (40 h) on Jan 1 and on hire; no carryover; no payout.
- Holidays `hcal_2026`: Jan 1, Jan 19, Feb 16, May 25, Jun 19, Jul 3, Sep 7, Nov 26, Nov 27 (the day after Thanksgiving is Larkspur's own choice), Dec 25 [V] [opm] for the federal dates. Eligible: all employees, hourly included.
- Opening balances: `import` rows dated 2026-10-15 ("imported from previous provider", like the YTD import), deterministic from start date and a seeded usage draw, no balance above its cap. Pin **wrk_0004 (Imani Ferreira (demo))** so that the GP9 final pay still shows "Unused PTO payout (90.00 h": she started 2023-04-03 (`packages/seed/src/people.ts` line 27), so on 2026-10-30 she has 42 months of service and the 360-minute tier; the prorated Oct 16 to 30 accrual is `floor(360 * 15 / 16) = 337`, so her import is `5,400 - 337 = 5,063`. Her salary is $232,000, so the payout stays 1,003,846 cents.
- Requests at the seed clock, in Hardware (CA) for the coverage demo. Hardware has 8 employees in the seed (Imani the lead, Grace, Oscar, Ruth, Samir, Kofi, Ben, Mira; Arjun is a contractor and does not count) plus Noor from Nov 2, so 9 on Nov 23:
  - R-A approved: Grace and Oscar, vacation Mon Nov 23 to Wed Nov 25.
  - R-B pending: Ruth, vacation Mon Nov 23 to Fri Nov 27. It triggers `COVERAGE_CONFLICT` on Nov 23 to 25 (3 of 9 out, 33.3% > 30%) and `INCLUDES_HOLIDAY` for Nov 26 and 27; it routes to Imani.
  - R-C pending: a NY engineer, sick Thu Oct 29, 4 hours, clean.
  - R-D pending: Ben Ashdown (demo), who started Oct 1, sick, 8 hours on Oct 28. Day 28 of employment, so `WAITING_PERIOD` blocks.
  - GP9 terminates Imani in its own reset world; when her worker leaves, her manager principal must be disabled in the same offboarding transaction and routing falls back to Vic.
  - One approved TX request inside Oct 16 to 31, so the open draft shows a `pto` line.

### 8.2 Expenses

Eight `needs_review` items (the hand-computed cases in 9.2) plus history: four `approved`, three `paid` (paid in `pay_2026_10_15`, so its `reimbursements_cents` totals are nonzero; recompute the seed digest) and two `declined`. One `paid` software item is the duplicate target for E7. Receipts are tiny generated PNGs, each with a sidecar extraction JSON (the simulated extractor reads the sidecar; no OCR and no model calls).

## 9. Hand-computed test cases

Money in cents, time in minutes unless stated. Rates per hour are `annual / 2,080` (as `hourlyRateOf` does).

### 9.1 Time off

| # | Case | Input | Expected |
|---|---|---|---|
| T1 | Per-period accrual | `top_vac_us`, 18 months of service, balance 4,800, the Oct 30 run processed | +300; balance 5,100 |
| T2 | Accrual cap | Cap 10,800, balance 10,650 | `accrual` +150, `accrual_capped` noting 150; the next period with no use posts 0 |
| T3 | Per-hour-worked, salaried exempt, 3 full periods | 5,200 worked minutes each, remainder 0 | 173 (rem 10), 173 (rem 20), 174 (rem 0); total 520 = 8.67 h |
| T4 | Per-hour-worked, hourly | 120.00 h worked = 7,200 minutes | 240 (4.00 h), remainder 0 |
| T5 | CO new hire, partial period | Noor, start Mon Nov 2, period Nov 1 to 15 | 10 weekdays, 2,400 * 10 / 5 = 4,800 deemed, accrual 160 (2.67 h) |
| T6 | HFWA annual cap | CO balance accrued this year 2,800, next accrual 173 | +80 (to 2,880); `accrual_capped` 93 |
| T7 | Request minutes with holidays | Vacation Mon Nov 23 to Fri Nov 27, 2026 | Weekdays 5, holidays Nov 26 and 27 charged 0, requested 1,440 (24 h) |
| T8 | Coverage | Hardware 9 employees on Nov 23, 2 approved out Nov 23 to 25, R-B adds a third | 3 / 9 = 33.3% > 30% on Nov 23, 24, 25: `COVERAGE_CONFLICT` (review) with evidence of the R-A ids; Nov 26 and 27 are holidays, not counted. Without Noor (8 employees) it is 37.5%, still a conflict |
| T9 | Balance check with projection | Available on Oct 26 is 1,200; one accrual of 300 posts Nov 13 (the Nov 15 run, payday Fri Nov 13); request 1,440 starting Nov 23 | Projected 1,500 >= 1,440: passes. With available 1,000, projected 1,300 < 1,440: `INSUFFICIENT_BALANCE` (block) |
| T10 | CA sick waiting period | Start Oct 1, request Oct 28 | Day 28 < 90: `WAITING_PERIOD` block; the accrued minutes show as `accrued_locked` |
| T11 | Salaried paycheck with PTO and holiday | CA, $132,000, Nov 16 to 30: 24 h vacation (Nov 23 to 25) plus 16 h holiday (Nov 26 and 27) | Period salary 550,000; rate 63.461538 per h; `pto` round(24 * 63.461538) = 152,308; `paid_holiday` round(16 * 63.461538) = 101,538; `salary` 550,000 - 152,308 - 101,538 = 296,154; gross 550,000, unchanged |
| T12 | Hourly paycheck with holiday | TX tech $30.00, Nov 16 to 30: 70.67 h worked plus 16 h holiday | `regular` 7,067 * 3,000 / 100 = 212,010; `paid_holiday` 48,000; gross 260,010; overtime only on worked hours |
| T13 | Final pay from the ledger | $232,000, posted balance 5,119 on Oct 15, last day Oct 30, 300 per period | Prorated accrual floor(300 * 15 / 16) = 281; balance 5,400 = 90.00 h; payout round(90 * 111.538461) = 1,003,846 (the value `offcycle.test.ts` line 74 already pins); a `payout` row -5,400 sets the balance to 0 |
| T14 | Negative balance at separation | Vacation balance -480 | No payout line, no deduction, `PTO_ADVANCE_NOT_RECOVERED` info |
| T15 | Sick never paid out | CA sick balance 2,400 at termination | No line |
| T16 | Year-end carryover | NY sick 3,120 on Dec 31 (cap 2,400); CA vacation 9,000 (cap 10,800); NYC unpaid 1,920 unused | NY: carry 2,400, forfeit 720; CA: all 9,000 carry; NYC unpaid: forfeit 1,920, front-load 1,920 on Jan 1, 2027 |
| T17 | Forfeiture guard | Create a CA vacation policy with carryover cap 2,400 and accrual cap 10,800 | `DOMAIN_FORFEITURE_NOT_ALLOWED` |
| T18 | Accruals are idempotent | `time_off.post_accruals` for the same run twice | The second call posts nothing |
| T19 | Agent cannot approve | The agent calls `time_off.decide` | A proposal, never executed; a forged decide with an agent principal returns `AGENT_PRINCIPAL` (existing rule) |

### 9.2 Expenses

| # | Case | Input | Expected |
|---|---|---|---|
| E1 | Clean travel | CA engineer, airfare $412.38, receipt matches, transaction Oct 12, submitted Oct 13 | No flags; the agent proposes approve |
| E2 | Meals without attendees | NY, meals $86.40, receipt | `MEALS_DETAIL_MISSING` and `OVER_CATEGORY_LIMIT` (over $75 per person with 1 person assumed); proposal: return, asking for attendees |
| E3 | Under $75, no receipt | TX tech, supplies $48.00 | No `RECEIPT_MISSING`; info "receipt not required under $75" [pub463]; approve |
| E4 | Equipment over limit, CA | CA Hardware, bench supply $1,249.00, receipt, no pre-approval | `OVER_CATEGORY_LIMIT`, `CA_NECESSARY_EXPENSE`, `SECOND_APPROVER`; the agent proposes approve with the note and does not decline |
| E5 | Lodging without receipt | NY, hotel $289.00, no receipt | `RECEIPT_MISSING` (block; lodging always needs one); proposal: return |
| E6 | Mileage | CA, 84.0 miles (`miles_x10` 840) on Oct 6, 2026, claimed $63.84 | Rate 76 cents: 840 * 76 / 10 = 6,384, matches. The same trip on Jun 6, 2026 at 72.5 cents gives 840 * 72.5 / 10 = 6,090; a claim of $63.84 then fails `MILEAGE_RATE` |
| E7 | Duplicate | TX, software $96.00, same merchant and date as a paid item | `DUPLICATE` (block); proposal: decline `duplicate` |
| E8 | Past 60 days | CA, meals $54.20, transaction Jul 31, submitted Oct 20 | 81 days (Aug 31 is day 31, Sep 30 is day 61, Oct 20 is day 81) > 60: `ACCOUNTABLE_WINDOW`; allowed decisions decline or approve_taxable |
| E9 | Per diem | NY trip Oct 5 to 7, meals claimed $180.00 | Allowance 5,100 + 6,800 + 5,100 = 17,000; `PER_DIEM_OVER` by 1,000 |
| E10 | Reimbursement on the draft | E1 and E6 for one CA engineer approved Oct 27 | Oct 30 paycheck: `reimbursements_cents` 41,238 + 6,384 = 47,622; gross, taxes and net unchanged; bank entry net + 47,622; run totals reimbursements and totalCost each +47,622; cashRequirement = totalCost |
| E11 | Taxable reimbursement | E8 approved as taxable | Earning `taxable_reimbursement` 5,420 inside gross; employee social security round(5,420 * 0.062) = 336; Medicare round(5,420 * 0.0145) = 79; income tax by the engine's aggregate method; `reimbursements_cents` unchanged |
| E12 | After the deadline | An item approved Oct 28 at 17:01 PT | Attached to the next draft (Nov 1 to 15), not `pay_2026_10_30` |
| E13 | No bulk approve | The chat asks to approve all open expenses | Zero `expenses.decide` actions executed; the reply offers to walk through each item; the registry has no command that takes several expense ids and decides |
| E14 | Paid is final | `expenses.reopen` on a `paid` item | Refused: "Not reversible: paid in pay_2026_10_15" |

## 10. Recommended decisions [W]

1. Minutes are the unit of record for time off; convert to `hours_x100` only on paychecks.
2. Two append-only ledgers (`time_off_ledger`, expense status history through action rows); balances are always derived and never stored.
3. The accrual engine runs from `payroll.processed` for regular runs only, idempotent per (run, assignment); final pay prorates the final partial period by calendar days.
4. Replace `unusedPtoHoursX100` with the ledger balance; seed Imani's import (5,063 minutes) so GP9 stays at 90.00 h and 1,003,846 cents. The unit test at `offcycle.test.ts` lines 63 to 67 pins the old month rule and must be rewritten against the ledger (T13).
5. No negative balances and no advances in wave 3 (CA final-pay rule); unpaid leave is a separate type.
6. One uniform Larkspur vacation policy with payout everywhere; per-jurisdiction sick policies generated from a versioned rule table with sources shown in the UI; a validation that refuses CA and CO vacation forfeiture.
7. Expense policy as deterministic rules whose output shape matches `flags_json`; the model only explains and proposes.
8. The accountable-plan boundary at 60 days, with "Approve as taxable" paying a supplemental earning line.
9. Reimbursements ride the next draft regular run before its deadline; no off-cycle reimbursement run in wave 3 (the reference has that subtype; leave it P1).
10. One decision per command call; no bulk command; the agent proposes and humans decide; manager routing with one seeded manager principal (Imani) checked inside the decide commands.
11. Receipt extraction is a simulator reading seeded sidecars; uploaded receipts without a sidecar are reviewed by their typed fields only. No vision model calls in wave 3 (cost and taint).
12. Holidays are a company calendar that drives request minutes and `paid_holiday` lines; paydays do not move for holidays in this wave.
13. Build order (finishing beats starting): (a) time-off ledger, policies, accruals from runs, balances, final pay from the ledger; (b) requests, checks, routing, decide, the routine, the Requests and Calendar tabs; (c) payroll lines for PTO, sick and holiday hours and the statement block; (d) expenses table, engine, submit, decide, reimbursement on the draft, the screen; (e) `rt_expense_review` and the chat walk-through. Ship (a) to (c) as one slice and (d) to (e) as another; each with its e2e spec (GP13 time off, GP14 expenses).

## 11. What Nitish has to do himself

Nothing is required. Both features run on Weft's own data and simulators: no vendor account, sign-up, terms, API key or setting is involved. Optional only:

- If he wants the agent's explanations from the live model during a demo, the existing `WEFT_LLM=openai` setup with the key already in `~/Developer/projects/.weft.secrets.env` covers it; the scripted provider is the default for tests.
- Legal review is his call before using any of this for a real company: the rule table is research, not legal advice, and items marked [K] are unverified.

## 12. Open questions and unverified items

- [K] California Labor Code text (201, 202, 203, 227.3, 246, 2802) was not readable (leginfo 403); the DLSE FAQs cover everything above except the exempt 40-hour deeming for sick accrual (LC 246(b)(3)) and the 2802 reimbursement duty. Verify both in a browser.
- [K] NY final pay timing (Labor Law 191(3), next regular payday) was not found on a DOL page.
- Oakland: whether an annual use cap is allowed, and whether front-loading satisfies the ordinance, were not researched; the design avoids both questions by using accrual and no use cap.
- NY State: the page does not state an annual accrual cap separate from the use cap; the design caps use and carryover at 40 hours and lets accrual continue, which matches the NYC FAQ example.
- CO: whether advanced vacation can be recovered at separation was not researched; the design never advances.
- [K] FLSA overtime excludes paid leave and holiday hours (29 CFR 778.218 to 778.219).
- [K] Meal substantiation elements beyond amount, date, place and essential character.
- The reference's policy, approval-chain and receipt features are not public; Weft's rule set is its own.
- `SPEC.md` 9.2 caps any run at 16 tools; adding two expense reads to chat reaches 16 exactly (section 7.5).
