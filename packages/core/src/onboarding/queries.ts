// Onboarding reads shared by onboarding.* commands and GET /v1/workers/:id/onboarding.
import { asc, eq } from "drizzle-orm";
import type { OnboardingTask } from "@weft/contracts";
import { onboardingTasks, type DbTx } from "@weft/db";

export type TaskRow = typeof onboardingTasks.$inferSelect;

/** Checklist order (SPEC 6.1 kind enum order). */
export const TASK_ORDER = ["sign_offer", "federal_w4", "state_withholding", "direct_deposit", "i9_sim", "benefits_selection", "it_accounts", "device", "state_registration"] as const;

export function toTaskDto(t: TaskRow): OnboardingTask {
  return { id: t.id, workerId: t.workerId, kind: t.kind as OnboardingTask["kind"], status: t.status as OnboardingTask["status"], owner: t.owner as OnboardingTask["owner"], dueOn: t.dueOn, doneAt: t.doneAt, blockedReason: t.blockedReason };
}

export async function listTasks(tx: DbTx, workerId: string): Promise<TaskRow[]> {
  const rows = await tx.select().from(onboardingTasks).where(eq(onboardingTasks.workerId, workerId)).orderBy(asc(onboardingTasks.id));
  return rows.sort((a, b) => TASK_ORDER.indexOf(a.kind as never) - TASK_ORDER.indexOf(b.kind as never) || (a.id < b.id ? -1 : 1));
}
