# Weft domain research: US payroll and compliance (tax year 2026)

Status: research notes for the Weft architect and builders. Written 2026-10-15. Not legal or tax advice; Weft runs on synthetic data only.

How to read this file

- Every fact carries a source tag like `[S1]`. The source list is in section 9.
- `P` sources are primary (agency publication, form or agency web page) and were read directly for this file.
- `S` sources are secondary (agency text seen only through a search engine snippet, or a payroll trade source). Treat `S` facts as good enough for a simulator, and flag them in code as `confidence: "secondary"`.
- `[derived]` means arithmetic or a modeling decision made here, not a published fact.
- Tax year: everything is 2026 unless it says otherwise. Fallbacks to 2025 are labeled.

---

## 0. Ten things a builder must not get wrong

1. Federal income tax withholding uses Pub 15-T Worksheet 1A with the **2026** annual tables (section 1.1). The line 1g standard amount is **$12,900 MFJ / $8,600 everyone else**, and it is **zero** when the W-4 Step 2 box is checked. [S1]
2. Pre-2020 Forms W-4 still exist: they use allowances x **$4,300** and no line 1g amount, and they can never use the Head of Household table. [S1]
3. Social Security: **6.2% employee + 6.2% employer on the first $184,500** of wages in 2026. Medicare: **1.45% + 1.45% with no cap**. Additional Medicare: **0.9% employee only** on wages paid **over $200,000** in the calendar year, regardless of filing status. [S2]
4. FUTA: **6.0% on the first $7,000**, less a credit of up to **5.4%**, so **0.6% net**; credit reduction states pay more, settled on Form 940 Schedule A at year end. For 2025 the credit reduction states are **California 1.2%** and **US Virgin Islands 4.5%**. [S2][S3]
5. 401(k) elective deferrals reduce **federal income tax wages only**; they are still subject to Social Security, Medicare and FUTA. Section 125 pre-tax health premiums reduce **income tax, Social Security, Medicare and FUTA** wages. [S2]
6. Deposit schedule is set once per calendar year by the lookback period: **$50,000 or less: monthly; more: semiweekly**. **$100,000 accumulated on any day: deposit next business day.** [S2]
7. California SDI is **1.3% with no wage cap** in 2026. [S4]
8. WA, TX and FL have no state income tax on wages; WA still has **two employee payroll premiums** (PFML and WA Cares). [S9][S10][S11]
9. Withholding rounding: Pub 15-T lets an employer round to whole dollars, but only if it does so consistently. Weft computes exact amounts and rounds each per-period tax line to the cent, half up (section 8 policy). [S1][derived]
10. Wage bases are per employee per calendar year and are tracked with YTD accumulators per tax (SS, FUTA, each SUI, CO FAMLI, WA PFML, NY PFL cap). Each tax has its own definition of taxable wages.

---

## 1. Federal

### 1.1 Federal income tax withholding: Pub 15-T (2026) percentage method for automated payroll systems

Source: Publication 15-T (2026), "For use in 2026", Worksheet 1A and the 2026 Percentage Method Tables for Automated Payroll Systems. [S1]

What changed for 2026 (quoted facts from Pub 15-T What's New) [S1]:
- The 2026 tables reflect P.L. 119-21 (One Big Beautiful Bill Act): permanent extension of the individual rates, the increased standard deduction and the termination of personal exemptions.
- The 2026 Form W-4 adds a checkbox below Step 4(c) to claim exemption from withholding (previously the employee wrote "Exempt").
- The 2026 W-4 was updated for new deductions available on the employee's return (qualified tips up to $25,000, qualified overtime up to $12,500 or $25,000 MFJ, per Pub 15 What's New). These do **not** change the employer computation: the employee folds them into Step 4(b) on the W-4. [S1][S2]

Pay periods per year (Worksheet 1A Table 3) [S1]:

| Frequency | Periods |
|---|---|
| Semiannually | 2 |
| Quarterly | 4 |
| Monthly | 12 |
| Semimonthly | 24 |
| Biweekly | 26 |
| Weekly | 52 |
| Daily | 260 |

Worksheet 1A, line by line [S1]:

- 1a taxable wages this period (after pre-tax deductions that reduce FIT wages, see 1.6)
- 1b pay periods per year (table above)
- 1c = 1a x 1b
- Form W-4 2020 or later:
  - 1d = W-4 Step 4(a) other income (annual)
  - 1e = 1c + 1d
  - 1f = W-4 Step 4(b) deductions (annual)
  - 1g = 0 if Step 2 box checked; else $12,900 if MFJ, else $8,600
  - 1h = 1f + 1g
  - 1i = max(0, 1e - 1h) = **Adjusted Annual Wage Amount**
- Form W-4 2019 or earlier:
  - 1j = allowances claimed
  - 1k = 1j x $4,300
  - 1l = max(0, 1c - 1k) = Adjusted Annual Wage Amount
  - Use the STANDARD schedules; "Married" maps to the MFJ table, "Single" to the Single table; never the HOH table.
- 2a = 1i or 1l
- 2b to 2g: find the row where 2a >= A and 2a < B; tentative annual = C + (2a - A) x D
- 2h = 2g / 1b = **Tentative Withholding Amount** (per period)
- 3a = W-4 Step 3 credits (annual; 0 for pre-2020 forms); 3b = 3a / 1b; 3c = max(0, 2h - 3b)
- 4a = W-4 Step 4(c) extra per period (line 6 on old forms); **4b = 3c + 4a = amount to withhold**

2026 Annual Percentage Method tables. Columns: A at least, B but less than, C base tax, D rate, E "of the amount that the wage exceeds" (always equals A). [S1]

STANDARD schedules (W-4 Step 2 box NOT checked, or any 2019-and-earlier W-4):

| Status | A | B | C | D |
|---|---|---|---|---|
| MFJ | 0 | 19,300 | 0.00 | 0% |
| MFJ | 19,300 | 44,100 | 0.00 | 10% |
| MFJ | 44,100 | 120,100 | 2,480.00 | 12% |
| MFJ | 120,100 | 230,700 | 11,600.00 | 22% |
| MFJ | 230,700 | 422,850 | 35,932.00 | 24% |
| MFJ | 422,850 | 531,750 | 82,048.00 | 32% |
| MFJ | 531,750 | 788,000 | 116,896.00 | 35% |
| MFJ | 788,000 | none | 206,583.50 | 37% |
| Single or MFS | 0 | 7,500 | 0.00 | 0% |
| Single or MFS | 7,500 | 19,900 | 0.00 | 10% |
| Single or MFS | 19,900 | 57,900 | 1,240.00 | 12% |
| Single or MFS | 57,900 | 113,200 | 5,800.00 | 22% |
| Single or MFS | 113,200 | 209,275 | 17,966.00 | 24% |
| Single or MFS | 209,275 | 263,725 | 41,024.00 | 32% |
| Single or MFS | 263,725 | 648,100 | 58,448.00 | 35% |
| Single or MFS | 648,100 | none | 192,979.25 | 37% |
| HOH | 0 | 15,550 | 0.00 | 0% |
| HOH | 15,550 | 33,250 | 0.00 | 10% |
| HOH | 33,250 | 83,000 | 1,770.00 | 12% |
| HOH | 83,000 | 121,250 | 7,740.00 | 22% |
| HOH | 121,250 | 217,300 | 16,155.00 | 24% |
| HOH | 217,300 | 271,750 | 39,207.00 | 32% |
| HOH | 271,750 | 656,150 | 56,631.00 | 35% |
| HOH | 656,150 | none | 191,171.00 | 37% |

Form W-4 Step 2 CHECKBOX schedules (2020-or-later W-4 with the Step 2 box checked):

| Status | A | B | C | D |
|---|---|---|---|---|
| MFJ | 0 | 16,100 | 0.00 | 0% |
| MFJ | 16,100 | 28,500 | 0.00 | 10% |
| MFJ | 28,500 | 66,500 | 1,240.00 | 12% |
| MFJ | 66,500 | 121,800 | 5,800.00 | 22% |
| MFJ | 121,800 | 217,875 | 17,966.00 | 24% |
| MFJ | 217,875 | 272,325 | 41,024.00 | 32% |
| MFJ | 272,325 | 400,450 | 58,448.00 | 35% |
| MFJ | 400,450 | none | 103,291.75 | 37% |
| Single or MFS | 0 | 8,050 | 0.00 | 0% |
| Single or MFS | 8,050 | 14,250 | 0.00 | 10% |
| Single or MFS | 14,250 | 33,250 | 620.00 | 12% |
| Single or MFS | 33,250 | 60,900 | 2,900.00 | 22% |
| Single or MFS | 60,900 | 108,938 | 8,983.00 | 24% |
| Single or MFS | 108,938 | 136,163 | 20,512.00 | 32% |
| Single or MFS | 136,163 | 328,350 | 29,224.00 | 35% |
| Single or MFS | 328,350 | none | 96,489.63 | 37% |
| HOH | 0 | 12,075 | 0.00 | 0% |
| HOH | 12,075 | 20,925 | 0.00 | 10% |
| HOH | 20,925 | 45,800 | 885.00 | 12% |
| HOH | 45,800 | 64,925 | 3,870.00 | 22% |
| HOH | 64,925 | 112,950 | 8,077.50 | 24% |
| HOH | 112,950 | 140,175 | 19,603.50 | 32% |
| HOH | 140,175 | 332,375 | 28,315.50 | 35% |
| HOH | 332,375 | none | 95,585.50 | 37% |

