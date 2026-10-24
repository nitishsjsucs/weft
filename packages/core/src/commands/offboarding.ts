// offboarding.* commands (wave 2, docs/wave2.md). Owner: w2-offboarding.
// terminate opens the case. final_pay, suspend_directory, deactivate_sso and lock_device are the proposal steps
// (approval always, a preview each); run_step finishes the direct steps once final pay is done. Each call finishes one
// step, so each step has its own action row and offboarding.step_done event.
import { eq } from "drizzle-orm";
import { z } from "zod";
import { formatCents, Refused, TerminationKind, type OffboardingStepKind } from "@weft/contracts";
import { proposals, workers } from "@weft/db";
import type { CommandDeps, WeftCommand } from "../shared/deps";
import { canonicalJson } from "../shared/canonical-json";
import { sha256Hex } from "../shared/hash";
import { DomainRefusal, nextActionSeq, notFound, readCommand, writeCommand } from "../demo/define";
import { nameRef } from "../people/names";
import { getWorker } from "../people/queries";
import { PayrollRefusal, refreshOpenDrafts, submitRun } from "../payroll/lifecycle";
import { createSpecialRun, periodEndContaining, specialSettleAt } from "../payroll/offcycle";
import { semimonthlyPeriod } from "../payroll/calendar";
import { BANK_CREDENTIAL_REF, PAYROLL_RUN_CEILING, proposeOffCycleCommand } from "./payroll";
import {
  accountLabel, AFTER_FINAL_PAY, caseDto, finishStep, insertCase, listCaseRows, openCaseFor, openStep, requireCase, requireFinalPayDone, STEP_LABEL,
  type CaseRow, type StepRow,
} from "../offboarding/cases";
import {
  accountsHash, accountsOf, clearAllGroups, cobraNotice, COBRA_FROM, endOfMonth, finalPayDiff, finalPayPlan,
  lockableDevices, lockDevices, suspendAccounts, terminateEnrollments,
} from "../offboarding/steps";
import { inScope, outsideReports, readScopeOf, reportsAccess, splitByScope } from "../people/scope";

const CaseId = z.string().startsWith("ofb_");
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function stepDone(c: CaseRow, step: StepRow) {
  return { type: "offboarding.step_done", subjectRef: step.id, payload: { case_id: c.id, step_id: step.id } };
}

async function finish(deps: CommandDeps, ctx: { now: string; approvedProposalId: string | null }, c: CaseRow, step: StepRow, detail: string) {
  const seq = await nextActionSeq(deps.tx);
  const { completed } = await finishStep(deps.tx, { step, c, actionSeq: seq, proposalId: ctx.approvedProposalId, detail, now: ctx.now });
  return { completed, seq };
}

// ------------------------------------------------------------------ reads

const ListInput = z.object({ status: z.enum(["open", "complete", "cancelled"]).optional() });
type ListInput = z.infer<typeof ListInput>;
const listCases = readCommand({
  name: "offboarding.list_cases", domain: "people",
  summary: "List offboarding cases and their steps.",
  description: "List offboarding cases (worker, termination kind, last day, status open or complete) with each step in order: final_pay, directory_suspend, sso_deactivate, group_removal, app_removal, device_lock, cobra_notice, benefits_terminate, and its status and proposal id.",
  input: ListInput,
  async run(i: ListInput, ctx, deps) {
    const scope = await readScopeOf(deps.tx, ctx);
    const { shown: rows, withheld } = splitByScope(scope, (await listCaseRows(deps.tx, ctx.companyId)).filter((c) => !i.status || c.status === i.status), (c) => c.workerId);
    const cases = [];
    for (const c of rows.slice(0, 40)) cases.push(await caseDto(deps.tx, c));
    const access = scope && withheld ? { access: reportsAccess(scope, "offboarding cases", withheld) } : {};
    return { data: { total: rows.length, count: cases.length, cases, ...access }, summary: `Listed ${rows.length} offboarding cases${withheld ? `; ${withheld} outside your reports withheld` : ""}` };
  },
});

