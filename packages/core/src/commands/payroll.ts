// payroll.* commands. Owner: t1-payroll. Append WeftCommand definitions to this array; commands/index.ts concatenates it.
// Refusals are thrown as `Refused(code, message)` (contracts/errors.ts); the executor maps them to ToolOutcome refusals
// with this registry entry's errorHints. Money in results is *_cents plus *_display.
import { and, eq, max } from "drizzle-orm";
import { z } from "zod";
import { formatCents, NotFound, Refused, type ExecContext, type Flag, type Preview } from "@weft/contracts";
import { actions, paychecks, proposals, type DbTx } from "@weft/db";
import type { CommandDeps, WeftCommand } from "../shared/deps";
import {
  concisePayrollRun, createDraft, getRun, groundExplanation, listRuns, markFailed, markProcessed, MAX_EXPLANATION_CHARS, PayrollRefusal, previewRun,
  readAttempts, runSubjectHash, submitRun, templateExplanation, totalsFromDto, workerNames, writeAttempts, writeRunSummary, type TotalsCents,
} from "../payroll/index";

export const BANK_CREDENTIAL_REF = "vault:sim-bank-operating" as const;
export const PAYROLL_RUN_CEILING = "agent.payroll_run_cents";

const RunId = z.string().startsWith("pay_");
const ResponseFormat = z.enum(["concise", "detailed"]).optional();

const BLOCKED_HINT = {
  hint: "Some paychecks are blocked (for example no active bank account). Submit again with exclude_blocked true to pay everyone else; excluded workers stay listed on the run for follow-up.",
  example: { run_id: "pay_2026_10_30", exclude_blocked: true },
};
const RUN_HINT = { hint: "Use a run id from payroll.list_runs, such as the open draft.", example: { run_id: "pay_2026_10_30" } };

/** Maps lifecycle refusals to the executor's Refused error. */
async function domain<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) {
    if (e instanceof PayrollRefusal) throw new Refused(e.code, e.message, e.details);
    throw e;
  }
}

const totalsOut = (t: TotalsCents | null) => (t ? Object.fromEntries(Object.entries(t).map(([k, v]) => [k, { cents: v, display: formatCents(v) }])) : null);

async function blockedWorkers(tx: DbTx, runId: string): Promise<string[]> {
  return (await tx.select({ w: paychecks.workerId }).from(paychecks).where(and(eq(paychecks.payrollRunId, runId), eq(paychecks.status, "blocked")))).map((r) => r.w).sort();
}

const base = {
  namespace: "payroll" as const, domain: "payroll" as const, compactDescription: "", autoAllow: "never" as const, amountCents: null, ceilingKey: null,
  reversible: false as const, lease: null, sandbox: "hidden" as const, access: "all" as const, untrustedFields: [] as string[], afterPending: "run" as const,
  errorHints: {}, preview: null,
};

// ---------------------------------------------------------------- reads

const ListRunsInput = z.object({ status: z.enum(["draft", "processing", "processed", "failed"]).optional(), limit: z.number().int().optional(), response_format: ResponseFormat });
type ListRunsInput = z.infer<typeof ListRunsInput>;
export const listRunsCommand: WeftCommand<ListRunsInput> = {
  ...base, name: "payroll.list_runs", summary: "List pay runs",
  description: "Lists pay runs (newest last) with status, period, payday, paycheck counts, review counts and total cost. Call it to find a run id. Example: {\"status\": \"draft\"}.",
  compactDescription: "List pay runs with status, period, counts and total cost.",
  input: ListRunsInput, needs: "view", effect: "read", risk: () => "R0", approval: "never",
  tiers: { main: "executable", task: "executable" }, mcp: "read", sandbox: "read",
  async run(i, ctx, deps) {
    const { rows, counts } = await listRuns(deps.tx, ctx.companyId, { limit: Math.min(Math.max(i.limit ?? 25, 1), 100), status: i.status ?? null });
    const data = rows.map((r) => {
      const t = totalsFromDto(r.totalsJson);
      const s = r.anomalySummaryJson ? (JSON.parse(r.anomalySummaryJson) as { needsReview: number; ready: number }) : null;
      return { run_id: r.id, status: r.status, period: `${r.periodStart} to ${r.periodEnd}`, payday: r.payday, approval_deadline: r.approvalDeadline, paychecks: counts.get(r.id) ?? 0, needs_review: s?.needsReview ?? 0, ready: s?.ready ?? 0, total_cost_cents: t?.totalCost ?? 0, total_cost_display: formatCents(t?.totalCost ?? 0) };
    });
    return { data: { runs: data }, summary: `${data.length} pay runs` };
  },
};

