// w3-expenses additive contract (docs/wave3.md rule 2). Additive only; the integrator may export it from
// packages/contracts/src/index.ts. The route table names "Page<Expense>", "Expense" and "ExpensePolicy"; these are the
// shapes the API serves: the frozen Expense plus display fields the screen needs (names come from the DB, never input).
import { z } from "zod";
import { Expense, ExpenseBand, ExpenseDecision, ExpenseDeclineReason, W3Check } from "../wave3";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** GET /v1/expenses rows. merchant is employee text: render it escaped, never as markup. */
export const W3ExpensesRow = Expense.extend({
  workerName: z.string(), workerTitle: z.string(), workState: z.string().nullable(), submittedDate: date, hasReceipt: z.boolean(),
  payrollRunStatus: z.string().nullable(),
});
export type W3ExpensesRow = z.infer<typeof W3ExpensesRow>;

/** GET /v1/expenses: a page plus the four band counts over the whole filter (not just this page). */
export const W3ExpensesPage = z.object({ hasMore: z.boolean(), count: z.number().int(), data: z.array(W3ExpensesRow), bands: z.record(ExpenseBand, z.number().int()) });
export type W3ExpensesPage = z.infer<typeof W3ExpensesPage>;

export const W3ExpensesSuggestion = z.object({ decision: ExpenseDecision, reasonCode: ExpenseDeclineReason.nullable(), note: z.string(), humanNote: z.string().nullable() });

/** GET /v1/expenses/:id: the row plus what the drawer shows. */
export const W3ExpensesDetail = W3ExpensesRow.extend({
  attendees: z.string().nullable(), decisionNote: z.string().nullable(), preApprovalRef: z.string().nullable(),
  receiptExtract: z.object({ totalCents: z.number().int(), date, merchant: z.string().optional() }).nullable(),
  allowedDecisions: z.array(ExpenseDecision), suggestion: W3ExpensesSuggestion.nullable(), reopenBlocker: z.string().nullable(),
  paycheckId: z.string().nullable(), trail: z.array(z.object({ seq: z.number().int(), at: z.string(), command: z.string(), actor: z.string(), summary: z.string() })),
});
export type W3ExpensesDetail = z.infer<typeof W3ExpensesDetail>;

/** GET /v1/portal/expenses: the caller's own claims, with the approver's note the employee reads on a returned item. */
export const W3ExpensesPortalRow = W3ExpensesRow.extend({ decisionNote: z.string().nullable() });
export type W3ExpensesPortalRow = z.infer<typeof W3ExpensesPortalRow>;
export const W3ExpensesPortalPage = W3ExpensesPage.extend({ data: z.array(W3ExpensesPortalRow), workerId: z.string().nullable() });
export type W3ExpensesPortalPage = z.infer<typeof W3ExpensesPortalPage>;

/** GET /v1/expense-policy */
export const W3ExpensesPolicy = z.object({
  version: z.number().int(), effectiveFrom: date, rules: z.record(z.string(), z.number().int()), sources: z.array(z.object({ rules: z.array(z.string()), source: z.string() })),
  rates: z.unknown(),
});
export type W3ExpensesPolicy = z.infer<typeof W3ExpensesPolicy>;
export type { W3Check };