const GetInput = z.object({ case_id: CaseId });
type GetInput = z.infer<typeof GetInput>;
const getCase = readCommand({
  name: "offboarding.get_case", domain: "people",
  summary: "Read one offboarding case.",
  description: "Read one offboarding case by case_id: the worker, last day, status and the eight ordered steps with status (pending, proposed, done, skipped, failed), proposal id, action seq and detail.",
  input: GetInput,
  async run(i: GetInput, ctx, deps) {
    const c = await requireCase(deps.tx, ctx.companyId, i.case_id);
    const scope = await readScopeOf(deps.tx, ctx);
    if (!inScope(scope, c.workerId)) throw outsideReports(scope!, "offboarding cases");
    const dto = await caseDto(deps.tx, c);
    return { data: dto, summary: `Case ${c.id} is ${c.status}: ${dto.steps.filter((s) => s.status === "done" || s.status === "skipped").length} of ${dto.steps.length} steps finished` };
  },
});

// ------------------------------------------------------------------ terminate

const TerminateInput = z.object({
  worker_id: z.string().startsWith("wrk_"), kind: TerminationKind, last_day: date,
  reason_note: z.string().max(400).optional(), pay_unused_pto: z.boolean().optional(),
});
type TerminateInput = z.infer<typeof TerminateInput>;

async function terminatePlan(i: TerminateInput, companyId: string, deps: CommandDeps) {
  const w = await getWorker(deps.tx, companyId, i.worker_id);
  if (!w) throw notFound("worker", i.worker_id);
  if (w.type !== "employee") throw new DomainRefusal("DOMAIN_NOT_EMPLOYEE", `${w.id} is a ${w.type}; contractors end through their contract`, null, null);
  if (w.status !== "active" && w.status !== "onboarding") throw new DomainRefusal("DOMAIN_NOT_ACTIVE", `${w.id} is ${w.status}; only active or onboarding employees are terminated`, null, null);
  if (i.last_day < w.startDate) throw new DomainRefusal("DOMAIN_LAST_DAY_BEFORE_START", `Last day ${i.last_day} is before the start date ${w.startDate}`, null, null);
  const open = await openCaseFor(deps.tx, w.id);
  if (open) throw new DomainRefusal("DOMAIN_CASE_OPEN", `${w.id} already has open offboarding case ${open.id}`, "Read it with offboarding.get_case", { case_id: open.id });
  return w;
}

export const terminateCommand = writeCommand({
  name: "offboarding.terminate", summary: "Terminate an employee and open an offboarding case.",
  description: "Terminate employee worker_id (kind voluntary, involuntary, layoff or end_of_contract; last_day YYYY-MM-DD). Sets the worker to offboarding with end_date last_day and opens a case with eight ordered steps; final pay, directory suspend, SSO deactivation and device lock follow as proposals. R2, always needs approval.",
  input: TerminateInput, domain: "people", needs: "edit", effect: "write", risk: () => "R2", approval: "always", reversible: false,
  untrustedFields: [], mcp: "hidden", lease: (i) => `offboarding:${i.worker_id}`,
  async preview(i, ctx, deps) {
    const w = await terminatePlan(i, ctx.companyId, deps);
    return {
      title: `Terminate ${nameRef(w.firstName, w.lastName, w.id)} (${i.kind.replaceAll("_", " ")}), last day ${i.last_day}`,
      diff: [{ label: "Status", before: w.status, after: "offboarding" }, { label: "End date", before: w.endDate ?? "none", after: i.last_day }, { label: "Offboarding case", before: "none", after: `8 steps from final pay to benefits termination${i.pay_unused_pto === false ? ", no PTO payout" : ", unused PTO paid"}` }],
      content: i.reason_note ? [{ label: "Reason note", text: i.reason_note }] : [], moneyCents: null, subjectRef: w.id,
      subjectHash: sha256Hex(canonicalJson({ worker: w.id, status: w.status, kind: i.kind, lastDay: i.last_day })), evidence: [{ label: "Worker", ref: w.id }],
    };
  },
  async run(i, ctx, deps) {
    const w = await terminatePlan(i, ctx.companyId, deps);
    // end_date is the last day from now on, so no regular draft pays past it (and the final period's draft prorates).
    await deps.tx.update(workers).set({ status: "offboarding", endDate: i.last_day }).where(eq(workers.id, w.id));
    await refreshOpenDrafts(deps.tx, { newId: deps.newId, now: ctx.now }, ctx.companyId, semimonthlyPeriod(periodEndContaining(i.last_day)).periodStart);
    const { caseId, steps } = await insertCase(deps.tx, { newId: (p) => deps.newId(p), now: ctx.now }, {
      companyId: ctx.companyId, workerId: w.id, kind: i.kind, lastDay: i.last_day, reasonNote: i.reason_note ?? "", payUnusedPto: i.pay_unused_pto ?? true,
    });
    return {
      data: { case_id: caseId, worker_id: w.id, status: "offboarding", last_day: i.last_day, pay_unused_pto: i.pay_unused_pto ?? true, steps: steps.map((s) => ({ id: s.id, kind: s.kind, status: s.status, detail: s.detail })) },
      summary: `Terminated ${nameRef(w.firstName, w.lastName, w.id)}, last day ${i.last_day}; opened offboarding case ${caseId}`,
      events: [{ type: "worker.terminated", subjectRef: w.id, payload: { worker_id: w.id, case_id: caseId } }],
    };
  },
});

