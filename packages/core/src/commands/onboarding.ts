// onboarding.* commands. Owner: t2-world. Append WeftCommand definitions to this array; commands/index.ts concatenates it.
import { z } from "zod";
import type { WeftCommand } from "../shared/deps";
import { notFound, readCommand, responseFormatField } from "../demo/define";
import { getWorker } from "../people/queries";
import { nameRef } from "../people/names";
import { listTasks } from "../onboarding/queries";
import { completeTask } from "../onboarding/writes";

/** HR-facing checklist item labels (the portal shows the employee-facing titles). */
export const TASK_LABEL: Record<string, string> = {
  sign_offer: "Offer letter signed", sign_confidentiality: "Confidentiality agreement", federal_w4: "Federal W-4", state_withholding: "State withholding",
  direct_deposit: "Direct deposit", i9_sim: "Form I-9 (simulated)", benefits_selection: "Benefits selection", it_accounts: "IT accounts", device: "Device",
  state_registration: "State tax registration",
};
export const taskLabel = (kind: string): string => TASK_LABEL[kind] ?? kind.replaceAll("_", " ");

const ChecklistInput = z.object({ worker_id: z.string(), ...responseFormatField });
type ChecklistInput = z.infer<typeof ChecklistInput>;
const getChecklist = readCommand({
  name: "onboarding.get_checklist", domain: "people",
  summary: "A new hire's onboarding checklist with task status and owners.",
  description: "Read a worker's onboarding checklist: each task's kind (federal_w4, state_withholding, direct_deposit, it_accounts, device, state_registration and others), status (pending, done, blocked), owner (employee, hr, agent), due date and blocked reason, plus open and done counts.",
  input: ChecklistInput,
  async run(i: ChecklistInput, ctx, deps) {
    const w = await getWorker(deps.tx, ctx.companyId, i.worker_id);
    if (!w) throw notFound("worker", i.worker_id);
    const tasks = (await listTasks(deps.tx, w.id)).map((t) => ({ id: t.id, kind: t.kind, label: taskLabel(t.kind), status: t.status, owner: t.owner, due_on: t.dueOn, done_at: t.doneAt, blocked_reason: t.blockedReason }));
    const open = tasks.filter((t) => t.status !== "done").length;
    return {
      data: { worker: nameRef(w.firstName, w.lastName, w.id), worker_id: w.id, worker_status: w.status, work_state: w.workState, start_date: w.startDate, open_count: open, done_count: tasks.length - open, tasks },
      summary: `Checklist for ${nameRef(w.firstName, w.lastName, w.id)}: ${open} open`,
    };
  },
});

export const onboardingCommands: WeftCommand[] = [getChecklist, completeTask];