Other W-4 facts the UI and engine need:
- 2026 W-4 Step 3 guidance to employees: $2,200 per qualifying child under 17, $500 per other dependent, if income is $200,000 or less ($400,000 MFJ). The employer only consumes the Step 3 dollar total. [S12]
- Rounding: wages may be rounded to the dollar and tax may be rounded to the nearest dollar (under 50 cents down, 50 to 99 cents up), "if rounding is used, it must be used consistently". [S1]
- Supplemental wages (bonus, commission paid separately): optional flat **22%**; mandatory **37%** on the part of supplemental wages over **$1,000,000** in the calendar year, regardless of W-4. Rate unchanged because P.L. 119-21 made the rates permanent. [S2]

### 1.2 FICA (Social Security and Medicare)

- Social Security 2026: **6.2%** employee and **6.2%** employer (12.4% total); wage base **$184,500**. [S2] (2025: $176,100; 2024: $168,600, per the Pub 15 rate table. [S2])
- Medicare: **1.45%** each, **no wage base**. [S2]
- Additional Medicare Tax: withhold **0.9%** on wages paid **in excess of $200,000** to an employee in a calendar year, starting in the pay period where wages cross $200,000, through year end. **Employee only, no employer share**, and the employer threshold ignores filing status. [S2]
- Successor employer: wages paid by a predecessor count toward the SS wage base and the $200,000 threshold when the acquisition rules are met (Pub 15 example: $184,500 - $2,000 = $182,500 remaining). [S2]
- Household workers: SS/Medicare apply at $3,000+ cash wages in 2026. [S2]

### 1.3 FUTA

- Rate **6.0%** on the first **$7,000** per employee per year (2026). Credit for state UI paid: up to **5.4%**, so **0.6%** net if state UI was paid in full and on time and the state is not a credit reduction state. [S2]
- Credit reduction: 0.3% for the first year a state has an outstanding Title XII loan, another 0.3% each further year, with possible add-ons from the third and fifth years. DOL announces after **November 10** each year; the extra tax is treated as incurred in Q4 and is due by January 31 of the next year. [S13][S14]
- **2025 credit reduction states (final, Schedule A (Form 940) for 2025, created 11/12/25): California 0.012 (1.2%), US Virgin Islands 0.045 (4.5%).** So a California employer's 2025 effective FUTA rate is 0.6% + 1.2% = 1.8% on FUTA wages. [S3]
- **2026 credit reduction states are not final until after November 10, 2026.** DOL publishes a "Potential 2026 Credit Reductions" spreadsheet (`potential_credit_states_2026.xlsx`). Weft should model 2026 credit reduction as a pending, effective-dated value and default CA to the 2025 rate plus 0.3% as a *projection only*, labeled as such. [S14][derived]
- FUTA deposits: if the undeposited FUTA liability is **over $500** at quarter end, deposit by the last day of the month after the quarter; at $500 or less, carry it forward. Q4: deposit by January 31 if over $500, else pay with Form 940. [S2]

### 1.4 Federal deposit rules

Source: Pub 15 section 11. [S2]
- All federal tax deposits are by EFT (EFTPS, IRS Direct Pay, or the IRS business tax account). New employers that get an EIN with a federal tax obligation are pre-enrolled in EFTPS. EFTPS same-day cutoff: 3:00 p.m. Eastern for payments of $1 million or less; payments over $1 million must be submitted by 8:00 p.m. Eastern the day before. [S2]
- Lookback period for 2026 (Form 941 filers): July 1, 2024 to June 30, 2025 (Q3 2024 to Q2 2025). Total Form 941 line 12 taxes **$50,000 or less: monthly depositor; more than $50,000: semiweekly depositor.** A brand-new employer is a monthly depositor in its first calendar year. [S2]
- Monthly: deposit a month's liability by the **15th of the following month**. [S2]
- Semiweekly: paydays **Wednesday, Thursday or Friday: deposit by the following Wednesday**; paydays **Saturday, Sunday, Monday or Tuesday: deposit by the following Friday**. A semiweekly period that spans two quarters needs two deposits (example: pay dates Wed Sep 30 2026 and Fri Oct 2 2026, both deposits due Wed Oct 7 2026). [S2]
- **$100,000 next-day rule**: accumulating $100,000 or more on any day requires deposit by the next business day, regardless of schedule; accumulation stops at the end of a deposit period. [S2]
- De minimis: if the quarter's (or prior quarter's) Form 941 line 12 liability is **less than $2,500**, the tax can be paid with the return. [S2]
- Due dates on weekends or legal holidays move to the next business day. [S2]
- Failure-to-deposit penalties: **2%** (1 to 5 days late), **5%** (6 to 15 days), **10%** (16+ days, or paid directly to IRS instead of deposited), **15%** (unpaid more than 10 days after the first IRS notice). The Trust Fund Recovery Penalty can apply to responsible persons for unpaid withheld taxes. [S2]

### 1.5 Federal filing calendar

Source: Pub 15 Calendar and sections 12 and 14 unless noted. [S2]

| Item | Due | Notes |
|---|---|---|
| Form 941 (quarterly) | Apr 30, Jul 31, Oct 31, Jan 31 | Zero-wage returns still required until a final return is filed. |
| Form 944 (annual) | Jan 31 | Only with IRS written notice; for employers with $1,000 or less annual liability. |
| Form 940 (FUTA, annual) | Jan 31 | 2025 Form 940 due **Feb 2, 2026** (Jan 31 was a Saturday); Feb 10 if all FUTA was deposited on time. Schedule A for multi-state or credit reduction. |
| Forms W-2 to employees, W-2 Copy A + W-3 to SSA | Jan 31 | |
| Forms 1099-NEC to payees and IRS | Jan 31 | Contractor payments. From 2026 the 1099-NEC/MISC threshold is **$2,000** (was $600), inflation-adjusted after 2026. [S2] |
| Form 941-X | When an error is found | Corrections are not made on a later 941. |

W-2 note: P.L. 119-21 raises the W-2 threshold to $2,000 for wages from which no income, Social Security or Medicare tax was withheld. [S2]

### 1.6 Pre-tax deductions and their tax treatment

From Pub 15 section 15 "Special Rules for Various Types of Services and Payments" and Pub 15-B. [S2][S15]

| Deduction | FIT withholding | Social Security / Medicare | FUTA | 2026 limit |
|---|---|---|---|---|
| 401(k) elective deferral (pre-tax) | Exempt (subject to the 402(g) limit) | **Taxable** | **Taxable** | $24,500; catch-up age 50+: $8,000; ages 60 to 63: $11,250 [S16] |
| Roth 401(k) | Taxable | Taxable | Taxable | Same combined limit [S16] |
| Section 125 cafeteria: health, dental, vision premiums when the employee picks the nontaxable benefit | Exempt | Exempt | Exempt | No dollar cap on premiums |
| Health FSA via Section 125 | Exempt | Exempt | Exempt | $3,400 (plan years beginning 2026) [S15] |
| HSA via Section 125 salary reduction | Exempt | Exempt | Exempt | $4,400 self-only, $8,750 family (2026) [S17] |
| HSA contributions by payroll deduction **outside** a cafeteria plan | Taxable | Taxable | Taxable | [S2] |
| 403(b) salary reduction | Exempt | Taxable | Taxable | [S2] |
| 457(b) salary reduction | Exempt | Taxable | Taxable | [S2] |

Notes:
- If the employee chooses cash under a cafeteria plan, that amount is subject to all employment taxes. [S2]
- Starting 2026, catch-up contributions must be Roth for participants whose prior-year FICA wages with the sponsor exceeded $150,000. [S16]
- State treatment differs (for example, some states do not follow the federal 401(k) or 125 exclusion for UI or income tax). For Weft's 8 states, the engine should make each deduction carry a per-tax-type `reduces` set so a state can override. Weft defaults states to the federal FIT treatment for state income tax and to the FUTA treatment for SUI. [derived; verify per state before claiming accuracy]

### 1.7 Pay frequency and pay date rules relevant to the engine

- Tax liability attaches on the **pay date** (when wages are paid), not the work period. Deposits follow pay dates. [S2]
- Pay periods per year: see the 1.1 table. 27-period biweekly years and 53-week years exist; Pub 15-T always annualizes with the stated count (26 or 52). Weft should annualize with the frequency's nominal count. [S1][derived]

---

## 2. States

Summary table, 2026. Wage bases and new-employer *base* rates are from the US DOL "Significant Provisions of State UI Laws, Effective January 2026" unless a state source is cited; DOL notes the new employer rate shown is the base rate and higher rates can apply by industry. [S5]

