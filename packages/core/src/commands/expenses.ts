// expenses.* commands (wave 3, docs/wave3.md). Owner: w3-expenses. Append WeftCommand definitions to this array; commands/index.ts
// concatenates it. Names, risk classes and access are fixed by W3_PLANNED_COMMANDS in packages/contracts/src/wave3.ts.
// One decision per call: expenses.decide takes exactly one expense_id, and no command decides several items (a registry
// test enforces it). Concise reads omit employee-entered text; detailed reads include it, wrapped and tainting the run.
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { ExpenseBand, ExpenseCategory, ExpenseDecision, ExpenseDeclineReason, ExpenseStatus, formatCents, W3_CEILINGS, type ExecContext, type W3Check } from "@weft/contracts";
import { expenses, payrollRuns, principals, proposals, settings, uploads, workers, type DbTx } from "@weft/db";
import type { CommandDeps, WeftCommand } from "../shared/deps";
import { canonicalJson } from "../shared/canonical-json";
import { sha256Hex } from "../shared/hash";
import { DomainRefusal, isDetailed, notFound, ptDateOf, readCommand, responseFormatField, writeCommand } from "../demo/define";
import { nameRef } from "../people/names";
import { isBlocking, usd, type PolicyResult } from "../expenses/policy";
import {
  attachToDraft, bandOf, checksOf, DECIDABLE, evaluateRow, getExpenseRow, listExpenseRows, markPaidForRun, policyItemOf, reopenBlocker, reopenExpense,
  scheduleForRun, targetDraft, writeChecks, type ExpenseRow,
} from "../expenses/store";
import { groundExpenseExplanation, MAX_EXPENSE_EXPLANATION_CHARS, templateExpenseExplanation } from "../expenses/explain";
import { EXPENSE_TOTALS_BY, expenseTotals } from "../expenses/totals";

const ExpenseId = z.string().startsWith("exp_");
const UNTRUSTED_LIST = ["expenses.*.merchant", "expenses.*.business_purpose", "expenses.*.attendees", "expenses.*.receipt_extract"];
const UNTRUSTED_ONE = ["expense.merchant", "expense.business_purpose", "expense.attendees", "expense.receipt_extract"];
const ID_HINT = { hint: "Use an expense id from expenses.list (one id per call).", example: { expense_id: "exp_0001" } };

const conciseItem = (r: ExpenseRow, name: string | undefined) => ({
  expense_id: r.id, worker: name ?? r.workerId, worker_id: r.workerId, category: r.category, amount_cents: r.amountCents, amount_display: formatCents(r.amountCents),
  transaction_date: r.transactionDate, submitted_date: ptDateOf(r.submittedAt), decided_date: r.decidedAt ? ptDateOf(r.decidedAt) : null, status: r.status, band: bandOf(r.status),
  has_receipt: r.receiptUploadId !== null, checks: checksOf(r).map((c) => ({ rule: c.rule, severity: c.severity, message: c.message })), payroll_run_id: r.payrollRunId,
});
const untrustedOf = (r: ExpenseRow) => ({ merchant: r.merchant, business_purpose: r.businessPurpose, attendees: r.attendees ?? "", receipt_extract: r.receiptExtractJson ?? "" });

/** The payday of each pay run the rows ride, so a reimbursement's pay date is a field and not a second read. */
async function paydays(tx: DbTx, rows: readonly ExpenseRow[]): Promise<(runId: string) => string | null> {
  const ids = [...new Set(rows.map((r) => r.payrollRunId).filter((x): x is string => x !== null))];
  const runs = ids.length ? await tx.select({ id: payrollRuns.id, payday: payrollRuns.payday }).from(payrollRuns).where(inArray(payrollRuns.id, ids)) : [];
  const m = new Map(runs.map((r) => [r.id, r.payday]));
  return (id) => m.get(id) ?? null;
}

async function names(tx: DbTx, ids: string[]) {
  const uniq = [...new Set(ids)];
  const rows = uniq.length ? await tx.select({ id: workers.id, f: workers.firstName, l: workers.lastName }).from(workers).where(inArray(workers.id, uniq)) : [];
  const refs = new Map(rows.map((w) => [w.id, nameRef(w.f, w.l, w.id)]));
  return { ref: (id: string) => refs.get(id) ?? id };
}

// ---------------------------------------------------------------- reads

