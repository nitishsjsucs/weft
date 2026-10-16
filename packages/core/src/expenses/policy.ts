// Expense policy engine (wave 3, research/wave3/expenses-timeoff.md section 7.2). Owner: w3-expenses.
// Deterministic and pure: the same item, worker and neighbours always give the same checks. Output uses the paycheck
// flag shape ({ rule, severity, message, evidence }). Messages carry only amounts, dates, ids and rule codes, never
// employee-entered text (merchant, purpose and attendees are untrusted). The model only explains and proposes.
import { EXPENSE_RATES, type ExpenseCategory, type ExpenseDecision, type ExpenseDeclineReason, type ExpenseRuleCode, type W3Check } from "@weft/contracts";

/** Versioned Larkspur policy. The seed stores it in expense_policies; rates come from EXPENSE_RATES (2026). */
export const EXPENSE_POLICY_V1 = {
  version: 1,
  effectiveFrom: "2026-01-01",
  rules: {
    receiptRequiredAtCents: EXPENSE_RATES.receiptRequiredAtCents,
    mismatchToleranceCents: 100,
    mismatchToleranceDays: 3,
    duplicateWindowDays: 1,
    accountableWindowDays: EXPENSE_RATES.accountableWindowDays,
    mealsPerPersonCents: 7500,
    equipmentPreApprovalCents: 100_000,
    softwareMonthlyCents: 5000,
    secondApproverOverCents: 100_000,
    perDiemMealsCents: EXPENSE_RATES.perDiemMealsCents,
    perDiemTravelDayCents: EXPENSE_RATES.perDiemTravelDayCents,
  },
  sources: [
    { rules: ["RECEIPT_MISSING"], source: "IRS Publication 463 (2025), chapter 5, documentary evidence: lodging, and any other expense of $75 or more" },
    { rules: ["ACCOUNTABLE_WINDOW"], source: "IRS Publication 15 (2026), section 5, accountable plans; 26 CFR 1.62-2(g) fixed date method, 60 days" },
    { rules: ["MILEAGE_RATE"], source: "IRS standard mileage rates: 72.5 cents (Jan 1 to Jun 30, 2026), 76 cents (Jul 1 to Dec 31, 2026)" },
    { rules: ["PER_DIEM_OVER", "OVER_CATEGORY_LIMIT"], source: "GSA per diem bulletin FTR 27-01 and the M&IE breakdown: $68 a day, $51 on the first and last day; standard lodging $110 (FY 2026) and $113 (FY 2027)" },
    { rules: ["CA_NECESSARY_EXPENSE"], source: "California Labor Code 2802 (not read in research; listed as unverified)" },
    { rules: ["RECEIPT_MISMATCH", "DUPLICATE", "OUTSIDE_EMPLOYMENT", "FUTURE_DATE", "MEALS_DETAIL_MISSING", "SECOND_APPROVER"], source: "Larkspur company policy (Weft design)" },
  ],
} as const;
export type ExpensePolicy = { version: number; effectiveFrom: string; rules: { [K in keyof typeof EXPENSE_POLICY_V1.rules]: number }; sources: readonly { rules: readonly string[]; source: string }[] };

export interface ReceiptExtract { totalCents: number; date: string; merchant?: string }
export interface PolicyItem {
  id: string; workerId: string; category: ExpenseCategory; merchant: string; amountCents: number; transactionDate: string;
  /** The submission date in the company time zone (YYYY-MM-DD). */
  submittedDate: string;
  businessPurpose: string; attendees: string | null; milesX10: number | null; tripRef: string | null; preApprovalRef: string | null;
  hasReceipt: boolean; extract: ReceiptExtract | null; status: string;
}
/** Statuses that are not yet decided; a pending twin is a duplicate only when it came first. */
const PENDING: ReadonlySet<string> = new Set(["submitted", "needs_review", "returned"]);
export interface PolicyWorker { id: string; workState: string | null; startDate: string; endDate: string | null }
/** `others`: the worker's other expenses (any status; declined ones never count as duplicates). */
export interface PolicyContext { worker: PolicyWorker; others: readonly PolicyItem[] }