// ------------------------------------------------------------------ final pay (proposal)

const FinalPayInput = z.object({ case_id: CaseId, pay_unused_pto: z.boolean().optional() });
type FinalPayInput = z.infer<typeof FinalPayInput>;

async function finalPayFacts(i: FinalPayInput, companyId: string, deps: CommandDeps, now: string) {
  const { c, step, worker } = await openStep(deps.tx, companyId, i.case_id, "final_pay");
  const plan = await finalPayPlan(deps.tx, c, worker, i.pay_unused_pto ?? true, now);
  if (!plan.hasBank) throw new DomainRefusal("DOMAIN_NO_BANK_ACCOUNT", `${worker.id} has no active bank account for final pay`, null, null);
  return { c, step, worker, plan };
}

export const finalPayCommand = writeCommand({
  name: "offboarding.final_pay", summary: "Propose final pay as a dismissal payroll run.",
  description: "Final pay for an offboarding case_id: a dismissal payroll run with the period wages through the last day plus unused PTO (pay_unused_pto, default true), each earning line in the preview. R4: an agent's call always needs approval (a person's direct call runs it); approval submits the run to the bank simulator and marks the step done.",
  input: FinalPayInput, domain: "payroll", needs: "edit", effect: "external", risk: () => "R4", approval: "always", reversible: false,
  amountCents: async (i, ctx, deps) => (await finalPayFacts(i, ctx.companyId, deps, ctx.now)).plan.totalCostCents,
  ceilingKey: PAYROLL_RUN_CEILING, lease: (i) => `offboarding:${i.case_id}:final_pay`, tiers: { main: "executable", task: "unavailable" },
  async preview(i, ctx, deps) {
    const { c, step, worker, plan } = await finalPayFacts(i, ctx.companyId, deps, ctx.now);
    return {
      title: `Final pay for ${nameRef(worker.firstName, worker.lastName, worker.id)}: dismissal run, net ${formatCents(plan.netCents)}, total cost ${formatCents(plan.totalCostCents)}, payday ${plan.payday}`,
      diff: finalPayDiff(plan), content: [], moneyCents: plan.totalCostCents, subjectRef: step.id, subjectHash: plan.hash,
      evidence: [{ label: "Offboarding case", ref: c.id }, { label: "Worker", ref: worker.id }],
    };
  },
  async run(i, ctx, deps) {
    const { c, step, worker, plan } = await finalPayFacts(i, ctx.companyId, deps, ctx.now);
    const approvedBy = ctx.approvedProposalId
      ? ((await deps.tx.select({ by: proposals.decidedBy }).from(proposals).where(eq(proposals.id, ctx.approvedProposalId)))[0]?.by ?? ctx.principal.id)
      : ctx.principal.id;
    const run = await createSpecialRun(deps.tx, { newId: deps.newId, now: ctx.now }, {
      companyId: c.companyId, subtype: "dismissal", periodStart: plan.periodStart, periodEnd: plan.periodEnd, payday: plan.payday,
      lines: [{ workerId: worker.id, earnings: plan.earnings }], benefits: true,
    });
    const seq = await nextActionSeq(deps.tx);
    const credential = await deps.resolveCredential(BANK_CREDENTIAL_REF);
    let res;
    try {
      res = await submitRun(deps.tx, { newId: deps.newId, now: ctx.now }, { runId: run.id, excludeBlocked: false, approvedBy, actionSeq: seq, bank: deps.sims.bank, credential, settleAt: specialSettleAt(plan.payday, ctx.now) });
    } catch (e) {
      if (e instanceof PayrollRefusal) throw new Refused(e.code, e.message, e.details);
      throw e;
    }
    // The open regular drafts of the period drop the worker now that final pay covers it (dismissedWorkerIds).
    const refreshed = await refreshOpenDrafts(deps.tx, { newId: deps.newId, now: ctx.now }, c.companyId, plan.periodStart);
    const { completed } = await finish(deps, ctx, c, step, `Dismissal run ${run.id}: net ${formatCents(plan.netCents)} to the bank, settles ${settleText(res.settleAt)}`);
    return {
      data: { case_id: c.id, step_id: step.id, run_id: run.id, subtype: "dismissal", refreshed_drafts: refreshed, batch_id: res.batchId, settle_at: res.settleAt, net_cents: plan.netCents, net_display: formatCents(plan.netCents), total_cost_cents: res.moneyCents, earnings: plan.earnings, case_complete: completed },
      summary: `Final pay for ${nameRef(worker.firstName, worker.lastName, worker.id)}: ${run.id} submitted, ${formatCents(res.bankTotalCents)} to the bank`,
      moneyCents: res.moneyCents,
      events: [stepDone(c, step), { type: "payroll.submitted", subjectRef: run.id, payload: { payroll_run_id: run.id } }],
    };
  },
});