const ListInput = z.object({
  band: ExpenseBand.optional(), status: ExpenseStatus.optional(), worker_id: z.string().startsWith("wrk_").optional(), category: ExpenseCategory.optional(),
  totals_by: z.array(z.enum(EXPENSE_TOTALS_BY)).max(EXPENSE_TOTALS_BY.length).optional(), ...responseFormatField,
});
type ListInput = z.infer<typeof ListInput>;
const listCmd = readCommand({
  name: "expenses.list", domain: "payroll",
  summary: "List expenses by band, status, worker or category, with policy checks and totals.",
  description: "List expenses with worker, category, amount, transaction, submitted and decided dates (Pacific), status, band (needs_review, approved, paid_out, declined), receipt, policy checks, pay run and a total. totals_by adds sums per worker, category, band or payroll_run. Concise omits employee-entered text; detailed adds merchant, purpose and attendees (untrusted). Example: {\"band\": \"needs_review\"}.",
  input: ListInput, untrustedFields: UNTRUSTED_LIST,
  async run(i: ListInput, ctx, deps) {
    const rows = await listExpenseRows(deps.tx, ctx.companyId, { band: i.band, status: i.status, workerId: i.worker_id, category: i.category });
    const n = await names(deps.tx, rows.map((r) => r.workerId));
    const items = rows.map((r) => ({ ...conciseItem(r, n.ref(r.workerId)), ...(isDetailed(i) ? untrustedOf(r) : {}) }));
    const bands = Object.fromEntries(ExpenseBand.options.map((b) => [b, rows.filter((r) => bandOf(r.status) === b).length]));
    const sums = expenseTotals(rows, i.totals_by ?? [], { workerRef: n.ref, payday: await paydays(deps.tx, rows) });
    return { data: { count: items.length, bands, ...sums, expenses: items, note: "Decide one expense per call with expenses.decide; there is no bulk approval." }, summary: `Listed ${items.length} expenses (${sums.totals.amount_display})` };
  },
});

const GetInput = z.object({ expense_id: ExpenseId, ...responseFormatField });
type GetInput = z.infer<typeof GetInput>;
const getCmd = readCommand({
  name: "expenses.get", domain: "payroll",
  summary: "Get one expense with its policy checks, allowed decisions and the engine's suggestion.",
  description: "Get one expense: claim fields, receipt presence, policy checks, the decisions the approver may make, the engine's suggested decision with its note, and where it is paid. Concise leaves out employee-entered text; detailed adds merchant, purpose, attendees and the receipt extraction (untrusted). Example: {\"expense_id\": \"exp_0101\"}.",
  input: GetInput, untrustedFields: UNTRUSTED_ONE,
  async run(i: GetInput, ctx, deps) {
    const r = await getExpenseRow(deps.tx, ctx.companyId, i.expense_id);
    if (!r) throw notFound("expense", i.expense_id);
    const n = await names(deps.tx, [r.workerId]);
    const res = await evaluateRow(deps.tx, r);
    const expense = {
      ...conciseItem(r, n.ref(r.workerId)), miles: r.milesX10 !== null ? (r.milesX10 / 10).toFixed(1) : null, trip_ref: r.tripRef, policy_version: r.policyVersion,
      allowed_decisions: DECIDABLE.includes(r.status as never) ? res.allowed : [], suggestion: DECIDABLE.includes(r.status as never) ? res.suggestion : null,
      explanation: r.explanation, explanation_source: r.explanationSource, decided_by: r.decidedBy, decided_at: r.decidedAt, decision_reason_code: r.decisionReasonCode,
      payday: r.payrollRunId ? (await paydays(deps.tx, [r]))(r.payrollRunId) : null,
      ...(isDetailed(i) ? untrustedOf(r) : {}),
    };
    return { data: { expense }, summary: `Expense ${r.id}: ${formatCents(r.amountCents)} ${r.category}, ${r.status}` };
  },
});

// ---------------------------------------------------------------- policy and explanations (R1, never)