| State | Income tax withholding | SUI wage base | SUI new employer rate | Employee payroll taxes besides FIT/FICA | Other employer taxes |
|---|---|---|---|---|---|
| CA | Yes, EDD Method B exact calc [S6] | $7,000 [S4][S5] | 3.4% (2 to 3 years) [S4] | SDI 1.3%, no cap [S4] | ETT 0.1% on $7,000 [S4] |
| NY | Yes, NYS-50-T-NYS exact calc [S7] | $17,600 [S5] | 4.1% total = 4.025% UI + 0.075% RSF [S8] | PFL 0.432%, max $411.91/yr [S18]; DBL 0.5% up to $0.60/week (employer may collect) [S19] | Reemployment Service Fund (in the 4.1%) |
| TX | None | $9,000 [S9][S5] | 2.70% for all groups in 2026 [S9] | None | None beyond SUI |
| WA | None | $78,200 [S20][S5] | 115% of industry average rate [S20] | PFML: employee share 71.43% of 1.13% [S10]; WA Cares 0.58% [S21] | PFML employer share 28.57% of 1.13% (waived under 50 employees) [S10] |
| FL | None | $7,000 [S11][S5] | 2.7% [S11] | None | None beyond reemployment tax |
| IL | Yes, flat 4.95% minus allowances [S22] | $14,250 [S5][S23] | 3.35% incl. 0.55% fund building rate (sector 56: 3.45%) [S23] | None statewide | None statewide |
| MA | Yes, 5.0% flat plus 4% surtax over $1,107,750 [S24] | $15,000 [S5] | 2.42% (construction 6.08%) [S25] | PFML employee 0.46% of 0.88% (25+ covered) [S26] | PFML employer 0.42%; EMAC (not researched) |
| CO | Yes, 4.40% flat via DR 1098 [S27] | $30,600 [S5][S28] | 1.53% base; 3.05% combined with 0.17% support and 1.35% solvency surcharge (non-construction) [S28] | FAMLI 0.44% (half of 0.88%), wages to $184,500 [S29] | FAMLI employer 0.44% |

### 2.1 California

Income tax withholding: EDD "California Withholding Schedules for 2026, Method B - Exact Calculation Method". [S6]
- Steps: (1) if gross wages <= Table 1 Low Income Exemption, withhold nothing; (2) subtract Table 2 estimated deduction amount for any DE 4 additional allowances; (3) subtract Table 3 standard deduction; (4) apply the Tax Rate Table; (5) subtract the Table 4 exemption allowance credit for regular allowances.
- EDD explicitly allows computing on an annual basis and dividing by pay periods ("Employers may determine the amount of income tax to be withheld for an annual payroll period and prorate the tax back to the payroll period"). **Weft uses the annual method** for all frequencies. [S6]
- Annual values (2026) [S6]:
  - Table 1 Low Income Exemption (annual): Single / dual-income married / married with multiple employers $18,896; Married with 0 or 1 DE 4 allowances $18,896; Married with 2+ allowances $37,791; Unmarried head of household $37,791.
  - Table 2 Estimated deduction: $1,000 per additional allowance (annual).
  - Table 3 Standard deduction (annual): Single $5,706; Married 0 or 1 allowances $5,706; Married 2+ allowances $11,412; HOH $11,412.
  - Table 4 Exemption allowance credit (annual): **$168.30 per regular allowance**.
  - Annual tax rate tables (taxable income over, not over, rate, of amount over, plus):
    - Single / dual income married: 0 to 11,079 at 1.1%; 11,079 to 26,264: 2.2% + 121.87; 26,264 to 41,452: 4.4% + 455.94; 41,452 to 57,542: 6.6% + 1,124.21; 57,542 to 72,724: 8.8% + 2,186.15; 72,724 to 371,479: 10.23% + 3,522.17; 371,479 to 445,771: 11.33% + 34,084.81; 445,771 to 742,953: 12.43% + 42,502.09; 742,953 to 1,000,000: 13.53% + 79,441.81; over 1,000,000: 14.63% + 114,220.27.
    - Married: 0 to 22,158 at 1.1%; 22,158 to 52,528: 2.2% + 243.74; 52,528 to 82,904: 4.4% + 911.88; 82,904 to 115,084: 6.6% + 2,248.42; 115,084 to 145,448: 8.8% + 4,372.30; 145,448 to 742,958: 10.23% + 7,044.33; 742,958 to 891,542: 11.33% + 68,169.60; 891,542 to 1,000,000: 12.43% + 85,004.17; 1,000,000 to 1,485,906: 13.53% + 98,485.50; over 1,485,906: 14.63% + 164,228.58.
    - Unmarried head of household: 0 to 22,173 at 1.1%; 22,173 to 52,530: 2.2% + 243.90; 52,530 to 67,716: 4.4% + 911.75; 67,716 to 83,805: 6.6% + 1,579.93; 83,805 to 98,990: 8.8% + 2,641.80; 98,990 to 505,208: 10.23% + 3,978.08; 505,208 to 606,251: 11.33% + 45,534.18; 606,251 to 1,000,000: 12.43% + 56,982.35; 1,000,000 to 1,010,417: 13.53% + 105,925.35; over 1,010,417: 14.63% + 107,334.77.
- Withholding certificate: new hires and changes need both Form W-4 and DE 4; pre-2020 W-4s without changes keep working. [S4]
- EDD worked example to use as a unit test: semimonthly $2,400, married, 4 allowances: 57,600 - 11,412 = 46,188; 528.66 + 243.74 = 772.40; minus 673.20 = 99.20 annual; / 24 = **$4.13**. [S6]

Payroll taxes [S4]:
- UI: new employers 3.4% for two to three years; 2026 schedule F+ (1.5% to 6.2%); wage limit $7,000.
- ETT: 0.1% on $7,000.
- SDI (employee): 1.3% for 2026; all wages subject since January 1, 2024 (no cap). 2025 was 1.2%.

Registration [S30]:
- Must register within **15 days** after paying more than **$100** in wages in a calendar quarter.
- Online through e-Services for Business ("New Employer", then register for an Employer Payroll Tax Account Number); paper DE 1 by mail takes about 10 to 14 days.
- Account number: **8 digits, format `000-0000-0`** (also called SEIN or State ID number).

Filing and deposits [S31]:
- DE 9 (quarterly contribution return) and DE 9C (employee wage detail) every quarter. 2026: Q1 due Apr 1, delinquent after Apr 30; Q2 Jul 1 / Jul 31; Q3 Oct 1 / Nov 2; Q4 Jan 1 2027 / Feb 1 2027.
- DE 88 deposits: UI and ETT quarterly with the DE 9; SDI and PIT on a schedule tied to the federal deposit schedule plus PIT withheld (more frequent if over $350 PIT).

Notices [S4]:
- **Rate notice DE 2088** (Notice of Contribution Rates and Statement of UI Reserve Account) combines UI, ETT and SDI rates; mailed in December with a December 31 mailing date; **60 days to protest**. Resolution: load the new rates effective January 1, or file a protest within 60 days.

### 2.2 New York

