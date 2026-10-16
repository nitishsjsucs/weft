// Display labels for expenses (owner: w3-expenses). One status badge map for the list, the drawer and the portal.
import type { ExpenseBand, ExpenseCategory, ExpenseDecision, ExpenseDeclineReason, ExpenseStatus } from "@weft/contracts";

export const usd = (c: number) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const BAND_LABEL: Record<ExpenseBand, string> = { needs_review: "Needs review", approved: "Approved", paid_out: "Paid out", declined: "Declined" };
export const CATEGORY_LABEL: Record<ExpenseCategory, string> = {
  travel: "Travel", lodging: "Lodging", meals: "Meals", mileage: "Mileage", equipment: "Equipment", software: "Software", office: "Office", supplies: "Supplies",
};
export const STATUS_LABEL: Record<ExpenseStatus, string> = {
  submitted: "Submitted", needs_review: "Needs review", returned: "Returned", approved: "Approved", approved_taxable: "Approved, taxable",
  declined: "Declined", scheduled: "Scheduled", paid: "Paid",
};
export const STATUS_TONE: Record<ExpenseStatus, "gray" | "amber" | "blue" | "green" | "red"> = {
  submitted: "amber", needs_review: "amber", returned: "gray", approved: "blue", approved_taxable: "blue", declined: "red", scheduled: "blue", paid: "green",
};
export const DECISION_LABEL: Record<ExpenseDecision, string> = { approve: "Approve", approve_taxable: "Approve as taxable", return: "Return", decline: "Decline" };
export const REASON_LABEL: Record<ExpenseDeclineReason, string> = {
  no_receipt: "No receipt", duplicate: "Duplicate", personal: "Personal", over_policy: "Over policy", late: "Late", other: "Other",
};
export const RULE_LABEL: Record<string, string> = {
  RECEIPT_MISSING: "Receipt", RECEIPT_MISMATCH: "Receipt mismatch", DUPLICATE: "Duplicate", ACCOUNTABLE_WINDOW: "Past 60 days", OVER_CATEGORY_LIMIT: "Over limit",
  MEALS_DETAIL_MISSING: "Meal details", PER_DIEM_OVER: "Over per diem", MILEAGE_RATE: "Mileage rate", OUTSIDE_EMPLOYMENT: "Outside employment",
  FUTURE_DATE: "Future date", CA_NECESSARY_EXPENSE: "California duty", SECOND_APPROVER: "Second approver",
};
export const SEVERITY_TONE = { block: "red", review: "amber", info: "gray" } as const;