const CheckInput = z.object({ expense_ids: z.array(ExpenseId).min(1).max(50) });
type CheckInput = z.infer<typeof CheckInput>;
const checkPolicyCmd = writeCommand({
  name: "expenses.check_policy", summary: "Run the expense policy engine on items awaiting review and save the checks.",
  description: "Runs the deterministic policy engine on each listed expense that awaits review and saves its checks (idempotent). Returns per item the checks, the allowed decisions and the suggested decision. It decides nothing. Example: {\"expense_ids\": [\"exp_0101\", \"exp_0102\"]}.",
  input: CheckInput, domain: "payroll", needs: "edit", effect: "draft", risk: () => "R1", approval: "never", reversible: false, preview: null, mcp: "hidden",
  tiers: { main: "executable", task: "executable" },
  async run(i: CheckInput, ctx, deps) {
    const out: { expense_id: string; status: string; checks: W3Check[]; allowed_decisions: string[]; suggestion: PolicyResult["suggestion"] | null }[] = [];
    for (const id of [...new Set(i.expense_ids)]) {
      const r = await getExpenseRow(deps.tx, ctx.companyId, id);
      if (!r) throw notFound("expense", id);
      if (!DECIDABLE.includes(r.status as never)) { out.push({ expense_id: id, status: r.status, checks: checksOf(r), allowed_decisions: [], suggestion: null }); continue; }
      const res = await writeChecks(deps.tx, r);
      out.push({ expense_id: id, status: "needs_review", checks: res.checks, allowed_decisions: res.allowed, suggestion: res.suggestion });
    }
    return { data: { count: out.length, items: out }, summary: `Checked ${out.length} expenses` };
  },
});

const ExplainInput = z.object({ items: z.array(z.object({ expense_id: ExpenseId, explanation: z.string().max(MAX_EXPENSE_EXPLANATION_CHARS).optional() })).min(1).max(50) });
type ExplainInput = z.infer<typeof ExplainInput>;
const ATTEMPTS = "expenses.explain_attempts";
const explainCmd = writeCommand({
  name: "expenses.explain", summary: "Save one grounded explanation per expense.",
  description: "Saves one plain explanation per expense. Numbers and dates must come from that item's claim, checks or policy limits; an ungrounded item is refused once (UNGROUNDED), then the template is saved (source template). Omit explanation to save the template. Never quote the merchant or purpose. Example: {\"items\": [{\"expense_id\": \"exp_0101\", \"explanation\": \"...\"}]}.",
  input: ExplainInput, domain: "payroll", needs: "edit", effect: "draft", risk: () => "R1", approval: "never", reversible: false, preview: null, mcp: "hidden",
  tiers: { main: "executable", task: "executable" },
  errorHints: { UNGROUNDED: { hint: "Use only amounts and dates from the expense and its checks.", example: { items: [{ expense_id: "exp_0001", explanation: "$412.38 travel on 2026-10-12 with a matching receipt: within policy." }] } } },
  async run(i: ExplainInput, ctx, deps) {
    const attempts = await readAttemptCounts(deps.tx);
    const results: { expense_id: string; status: "saved" | "refused"; source: "agent" | "template" | null; code: string | null; offending: string[]; explanation: string | null }[] = [];
    for (const item of i.items) {
      const r = await getExpenseRow(deps.tx, ctx.companyId, item.expense_id);
      if (!r) { results.push({ expense_id: item.expense_id, status: "refused", source: null, code: "UNKNOWN_REFERENCE", offending: [], explanation: null }); continue; }
      const pi = policyItemOf(r);
      const checks = checksOf(r);
      const save = async (text: string, source: "agent" | "template") => {
        await deps.tx.update(expenses).set({ explanation: text, explanationSource: source, explanationRunId: ctx.run?.id ?? null }).where(eq(expenses.id, r.id));
        results.push({ expense_id: r.id, status: "saved", source, code: null, offending: [], explanation: text });
      };
      const text = item.explanation?.trim() ?? "";
      // A tainted run saw employee-entered text, so its prose could carry an injection into later untainted runs that
      // read the explanation as trusted: only the template is saved there (harness 6.2, laundering channels).
      if (!text || ctx.tainted) { await save(templateExpenseExplanation(pi, checks), "template"); continue; }
      const g = groundExpenseExplanation(text, pi, checks);
      if (g.ok) { await save(text, "agent"); delete attempts[r.id]; continue; }
      if ((attempts[r.id] ?? 0) >= 1) {
        await save(templateExpenseExplanation(pi, checks), "template");
        results[results.length - 1]!.code = "UNGROUNDED";
        results[results.length - 1]!.offending = g.offending;
        delete attempts[r.id];
        continue;
      }
      attempts[r.id] = (attempts[r.id] ?? 0) + 1;
      results.push({ expense_id: r.id, status: "refused", source: null, code: "UNGROUNDED", offending: g.offending, explanation: null });
    }
    await writeAttemptCounts(deps.tx, attempts);
    const saved = results.filter((x) => x.status === "saved").length;
    return { data: { saved, refused: results.length - saved, results }, summary: `Saved ${saved} of ${results.length} expense explanations` };
  },
});