export interface Suggestion { decision: ExpenseDecision; reasonCode: ExpenseDeclineReason | null; note: string; humanNote: string | null }
export interface PolicyResult { checks: W3Check[]; allowed: ExpenseDecision[]; suggestion: Suggestion; policyVersion: number }

const DAY = 86_400_000;
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
export const usd = (cents: number) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
const fold = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Mileage rate in tenths of a cent per mile for the transaction date (not the submission date), or null. */
export function mileageRateX10(date: string): number | null {
  return EXPENSE_RATES.mileageCentsPerMileX10.find((r) => r.from <= date && date <= r.to)?.centsPerMileX10 ?? null;
}
/** round(miles x rate), half up, in cents: miles_x10 x cents_per_mile_x10 / 100. */
export function mileageCents(milesX10: number, rateX10: number): number {
  return Math.floor((milesX10 * rateX10 + 50) / 100);
}
export function lodgingRateCents(date: string): number {
  return EXPENSE_RATES.lodgingCents.find((r) => r.from <= date && date <= r.to)?.cents ?? EXPENSE_RATES.lodgingCents[EXPENSE_RATES.lodgingCents.length - 1]!.cents;
}
/** Meals allowance for a trip of `days` calendar days: 75% on the first and last day, the full rate between. */
export function perDiemAllowanceCents(days: number, p: ExpensePolicy = EXPENSE_POLICY_V1): number {
  if (days <= 0) return 0;
  if (days === 1) return p.rules.perDiemTravelDayCents;
  return 2 * p.rules.perDiemTravelDayCents + (days - 2) * p.rules.perDiemMealsCents;
}
export const attendeeCount = (a: string | null) => Math.max(1, (a ?? "").split(/[,;\n]/).map((x) => x.trim()).filter(Boolean).length);

const check = (rule: ExpenseRuleCode, severity: W3Check["severity"], message: string, evidence: W3Check["evidence"] = []): W3Check => ({ rule, severity, message, evidence });

