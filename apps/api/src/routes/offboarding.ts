// /v1 offboarding routes (wave 2, docs/wave2.md). Owner: w2-offboarding. Paths come from packages/contracts/src/api.ts.
// POST /v1/workers/:id/terminate runs offboarding.terminate as the person, then files the four proposal steps
// (final pay, directory suspend, SSO deactivation, device lock) through HumanExecutor.propose: each one is a gated
// call with its own preview that waits for an approval, untainted, on the person's behalf.
// Reads build OffboardingCase straight from the tables, like the other read routes.
import { Hono, type Context } from "hono";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  NotFound, OFFBOARDING_PROPOSAL_STEPS, OFFBOARDING_STEP_ORDER, TerminationInput, Unauthorized,
  type HumanSession, type OffboardingCase, type OffboardingStep, type OffboardingStepKind, type ToolOutcome,
} from "@weft/contracts";
import { offboardingCases, offboardingSteps, proposals, type DbTx } from "@weft/db";
import type { Weft, WeftEnv } from "../http/context";
import { stubRoutes } from "../http/stub";

const PROPOSAL_COMMAND: Partial<Record<OffboardingStepKind, string>> = {
  final_pay: "offboarding.final_pay", directory_suspend: "offboarding.suspend_directory", sso_deactivate: "offboarding.deactivate_sso", device_lock: "offboarding.lock_device",
};

function session(c: Context<WeftEnv>): HumanSession {
  const s = c.var.session;
  if (!s) throw new Unauthorized();
  return s;
}

function refused(c: Context<WeftEnv>, out: ToolOutcome): Response | null {
  if (out.ok) return null;
  return c.json({ _tag: "Refused", message: out.refusal.message, code: out.refusal.code, hint: out.refusal.hint, example: out.refusal.example, tainted: out.tainted }, 422);
}

type CaseRow = typeof offboardingCases.$inferSelect;
type StepRow = typeof offboardingSteps.$inferSelect;

async function caseDtos(db: DbTx, rows: CaseRow[]): Promise<OffboardingCase[]> {
  if (!rows.length) return [];
  const steps = await db.select().from(offboardingSteps).where(inArray(offboardingSteps.caseId, rows.map((r) => r.id)));
  const props = steps.length
    ? await db.select({ id: proposals.id, subject: proposals.subjectRef, status: proposals.status }).from(proposals).where(inArray(proposals.subjectRef, steps.map((s) => s.id))).orderBy(desc(proposals.createdAt), desc(proposals.id))
    : [];
  const latest = new Map<string, { id: string; status: string }>();
  for (const p of props) if (p.subject && !latest.has(p.subject)) latest.set(p.subject, { id: p.id, status: p.status });
  const order = (s: StepRow) => OFFBOARDING_STEP_ORDER.indexOf(s.kind as OffboardingStepKind);
  return rows.map((c) => ({
    id: c.id, workerId: c.workerId, kind: c.kind as OffboardingCase["kind"], lastDay: c.lastDay, status: c.status as OffboardingCase["status"], createdAt: c.createdAt,
    steps: steps.filter((s) => s.caseId === c.id).sort((a, b) => order(a) - order(b)).map((s): OffboardingStep => {
      const p = latest.get(s.id);
      return {
        id: s.id, caseId: s.caseId, kind: s.kind as OffboardingStepKind, status: s.status === "pending" && p?.status === "pending" ? "proposed" : (s.status as OffboardingStep["status"]),
        proposalId: s.proposalId ?? p?.id ?? null, actionSeq: s.actionSeq, doneAt: s.doneAt, detail: s.detail,
      };
    }),
  }));
}

export function offboardingRoutes(weft: Weft): Hono<WeftEnv> {
  const r = new Hono<WeftEnv>();

  r.post("/v1/workers/:id/terminate", async (c) => {
    const s = session(c);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const input = TerminationInput.parse({ ...body, workerId: c.req.param("id") });
    const out = await weft.executor.human.exec(s, "offboarding.terminate", {
      worker_id: input.workerId, kind: input.kind, last_day: input.lastDay, reason_note: input.reasonNote || undefined, pay_unused_pto: input.payUnusedPto,
    });
    const bad = refused(c, out);
    if (bad) { await weft.scheduler.kick(); return bad; }
    if (out.ok && out.status === "done") {
      const data = out.data as { case_id: string; steps: { kind: OffboardingStepKind; status: string }[] };
      const propose = weft.executor.human.propose;
      if (!propose) throw new Error("offboarding: the executor has no HumanExecutor.propose");
      for (const kind of OFFBOARDING_PROPOSAL_STEPS) {
        const step = data.steps.find((x) => x.kind === kind);
        if (!step || step.status !== "pending") continue;
        const args = kind === "final_pay" ? { case_id: data.case_id, pay_unused_pto: input.payUnusedPto } : { case_id: data.case_id };
        await propose.call(weft.executor.human, s, PROPOSAL_COMMAND[kind]!, args);
      }
    }
    await weft.scheduler.kick();
    return c.json(out);
  });

  r.get("/v1/offboarding", async (c) => {
    const s = session(c);
    const rows = await weft.db.select().from(offboardingCases).where(eq(offboardingCases.companyId, s.companyId)).orderBy(asc(offboardingCases.id));
    return c.json(await caseDtos(weft.db, rows));
  });

  r.get("/v1/offboarding/:id", async (c) => {
    const s = session(c);
    const rows = await weft.db.select().from(offboardingCases).where(and(eq(offboardingCases.id, c.req.param("id")), eq(offboardingCases.companyId, s.companyId)));
    if (!rows.length) throw new NotFound(`No offboarding case ${c.req.param("id")}`);
    return c.json((await caseDtos(weft.db, rows))[0]);
  });

  return stubRoutes(r, "offboarding", ["POST /v1/workers/:id/terminate", "GET /v1/offboarding", "GET /v1/offboarding/:id"]);
}