async function readAttemptCounts(tx: DbTx): Promise<Record<string, number>> {
  const row = (await tx.select().from(settings).where(eq(settings.key, ATTEMPTS)))[0];
  return row ? (JSON.parse(row.valueJson) as Record<string, number>) : {};
}
async function writeAttemptCounts(tx: DbTx, a: Record<string, number>): Promise<void> {
  const valueJson = JSON.stringify(Object.fromEntries(Object.entries(a).sort(([x], [y]) => (x < y ? -1 : 1))));
  await tx.insert(settings).values({ key: ATTEMPTS, valueJson }).onConflictDoUpdate({ target: settings.key, set: { valueJson } });
}

// ---------------------------------------------------------------- the one decision per call

const DecideInput = z.object({
  expense_id: ExpenseId, decision: ExpenseDecision, reason_code: ExpenseDeclineReason.optional(), note: z.string().max(400).optional(),
});
type DecideInput = z.infer<typeof DecideInput>;
const STATUS_AFTER = { approve: "approved", approve_taxable: "approved_taxable", return: "returned", decline: "declined" } as const;
const VERB = { approve: "Approve", approve_taxable: "Approve as taxable", return: "Return", decline: "Decline" } as const;

async function decidable(i: DecideInput, ctx: ExecContext, deps: CommandDeps): Promise<{ r: ExpenseRow; res: PolicyResult; who: string }> {
  const r = await getExpenseRow(deps.tx, ctx.companyId, i.expense_id);
  if (!r) throw notFound("expense", i.expense_id);
  if (!DECIDABLE.includes(r.status as never)) throw new DomainRefusal("DOMAIN_NOT_DECIDABLE", `Expense ${r.id} is ${r.status}; only items awaiting review can be decided`, "List items awaiting review with expenses.list {\"band\": \"needs_review\"}", { band: "needs_review" });
  const res = await evaluateRow(deps.tx, r);
  if (!res.allowed.includes(i.decision)) {
    throw new DomainRefusal("DOMAIN_DECISION_NOT_ALLOWED", `${VERB[i.decision]} is not allowed for ${r.id}: allowed ${res.allowed.join(", ")}${isBlocking(res.checks) ? " (a blocking check fired)" : ""}`, `Pick one of: ${res.allowed.join(", ")}`, { expense_id: r.id, decision: res.allowed[0], ...(res.allowed[0] === "decline" ? { reason_code: "other" } : {}) });
  }
  if (i.decision === "decline" && !i.reason_code) throw new DomainRefusal("DOMAIN_REASON_REQUIRED", "A decline needs a reason_code", "reason_code is one of no_receipt, duplicate, personal, over_policy, late, other", { expense_id: r.id, decision: "decline", reason_code: res.suggestion.reasonCode ?? "other" });
  if (i.decision === "return" && !i.note?.trim()) throw new DomainRefusal("DOMAIN_NOTE_REQUIRED", "A return needs a note the employee will read", "Say what the employee should fix", { expense_id: r.id, decision: "return", note: res.suggestion.note });
  const w = (await deps.tx.select().from(workers).where(eq(workers.id, r.workerId)))[0]!;
  // Separation of duties: the person deciding (the proposal's approver when one is being executed) never decides
  // their own expense.
  const decider = ctx.approvedProposalId ? ((await deps.tx.select({ by: proposals.decidedBy }).from(proposals).where(eq(proposals.id, ctx.approvedProposalId)))[0]?.by ?? null) : ctx.principal.kind === "human" ? ctx.principal.id : null;
  if (decider) {
    const [dp] = await deps.tx.select({ workerId: principals.workerId }).from(principals).where(eq(principals.id, decider)).limit(1);
    if (dp?.workerId && dp.workerId === r.workerId) throw new DomainRefusal("DOMAIN_SELF_APPROVAL", `${r.id} is your own expense; another approver decides it`, "Ask another payroll admin or the People admin to decide it", null);
  }
  return { r, res, who: nameRef(w.firstName, w.lastName, w.id) };
}