/** Runs the 12 rules on one item. */
export function evaluateExpense(item: PolicyItem, ctx: PolicyContext, policy: ExpensePolicy = EXPENSE_POLICY_V1): PolicyResult {
  const r = policy.rules;
  const checks: W3Check[] = [];
  const self = { label: "Expense", ref: item.id };

  // RECEIPT_MISSING: lodging always, anything else at $75.00 or more. Mileage is substantiated by the miles.
  if (item.category !== "mileage" && !item.hasReceipt) {
    if (item.category === "lodging" || item.amountCents >= r.receiptRequiredAtCents) {
      checks.push(check("RECEIPT_MISSING", "block", item.category === "lodging" ? "Lodging always needs a receipt" : `No receipt for ${usd(item.amountCents)}; receipts are required from ${usd(r.receiptRequiredAtCents)}`, [self]));
    } else {
      checks.push(check("RECEIPT_MISSING", "info", `Receipt not required under ${usd(r.receiptRequiredAtCents)} (IRS Publication 463)`, [self]));
    }
  }
  // RECEIPT_MISMATCH: the extracted total or date disagrees with the claim.
  if (item.hasReceipt && item.extract) {
    const dc = Math.abs(item.extract.totalCents - item.amountCents);
    const dd = Math.abs(daysBetween(item.extract.date, item.transactionDate));
    if (dc > r.mismatchToleranceCents || dd > r.mismatchToleranceDays) {
      checks.push(check("RECEIPT_MISMATCH", "review", `Receipt shows ${usd(item.extract.totalCents)} on ${item.extract.date}; the claim is ${usd(item.amountCents)} on ${item.transactionDate}`, [{ label: "Receipt", ref: item.id }]));
    }
  }
  // DUPLICATE: same merchant (case folded), amount and date within a day of a non-declined item. Between two items
  // still pending, only the later one (by submission date, then id) is the duplicate, so the original stays approvable.
  const earlierPending = (o: PolicyItem) => o.submittedDate < item.submittedDate || (o.submittedDate === item.submittedDate && o.id < item.id);
  const dup = ctx.others.find((o) => o.id !== item.id && o.status !== "declined" && (!PENDING.has(o.status) || earlierPending(o))
    && fold(o.merchant) === fold(item.merchant) && o.amountCents === item.amountCents
    && Math.abs(daysBetween(o.transactionDate, item.transactionDate)) <= r.duplicateWindowDays);
  if (dup) checks.push(check("DUPLICATE", "block", `Same merchant, amount (${usd(item.amountCents)}) and date as ${dup.id} (${dup.status})`, [{ label: "Earlier expense", ref: dup.id }]));
  // ACCOUNTABLE_WINDOW: substantiated more than 60 days after the expense.
  const lateBy = daysBetween(item.transactionDate, item.submittedDate);
  const late = lateBy > r.accountableWindowDays;
  if (late) checks.push(check("ACCOUNTABLE_WINDOW", "review", `Submitted ${lateBy} days after the expense (limit ${r.accountableWindowDays}); only Decline or Approve as taxable are allowed`, [self]));
  // OVER_CATEGORY_LIMIT, MEALS_DETAIL_MISSING, PER_DIEM_OVER
  let overLimit: string | null = null;
  if (item.category === "meals") {
    if (!item.attendees?.trim() || !item.businessPurpose.trim()) checks.push(check("MEALS_DETAIL_MISSING", "review", "Meals need the attendees and the business purpose", [self]));
    if (item.tripRef) {
      const trip = [item, ...ctx.others.filter((o) => o.id !== item.id && o.tripRef === item.tripRef && o.status !== "declined")];
      const dates = trip.map((t) => t.transactionDate).sort();
      const days = daysBetween(dates[0]!, dates[dates.length - 1]!) + 1;
      const allowance = perDiemAllowanceCents(days, policy);
      const meals = trip.filter((t) => t.category === "meals").reduce((s, t) => s + t.amountCents, 0);
      if (meals > allowance) {
        checks.push(check("PER_DIEM_OVER", "review", `Trip meals ${usd(meals)} over ${days} days exceed the ${usd(allowance)} allowance by ${usd(meals - allowance)}`, trip.filter((t) => t.category === "meals").map((t) => ({ label: "Trip meals", ref: t.id }))));
      }
    } else {
      const n = attendeeCount(item.attendees);
      const limit = r.mealsPerPersonCents * n;
      if (item.amountCents > limit) overLimit = `Meals ${usd(item.amountCents)} for ${n} ${n === 1 ? "person" : "people"} exceed ${usd(r.mealsPerPersonCents)} per person`;
    }
  } else if (item.category === "equipment" && item.amountCents > r.equipmentPreApprovalCents && !item.preApprovalRef) {
    overLimit = `Equipment ${usd(item.amountCents)} is over ${usd(r.equipmentPreApprovalCents)} without a pre-approval reference`;
  } else if (item.category === "software" && item.amountCents > r.softwareMonthlyCents) {
    overLimit = `Software ${usd(item.amountCents)} is over the ${usd(r.softwareMonthlyCents)} monthly limit`;
  } else if (item.category === "lodging") {
    const rate = lodgingRateCents(item.transactionDate);
    if (item.amountCents > rate) overLimit = `Lodging ${usd(item.amountCents)} is over the standard ${usd(rate)} night rate for ${item.transactionDate}`;
  }
  if (overLimit) checks.push(check("OVER_CATEGORY_LIMIT", "review", overLimit, [self]));
  // MILEAGE_RATE: the claim must equal round(miles x the rate on the transaction date).
  if (item.category === "mileage") {
    const rate = mileageRateX10(item.transactionDate);
    if (item.milesX10 === null) checks.push(check("MILEAGE_RATE", "block", "Mileage claims need the miles driven", [self]));
    else if (rate === null) checks.push(check("MILEAGE_RATE", "block", `No published mileage rate for ${item.transactionDate}`, [self]));
    else {
      const expected = mileageCents(item.milesX10, rate);
      if (expected !== item.amountCents) checks.push(check("MILEAGE_RATE", "block", `${(item.milesX10 / 10).toFixed(1)} miles at ${(rate / 10).toFixed(1)} cents is ${usd(expected)}; the claim is ${usd(item.amountCents)}`, [self]));
    }
  }
  // OUTSIDE_EMPLOYMENT, FUTURE_DATE
  const w = ctx.worker;
  if (item.transactionDate < w.startDate || (w.endDate !== null && item.transactionDate > w.endDate)) {
    checks.push(check("OUTSIDE_EMPLOYMENT", "block", `Expense on ${item.transactionDate} is outside employment (${w.startDate} to ${w.endDate ?? "present"})`, [{ label: "Worker", ref: w.id }]));
  }
  if (item.transactionDate > item.submittedDate) checks.push(check("FUTURE_DATE", "block", `Expense date ${item.transactionDate} is after the submission date ${item.submittedDate}`, [self]));
  // CA_NECESSARY_EXPENSE, SECOND_APPROVER
  if (overLimit && w.workState === "CA") {
    checks.push(check("CA_NECESSARY_EXPENSE", "info", "California workers must be reimbursed for necessary business expenses; decide whether this purchase was necessary", [{ label: "Worker", ref: w.id }]));
  }
  if (item.amountCents > r.secondApproverOverCents) checks.push(check("SECOND_APPROVER", "info", `Over ${usd(r.secondApproverOverCents)}: a second person reviews after the approver`, [self]));

  return { checks, allowed: allowedDecisions(checks), suggestion: suggest(item, checks), policyVersion: policy.version };
}

