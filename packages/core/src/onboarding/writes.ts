// onboarding.complete_task (R1). state_registration completes only when every registration for the worker's
// work state is active (the tax_account.activated handler calls it as svc_events).
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { OnboardingTaskKind } from "@weft/contracts";
import { events as eventRows, onboardingTasks, taxAccounts } from "@weft/db";
import type { WeftCommand } from "../shared/deps";
import { DomainRefusal, notFound, riskOf, writeCommand } from "../demo/define";
import { nameRef } from "../people/names";
import { getWorker } from "../people/queries";

const CompleteInput = z.object({ worker_id: z.string(), kind: OnboardingTaskKind });
export const completeTask = writeCommand({
  name: "onboarding.complete_task", summary: "Mark an onboarding checklist task done.",
  description: "Mark one onboarding task (worker_id, kind) done. state_registration is refused until every tax account for the worker's work state is active. When every task is done, emits worker.onboarding_completed. R1: no approval.",
  input: CompleteInput, domain: "people", needs: "edit", effect: "write", risk: riskOf("R1"), approval: "never", reversible: false,
  tiers: { main: "executable", task: "executable" }, preview: null,
  async run(i, ctx, deps) {
    const tx = deps.tx;
    const w = await getWorker(tx, ctx.companyId, i.worker_id);
    if (!w) throw notFound("worker", i.worker_id);
    const [t] = await tx.select().from(onboardingTasks).where(and(eq(onboardingTasks.workerId, w.id), eq(onboardingTasks.kind, i.kind))).limit(1);
    if (!t) throw new DomainRefusal("DOMAIN_NO_TASK", `${w.id} has no ${i.kind} task`, "Read onboarding.get_checklist for the task kinds", null);
    if (t.status === "done") return { data: { task_id: t.id, kind: t.kind, status: "done", changed: false }, summary: `${i.kind} already done for ${nameRef(w.firstName, w.lastName, w.id)}` };
    if (i.kind === "state_registration") {
      const accts = w.workState ? await tx.select().from(taxAccounts).where(and(eq(taxAccounts.companyId, ctx.companyId), eq(taxAccounts.jurisdiction, w.workState))) : [];
      const pending = accts.filter((a) => a.status !== "active");
      if (accts.length === 0 || pending.length) throw new DomainRefusal("DOMAIN_REGISTRATION_INCOMPLETE", `${w.workState} registrations not active: ${pending.map((a) => `${a.id} ${a.status}`).join(", ") || "none on file"}`, "Wait for tax_account.activated", null);
    }
    await tx.update(onboardingTasks).set({ status: "done", doneAt: ctx.now, blockedReason: null }).where(eq(onboardingTasks.id, t.id));
    const all = await tx.select().from(onboardingTasks).where(eq(onboardingTasks.workerId, w.id));
    const allDone = all.every((x) => x.id === t.id || x.status === "done");
    // The new-hire portal (wave 2) emits worker.onboarding_completed when the employee tasks finish; the agent's
    // later tasks must not emit it a second time.
    const already = allDone ? (await tx.select({ id: eventRows.id }).from(eventRows).where(and(eq(eventRows.type, "worker.onboarding_completed"), eq(eventRows.subjectRef, w.id))).limit(1)).length > 0 : false;
    return {
      data: { task_id: t.id, kind: t.kind, status: "done", changed: true, open_count: all.filter((x) => x.id !== t.id && x.status !== "done").length },
      summary: `Completed ${i.kind} for ${nameRef(w.firstName, w.lastName, w.id)}`,
      events: allDone && !already ? [{ type: "worker.onboarding_completed", subjectRef: w.id, payload: { worker_id: w.id } }] : [],
    };
  },
});