const decideCmd: WeftCommand<DecideInput> = {
  ...writeCommand({
    name: "expenses.decide", summary: "Propose one decision on one expense: approve, approve as taxable, return or decline.",
    description: "Decides exactly one expense (one expense_id; there is no bulk form). approve pays it on the next open draft outside gross; approve_taxable (only past 60 days) pays it inside gross; return sends it back with a note; decline needs reason_code. An agent's call is always a proposal. Example: {\"expense_id\": \"exp_0101\", \"decision\": \"approve\"}.",
    input: DecideInput, domain: "payroll", needs: "edit", effect: "write", risk: () => "R2", approval: "always", reversible: { reverse: "expenses.reopen" },
    ceilingKey: W3_CEILINGS.expense, lease: (i) => `expenses:${i.expense_id}`, mcp: "propose", tiers: { main: "executable", task: "delegated" },
    amountCents: async (i, ctx, deps) => (await getExpenseRow(deps.tx, ctx.companyId, i.expense_id))?.amountCents ?? null,
    errorHints: { INVALID_INPUT: ID_HINT, UNKNOWN_REFERENCE: ID_HINT },
    async preview(i: DecideInput, ctx, deps) {
      const { r, res, who } = await decidable(i, ctx, deps);
      const w = (await deps.tx.select().from(workers).where(eq(workers.id, r.workerId)))[0]!;
      const draft = w.payScheduleId ? await targetDraft(deps.tx, ctx.companyId, w.payScheduleId, ctx.now) : null;
      const pays = i.decision === "approve" ? `${draft?.id ?? "the next draft"}, reimbursement outside gross` : i.decision === "approve_taxable" ? `${draft?.id ?? "the next draft"}, taxable earning inside gross` : "not paid";
      return {
        title: `${VERB[i.decision]} expense ${r.id} for ${who}: ${formatCents(r.amountCents)} ${r.category} on ${r.transactionDate}`,
        diff: [
          { label: "Status", before: r.status, after: STATUS_AFTER[i.decision] },
          { label: "Payroll", before: r.payrollRunId ?? "not scheduled", after: pays },
          ...(i.reason_code ? [{ label: "Reason", before: "none", after: i.reason_code }] : []),
          ...res.checks.filter((c) => c.severity !== "info" || c.rule === "CA_NECESSARY_EXPENSE" || c.rule === "SECOND_APPROVER").map((c) => ({ label: `Check ${c.rule}`, before: c.severity, after: c.message })),
        ],
        content: i.note?.trim() ? [{ label: i.decision === "return" ? "Note to the employee" : "Decision note", text: i.note.trim() }] : [],
        moneyCents: i.decision === "approve" || i.decision === "approve_taxable" ? r.amountCents : 0,
        subjectRef: `expense:${r.id}`,
        subjectHash: sha256Hex(canonicalJson({ id: r.id, status: r.status, amount: r.amountCents, date: r.transactionDate, checks: res.checks.map((c) => [c.rule, c.severity]), receipt: r.receiptUploadId })),
        evidence: [{ label: "Expense", ref: r.id }, ...res.checks.flatMap((c) => c.evidence).filter((e, k, a) => a.findIndex((x) => x.ref === e.ref) === k && e.ref !== r.id)],
      };
    },
    async run(i: DecideInput, ctx, deps) {
      const { r } = await decidable(i, ctx, deps);
      const approver = ctx.approvedProposalId ? ((await deps.tx.select({ by: proposals.decidedBy }).from(proposals).where(eq(proposals.id, ctx.approvedProposalId)))[0]?.by ?? ctx.principal.id) : ctx.principal.id;
      const status = STATUS_AFTER[i.decision];
      await deps.tx.update(expenses).set({
        status, decidedBy: approver, decidedAt: ctx.now, approverPrincipalId: approver, decisionReasonCode: i.decision === "decline" ? i.reason_code ?? "other" : null,
        decisionNote: i.note?.trim() || null,
      }).where(eq(expenses.id, r.id));
      let runId: string | null = null;
      if (status === "approved" || status === "approved_taxable") {
        const fresh = (await getExpenseRow(deps.tx, ctx.companyId, r.id))!;
        runId = await attachToDraft(deps.tx, { newId: deps.newId, now: ctx.now }, fresh);
      }
      const after = (await getExpenseRow(deps.tx, ctx.companyId, r.id))!;
      const paid = runId ? ` on ${runId}` : status.startsWith("approved") ? " (waiting for the next draft)" : "";
      return {
        data: { expense_id: r.id, decision: i.decision, status: after.status, payroll_run_id: after.payrollRunId, amount_cents: r.amountCents, amount_display: formatCents(r.amountCents) },
        summary: `${VERB[i.decision]} ${r.id} (${formatCents(r.amountCents)})${paid}`,
        reverseArgs: { expense_id: r.id },
        events: [{ type: "expense.decided", subjectRef: r.id, payload: { expense_id: r.id, status: after.status } }],
        moneyCents: i.decision === "approve" || i.decision === "approve_taxable" ? r.amountCents : 0,
      };
    },
  }),
  autoEligible: W3_CEILINGS.expenseAuto,
};