// ------------------------------------------------------------------ IdP and device proposals

const StepInput = z.object({ case_id: CaseId });
type StepInput = z.infer<typeof StepInput>;

function idpStep(spec: { name: `offboarding.${string}`; kind: OffboardingStepKind; systems: string[]; summary: string; description: string; verb: string }): WeftCommand<StepInput> {
  const facts = async (i: StepInput, companyId: string, deps: CommandDeps) => {
    const o = await openStep(deps.tx, companyId, i.case_id, spec.kind);
    const rows = await accountsOf(deps.tx, o.worker.id, spec.systems);
    return { ...o, rows };
  };
  return writeCommand({
    name: spec.name, summary: spec.summary, description: spec.description,
    input: StepInput, domain: "it", needs: "edit", effect: "external", risk: () => "R3", approval: "always", reversible: false,
    lease: (i) => `offboarding:${i.case_id}:${spec.kind}`,
    async preview(i, ctx, deps) {
      const { c, step, worker, rows } = await facts(i, ctx.companyId, deps);
      return {
        title: `${STEP_LABEL[spec.kind]} for ${nameRef(worker.firstName, worker.lastName, worker.id)}: ${spec.verb} ${rows.length ? rows.map((r) => `${r.system} ${r.handle}`).join(", ") : "no accounts"}`,
        diff: rows.length ? rows.map((r) => ({ label: `${r.system} ${r.handle}`, before: r.status, after: "suspended" })) : [{ label: "Accounts", before: "none", after: "none" }],
        content: [], moneyCents: null, subjectRef: step.id, subjectHash: accountsHash(c.id, rows), evidence: [{ label: "Offboarding case", ref: c.id }, { label: "Worker", ref: worker.id }],
      };
    },
    async run(i, ctx, deps) {
      const { c, step, worker, rows } = await facts(i, ctx.companyId, deps);
      const done = await suspendAccounts(deps, rows);
      const { completed } = await finish(deps, ctx, c, step, done.length ? `Suspended ${done.map(accountLabel).join(", ")}` : "No accounts to suspend");
      return {
        data: { case_id: c.id, step_id: step.id, suspended: done, case_complete: completed },
        summary: `${STEP_LABEL[spec.kind]} for ${nameRef(worker.firstName, worker.lastName, worker.id)}: ${done.length ? done.join(", ") : "nothing to suspend"}`,
        events: [stepDone(c, step)],
      };
    },
  });
}

export const suspendDirectoryCommand = idpStep({
  name: "offboarding.suspend_directory", kind: "directory_suspend", systems: ["google_ws"], verb: "suspend",
  summary: "Propose suspending the Google Workspace account.",
  description: "Directory suspend for an offboarding case_id: suspends the worker's Google Workspace account in the simulated IdP. R3, always needs approval; approval runs the IdP call and marks the step done.",
});

export const deactivateSsoCommand = idpStep({
  name: "offboarding.deactivate_sso", kind: "sso_deactivate", systems: ["sso"], verb: "deactivate",
  summary: "Propose deactivating the SSO account.",
  description: "SSO deactivation for an offboarding case_id: deactivates the worker's SSO account in the simulated IdP so no app sign-in works. R3, always needs approval; approval runs the IdP call and marks the step done.",
});

