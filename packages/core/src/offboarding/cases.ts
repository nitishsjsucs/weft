// Offboarding cases and steps (wave 2, w2-offboarding). A case holds the eight steps in OFFBOARDING_STEP_ORDER; each
// step is finished by exactly one executor call, so every step has its own action row and offboarding.step_done event.
// A step's proposal link is derived from the proposals table (subject_ref = step id), never written outside the executor.
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { OFFBOARDING_STEP_ORDER, type OffboardingCase, type OffboardingStep, type OffboardingStepKind, type TerminationKind } from "@weft/contracts";
import { devices, itAccounts, offboardingCases, offboardingSteps, proposals, workers, type DbTx } from "@weft/db";
import { DomainRefusal } from "../demo/define";

export type CaseRow = typeof offboardingCases.$inferSelect;
export type StepRow = typeof offboardingSteps.$inferSelect;

/** Commands that finish each step; the four proposal steps have their own command, the rest share run_step. */
export const STEP_COMMAND: Record<OffboardingStepKind, string> = {
  final_pay: "offboarding.final_pay", directory_suspend: "offboarding.suspend_directory", sso_deactivate: "offboarding.deactivate_sso",
  group_removal: "offboarding.run_step", app_removal: "offboarding.run_step", device_lock: "offboarding.lock_device",
  cobra_notice: "offboarding.run_step", benefits_terminate: "offboarding.run_step",
};

export const STEP_LABEL: Record<OffboardingStepKind, string> = {
  final_pay: "Final pay", directory_suspend: "Directory suspend", sso_deactivate: "SSO deactivation", group_removal: "Group removal",
  app_removal: "App removal", device_lock: "Device lock", cobra_notice: "COBRA notice", benefits_terminate: "Benefits termination",
};

export async function getCaseRow(tx: DbTx, companyId: string, caseId: string): Promise<CaseRow | null> {
  const [c] = await tx.select().from(offboardingCases).where(and(eq(offboardingCases.id, caseId), eq(offboardingCases.companyId, companyId))).limit(1);
  return c ?? null;
}

export async function requireCase(tx: DbTx, companyId: string, caseId: string): Promise<CaseRow> {
  const c = await getCaseRow(tx, companyId, caseId);
  if (!c) throw new DomainRefusal("DOMAIN_NOT_FOUND", `No offboarding case ${caseId} in this company`, "Use a case id from offboarding.list_cases", null);
  return c;
}

export async function stepsOf(tx: DbTx, caseId: string): Promise<StepRow[]> {
  const rows = await tx.select().from(offboardingSteps).where(eq(offboardingSteps.caseId, caseId));
  return rows.sort((a, b) => OFFBOARDING_STEP_ORDER.indexOf(a.kind as OffboardingStepKind) - OFFBOARDING_STEP_ORDER.indexOf(b.kind as OffboardingStepKind));
}

export async function stepOf(tx: DbTx, caseId: string, kind: OffboardingStepKind): Promise<StepRow> {
  const [s] = await tx.select().from(offboardingSteps).where(and(eq(offboardingSteps.caseId, caseId), eq(offboardingSteps.kind, kind))).limit(1);
  if (!s) throw new Error(`offboarding: case ${caseId} has no ${kind} step`);
  return s;
}

/** A step that can still run: open case, step pending (a pending proposal does not count as done). */
export async function openStep(tx: DbTx, companyId: string, caseId: string, kind: OffboardingStepKind): Promise<{ c: CaseRow; step: StepRow; worker: typeof workers.$inferSelect }> {
  const c = await requireCase(tx, companyId, caseId);
  if (c.status !== "open") throw new DomainRefusal("DOMAIN_CASE_CLOSED", `Offboarding case ${c.id} is ${c.status}`, null, null);
  const step = await stepOf(tx, c.id, kind);
  if (step.status === "done" || step.status === "skipped") throw new DomainRefusal("DOMAIN_STEP_DONE", `${STEP_LABEL[kind]} on ${c.id} is already ${step.status}`, "Read the case with offboarding.get_case", { case_id: c.id });
  const [worker] = await tx.select().from(workers).where(eq(workers.id, c.workerId)).limit(1);
  if (!worker) throw new Error(`offboarding: worker ${c.workerId} missing`);
  return { c, step, worker };
}