const GetRunInput = z.object({ run_id: RunId, response_format: ResponseFormat, flagged_only: z.boolean().optional(), worker_id: z.string().startsWith("wrk_").optional(), state: z.string().length(2).optional() });
type GetRunInput = z.infer<typeof GetRunInput>;
export const getRunCommand: WeftCommand<GetRunInput> = {
  ...base, name: "payroll.get_run", summary: "Read one pay run",
  description: "Reads a pay run: totals, counts by section and every flagged paycheck with its flag evidence (before and after cents; for GROSS_CHANGE the pay rate id, action seq and result id). Filters: flagged_only, worker_id, state. Example: {\"run_id\": \"pay_2026_10_30\"}.",
  compactDescription: "Read a pay run: totals, counts and flagged paychecks with evidence.",
  input: GetRunInput, needs: "view", effect: "read", risk: () => "R0", approval: "never",
  tiers: { main: "executable", task: "executable" }, mcp: "read", sandbox: "read", errorHints: { UNKNOWN_REFERENCE: RUN_HINT },
  async run(i, _ctx, deps) {
    const run = await getRun(deps.tx, i.run_id);
    const data = await concisePayrollRun(deps.tx, run, { flaggedOnly: i.flagged_only, workerId: i.worker_id, state: i.state, detailed: i.response_format === "detailed" });
    return { data, summary: `${run.id} ${run.status}: ${data.counts.needs_review} need review, ${data.counts.ready} ready` };
  },
};

// ---------------------------------------------------------------- drafts

const PreviewRunInput = z.object({ run_id: RunId });
type PreviewRunInput = z.infer<typeof PreviewRunInput>;
export const previewRunCommand: WeftCommand<PreviewRunInput> = {
  ...base, name: "payroll.preview_run", summary: "Recompute a draft pay run",
  description: "Recomputes a draft from current HR, benefits and tax data (for example after a rate change) and reports which paychecks changed. Drafts only. Example: {\"run_id\": \"pay_2026_10_30\"}.",
  compactDescription: "Recompute a draft pay run and report changed paychecks.",
  input: PreviewRunInput, needs: "edit", effect: "draft", risk: () => "R1", approval: "never", afterPending: "skip",
  tiers: { main: "executable", task: "executable" }, mcp: "read", errorHints: { UNKNOWN_REFERENCE: RUN_HINT },
  async run(i, ctx, deps) {
    const before = new Map((await deps.tx.select().from(paychecks).where(eq(paychecks.payrollRunId, i.run_id))).map((p) => [p.workerId, p]));
    const run = await domain(() => previewRun(deps.tx, { newId: deps.newId, now: ctx.now }, i.run_id));
    const after = await deps.tx.select().from(paychecks).where(eq(paychecks.payrollRunId, i.run_id));
    const employer = (json: string) => (JSON.parse(json) as { payer: string; amount_cents: number }[]).filter((x) => x.payer === "employer").reduce((s, x) => s + x.amount_cents, 0);
    // A paycheck changed when any amount changed (a rate on a line whose taxable wages are 0 is not a change).
    const amounts = (json: string) => (JSON.parse(json) as { code: string; jurisdiction: string; payer: string; amount_cents: number }[]).map((x) => `${x.jurisdiction}:${x.code}:${x.payer}:${x.amount_cents}`).sort().join("|");
    const changes = after.filter((p) => { const b = before.get(p.workerId); return !b || b.netCents !== p.netCents || b.grossCents !== p.grossCents || amounts(b.taxesJson) !== amounts(p.taxesJson); })
      .sort((a, b) => (a.workerId < b.workerId ? -1 : 1))
      .map((p) => { const b = before.get(p.workerId); const eb = b ? employer(b.taxesJson) : 0; const ea = employer(p.taxesJson); return { paycheck_id: p.id, worker_id: p.workerId, net_before_cents: b?.netCents ?? null, net_after_cents: p.netCents, employer_taxes_before_cents: b ? eb : null, employer_taxes_after_cents: ea, employer_taxes_before_display: b ? formatCents(eb) : null, employer_taxes_after_display: formatCents(ea) }; });
    const t = totalsFromDto(run.totalsJson);
    return { data: { run_id: run.id, status: run.status, changed: changes.length, unchanged: after.length - changes.length, changes, totals: totalsOut(t) }, summary: `Recomputed ${run.id}: ${changes.length} paychecks changed` };
  },
};