Income tax withholding: NYS-50-T-NYS (1/26), "Effective January 1, 2026 to December 31, 2026", Method II exact calculation. [S7]
- Step 1: subtract the Table A combined deduction and exemption allowance (by payroll period, marital status, exemptions 0 to 10; beyond 10 use Table B deduction + Table C exemption x count). Step 2 to 5: per-period table, (net - col 3) x col 4 + col 5.
- Annual Table A: Single $7,400 + $1,000 per exemption; Married $7,950 + $1,000 per exemption. Table C exemption value per period: daily $3.85, weekly $19.25, biweekly $38.50, semimonthly $41.65, monthly $83.30, annual $1,000. Biweekly Table A: Single 0 = $284.60, 1 = $323.10; Married 0 = $305.80, 1 = $344.30. [S7]
- If annualized net wages are at least $1,077,550, Method III (top income) applies (not modeled in the foundation). [S7]
- Single biweekly table II-B (at least, less than, subtract, rate, add): 0 to 327: 3.90%, +0; 327 to 450: 4.40%, +12.77; 450 to 535: 5.15%, +18.15; 535 to 3,102: 5.40%, +22.54; 3,102 to 3,723: 5.90%, +161.15; 3,723 to 4,140: 7.03%, +197.81; 4,140 to 6,063: 7.53%, +227.15; 6,063 to 8,285: 6.40%, +372.04; 8,285 to 10,208: 11.44%, +514.19; 10,208 to 41,444: 7.35%, +734.27. [S7]
- Single annual schedule: 0 to 8,500: 3.90%; 8,500 to 11,700: 4.40% + 332; 11,700 to 13,900: 5.15% + 472; 13,900 to 80,650: 5.40% + 586; 80,650 to 96,800: 5.90% + 4,190; 96,800 to 107,650: 7.03% + 5,143; 107,650 to 157,650: 7.53% + 5,906; 157,650 to 215,400: 6.40% + 9,673; 215,400 to 265,400: 11.44% + 13,369; 265,400 to 1,077,550: 7.35% + 19,091. [S7]
- Married annual schedule: 0 to 8,500: 3.90%; 8,500 to 11,700: 4.40% + 332; 11,700 to 13,900: 5.15% + 472; 13,900 to 80,650: 5.40% + 586; 80,650 to 96,800: 5.90% + 4,190; 96,800 to 107,650: 6.57% + 5,143; 107,650 to 157,650: 7.07% + 5,855; 157,650 to 211,550: 8.01% + 9,388; 211,550 to 323,200: 6.40% + 13,708; 323,200 to 373,200: 13.49% + 20,854; 373,200 to 1,077,550: 7.35% + 27,600; 1,077,550 to 2,155,350: 7.65% + 79,369. [S7]
- (The odd non-monotonic rates are recapture bands baked into the withholding tables; encode them as data, do not "fix" them.) [derived]
- Supplemental wages paid separately: **11.70%** flat, or the aggregate method. [S7]
- NYC and Yonkers withholding exist but are out of scope for the foundation (Weft's fictional NY employees live outside NYC). [derived]

Payroll taxes:
- UI 2026: wage base **$17,600** (was $12,800 in 2025; from 2026 indexed to 18% of the state average annual wage, rounded up to $100). [S5][S32]
- New employer: 4.025% UI + 0.075% Re-employment Service Fund = **4.1%**; the DOL page also states "the new employer normal contribution rate is 3.4%" (the normal rate before the subsidiary component). Experienced range 1.7% to 9.5% total. [S8]
- Paid Family Leave (employee): **0.432%** of gross wages per pay period, max **$411.91** per year (2026; 2025 was 0.388%). [S18]
- Disability Benefits Law (employee share): employer *may* collect **0.5% of wages, no more than $0.60 per week**. [S19]

Registration [S33]:
- Form NYS-100 (businesses register online via New York Business Express) registers the employer for UI, withholding and wage reporting in one filing.
- UI employer registration number: **8 digits** (web filing shows a placeholder `00-00000 0` if not yet assigned).
- Withholding ID: the 9-digit federal EIN, plus a 2-digit NYS suffix and a check digit if assigned.

Filing [S33]:
- NYS-45 quarterly combined withholding, wage reporting and UI return: due Apr 30, Jul 31, Oct 31, Jan 31; **required even with no payroll** (unless seasonal). Electronic via Web File, Web Upload or FSET.

Notices [S8]:
- DOL mails UI rate notices starting mid-February each year. Resolution: load the new rate effective January 1 of that year and recompute Q1 liabilities if already filed (file an amended NYS-45 if needed). [derived]

### 2.3 Texas

- No state income tax on wages. [derived from TWC scope; Texas has no personal income tax]
- UI: wage base **$9,000** set by statute; 2026 entry-level rate **2.70% for all groups with no exceptions**; 2026 range 0.32% to 6.32%; effective rate = General Tax Rate + Replenishment Tax Rate + Obligation Assessment Rate + Deficit Tax Rate + Employment and Training Investment Assessment. [S9]
- Registration: within **10 days** of becoming liable, online via Unemployment Tax Registration; yields a TWC tax account number. Account number format not confirmed in a primary source (model as 9 digits, `99-999999-9`, labeled synthetic). [S34]
- Filing: Form C-3 quarterly report and payment due Apr 30, Jul 31, Oct 31, Jan 31; electronic filing is mandatory (TWC Rules 815.107 and 815.109). [S34]

### 2.4 Washington

- No state income tax on wages.
- UI: wage base **$78,200** in 2026 (up from $72,800 in 2025; $82,000 in 2027). New employers pay **115% of the average rate for their industry**; total experience + social tax cannot exceed 6%; new-employer status lasts 2.5 to 3 years. [S20]
- Paid Family and Medical Leave 2026: total premium **1.13%** (0.92% in 2025); **employees 71.43%, employers 28.57%**; employers under 50 employees need not pay the employer share but must still collect or pay the employee share. Published October 29, 2025. Premiums apply only up to the Social Security wage cap, **$184,500** in 2026. [S10][S35]
- WA Cares Fund (long-term care): **0.58% of gross wages**, employee-paid. No wage cap was stated on the employer page. [S21]
- Registration: business license through the Department of Revenue (assigns the **9-digit UBI**); separate ESD employment security account number for UI. [S36]
- Filing: two quarterly reports, (1) UI tax and wage report to ESD, (2) combined Paid Leave and WA Cares report; due the last day of the month after the quarter; required even with no payroll. [S36]
- Penalties: **$25 per late report**; late tax payments accrue interest at **1% of taxes due per month**. [S36]

### 2.5 Florida

- No state income tax on wages.
- Reemployment tax: first **$7,000** of wages; initial rate for new employers **0.0270 (2.7%)**. [S11]
- Registration: Florida Business Tax Application (DR-1), online; the Department assigns a **7-digit** reemployment tax account number. [S37]
- Filing: RT-6 quarterly, due Jan 31, Apr 30, Jul 31, Oct 31, **required even with no employees or wages**. Since August 24, 2026 filing and payment moved to a new eFile and Pay system. [S37]
- Notice: **RT-1 Notice of Benefits Paid**, mailed about two weeks after quarter end only when benefits were charged to the account. Resolution: review charges; protest incorrect charges. [S37]

### 2.6 Illinois

Income tax withholding (IL-700-T, effective January 1, 2026) [S22]:
- Rate **4.95%**. Automated formula: `withholding = 0.0495 x (wages - ((line1_allowances x $2,925) + (line2_allowances x $1,000)) / pay_periods) + IL-W-4 line 3 extra`.
- Agency example: weekly $800, 2 line-1 and 2 line-2 allowances: 7,850 / 52 = 150.96; (800 - 150.96) x 0.0495 = **$32.13**. Use as a unit test.

Payroll taxes:
- UI 2026: wage base **$14,250**; standard new employer rate **3.350%** including the **0.550%** fund building rate; sector 56 (administrative support and waste management) 3.450%. DOL lists the base rate before fund building as 2.80%. [S23][S5]

Registration and filing [S38]:
- IDOR withholding account via MyTax Illinois; Form IL-941 quarterly, electronic only, **required even if nothing was withheld**; Schedule P with the IL-941. 2026 due dates: Q1 Apr 30 2026, Q2 Jul 31 2026, Q3 **Nov 2 2026**, Q4 Feb 1 2027. Payment schedule (semiweekly or monthly) assigned by IDOR from a lookback.
- IDES UI account and the UI-3/40 quarterly contribution and wage report (excess wages over $14,250 per worker are deducted on the form). Account number format not confirmed. [S23]

### 2.7 Massachusetts

Caution: mass.gov blocks automated fetches, so the Massachusetts facts below come from search snippets of mass.gov pages plus trade sources. They are internally consistent but should be confirmed by a human against Circular M. [S24][S25][S26]

Income tax withholding (Circular M, "Income Tax Withholding Tables at 5.0% Effective January 1, 2026") [S24]:
- Rate **5.0%**. 4% surtax threshold for 2026: **$1,107,750** (2025: $1,083,150); the percentage method computes surtax on the annual amount above the threshold and spreads it across periods.
- Percentage method (secondary-sourced): annual wages, minus Social Security + Medicare (+ MA retirement) **capped at $2,000**, minus the M-4 exemption amount (**$3,400 + $1,000 x exemptions** when at least one exemption is claimed, so $4,400 for one; $0 when none), minus $2,400 for head of household, times 5%. Consistency check: Circular M weekly table text says HOH employees get "$2.31 less", and 2,400 x 5% / 52 = 2.31. [S24][derived]
- Supplemental: lesser of 9% of the payment or 9% of the excess over the threshold plus 5% of the remainder, when the annualized total exceeds the surtax threshold; otherwise 5%. [S24]

Payroll taxes:
- UI: wage base **$15,000**; 2026 new employer rate **2.42%** (construction 6.08%); rate notices mailed by January 31. [S5][S25]
- PFML 2026 (25+ covered individuals): **0.88%** of eligible wages = 0.70% medical + 0.18% family; employees pay up to 0.28% medical + 0.18% family = **0.46%**; employer 0.42%. Under 25 covered individuals: 0.46% total, no employer share. PFML is collected by DOR through MassTaxConnect quarterly; W-2 Box 14 label "MAPFML". Chapter 101 of the Acts of 2026 changes the structure from January 1, 2027. [S26]

Registration [S26]:
- DOR withholding and PFML: MassTaxConnect.
- DUA (UI): **8-digit Employer Account Number (EAN)**, plus a UI Online user ID; the account must be activated before DUA accepts reports.

### 2.8 Colorado

Income tax withholding (DR 1098, "2026 Colorado Withholding Worksheet for Employers", 10/21/25) [S27]:
- 1a wages this period (including overtime pay; overtime exempt from federal withholding under P.L. 119-21 is still Colorado wages [S39]); 1b periods; 1c annual.
- 2a: DR 0004 line 2 amount if provided; else by W-4 filing status: **$11,000 MFJ or qualifying surviving spouse; $5,500 otherwise**; no W-4 and no DR 0004: treat as single.
- 2b = max(0, 1c - 2a); 2c = 2b x **4.40%**; 2d = 2c / 1b; 2e = DR 0004 line 3 extra; **2f = 2d + 2e**.
- Colorado no longer publishes tables; DR 1098 is the required method.

Payroll taxes:
- UI 2026 chargeable wage base **$30,600** (2027: $32,100). Introductory 2026 rates: non-construction base 1.53% + support 0.17% + solvency surcharge 1.35% = **3.05%**; heavy construction 4.28% base, 6.285% combined. Solvency surcharge not in effect for 2027. [S28]
- FAMLI 2026: **0.88%** of wages, **0.44% employer + 0.44% employee** (employer may pay all), on wages up to **$184,500**. [S29]

Registration [S40]:
- CDOR wage withholding account via MyBizColorado or CR 0100; online applications get the **8-digit Colorado Account Number (CAN)** the same day; the CAN is the W-2 state ID.
- CDLE UI account via MyBizColorado or MyUI Employer+.

Filing frequency for withholding (by annual withholding) [S39]:
- Under $7,000: quarterly (due the last day of the month after the quarter).
- $7,000 to $50,000: monthly (15th of the following month).
- $50,000 or more: weekly (third business day after the Friday ending the Saturday-to-Friday week), EFT required.
- Monthly and quarterly filers must file even when no tax is due; the Department can change frequency, effective January 1.

---

## 3. Notices: what the simulators should emit

Agency names and form numbers below are real; the `kind` values are Weft simulator codes, not agency codes.

| kind | Agency examples | Trigger in the simulator | What resolving it involves |
|---|---|---|---|
| `rate_change` | CA DE 2088 (Dec, 60-day protest) [S4]; NY rate notice from mid-Feb [S8]; MA DUA by Jan 31 [S25]; WA PFML rate set each October [S35] | New year, or a protest outcome | Update the effective-dated rate; recompute affected employer liabilities from the effective date; amend filed quarterly returns if needed; optionally protest within the window |
| `missing_filing` | NYS-45, WA no-payroll report, FL RT-6, IL-941, CO zero returns, federal 941/940 zero-wage returns [S33][S36][S37][S38][S39][S2] | A due date passes with no return on file | File the return (zero if no payroll), pay any balance, then respond to any penalty |
| `late_deposit_penalty` | IRS failure-to-deposit 2/5/10/15% [S2]; WA $25 per late report and 1%/month interest [S36] | Deposit or report after its due date | Verify the deposit trace (EFTPS acknowledgment), pay the penalty or request abatement with a reason |
| `deposit_schedule_change` | IRS lookback ($50,000) [S2]; CO frequency change effective Jan 1 [S39] | Lookback total crosses the threshold | Switch the employer's deposit schedule from the next calendar year; re-plan deposit due dates |
| `futa_credit_reduction` | DOL announcement after Nov 10; Schedule A (Form 940) [S13][S14] | Year end for employers with wages in a credit reduction state | Accrue the extra FUTA in Q4, deposit by Jan 31, attach Schedule A |
| `benefit_charge` | FL RT-1 Notice of Benefits Paid [S37] | A former employee's UI claim | Review the charge; protest if the separation was not chargeable |
| `registration_confirmed` | All states (account number issued) [S30][S33][S37][S40] | Registration task completes | Store the account number on the employer's jurisdiction record; unblock filings |

Registration timelines for the simulator (wall-clock delays to fake): CA online immediate / paper 10 to 14 days [S30]; CO CAN same day online [S40]; others not published in the sources read, so use a configurable 1 to 10 business day delay. [derived]

---

## 4. Account number formats for synthetic data

| Jurisdiction | Format | Source |
|---|---|---|
| IRS EIN | `00-0000000` (9 digits) | [S2] |
| CA EDD | `000-0000-0` (8 digits) | [S30] |
| NY DOL UI | 8 digits (`00-00000 0` placeholder style) | [S33] |
| NY withholding | EIN + 2-digit suffix + check digit | [S33] |
| TX TWC | 9 digits `00-000000-0` | synthetic, not confirmed |
| WA UBI | 9 digits | [S36] |
| FL reemployment | 7 digits | [S37] |
| IL IDOR / IDES | not confirmed; use `0000-0000` (IDOR) and 7 digits (IDES) | synthetic |
| MA DUA EAN | 8 digits | [S26] |
| CO CAN | 8 digits | [S40] |

Synthetic EINs should use a visibly fake prefix (for example `00-`), which is not a valid IRS campus prefix, so demo data can never collide with a real employer. [derived]

---

## 5. Engine design notes that follow from the domain

- Separate **gross-to-taxable-wage** computation per tax type (FIT wages, SS wages, Medicare wages, FUTA wages, each state's income tax wages, SUI wages, state-premium wages) from **tax computation**. The 401(k) vs Section 125 difference in 1.6 is the canonical test.
- Every rate, wage base, table and threshold is versioned data keyed by `(jurisdiction, tax_code, effective_from)`, never code constants. Rates change mid-history (NY PFL each January, WA PFML each October announcement, CA SDI yearly, credit reduction after Nov 10).
- YTD accumulators per employee per employer per calendar year per tax code are required for: SS ($184,500), Additional Medicare ($200,000 threshold), FUTA ($7,000), each SUI base, NY PFL ($411.91 cap), WA PFML and CO FAMLI ($184,500), 401(k) ($24,500 + catch-up), supplemental $1,000,000.
- Liability date = pay date. Quarter assignment, deposit due dates and the $100,000 next-day test all key off pay date.
- Rounding policy: compute each per-period tax line with exact decimal arithmetic (no floats), round once to cents half up. Do not round to whole dollars (allowed by Pub 15-T but must be consistent; exact cents is simpler to test). [S1][derived]

---

## 6. Machine-friendly spec (versioned data the engine should encode)

```yaml
# weft tax data, version 2026.1, generated from research/domain.md
version: "2026.1"
effective_from: "2026-01-01"
rounding: { mode: "half_up", scale: 2, per: "tax_line_per_period" }

federal:
  pay_periods: { annual: 1, semiannual: 2, quarterly: 4, monthly: 12, semimonthly: 24, biweekly: 26, weekly: 52, daily: 260 }
  fit:
    method: "pub15t_2026_worksheet_1a"
    source: "https://www.irs.gov/publications/p15t"
    line_1g_standard: { mfj: 12900, single: 8600, hoh: 8600 }   # 0 when step2_checkbox
    pre2020_allowance_value: 4300
    supplemental: { flat_rate: 0.22, over_1m_rate: 0.37, threshold: 1000000 }
    # rows: [at_least, base_tax, rate]; "less than" is the next row's at_least
    tables:
      standard:
        mfj:    [[0,0,0],[19300,0,0.10],[44100,2480,0.12],[120100,11600,0.22],[230700,35932,0.24],[422850,82048,0.32],[531750,116896,0.35],[788000,206583.50,0.37]]
        single: [[0,0,0],[7500,0,0.10],[19900,1240,0.12],[57900,5800,0.22],[113200,17966,0.24],[209275,41024,0.32],[263725,58448,0.35],[648100,192979.25,0.37]]
        hoh:    [[0,0,0],[15550,0,0.10],[33250,1770,0.12],[83000,7740,0.22],[121250,16155,0.24],[217300,39207,0.32],[271750,56631,0.35],[656150,191171,0.37]]
      step2_checkbox:
        mfj:    [[0,0,0],[16100,0,0.10],[28500,1240,0.12],[66500,5800,0.22],[121800,17966,0.24],[217875,41024,0.32],[272325,58448,0.35],[400450,103291.75,0.37]]
        single: [[0,0,0],[8050,0,0.10],[14250,620,0.12],[33250,2900,0.22],[60900,8983,0.24],[108938,20512,0.32],[136163,29224,0.35],[328350,96489.63,0.37]]
        hoh:    [[0,0,0],[12075,0,0.10],[20925,885,0.12],[45800,3870,0.22],[64925,8077.50,0.24],[112950,19603.50,0.32],[140175,28315.50,0.35],[332375,95585.50,0.37]]
  social_security: { employee_rate: 0.062, employer_rate: 0.062, wage_base: 184500 }
  medicare: { employee_rate: 0.0145, employer_rate: 0.0145, additional_rate: 0.009, additional_threshold: 200000, additional_employer: false }
  futa:
    gross_rate: 0.060
    max_credit: 0.054
    net_rate: 0.006
    wage_base: 7000
    credit_reduction:
      "2025": { CA: 0.012, VI: 0.045 }        # final, Schedule A (Form 940) 2025
      "2026": { status: "pending_until_2026-11-10" }
    deposit_threshold: 500
  deposits:
    lookback_threshold: 50000
    next_day_threshold: 100000
    de_minimis_quarter: 2500
    monthly_due_day: 15
    semiweekly: { wed_thu_fri: "next_wednesday", sat_sun_mon_tue: "next_friday" }
    ftd_penalty: [[1,5,0.02],[6,15,0.05],[16,null,0.10]]   # 15% after 10 days past first notice
  filings:
    form_941: { frequency: quarterly, due: ["04-30","07-31","10-31","01-31"] }
    form_940: { frequency: annual, due: "01-31", late_ok_if_fully_deposited: "02-10" }
    w2_w3:    { due: "01-31" }
    form_1099_nec: { due: "01-31", threshold_from_2026: 2000 }
  pretax:
    "401k_traditional": { reduces: [fit], limit: 24500, catchup_50: 8000, catchup_60_63: 11250 }
    "403b":             { reduces: [fit] }
    "457b":             { reduces: [fit] }
    section125_medical: { reduces: [fit, ss, medicare, futa] }
    health_fsa:         { reduces: [fit, ss, medicare, futa], limit: 3400 }
    hsa_cafeteria:      { reduces: [fit, ss, medicare, futa], limit_self: 4400, limit_family: 8750 }
    roth_401k:          { reduces: [] }

states:
  CA:
    income_tax:
      method: "edd_method_b_annualized"
      low_income_exemption: { single: 18896, married_0_1: 18896, married_2plus: 37791, hoh: 37791 }
      standard_deduction:   { single: 5706, married_0_1: 5706, married_2plus: 11412, hoh: 11412 }
      estimated_deduction_per_allowance: 1000
      allowance_credit: 168.30
      # rows: [over, base_tax, rate]
      tables:
        single:  [[0,0,0.011],[11079,121.87,0.022],[26264,455.94,0.044],[41452,1124.21,0.066],[57542,2186.15,0.088],[72724,3522.17,0.1023],[371479,34084.81,0.1133],[445771,42502.09,0.1243],[742953,79441.81,0.1353],[1000000,114220.27,0.1463]]
        married: [[0,0,0.011],[22158,243.74,0.022],[52528,911.88,0.044],[82904,2248.42,0.066],[115084,4372.30,0.088],[145448,7044.33,0.1023],[742958,68169.60,0.1133],[891542,85004.17,0.1243],[1000000,98485.50,0.1353],[1485906,164228.58,0.1463]]
        hoh:     [[0,0,0.011],[22173,243.90,0.022],[52530,911.75,0.044],[67716,1579.93,0.066],[83805,2641.80,0.088],[98990,3978.08,0.1023],[505208,45534.18,0.1133],[606251,56982.35,0.1243],[1000000,105925.35,0.1353],[1010417,107334.77,0.1463]]
    sdi: { employee_rate: 0.013, wage_base: null }
    sui: { wage_base: 7000, new_employer_rate: 0.034, range: [0.015, 0.062] }
    ett: { rate: 0.001, wage_base: 7000 }
  NY:
    income_tax:
      method: "nys50t_method_ii"
      annual_allowance: { single: 7400, married: 7950, per_exemption: 1000 }
      supplemental_rate: 0.117
      tables:   # annual: [at_least, base, rate]
        single:  [[0,0,0.039],[8500,332,0.044],[11700,472,0.0515],[13900,586,0.054],[80650,4190,0.059],[96800,5143,0.0703],[107650,5906,0.0753],[157650,9673,0.064],[215400,13369,0.1144],[265400,19091,0.0735]]
        married: [[0,0,0.039],[8500,332,0.044],[11700,472,0.0515],[13900,586,0.054],[80650,4190,0.059],[96800,5143,0.0657],[107650,5855,0.0707],[157650,9388,0.0801],[211550,13708,0.064],[323200,20854,0.1349],[373200,27600,0.0735],[1077550,79369,0.0765]]
      method_iii_threshold: 1077550
    pfl: { employee_rate: 0.00432, annual_max: 411.91 }
    dbl: { employee_rate: 0.005, weekly_max: 0.60, employer_optional: true }
    sui: { wage_base: 17600, new_employer_rate: 0.041, components: { ui: 0.04025, rsf: 0.00075 } }
  TX:
    income_tax: null
    sui: { wage_base: 9000, new_employer_rate: 0.027, range: [0.0032, 0.0632] }
  WA:
    income_tax: null
    pfml: { total_rate: 0.0113, employee_share: 0.7143, employer_share: 0.2857, wage_base: 184500, small_employer_threshold: 50 }
    wa_cares: { employee_rate: 0.0058, wage_base: null }
    sui: { wage_base: 78200, new_employer_rate: "1.15x_industry_average" }
  FL:
    income_tax: null
    sui: { wage_base: 7000, new_employer_rate: 0.027 }
  IL:
    income_tax: { method: "flat_allowance", rate: 0.0495, line1_allowance: 2925, line2_allowance: 1000 }
    sui: { wage_base: 14250, new_employer_rate: 0.0335, includes_fund_building: 0.0055 }
  MA:
    income_tax:
      method: "circular_m_percentage"
      confidence: "secondary"
      rate: 0.05
      fica_deduction_cap: 2000
      exemption_base: 3400            # applied only if exemptions >= 1
      exemption_per: 1000
      hoh_deduction: 2400
      surtax: { rate: 0.04, threshold: 1107750 }
    pfml: { total_rate: 0.0088, employee_rate: 0.0046, employer_rate: 0.0042, small_employer_threshold: 25, confidence: "secondary" }
    sui: { wage_base: 15000, new_employer_rate: 0.0242 }
  CO:
    income_tax: { method: "dr1098_2026", rate: 0.044, allowance: { mfj: 11000, qss: 11000, other: 5500 } }
    famli: { total_rate: 0.0088, employee_rate: 0.0044, employer_rate: 0.0044, wage_base: 184500 }
    sui: { wage_base: 30600, new_employer_rate: 0.0305, components: { base: 0.0153, support: 0.0017, solvency: 0.0135 } }
```

---

## 7. Ten hand-computed paychecks (engine test fixtures)

Conventions for all cases: 2026 tables; YTD wages are zero unless stated; every tax line is rounded once to cents half up; FIT is computed with Worksheet 1A without whole-dollar rounding; state income tax for CA uses the EDD annualized method. "Net" is gross minus employee taxes and employee deductions.

### Case 1: California, biweekly, single, W-4 default, DE 4 single 1 allowance, gross $3,000.00

- FIT: 3,000 x 26 = 78,000; minus 8,600 = 69,400. Single standard row 57,900: 5,800 + 0.22 x (69,400 - 57,900) = 5,800 + 2,530 = 8,330. 8,330 / 26 = 320.384615 -> **$320.38**
- SS: 3,000 x 0.062 = **$186.00**. Medicare: 3,000 x 0.0145 = **$43.50**
- CA SDI: 3,000 x 0.013 = **$39.00**
- CA PIT: annual 78,000 > 18,896 (low income), so withhold. 78,000 - 5,706 = 72,294. Single row over 57,542: 2,186.15 + 0.088 x (72,294 - 57,542) = 2,186.15 + 1,298.176 = 3,484.326. Minus 1 allowance credit 168.30 = 3,316.026. / 26 = 127.539462 -> **$127.54**
- Net: 3,000 - 320.38 - 186.00 - 43.50 - 39.00 - 127.54 = **$2,283.58**
- Employer side (new CA employer, YTD 0): SS $186.00; Medicare $43.50; FUTA 3,000 x 0.006 = $18.00 (credit reduction trued up on Form 940 at year end); CA UI 3,000 x 0.034 = $102.00; ETT 3,000 x 0.001 = $3.00.

### Case 2: Texas, semimonthly, MFJ, gross $5,000.00, 401(k) 6% pre-tax, Section 125 medical $200.00

- 401(k): 5,000 x 0.06 = $300.00. Section 125: $200.00.
- FIT wages: 5,000 - 300 - 200 = 4,500. FICA wages: 5,000 - 200 = 4,800 (401(k) stays in FICA wages).
- FIT: 4,500 x 24 = 108,000; minus 12,900 = 95,100. MFJ row 44,100: 2,480 + 0.12 x 51,000 = 2,480 + 6,120 = 8,600. / 24 = 358.3333 -> **$358.33**
- SS: 4,800 x 0.062 = **$297.60**. Medicare: 4,800 x 0.0145 = **$69.60**
- TX: no income tax, no employee payroll tax.
- Net: 5,000 - 300 - 200 - 358.33 - 297.60 - 69.60 = **$3,774.47**

### Case 3: Washington, weekly, head of household, W-4 Step 3 = $2,200, gross $1,200.00, employer has 50+ employees

- FIT: 1,200 x 52 = 62,400; minus 8,600 = 53,800. HOH row 33,250: 1,770 + 0.12 x 20,550 = 1,770 + 2,466 = 4,236. / 52 = 81.461538. Credits 2,200 / 52 = 42.307692. 81.461538 - 42.307692 = 39.153846 -> **$39.15**
- SS: 1,200 x 0.062 = **$74.40**. Medicare: 1,200 x 0.0145 = **$17.40**
- WA PFML: total premium 1,200 x 0.0113 = 13.56; employee 71.43% = 1,200 x 0.0113 x 0.7143 = 9.685908 -> **$9.69**; employer share 13.56 - 9.69 = $3.87.
- WA Cares: 1,200 x 0.0058 = **$6.96**
- Net: 1,200 - 39.15 - 74.40 - 17.40 - 9.69 - 6.96 = **$1,052.40**

### Case 4: New York, biweekly, single, IT-2104 single 1 allowance, gross $4,000.00, employer collects DBL

- FIT: 4,000 x 26 = 104,000; minus 8,600 = 95,400. Single row 57,900: 5,800 + 0.22 x 37,500 = 5,800 + 8,250 = 14,050. / 26 = 540.384615 -> **$540.38**
- SS: **$248.00**. Medicare: **$58.00**
- NY PIT: Table A biweekly single 1 exemption = 323.10. Net wages 4,000 - 323.10 = 3,676.90. Table II-B row 5 (3,102 to 3,723): (3,676.90 - 3,102) x 0.0590 + 161.15 = 574.90 x 0.059 + 161.15 = 33.9191 + 161.15 = 195.0691 -> **$195.07**
- NY PFL: 4,000 x 0.00432 = **$17.28**
- NY DBL: 0.5% x 4,000 = 20.00, capped at 2 weeks x $0.60 = **$1.20**
- Net: 4,000 - 540.38 - 248.00 - 58.00 - 195.07 - 17.28 - 1.20 = **$2,940.07**

### Case 5: Illinois, biweekly, MFJ, W-4 Step 4(a) $5,000, 4(b) $10,000, 4(c) $50, IL-W-4 line 1 = 2 allowances, gross $4,000.00

- FIT: 4,000 x 26 = 104,000; + 5,000 = 109,000; minus (10,000 + 12,900) = 86,100. MFJ row 44,100: 2,480 + 0.12 x 42,000 = 2,480 + 5,040 = 7,520. / 26 = 289.230769; + 50 = 339.230769 -> **$339.23**
- SS: **$248.00**. Medicare: **$58.00**
- IL: exemptions 2 x 2,925 = 5,850 / 26 = 225.00. (4,000 - 225.00) x 0.0495 = 3,775 x 0.0495 = 186.8625 -> **$186.86**
- Net: 4,000 - 339.23 - 248.00 - 58.00 - 186.86 = **$3,167.91**

### Case 6: Florida, semimonthly, single, gross $10,000.00, YTD Social Security wages $180,000.00 (Social Security wage base crossing)

- FIT: 10,000 x 24 = 240,000; minus 8,600 = 231,400. Single row 209,275: 41,024 + 0.32 x 22,125 = 41,024 + 7,080 = 48,104. / 24 = 2,004.3333 -> **$2,004.33**
- SS: remaining base 184,500 - 180,000 = 4,500. 4,500 x 0.062 = **$279.00** (employer also $279.00)
- Medicare: 10,000 x 0.0145 = **$145.00**. YTD Medicare wages become 190,000 < 200,000, so no Additional Medicare.
- FL: none.
- Net: 10,000 - 2,004.33 - 279.00 - 145.00 = **$7,571.67**

### Case 7: Colorado, monthly, MFJ (W-4 only, no DR 0004), gross $20,000.00, YTD wages $195,000.00 (Additional Medicare crossing; SS and FAMLI already capped)

- FIT: 20,000 x 12 = 240,000; minus 12,900 = 227,100. MFJ row 120,100: 11,600 + 0.22 x 107,000 = 11,600 + 23,540 = 35,140. / 12 = 2,928.3333 -> **$2,928.33**
- SS: YTD 195,000 >= 184,500, so **$0.00**
- Medicare: 20,000 x 0.0145 = **$290.00**
- Additional Medicare: YTD after this check 215,000; excess over 200,000 inside this payment = 15,000. 15,000 x 0.009 = **$135.00** (no employer match; filing status irrelevant)
- CO PIT: 240,000 - 11,000 = 229,000. x 0.044 = 10,076. / 12 = 839.6667 -> **$839.67**
- CO FAMLI: YTD 195,000 >= 184,500, so **$0.00**
- Net: 20,000 - 2,928.33 - 290.00 - 135.00 - 839.67 = **$15,807.00**

### Case 8: Massachusetts, weekly, single, M-4 1 exemption, gross $1,500.00, employer has 25+ covered individuals (secondary-sourced MA formula)

- FIT: 1,500 x 52 = 78,000; minus 8,600 = 69,400. Single row 57,900: 5,800 + 0.22 x 11,500 = 8,330. / 52 = 160.192308 -> **$160.19**
- SS: 1,500 x 0.062 = **$93.00**. Medicare: 1,500 x 0.0145 = **$21.75**
- MA PIT: annual 78,000. FICA deduction = min(2,000, (93.00 + 21.75) x 52 = 5,967) = 2,000. Exemption 3,400 + 1,000 x 1 = 4,400. Taxable 78,000 - 2,000 - 4,400 = 71,600. x 0.05 = 3,580. / 52 = 68.846154 -> **$68.85**
- MA PFML (employee): 1,500 x 0.0046 = **$6.90**
- Net: 1,500 - 160.19 - 93.00 - 21.75 - 68.85 - 6.90 = **$1,149.31**

### Case 9: Texas, biweekly, 2019 Form W-4 "Married" with 3 allowances, gross $2,500.00 (legacy W-4 path)

- FIT: 2,500 x 26 = 65,000. Line 1k = 3 x 4,300 = 12,900. Line 1l = 65,000 - 12,900 = 52,100 (no line 1g amount on this path). STANDARD MFJ row 44,100: 2,480 + 0.12 x 8,000 = 2,480 + 960 = 3,440. / 26 = 132.307692 -> **$132.31**
- SS: 2,500 x 0.062 = **$155.00**. Medicare: 2,500 x 0.0145 = **$36.25**
- Net: 2,500 - 132.31 - 155.00 - 36.25 = **$2,176.44**

### Case 10: New York, supplemental bonus $5,000.00 paid separately (employer withheld FIT from regular wages this year; YTD supplemental under $1,000,000; DBL already at its weekly cap from this week's regular pay; YTD PFL well under $411.91)

- FIT: optional flat 22%: 5,000 x 0.22 = **$1,100.00**
- NY PIT: supplemental flat 11.70%: 5,000 x 0.117 = **$585.00**
- SS: 5,000 x 0.062 = **$310.00**. Medicare: 5,000 x 0.0145 = **$72.50**
- NY PFL: 5,000 x 0.00432 = **$21.60**
- NY DBL: **$0.00** (weekly cap reached)
- Net: 5,000 - 1,100.00 - 585.00 - 310.00 - 72.50 - 21.60 = **$2,910.90**

### Extra edge cases (FIT only)

- 11. Weekly, single, $300.00: 15,600 - 8,600 = 7,000 < 7,500, so FIT **$0.00**; SS $18.60; Medicare $4.35.
- 12. Monthly, single, Step 2 box checked, $6,000.00: line 1g = 0, adjusted 72,000. Checkbox single row 60,900: 8,983 + 0.24 x 11,100 = 8,983 + 2,664 = 11,647. / 12 = 970.5833 -> **$970.58**.
- Agency examples to reuse verbatim as tests: CA Method B Example E ($4.13, section 2.1) [S6]; IL weekly $800 example ($32.13, section 2.6) [S22]; NY Example 1 weekly $400 single 3 exemptions ($8.01) [S7].

Expected results as a fixture table (all amounts in dollars):

| # | State | Freq | Gross | FIT | SS | Medicare | Add'l Medicare | State PIT | Other employee taxes | Pre-tax deductions | Net |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | CA | biweekly | 3000.00 | 320.38 | 186.00 | 43.50 | 0.00 | 127.54 | SDI 39.00 | 0.00 | 2283.58 |
| 2 | TX | semimonthly | 5000.00 | 358.33 | 297.60 | 69.60 | 0.00 | 0.00 | 0.00 | 500.00 | 3774.47 |
| 3 | WA | weekly | 1200.00 | 39.15 | 74.40 | 17.40 | 0.00 | 0.00 | PFML 9.69, WA Cares 6.96 | 0.00 | 1052.40 |
| 4 | NY | biweekly | 4000.00 | 540.38 | 248.00 | 58.00 | 0.00 | 195.07 | PFL 17.28, DBL 1.20 | 0.00 | 2940.07 |
| 5 | IL | biweekly | 4000.00 | 339.23 | 248.00 | 58.00 | 0.00 | 186.86 | 0.00 | 0.00 | 3167.91 |
| 6 | FL | semimonthly | 10000.00 | 2004.33 | 279.00 | 145.00 | 0.00 | 0.00 | 0.00 | 0.00 | 7571.67 |
| 7 | CO | monthly | 20000.00 | 2928.33 | 0.00 | 290.00 | 135.00 | 839.67 | FAMLI 0.00 | 0.00 | 15807.00 |
| 8 | MA | weekly | 1500.00 | 160.19 | 93.00 | 21.75 | 0.00 | 68.85 | PFML 6.90 | 0.00 | 1149.31 |
| 9 | TX | biweekly | 2500.00 | 132.31 | 155.00 | 36.25 | 0.00 | 0.00 | 0.00 | 0.00 | 2176.44 |
| 10 | NY | supplemental | 5000.00 | 1100.00 | 310.00 | 72.50 | 0.00 | 585.00 | PFL 21.60 | 0.00 | 2910.90 |

All ten cases were re-run with Python `Decimal` arithmetic while writing this file and matched the hand arithmetic to the cent.

---

## 8. Open questions and known gaps

1. **Massachusetts Circular M** could not be fetched (mass.gov returns 403 to automated clients). The exemption base ($3,400 + $1,000 each), $2,000 FICA cap and $2,400 HOH figures are secondary; Case 8 depends on them. A human should open the 2026 Circular M PDF and confirm.
2. **2026 FUTA credit reduction states** are announced after November 10, 2026. Weft should ship 2025 values (CA 1.2%, VI 4.5%) and a pending 2026 slot.
3. **State treatment of 401(k) and Section 125** for state income tax and SUI was not researched state by state. Defaults in section 1.6 are a modeling choice.
4. **TX, IL account number formats** were not confirmed in primary sources; synthetic formats are marked.
5. **NY UI new employer rate**: DOL rate page shows 4.1% total (4.025% + 0.075% RSF) and also "new employer normal contribution rate is 3.4%"; DOL national table shows 4.025% base. Weft uses 4.1% total. NY lowest experienced rate differs between the NY DOL page (1.625% UI) and the DOL national table (2.025%); not needed for the foundation.
6. **CA Method B per-period tables** differ from the annualized method by cents in some cases; Weft deliberately uses annualization, which EDD permits.
7. **NYC, Yonkers, local taxes, reciprocity, multi-state work allocation, Method III top-income NY, MA surtax withholding, CA supplemental rates** are out of scope for the 9-hour foundation.
8. **IRS notice numbers** (CP-series) were not researched; the simulator uses generic `kind` codes in section 3.
9. **Social Security wage base** is taken from Pub 15 (2026); ssa.gov returned "Access Denied" to automated fetches, so SSA's own page was not read.

---

## 9. Sources

Local copies (scratch, not committed) were made under the research agent's scratchpad for tables parsed from HTML and PDF.

- [S1] P. IRS Publication 15-T (2026), Federal Income Tax Withholding Methods, "For use in 2026", Worksheet 1A and 2026 Percentage Method Tables. https://www.irs.gov/publications/p15t (PDF: https://www.irs.gov/pub/irs-pdf/p15t.pdf)
- [S2] P. IRS Publication 15 (2026), (Circular E), Employer's Tax Guide: What's New, Calendar, sections 1, 5, 7, 9, 11, 12, 14, 15. https://www.irs.gov/publications/p15
- [S3] P. IRS Schedule A (Form 940) for 2025 and its instructions, "Created 11/12/25": credit reduction rates CA 0.012, VI 0.045. https://www.irs.gov/pub/irs-pdf/f940sa.pdf
- [S4] P. California EDD, Contribution Rates, Withholding Schedules, and Meals and Lodging Values (2026 UI, ETT, SDI; DE 2088). https://edd.ca.gov/en/payroll_taxes/rates_and_withholding/
- [S5] P. US DOL ETA, Significant Provisions of State Unemployment Insurance Laws, Effective January 2026 (taxable wage bases and new employer base rates). https://oui.doleta.gov/unemploy/content/sigpros/2020-2029/January2026.pdf
- [S6] P. California EDD, California Withholding Schedules for 2026, Method B Exact Calculation Method. https://edd.ca.gov/siteassets/files/pdf_pub_ctr/26methb.pdf
- [S7] P. NY Department of Taxation and Finance, NYS-50-T-NYS (1/26), New York State Withholding Tax Tables and Methods, effective January 1, 2026. https://www.tax.ny.gov/pdf/publications/withholding/nys50_t_nys.pdf
- [S8] P. NY DOL, Unemployment Insurance Rate Information (2026 rates incl. RSF; rate notices mailed from mid-February). https://dol.ny.gov/unemployment-insurance-rate-information
- [S9] P. Texas Workforce Commission, Tax Rates. https://www.twc.texas.gov/programs/unemployment-tax/tax-rates
- [S10] P. Washington ESD news release (Oct 29, 2025), Paid Family and Medical Leave premium rate increases to 1.13% in 2026. https://esd.wa.gov/node/1109
- [S11] P. Florida Department of Revenue, Reemployment Tax ($7,000 wage base; .0270 initial rate). https://floridarevenue.com/taxes/taxesfees/Pages/reemployment.aspx
- [S12] S. IRS Form W-4 (2026), Step 3 amounts, via search of irs.gov. https://www.irs.gov/pub/irs-pdf/fw4.pdf
- [S13] P. IRS, FUTA credit reduction (0.3% schedule, Q4 incurrence, due Jan 31). https://www.irs.gov/businesses/small-businesses-self-employed/futa-credit-reduction
- [S14] P. US DOL ETA, FUTA Credit Reductions (Nov 10 rule; potential 2026 list). https://oui.doleta.gov/unemploy/futa_credit.asp
- [S15] S. IRS Rev. Proc. 2025-32 and Pub 15-B (2026): health FSA $3,400, via search of irs.gov. https://www.irs.gov/pub/irs-drop/rp-25-32.pdf ; https://www.irs.gov/publications/p15b
- [S16] S. IRS COLA increases for dollar limitations and Notice 2025-67 (2026 401(k) limits, Roth catch-up rule), via search of irs.gov. https://www.irs.gov/retirement-plans/cola-increases-for-dollar-limitations-on-benefits-and-contributions ; https://www.irs.gov/pub/irs-drop/n-25-67.pdf
- [S17] S. IRS Rev. Proc. 2025-19 (2026 HSA limits), via search of irs.gov. https://www.irs.gov/pub/irs-drop/rp-25-19.pdf
- [S18] P. New York Paid Family Leave Updates for 2026. https://paidfamilyleave.ny.gov/2026
- [S19] S. NY Workers' Compensation Board, Disability Benefits employer page (0.5%, $0.60/week, employer may collect), via search. https://www.wcb.ny.gov/content/main/DisabilityBenefits/employer-disability-benefits.jsp
- [S20] S. Washington ESD, How we determine tax rates; 2026 wage base and new employer 115% rule, via search of esd.wa.gov. https://esd.wa.gov/employer-requirements/unemployment-taxes/how-we-determine-tax-rates
- [S21] P. WA Cares Fund, employers page (0.58% of gross wages). https://wacaresfund.wa.gov/employers/
- [S22] P. Illinois Department of Revenue, IL-700-T Illinois Withholding Tax Tables, effective January 1, 2026. https://tax.illinois.gov/content/dam/soi/en/web/tax/forms/withholding/documents/currentyear/il-700-t.pdf
- [S23] S. IDES EA-50 (11/2025) 2026 State Experience Factor and rates, and UI-3/40, via search of ides.illinois.gov. https://ides.illinois.gov/content/dam/soi/en/web/ides/ides_forms_and_publications/EA-50_2026.pdf
- [S24] S. Massachusetts DOR, Circular M, Income Tax Withholding Tables at 5.0% Effective January 1, 2026 (via search snippets; direct fetch blocked) plus trade sources for the exemption formula. https://www.mass.gov/doc/massachusetts-circular-m-income-tax-withholding-tables-at-50-effective-january-1-2026/download
- [S25] S. Massachusetts DUA, Employer contributions to unemployment (2026 new employer rates, $15,000 base), via search. https://www.mass.gov/info-details/employer-contributions-to-unemployment
- [S26] S. Massachusetts DFML/DOR PFML pages (0.88%, employee 0.46%, MassTaxConnect, DUA 8-digit EAN), via search; split corroborated by trade sources. https://www.mass.gov/info-details/paid-family-and-medical-leave-employer-contribution-rates-and-calculator ; https://www.mass.gov/info-details/pfml-registration-contributions-and-payments
- [S27] P. Colorado DOR, DR 1098 (10/21/25), 2026 Colorado Withholding Worksheet for Employers. https://tax.colorado.gov/sites/tax/files/documents/DR_1098_Colorado_Withholding_Worksheet_for_Employees.pdf
- [S28] S. Colorado CDLE, Premium Rates and Introductory Rates (2026 $30,600; 2027 $32,100; intro 3.05%), via search of cdle.colorado.gov. https://cdle.colorado.gov/employers/unemployment-insurance-premiums/introductory-rates
- [S29] P. Colorado FAMLI, Premium and Benefits Calculator (0.88%, 0.44%/0.44%, $184,500 cap). https://famli.colorado.gov/individuals-and-families/how-famli-works/premium-and-benefits-calculator
- [S30] S. California EDD, Step 1: Register as an Employer; Step 3: Register for a Payroll Tax Account (15 days, $100, 8-digit `000-0000-0`), via search. https://edd.ca.gov/en/payroll_taxes/step-1-register-as-an-employer/ ; https://edd.ca.gov/en/payroll_taxes/step-3-register-for-a-payroll-tax-account/
- [S31] S. California EDD, Required Filings and Due Dates; Payroll Tax Calendar, via search. https://edd.ca.gov/en/payroll_taxes/required_filings_and_due_dates/
- [S32] S. Bloomberg Tax, "New York Unemployment Wage Base Rising to $17,600 for 2026" (18% indexing), corroborating [S5]. https://news.bloombergtax.com/payroll/new-york-unemployment-wage-base-rising-to-17-600-for-2026
- [S33] S. NY DOL and DTF: Register for Unemployment Insurance (NYS-100), NYS-45 instructions, via search. https://dol.ny.gov/register-unemployment-insurance-0 ; https://www.tax.ny.gov/pdf/current_forms/wt/nys45i.pdf
- [S34] S. TWC, Tax Report and Payment Due Dates; Responsibilities of a Liable Employer, via search. https://www.twc.texas.gov/programs/unemployment-tax/tax-report-payment-due-dates
- [S35] S. Washington Paid Leave, premium wage cap equals the Social Security wage cap ($184,500 in 2026), via search results quoting ESD and paidleave.wa.gov. https://paidleave.wa.gov/reporting/
- [S36] S. Washington ESD, How to file your quarterly tax and wage reports; Penalties for late or incomplete tax payments and reports; DOR new registrant info, via search. https://esd.wa.gov/employer-requirements/quarterly-reports/how-file-your-quarterly-tax-and-wage-reports ; https://esd.wa.gov/employer-requirements/unemployment-taxes/penalties-late-or-incomplete-tax-payments-and-reports
- [S37] S. Florida DOR, Employer Guide to Reemployment Tax (RT-800002), Reemployment Tax Return and Payment Information, and the tax tip on the new eFile and Pay system, via search. https://floridarevenue.com/Forms_library/current/guides/rt800002.pdf ; https://floridarevenue.com/taxes/tips/Documents/TIP_2673B-01.pdf
- [S38] S. Illinois DOR, 2026 Form IL-941 Instructions, via search. https://tax.illinois.gov/content/dam/soi/en/web/tax/forms/withholding/documents/currentyear/il-941-instr.pdf
- [S39] P. Colorado DOR, Withholding Tax Guide page and Wage Withholding Tax Guide (Jan 2026): filing frequencies; overtime is Colorado wages. https://tax.colorado.gov/withholding-tax-guide
- [S40] S. Colorado DOR Withholding Accounts and CR 0100 instructions; CDLE Starting a Business, via search. https://tax.colorado.gov/withholding-accounts ; https://cdle.colorado.gov/employers/starting-a-business