/** Simulated systems in words, always marked (sim) like the rest of the app. */
export const SYSTEM_LABEL: Record<string, string> = { google_ws: "Google Workspace (sim)", github: "GitHub (sim)", chat: "Team chat (sim)", sso: "SSO (sim)" };
/** "google_ws imani.ferreira" (the suspend and remove results) as "Google Workspace (sim) imani.ferreira". */
export const accountLabel = (systemHandle: string) => { const [sys, ...rest] = systemHandle.split(" "); return [SYSTEM_LABEL[sys!] ?? sys, ...rest].join(" "); };

/** Steps that wait for final pay: the COBRA notice and the benefits end date. Access removal never waits on pay. */
export const AFTER_FINAL_PAY: readonly OffboardingStepKind[] = ["cobra_notice", "benefits_terminate"];

/** COBRA and benefits steps run once final pay is finished: done, or skipped (nothing to pay, no bank, expired). */
export async function requireFinalPayDone(tx: DbTx, caseId: string): Promise<void> {
  const fp = await stepOf(tx, caseId, "final_pay");
  if (fp.status !== "done" && fp.status !== "skipped") throw new DomainRefusal("DOMAIN_FINAL_PAY_PENDING", `Final pay on ${caseId} is ${fp.status}; approve it first`, "Approve the final pay proposal, then run this step", { case_id: caseId });
}

export async function openCaseFor(tx: DbTx, workerId: string): Promise<CaseRow | null> {
  const [c] = await tx.select().from(offboardingCases).where(and(eq(offboardingCases.workerId, workerId), eq(offboardingCases.status, "open"))).limit(1);
  return c ?? null;
}

/** Inserts the case and its eight steps. Steps with nothing to act on start skipped, with the reason as detail. */
export async function insertCase(tx: DbTx, deps: { newId(p: "ofb_" | "ofs_"): Promise<string>; now: string }, input: { companyId: string; workerId: string; kind: TerminationKind; lastDay: string; reasonNote: string; payUnusedPto: boolean }): Promise<{ caseId: string; steps: StepRow[] }> {
  const caseId = await deps.newId("ofb_");
  await tx.insert(offboardingCases).values({ id: caseId, companyId: input.companyId, workerId: input.workerId, kind: input.kind, lastDay: input.lastDay, reasonNote: input.reasonNote, status: "open", createdAt: deps.now, closedAt: null });
  const accts = await tx.select().from(itAccounts).where(eq(itAccounts.workerId, input.workerId));
  const devs = (await tx.select().from(devices).where(eq(devices.workerId, input.workerId))).filter((d) => d.status === "assigned" || d.status === "delivered");
  const has = (sys: string) => accts.some((a) => a.system === sys && a.status !== "suspended");
  const initial: Record<OffboardingStepKind, { status: "pending" | "skipped"; detail: string }> = {
    final_pay: { status: "pending", detail: input.payUnusedPto ? "Dismissal run through the last day, with unused PTO" : "Dismissal run through the last day, no PTO payout" },
    directory_suspend: has("google_ws") ? { status: "pending", detail: "Suspend the Google Workspace (sim) account" } : { status: "skipped", detail: "No active Google Workspace (sim) account" },
    sso_deactivate: has("sso") ? { status: "pending", detail: "Deactivate the SSO (sim) account" } : { status: "skipped", detail: "No SSO (sim) account on file" },
    group_removal: { status: "pending", detail: "Remove every group membership" },
    app_removal: has("github") || has("chat") ? { status: "pending", detail: "Remove GitHub (sim) and team chat (sim) accounts" } : { status: "skipped", detail: "No app accounts" },
    device_lock: devs.length ? { status: "pending", detail: `Lock ${devs.length} device${devs.length === 1 ? "" : "s"}` } : { status: "skipped", detail: "No device assigned" },
    cobra_notice: { status: "pending", detail: "Email the COBRA continuation notice" },
    benefits_terminate: { status: "pending", detail: "End enrollments at the end of the month" },
  };
  for (const kind of OFFBOARDING_STEP_ORDER) {
    const s = initial[kind];
    await tx.insert(offboardingSteps).values({ id: await deps.newId("ofs_"), caseId, kind, status: s.status, proposalId: null, actionSeq: null, detail: s.detail, doneAt: s.status === "skipped" ? deps.now : null });
  }
  return { caseId, steps: await stepsOf(tx, caseId) };
}