const has = (checks: W3Check[], rule: ExpenseRuleCode, severity?: W3Check["severity"]) => checks.some((c) => c.rule === rule && (!severity || c.severity === severity));
export const isBlocking = (checks: readonly W3Check[]) => checks.some((c) => c.severity === "block");

/** Decisions the approver may make: past the window only Decline or Approve as taxable; a block forbids approval. */
export function allowedDecisions(checks: W3Check[]): ExpenseDecision[] {
  if (isBlocking(checks)) return ["return", "decline"];
  if (has(checks, "ACCOUNTABLE_WINDOW")) return ["approve_taxable", "decline"];
  return ["approve", "return", "decline"];
}

/** The engine's suggested decision (the routine's per-item precheck arg). One decision per item, never a batch. */
export function suggest(item: PolicyItem, checks: W3Check[]): Suggestion {
  const s = (decision: ExpenseDecision, note: string, reasonCode: ExpenseDeclineReason | null = null, humanNote: string | null = null): Suggestion => ({ decision, reasonCode, note, humanNote });
  if (has(checks, "DUPLICATE")) return s("decline", "Duplicate of an earlier expense", "duplicate");
  if (has(checks, "OUTSIDE_EMPLOYMENT")) return s("decline", "The expense falls outside the employment dates", "other");
  if (has(checks, "FUTURE_DATE")) return s("return", "Please correct the expense date; it is after the submission date");
  if (has(checks, "RECEIPT_MISSING", "block")) return s("return", item.category === "lodging" ? "Please attach the hotel receipt; lodging always needs one" : "Please attach the receipt; receipts are required from $75.00");
  if (has(checks, "MILEAGE_RATE")) return s("return", "Please correct the mileage claim to the IRS rate for the trip date");
  if (has(checks, "ACCOUNTABLE_WINDOW")) return s("approve_taxable", "Submitted after the 60-day window: pay it as a taxable reimbursement on the next payroll, or decline it as late", null, "Choose Approve as taxable or Decline (late)");
  if (has(checks, "MEALS_DETAIL_MISSING")) return s("return", "Please add who attended and the business purpose of the meal");
  if (has(checks, "RECEIPT_MISMATCH")) return s("return", "The receipt does not match the claim; please check the amount and date");
  if (has(checks, "PER_DIEM_OVER")) return s("return", "Trip meals are over the per diem allowance; please claim up to the allowance");
  if (has(checks, "OVER_CATEGORY_LIMIT")) {
    const ca = has(checks, "CA_NECESSARY_EXPENSE");
    return s("approve", ca ? "Over the category limit for a California worker: approve if the purchase was necessary for the job" : "Over the category limit: approve if the purchase was necessary for the job", null,
      ca ? "California workers must be reimbursed for necessary business expenses; decide whether this purchase was necessary" : "A person decides whether this purchase was necessary");
  }
  return s("approve", "Within policy");
}

/** The day after `date`, for date windows in callers. */
export const nextDay = (date: string) => addDays(date, 1);