// ---------------------------------------------------------------- human-only: reopen

const ReopenInput = z.object({ expense_id: ExpenseId });
type ReopenInput = z.infer<typeof ReopenInput>;
const reopenCmd = writeCommand({
  name: "expenses.reopen", summary: "Reopen a decided expense until it is paid.",
  description: "Puts a decided expense back to needs review: clears the decision, takes it off its draft (recomputed) and reruns the checks. Refused once paid or once its run left draft. People only.",
  input: ReopenInput, domain: "payroll", needs: "edit", effect: "write", risk: () => "R2", approval: "never", reversible: false, preview: null, access: "human_only",
  lease: (i) => `expenses:${i.expense_id}`,
  async run(i: ReopenInput, ctx, deps) {
    const r = await getExpenseRow(deps.tx, ctx.companyId, i.expense_id);
    if (!r) throw notFound("expense", i.expense_id);
    const why = await reopenBlocker(deps.tx, r);
    if (why) throw new DomainRefusal("DOMAIN_NOT_REVERSIBLE", why, null, null);
    const out = await reopenExpense(deps.tx, { newId: deps.newId, now: ctx.now }, r);
    return {
      data: { expense_id: r.id, before: out.before, status: "needs_review", detached_from: out.detachedFrom },
      summary: `Reopened ${r.id} (was ${out.before}${out.detachedFrom ? `, off ${out.detachedFrom}` : ""})`,
      events: [{ type: "expense.decided", subjectRef: r.id, payload: { expense_id: r.id, status: "needs_review" } }],
    };
  },
});

// ---------------------------------------------------------------- human-only: submit and resubmit (the employee's own claim)

const GRANT_RANK = { none: 0, view: 1, edit: 2, approve: 3 } as const;
/** A receipt the route stored on the I-9 upload path (uploads/<sha256>.bin); the command writes the uploads row. */
const ReceiptFile = z.object({
  file_name: z.string().min(1).max(120), bytes: z.number().int().min(1).max(5 * 1024 * 1024), sha256: z.string().regex(/^[0-9a-f]{64}$/),
  storage_path: z.string().regex(/^uploads\/[0-9a-f]{64}\.bin$/),
}).refine((f) => f.storage_path === `uploads/${f.sha256}.bin`, { message: "storage_path must be uploads/<sha256>.bin" });
const ClaimFields = {
  category: ExpenseCategory, merchant: z.string().min(1).max(120), amount_cents: z.number().int().min(1).max(10_000_000),
  transaction_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), business_purpose: z.string().min(1).max(400), attendees: z.string().max(400).optional(),
  miles_x10: z.number().int().min(1).max(100_000).optional(), trip_ref: z.string().max(40).optional(), pre_approval_ref: z.string().max(40).optional(),
  receipt: ReceiptFile.optional(),
};
const SubmitInput = z.object({ worker_id: z.string().startsWith("wrk_"), ...ClaimFields });
type SubmitInput = z.infer<typeof SubmitInput>;
const ResubmitInput = z.object({ expense_id: ExpenseId, ...ClaimFields });
type ResubmitInput = z.infer<typeof ResubmitInput>;
type Claim = Omit<SubmitInput, "worker_id">;

/**
 * Self-service rule: a person files claims for their own worker record (the new hire persona from the portal, or any
 * employee whose principal names that worker); filing for someone else needs payroll edit (an admin keying a claim in).
 */