const lockFacts = async (i: StepInput, companyId: string, deps: CommandDeps) => {
  const o = await openStep(deps.tx, companyId, i.case_id, "device_lock");
  return { ...o, devs: await lockableDevices(deps.tx, o.worker.id) };
};
export const lockDeviceCommand = writeCommand({
  name: "offboarding.lock_device", summary: "Propose remotely locking the worker's devices.",
  description: "Device lock for an offboarding case_id: remotely locks each assigned device through the simulated device vendor (fault target devices.lock). R3, always needs approval; approval runs the lock and marks the step done.",
  input: StepInput, domain: "it", needs: "edit", effect: "external", risk: () => "R3", approval: "always", reversible: false,
  lease: (i) => `offboarding:${i.case_id}:device_lock`,
  async preview(i, ctx, deps) {
    const { c, step, worker, devs } = await lockFacts(i, ctx.companyId, deps);
    return {
      title: `Device lock for ${nameRef(worker.firstName, worker.lastName, worker.id)}: ${devs.length} device${devs.length === 1 ? "" : "s"}`,
      diff: devs.map((d) => ({ label: `${d.model} (${d.id})`, before: "unlocked", after: "locked" })), content: [], moneyCents: null, subjectRef: step.id,
      subjectHash: sha256Hex(canonicalJson({ case: c.id, devices: devs.map((d) => [d.id, d.status]) })), evidence: [{ label: "Offboarding case", ref: c.id }, ...devs.map((d) => ({ label: "Device", ref: d.id }))],
    };
  },
  async run(i, ctx, deps) {
    const { c, step, worker } = await lockFacts(i, ctx.companyId, deps);
    const locks = await lockDevices(deps, worker.id, c.id);
    const { completed } = await finish(deps, ctx, c, step, locks.length ? `Locked ${locks.length} device${locks.length === 1 ? "" : "s"} remotely` : "No devices to lock");
    return { data: { case_id: c.id, step_id: step.id, locks, case_complete: completed }, summary: `Locked ${locks.length} device(s) for ${nameRef(worker.firstName, worker.lastName, worker.id)}`, events: [stepDone(c, step)] };
  },
});

// ------------------------------------------------------------------ direct steps

const DirectStep = z.enum(["group_removal", "app_removal", "cobra_notice", "benefits_terminate"]);
const RunStepInput = z.object({ case_id: CaseId, step: DirectStep });
type RunStepInput = z.infer<typeof RunStepInput>;

export const runStepCommand = writeCommand({
  name: "offboarding.run_step", summary: "Run a direct offboarding step after final pay.",
  description: "Runs one direct step of an offboarding case_id: group_removal (clear IdP groups), app_removal (GitHub and chat), cobra_notice (email through the email simulator) or benefits_terminate (end enrollments at month end). cobra_notice and benefits_terminate wait until final pay is done or skipped; access removal never waits. An agent's call is a proposal; a person runs it directly.",
  input: RunStepInput, domain: "people", needs: "edit", effect: "external", risk: (i) => (i.step === "benefits_terminate" ? "R2" : "R3"), approval: "always", reversible: false,
  lease: (i) => `offboarding:${i.case_id}:${i.step}`,
  async preview(i, ctx, deps) {
    const { c, step, worker } = await openStep(deps.tx, ctx.companyId, i.case_id, i.step);
    return {
      title: `${STEP_LABEL[i.step]} for ${nameRef(worker.firstName, worker.lastName, worker.id)}`, diff: [{ label: STEP_LABEL[i.step], before: step.status, after: "done" }], content: [], moneyCents: null,
      subjectRef: step.id, subjectHash: sha256Hex(canonicalJson({ case: c.id, step: step.id, status: step.status })), evidence: [{ label: "Offboarding case", ref: c.id }],
    };
  },
  async run(i, ctx, deps) {
    const { c, step, worker } = await openStep(deps.tx, ctx.companyId, i.case_id, i.step);
    // Access removal runs at once; only the COBRA notice and the benefits end date wait for final pay.
    if (AFTER_FINAL_PAY.includes(i.step)) await requireFinalPayDone(deps.tx, c.id);
    let detail: string;
    let data: Record<string, unknown> = {};
    if (i.step === "group_removal") {
      const cleared = await clearAllGroups(deps, worker.id);
      detail = cleared.length ? `Removed ${cleared.reduce((s, x) => s + x.removed.length, 0)} group memberships across ${cleared.map((x) => accountLabel(`${x.system} ${x.handle}`)).join(", ")}` : "No group memberships";
      data = { cleared };
    } else if (i.step === "app_removal") {
      const done = await suspendAccounts(deps, await accountsOf(deps.tx, worker.id, ["github", "chat"]));
      detail = done.length ? `Removed ${done.map(accountLabel).join(", ")}` : "No app accounts";
      data = { removed: done };
    } else if (i.step === "benefits_terminate") {
      const effectiveTo = endOfMonth(c.lastDay);
      const ids = await terminateEnrollments(deps.tx, worker.id, effectiveTo);
      detail = ids.length ? `Terminated ${ids.length} enrollment${ids.length === 1 ? "" : "s"}, effective to ${effectiveTo}` : "No active enrollments";
      data = { enrollment_ids: ids, effective_to: effectiveTo };
    } else {
      const n = await cobraNotice(deps.tx, worker, c);
      const sent = await deps.sims.email.send({ to: n.to, from: COBRA_FROM, subject: n.subject, body: n.body, kind: "cobra_notice", relatedRef: c.id });
      detail = `COBRA notice emailed to ${n.to}`;
      data = { email_id: sent.id, to: n.to, plans: n.plans };
    }
    const { completed } = await finish(deps, ctx, c, step, detail);
    return { data: { case_id: c.id, step_id: step.id, step: i.step, ...data, case_complete: completed }, summary: `${STEP_LABEL[i.step]} for ${nameRef(worker.firstName, worker.lastName, worker.id)}: ${detail}`, events: [stepDone(c, step)] };
  },
});