/**
 * Marks a step done in the executor's transaction (actionSeq is the seq the executor gives this call's action row),
 * then completes the case when every step is done or skipped: the case closes and the worker turns inactive.
 */
export async function finishStep(tx: DbTx, input: { step: StepRow; c: CaseRow; actionSeq: number; proposalId: string | null; detail: string; now: string; status?: "done" | "skipped" }): Promise<{ completed: boolean }> {
  await tx.update(offboardingSteps).set({ status: input.status ?? "done", actionSeq: input.actionSeq, proposalId: input.proposalId, detail: input.detail, doneAt: input.now }).where(eq(offboardingSteps.id, input.step.id));
  const steps = await stepsOf(tx, input.c.id);
  const completed = steps.every((s) => s.status === "done" || s.status === "skipped");
  if (completed) {
    await tx.update(offboardingCases).set({ status: "complete", closedAt: input.now }).where(eq(offboardingCases.id, input.c.id));
    await tx.update(workers).set({ status: "inactive", endDate: input.c.lastDay }).where(eq(workers.id, input.c.workerId));
  }
  return { completed };
}

/** Latest proposal per step subject, for the step DTO's proposal link and the derived "proposed" status. */
async function proposalsFor(tx: DbTx, stepIds: string[]): Promise<Map<string, { id: string; status: string }>> {
  const out = new Map<string, { id: string; status: string }>();
  if (!stepIds.length) return out;
  const rows = await tx.select({ id: proposals.id, subject: proposals.subjectRef, status: proposals.status, createdAt: proposals.createdAt }).from(proposals)
    .where(inArray(proposals.subjectRef, stepIds)).orderBy(desc(proposals.createdAt), desc(proposals.id));
  for (const r of rows) if (r.subject && !out.has(r.subject)) out.set(r.subject, { id: r.id, status: r.status });
  return out;
}

export function stepDto(s: StepRow, p: { id: string; status: string } | undefined): OffboardingStep {
  const proposed = s.status === "pending" && p?.status === "pending";
  return {
    id: s.id, caseId: s.caseId, kind: s.kind as OffboardingStepKind, status: proposed ? "proposed" : (s.status as OffboardingStep["status"]),
    proposalId: s.proposalId ?? p?.id ?? null, actionSeq: s.actionSeq, doneAt: s.doneAt, detail: s.detail,
  };
}

export async function caseDto(tx: DbTx, c: CaseRow): Promise<OffboardingCase> {
  const steps = await stepsOf(tx, c.id);
  const props = await proposalsFor(tx, steps.map((s) => s.id));
  return { id: c.id, workerId: c.workerId, kind: c.kind as TerminationKind, lastDay: c.lastDay, status: c.status as OffboardingCase["status"], createdAt: c.createdAt, steps: steps.map((s) => stepDto(s, props.get(s.id))) };
}

export async function listCaseRows(tx: DbTx, companyId: string): Promise<CaseRow[]> {
  return tx.select().from(offboardingCases).where(eq(offboardingCases.companyId, companyId)).orderBy(asc(offboardingCases.id));
}