async function requireFiler(tx: DbTx, ctx: ExecContext, workerId: string): Promise<void> {
  const [p] = await tx.select({ workerId: principals.workerId, grantsJson: principals.grantsJson }).from(principals).where(eq(principals.id, ctx.principal.id));
  if (p?.workerId === workerId) return;
  let payroll: keyof typeof GRANT_RANK = "none";
  try { payroll = ((JSON.parse(p?.grantsJson ?? "{}") as Record<string, string>).payroll ?? "none") as keyof typeof GRANT_RANK; } catch { /* no grants */ }
  if ((GRANT_RANK[payroll] ?? 0) >= GRANT_RANK.edit) return;
  throw new DomainRefusal("DOMAIN_NOT_OWN_EXPENSE", "You can file expense claims only for yourself", "Submit from your own portal; payroll admins can key a claim in for an employee", null);
}

async function claimChecks(i: Claim): Promise<void> {
  if (i.category === "mileage" && !i.miles_x10) throw new DomainRefusal("DOMAIN_MILES_REQUIRED", "Mileage claims need miles_x10", "Send the miles times ten, for example 84.0 miles as 840", { miles_x10: 840 });
}

async function storeReceipt(tx: DbTx, ctx: ExecContext, deps: CommandDeps, workerId: string, f: NonNullable<Claim["receipt"]>): Promise<string> {
  const id = await deps.newId("upl_");
  await tx.insert(uploads).values({ id, workerId, purpose: "receipt", fileName: f.file_name, storagePath: f.storage_path, bytes: f.bytes, sha256: f.sha256, createdAt: ctx.now });
  return id;
}

const claimColumns = (i: Claim) => ({
  category: i.category, merchant: i.merchant, amountCents: i.amount_cents, transactionDate: i.transaction_date, businessPurpose: i.business_purpose,
  attendees: i.attendees?.trim() || null, milesX10: i.category === "mileage" ? i.miles_x10 ?? null : null, tripRef: i.trip_ref?.trim() || null, preApprovalRef: i.pre_approval_ref?.trim() || null,
});

const submitCmd = writeCommand({
  name: "expenses.submit", summary: "Submit an expense claim (the employee's own submission).",
  description: "Records an expense claim with an optional receipt, runs the policy engine and puts it in needs review. People only: the employee for their own record (the portal), or a payroll admin keying one in; agents never submit claims.",
  input: SubmitInput, domain: "people", needs: "view", effect: "write", risk: () => "R2", approval: "never", reversible: false, preview: null, access: "human_only",
  untrustedFields: [],
  async run(i: SubmitInput, ctx, deps) {
    const w = (await deps.tx.select().from(workers).where(eq(workers.id, i.worker_id)))[0];
    if (!w || w.companyId !== ctx.companyId) throw notFound("worker", i.worker_id);
    await requireFiler(deps.tx, ctx, w.id);
    await claimChecks(i);
    const id = await deps.newId("exp_");
    const receiptUploadId = i.receipt ? await storeReceipt(deps.tx, ctx, deps, w.id, i.receipt) : null;
    await deps.tx.insert(expenses).values({
      id, companyId: ctx.companyId, workerId: w.id, ...claimColumns(i), currency: "USD", submittedAt: ctx.now,
      receiptUploadId, receiptExtractJson: null, status: "submitted", checksJson: "[]",
    });
    const res = await writeChecks(deps.tx, (await getExpenseRow(deps.tx, ctx.companyId, id))!);
    return {
      data: { expense_id: id, status: "needs_review", has_receipt: receiptUploadId !== null, checks: res.checks.map((c) => ({ rule: c.rule, severity: c.severity, message: c.message })) },
      summary: `Submitted ${id}: ${usd(i.amount_cents)} ${i.category}`,
      events: [{ type: "expense.submitted", subjectRef: id, payload: { expense_id: id, worker_id: w.id } }],
    };
  },
});

