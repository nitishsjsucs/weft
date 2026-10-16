// Expense explanations (wave 3, research/wave3/expenses-timeoff.md 7.4 and 7.5). Owner: w3-expenses. Like paycheck flag
// explanations: the agent's text is grounded per item against that item's facts with @weft/grounding; a failing item is
// refused once (UNGROUNDED), then the deterministic template is saved and labeled "template".
import { check } from "@weft/grounding";
import type { W3Check } from "@weft/contracts";
import { EXPENSE_POLICY_V1, daysBetween, mileageCents, mileageRateX10, lodgingRateCents, perDiemAllowanceCents, suggest, usd, type PolicyItem } from "./policy";

export const MAX_EXPENSE_EXPLANATION_CHARS = 600;

const DECISION_WORDS = { approve: "approve", approve_taxable: "approve as a taxable reimbursement", return: "return to the employee", decline: "decline" } as const;

/** One sentence per check plus the suggested decision, built only from structured fields (never employee text). */
export function templateExpenseExplanation(item: PolicyItem, checks: readonly W3Check[]): string {
  const parts = [`${usd(item.amountCents)} ${item.category} on ${item.transactionDate}, submitted ${item.submittedDate}.`];
  if (!checks.length) parts.push("No policy checks fired.");
  for (const c of checks) parts.push(`${c.message}.`);
  const s = suggest(item, [...checks]);
  parts.push(`Suggested: ${DECISION_WORDS[s.decision]}.${s.humanNote ? ` ${s.humanNote}.` : ""}`);
  return parts.join(" ").replace(/\.\./g, ".");
}

/** The numbers and dates an explanation may use: the claim, the policy limits and the values the checks computed. */
export function expenseFacts(item: PolicyItem): Record<string, unknown> {
  const r = EXPENSE_POLICY_V1.rules;
  const rate = mileageRateX10(item.transactionDate);
  return {
    expense_id: item.id, amount_cents: item.amountCents, transaction_date: item.transactionDate, submitted_date: item.submittedDate,
    days_after_expense: daysBetween(item.transactionDate, item.submittedDate), window_days: r.accountableWindowDays,
    receipt_required_at_cents: r.receiptRequiredAtCents, meals_per_person_cents: r.mealsPerPersonCents, equipment_pre_approval_cents: r.equipmentPreApprovalCents,
    software_monthly_cents: r.softwareMonthlyCents, second_approver_over_cents: r.secondApproverOverCents, lodging_rate_cents: lodgingRateCents(item.transactionDate),
    per_diem_meals_cents: r.perDiemMealsCents, per_diem_travel_day_cents: r.perDiemTravelDayCents, per_diem_3_day_cents: perDiemAllowanceCents(3),
    miles: item.milesX10 !== null ? (item.milesX10 / 10).toFixed(1) : null, mileage_rate_cents_per_mile: rate !== null ? (rate / 10).toFixed(1) : null,
    mileage_expected_cents: item.milesX10 !== null && rate !== null ? mileageCents(item.milesX10, rate) : null,
    extract_total_cents: item.extract?.totalCents ?? null, extract_date: item.extract?.date ?? null,
  };
}

export function groundExpenseExplanation(text: string, item: PolicyItem, checks: readonly W3Check[]): { ok: boolean; offending: string[] } {
  return check(text, [expenseFacts(item), ...checks.map((c) => ({ message: c.message, evidence: c.evidence }))]);
}