const CreateDraftInput = z.object({ pay_schedule_id: z.string().startsWith("ps_"), period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
type CreateDraftInput = z.infer<typeof CreateDraftInput>;
export const createDraftCommand: WeftCommand<CreateDraftInput> = {
  ...base, name: "payroll.create_draft", summary: "Create a draft pay run",
  description: "Creates the draft for a semi-monthly period ending on the 15th or the month end, even while another draft is open; it is compared with the last processed run. Example: {\"pay_schedule_id\": \"ps_us_semimonthly\", \"period_end\": \"2026-11-15\"}.",
  compactDescription: "Create a draft pay run for a period end.",
  input: CreateDraftInput, needs: "edit", effect: "draft", risk: () => "R1", approval: "never",
  tiers: { main: "executable", task: "unavailable" }, mcp: "read",
  errorHints: { DOMAIN_UNSUPPORTED_SCHEDULE: { hint: "Use the US semi-monthly schedule.", example: { pay_schedule_id: "ps_us_semimonthly", period_end: "2026-11-15" } } },
  async run(i, ctx, deps) {
    const run = await domain(async () => {
      try { return await createDraft(deps.tx, { newId: deps.newId, now: ctx.now }, { companyId: ctx.companyId, payScheduleId: i.pay_schedule_id, periodEnd: i.period_end }); } catch (e) {
        if (e instanceof Error && /not a semi-monthly period end/.test(e.message)) throw new Refused("INVALID_INPUT", e.message);
        if (e instanceof Error && e.name === "Conflict") throw new Refused("DOMAIN_DRAFT_EXISTS", e.message);
        throw e;
      }
    });
    const s = JSON.parse(run.anomalySummaryJson ?? "{}") as { needsReview?: number; ready?: number };
    const n = (await deps.tx.select({ id: paychecks.id }).from(paychecks).where(eq(paychecks.payrollRunId, run.id))).length;
    return {
      data: { run_id: run.id, status: run.status, period: `${run.periodStart} to ${run.periodEnd}`, payday: run.payday, previous_run_id: run.previousRunId, paychecks: n, needs_review: s.needsReview ?? 0, ready: s.ready ?? 0 },
      summary: `Created draft ${run.id} (${run.periodStart} to ${run.periodEnd}) with ${n} paychecks`,
      events: [{ type: "payroll.draft_created", subjectRef: run.id, payload: { payroll_run_id: run.id } }],
    };
  },
};

// ---------------------------------------------------------------- explanations

const ExplainInput = z.object({
  run_id: RunId,
  items: z.array(z.object({ paycheck_id: z.string().startsWith("pyc_"), explanation: z.string().max(MAX_EXPLANATION_CHARS).optional() })).min(1).max(60),
});
type ExplainInput = z.infer<typeof ExplainInput>;
export const explainFlagsCommand: WeftCommand<ExplainInput> = {
  ...base, name: "payroll.explain_flags", summary: "Save explanations for flagged paychecks",
  description: "Saves one plain explanation per flagged paycheck in one call. Each is checked against that paycheck's flag evidence: numbers must come from it. Ungrounded items are refused per item (UNGROUNDED); after one repair the template is saved (source template). Omit explanation to save the template. Example: {\"run_id\": \"pay_2026_10_30\", \"items\": [{\"paycheck_id\": \"pyc_0150\", \"explanation\": \"...\"}]}.",
  compactDescription: "Save grounded explanations for flagged paychecks (batch).",
  input: ExplainInput, needs: "edit", effect: "draft", risk: () => "R1", approval: "never",
  tiers: { main: "executable", task: "executable" }, mcp: "hidden",
  errorHints: { UNGROUNDED: { hint: "Use only numbers from that paycheck's flag evidence (cents as dollars, percents, dates, hours).", example: { run_id: "pay_2026_10_30", items: [{ paycheck_id: "pyc_0150", explanation: "Gross pay changed 18.0% from $5,000.00 to $5,900.00 after the raise took effect 2026-10-16." }] } } },
  async run(i, ctx, deps) {
    const run = await getRun(deps.tx, i.run_id);
    const rows = await deps.tx.select().from(paychecks).where(eq(paychecks.payrollRunId, run.id));
    const byId = new Map(rows.map((p) => [p.id, p]));
    const attempts = await readAttempts(deps.tx, run.id);
    const results: { paycheck_id: string; status: "saved" | "refused"; source: "agent" | "template" | null; code: string | null; offending: string[]; explanation: string | null }[] = [];
    for (const item of i.items) {
      const p = byId.get(item.paycheck_id);
      if (!p) { results.push({ paycheck_id: item.paycheck_id, status: "refused", source: null, code: "UNKNOWN_REFERENCE", offending: [], explanation: null }); continue; }
      const flags = JSON.parse(p.flagsJson) as Flag[];
      if (!flags.length) { results.push({ paycheck_id: p.id, status: "refused", source: null, code: "DOMAIN_NOT_FLAGGED", offending: [], explanation: null }); continue; }
      const save = async (text: string, source: "agent" | "template") => {
        await deps.tx.update(paychecks).set({ explanation: text, explanationSource: source, explanationRunId: ctx.run?.id ?? null }).where(eq(paychecks.id, p.id));
      };
      const text = item.explanation?.trim() ?? "";
      if (!text) {
        const t = templateExplanation(flags);
        await save(t, "template");
        results.push({ paycheck_id: p.id, status: "saved", source: "template", code: null, offending: [], explanation: t });
        continue;
      }
      const g = groundExplanation(text, flags, { gross_cents: p.grossCents, net_cents: p.netCents, hours_x100: p.hoursX100 });
      if (g.ok) {
        await save(text, "agent");
        delete attempts[p.id];
        results.push({ paycheck_id: p.id, status: "saved", source: "agent", code: null, offending: [], explanation: text });
      } else if ((attempts[p.id] ?? 0) >= 1) {
        const t = templateExplanation(flags);
        await save(t, "template");
        delete attempts[p.id];
        // The agent's text is refused again (code UNGROUNDED), and the row is saved with the labeled template instead.
        results.push({ paycheck_id: p.id, status: "saved", source: "template", code: "UNGROUNDED", offending: g.offending, explanation: t });
      } else {
        attempts[p.id] = (attempts[p.id] ?? 0) + 1;
        results.push({ paycheck_id: p.id, status: "refused", source: null, code: "UNGROUNDED", offending: g.offending, explanation: null });
      }
    }
    await writeAttempts(deps.tx, run.id, attempts);
    const saved = results.filter((r) => r.source !== null);
    const remaining = rows.filter((p) => p.reviewGroup === "needs_review" && p.status !== "excluded").length
      - (await deps.tx.select({ id: paychecks.id, e: paychecks.explanation, g: paychecks.reviewGroup, s: paychecks.status }).from(paychecks).where(eq(paychecks.payrollRunId, run.id))).filter((r) => r.g === "needs_review" && r.s !== "excluded" && r.e !== null).length;
    return {
      data: { run_id: run.id, items: results, saved: saved.length, refused: results.filter((r) => r.status === "refused").length, unexplained_flagged: remaining },
      summary: `Explanations for ${run.id}: ${saved.filter((r) => r.source === "agent").length} agent, ${saved.filter((r) => r.source === "template").length} template, ${results.filter((r) => r.source === null).length} refused`,
    };
  },
};

// ---------------------------------------------------------------- submit

const SubmitInput = z.object({ run_id: RunId, exclude_blocked: z.boolean().optional() });
type SubmitInput = z.infer<typeof SubmitInput>;

async function submitAmount(i: SubmitInput, deps: CommandDeps): Promise<{ hash: string; totals: TotalsCents; included: number; excluded: string[] }> {
  const run = await getRun(deps.tx, i.run_id);
  if (run.status !== "draft") throw new Refused("DOMAIN_NOT_DRAFT", `Payroll run ${run.id} is ${run.status}, not draft`);
  const blocked = await blockedWorkers(deps.tx, run.id);
  if (blocked.length && !i.exclude_blocked) throw new Refused("BLOCKED_LINES", `${blocked.length} paycheck(s) are blocked: ${blocked.join(", ")}`, { runId: run.id, blockedWorkerIds: blocked });
  const { hash, material } = await runSubjectHash(deps.tx, run.id, i.exclude_blocked ?? false);
  return { hash, totals: material.totals, included: material.paychecks.length, excluded: i.exclude_blocked ? blocked : [] };
}

export const submitRunCommand: WeftCommand<SubmitInput> = {
  ...base, name: "payroll.submit_run", summary: "Submit a pay run for payment",
  description: "Submits a draft for payment: one bank batch of net pay plus reimbursements, settling payday 06:00 PT. Always needs a human approval. Blocked paychecks refuse the call unless exclude_blocked is true. Example: {\"run_id\": \"pay_2026_10_30\", \"exclude_blocked\": true}.",
  compactDescription: "Submit a draft pay run for payment (needs approval).",
  input: SubmitInput, needs: "edit", effect: "external", risk: () => "R4", approval: "always",
  amountCents: async (i, _ctx, deps) => (await submitAmount(i, deps)).totals.totalCost,
  ceilingKey: PAYROLL_RUN_CEILING, lease: (i) => `payroll:${i.run_id}`,
  tiers: { main: "executable", task: "unavailable" }, mcp: "propose",
  errorHints: { BLOCKED_LINES: BLOCKED_HINT, UNKNOWN_REFERENCE: RUN_HINT, STALE_SUBJECT: { hint: "The run changed after the proposal (for example a direct-deposit change). Preview the run again and propose a new submission.", example: { run_id: "pay_2026_10_30", exclude_blocked: true } } },
  async preview(i, _ctx, deps): Promise<Preview> {
    const run = await getRun(deps.tx, i.run_id);
    const s = await submitAmount(i, deps);
    const names = await workerNames(deps.tx, s.excluded);
    return {
      title: `Submit payroll ${run.id} (${run.periodStart} to ${run.periodEnd}, payday ${run.payday}): ${s.included} paychecks, total cost ${formatCents(s.totals.totalCost)}`,
      diff: [
        { label: "Status", before: "draft", after: "processing" },
        { label: "Net pay to bank", before: "$0.00", after: formatCents(s.totals.netPay + s.totals.reimbursements) },
        { label: "Excluded (blocked)", before: "none", after: s.excluded.length ? s.excluded.map((w) => `${names.get(w)?.name ?? w} (${w})`).join(", ") : "none" },
      ],
      content: [], moneyCents: s.totals.totalCost, subjectRef: run.id, subjectHash: s.hash,
      evidence: [{ label: "Pay run", ref: run.id }, ...s.excluded.map((w) => ({ label: "Excluded worker", ref: w }))],
    };
  },
  async run(i, ctx, deps) {
    const approvedBy = ctx.approvedProposalId
      ? ((await deps.tx.select({ by: proposals.decidedBy }).from(proposals).where(eq(proposals.id, ctx.approvedProposalId)))[0]?.by ?? ctx.principal.id)
      : ctx.principal.id;
    const head = (await deps.tx.select({ m: max(actions.seq) }).from(actions))[0]?.m ?? 0;
    const credential = await deps.resolveCredential(BANK_CREDENTIAL_REF);
    const res = await domain(() => submitRun(deps.tx, { newId: deps.newId, now: ctx.now }, {
      runId: i.run_id, excludeBlocked: i.exclude_blocked ?? false, approvedBy, actionSeq: head + 1, bank: deps.sims.bank, credential,
    }));
    return {
      data: { run_id: res.runId, status: "processing", batch_id: res.batchId, settle_at: res.settleAt, included: res.includedCount, excluded_worker_ids: res.excludedWorkerIds, bank_total_cents: res.bankTotalCents, bank_total_display: formatCents(res.bankTotalCents), totals: totalsOut(res.totals) },
      summary: `Submitted ${res.runId}: ${res.includedCount} paychecks, ${formatCents(res.bankTotalCents)} to the bank, settles ${res.settleAt}${res.excludedWorkerIds.length ? `; excluded ${res.excludedWorkerIds.join(", ")}` : ""}`,
      moneyCents: res.moneyCents,
      events: [{ type: "payroll.submitted", subjectRef: res.runId, payload: { payroll_run_id: res.runId } }],
    };
  },
};

// ---------------------------------------------------------------- system records

const system = { tiers: { main: "unavailable" as const, task: "unavailable" as const }, mcp: "hidden" as const, access: "system_only" as const, risk: () => "R1" as const, approval: "never" as const, needs: "edit" as const, effect: "write" as const };

const MarkProcessedInput = z.object({ run_id: RunId, batch_id: z.string().optional() });
type MarkProcessedInput = z.infer<typeof MarkProcessedInput>;
export const markProcessedCommand: WeftCommand<MarkProcessedInput> = {
  ...base, ...system, name: "payroll.mark_processed", summary: "Record a settled bank batch",
  description: "System record of a settled bank batch: marks the run processed and writes the YTD ledger. Run by svc_events from sim.bank_batch_settled.",
  compactDescription: "System: record a settled bank batch.", input: MarkProcessedInput,
  async run(i, ctx, deps) {
    const res = await domain(() => markProcessed(deps.tx, { now: ctx.now }, { runId: i.run_id, batchId: i.batch_id }));
    return {
      data: { run_id: res.runId, status: "processed", paychecks: res.paychecks, ytd_rows: res.ytdRows }, summary: `Processed ${res.runId}: ${res.paychecks} paychecks settled`,
      events: res.paychecks ? [{ type: "payroll.processed", subjectRef: res.runId, payload: { payroll_run_id: res.runId } }] : [],
    };
  },
};

const MarkFailedInput = z.object({ run_id: RunId, batch_id: z.string().optional(), worker_id: z.string().startsWith("wrk_") });
type MarkFailedInput = z.infer<typeof MarkFailedInput>;
export const markFailedCommand: WeftCommand<MarkFailedInput> = {
  ...base, ...system, name: "payroll.mark_failed", summary: "Record a returned bank batch",
  description: "System record of a returned bank batch: the simulator returned an entry and settled nothing, so the run and its in-flight paychecks become failed and no YTD rows are written. Run by svc_events from sim.bank_batch_returned.",
  compactDescription: "System: record a returned bank batch.", input: MarkFailedInput,
  async run(i, ctx, deps) {
    const res = await domain(() => markFailed(deps.tx, { now: ctx.now }, { runId: i.run_id, batchId: i.batch_id, workerId: i.worker_id }));
    return {
      data: { run_id: res.runId, status: "failed", returned_paycheck_id: res.returnedPaycheckId, worker_id: i.worker_id, failed: res.failed },
      summary: `Bank returned the batch for ${res.runId} (entry for ${i.worker_id}); ${res.failed} paychecks failed, none paid`,
    };
  },
};

export const payrollCommands: WeftCommand[] = [
  listRunsCommand, getRunCommand, previewRunCommand, createDraftCommand, explainFlagsCommand, submitRunCommand, markProcessedCommand, markFailedCommand,
];

/** For tests and the precheck: the deps-free view of a run's submit amount. */
export async function submitPreviewFor(deps: CommandDeps, runId: string, excludeBlocked: boolean) { return submitAmount({ run_id: runId, exclude_blocked: excludeBlocked }, deps); }
export type { ExecContext };