const resubmitCmd = writeCommand({
  name: "expenses.resubmit", summary: "Resubmit a returned expense with the fixes the approver asked for.",
  description: "Replaces the claim fields of a returned expense (and its receipt when a new one is attached), clears the return note, reruns the policy engine and puts it back in needs review. Only returned items; the employee for their own record or a payroll admin.",
  input: ResubmitInput, domain: "people", needs: "view", effect: "write", risk: () => "R2", approval: "never", reversible: false, preview: null, access: "human_only",
  // No lease: only a returned item can be resubmitted, and returned is not decidable, so the approver's decision lease
  // (held for 10 minutes after Return) must not keep the employee waiting. The status check runs inside the transaction.
  untrustedFields: [],
  async run(i: ResubmitInput, ctx, deps) {
    const r = await getExpenseRow(deps.tx, ctx.companyId, i.expense_id);
    if (!r) throw notFound("expense", i.expense_id);
    await requireFiler(deps.tx, ctx, r.workerId);
    if (r.status !== "returned") throw new DomainRefusal("DOMAIN_NOT_RETURNED", `Expense ${r.id} is ${r.status}; only a returned item can be resubmitted`, "Submit a new claim instead", null);
    await claimChecks(i);
    const receiptUploadId = i.receipt ? await storeReceipt(deps.tx, ctx, deps, r.workerId, i.receipt) : r.receiptUploadId;
    await deps.tx.update(expenses).set({
      ...claimColumns(i), submittedAt: ctx.now, receiptUploadId, receiptExtractJson: i.receipt ? null : r.receiptExtractJson, status: "submitted",
      decidedBy: null, decidedAt: null, approverPrincipalId: null, decisionReasonCode: null, decisionNote: null, explanation: null, explanationSource: null, explanationRunId: null,
    }).where(eq(expenses.id, r.id));
    const res = await writeChecks(deps.tx, (await getExpenseRow(deps.tx, ctx.companyId, r.id))!);
    return {
      data: { expense_id: r.id, before: "returned", status: "needs_review", has_receipt: receiptUploadId !== null, checks: res.checks.map((c) => ({ rule: c.rule, severity: c.severity, message: c.message })) },
      summary: `Resubmitted ${r.id}: ${usd(i.amount_cents)} ${i.category}`,
      events: [{ type: "expense.submitted", subjectRef: r.id, payload: { expense_id: r.id, worker_id: r.workerId } }],
    };
  },
});

// ---------------------------------------------------------------- system records (svc_events)

const RunInput = z.object({ payroll_run_id: z.string().startsWith("pay_") });
type RunInput = z.infer<typeof RunInput>;
const scheduleCmd = writeCommand({
  name: "expenses.schedule", summary: "Attach approved expenses waiting for a draft to a new draft (system record).",
  description: "System record on payroll.draft_created: attaches approved expenses that were waiting for a draft to that draft and recomputes it.",
  input: RunInput, domain: "payroll", needs: "edit", effect: "write", risk: () => "R1", approval: "never", reversible: false, preview: null, access: "system_only",
  async run(i: RunInput, ctx, deps) {
    const ids = await scheduleForRun(deps.tx, { newId: deps.newId, now: ctx.now }, i.payroll_run_id);
    return { data: { payroll_run_id: i.payroll_run_id, scheduled: ids }, summary: `Scheduled ${ids.length} approved expenses on ${i.payroll_run_id}` };
  },
});
const markPaidCmd = writeCommand({
  name: "expenses.mark_paid", summary: "Mark a processed run's reimbursements paid (system record).",
  description: "System record on payroll.processed: expenses on that run whose paycheck was processed become paid; items on an excluded paycheck go back to approved for the next draft.",
  input: RunInput, domain: "payroll", needs: "edit", effect: "write", risk: () => "R1", approval: "never", reversible: false, preview: null, access: "system_only",
  async run(i: RunInput, ctx, deps) {
    const out = await markPaidForRun(deps.tx, i.payroll_run_id);
    // A released item rides the earliest open draft now, even when that draft was created before this run processed
    // (expenses.schedule only fires on payroll.draft_created).
    const reattached: string[] = [];
    for (const id of out.released) {
      const row = await getExpenseRow(deps.tx, ctx.companyId, id);
      if (row && await attachToDraft(deps.tx, { newId: deps.newId, now: ctx.now }, row)) reattached.push(id);
    }
    return {
      data: { payroll_run_id: i.payroll_run_id, paid: out.paid, released: out.released, reattached },
      summary: `Marked ${out.paid.length} expenses paid in ${i.payroll_run_id}${out.released.length ? `; ${out.released.length} back to approved` : ""}${reattached.length ? `, ${reattached.length} moved to the next open draft` : ""}`,
      events: out.paid.map((id) => ({ type: "expense.paid", subjectRef: id, payload: { expense_id: id, payroll_run_id: i.payroll_run_id } })),
    };
  },
});

export const expensesCommands: WeftCommand[] = [listCmd, getCmd, checkPolicyCmd, explainCmd, decideCmd, reopenCmd, submitCmd, resubmitCmd, scheduleCmd, markPaidCmd];