// ------------------------------------------------------------------ skip

const SkipInput = z.object({ case_id: CaseId, step: z.enum(["final_pay", "directory_suspend", "sso_deactivate", "group_removal", "app_removal", "device_lock", "cobra_notice", "benefits_terminate"]), reason: z.string().min(1).max(200) });
type SkipInput = z.infer<typeof SkipInput>;
export const skipStepCommand = writeCommand({
  name: "offboarding.skip_step", summary: "Skip an offboarding step that does not apply.",
  description: "Marks one pending step of an offboarding case_id skipped with a reason (for example the laptop was returned in person). Skipping final pay pays nothing. An agent's call is a proposal; a person runs it directly. Writes an action row and offboarding.step_done; the case completes when nothing is left.",
  input: SkipInput, domain: "people", needs: "edit", effect: "write", risk: () => "R2", approval: "always", reversible: false,
  untrustedFields: [], lease: (i) => `offboarding:${i.case_id}:${i.step}`,
  async preview(i, ctx, deps) {
    const { c, step, worker } = await openStep(deps.tx, ctx.companyId, i.case_id, i.step);
    return {
      title: `Skip ${STEP_LABEL[i.step].toLowerCase()} for ${nameRef(worker.firstName, worker.lastName, worker.id)}`, diff: [{ label: STEP_LABEL[i.step], before: step.status, after: "skipped" }],
      content: [{ label: "Reason", text: i.reason }], moneyCents: null, subjectRef: step.id, subjectHash: sha256Hex(canonicalJson({ case: c.id, step: step.id, status: step.status })),
      evidence: [{ label: "Offboarding case", ref: c.id }],
    };
  },
  async run(i, ctx, deps) {
    const { c, step, worker } = await openStep(deps.tx, ctx.companyId, i.case_id, i.step);
    // The free-text reason stays in the call's arguments (the action row), never in the step detail agents read.
    const seq = await nextActionSeq(deps.tx);
    const { completed } = await finishStep(deps.tx, { step, c, actionSeq: seq, proposalId: ctx.approvedProposalId, detail: `Skipped; the reason is in action ${seq}`, now: ctx.now, status: "skipped" });
    return { data: { case_id: c.id, step_id: step.id, step: i.step, status: "skipped", case_complete: completed }, summary: `Skipped ${STEP_LABEL[i.step].toLowerCase()} for ${nameRef(worker.firstName, worker.lastName, worker.id)}`, events: [stepDone(c, step)] };
  },
});

export const offboardingCommands: WeftCommand[] = [
  listCases, getCase, terminateCommand, finalPayCommand, suspendDirectoryCommand, deactivateSsoCommand, lockDeviceCommand, runStepCommand, skipStepCommand,
  proposeOffCycleCommand,   // payroll.propose_off_cycle, defined in commands/payroll.ts
];

/** "Fri, Oct 30, 6:00 AM PT" for a step detail an agent and a person read; never a raw ISO instant. */
function settleText(iso: string): string {
  return `${new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso))} PT`;
}
