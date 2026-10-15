// benefits.* commands. Owner: t2-world. Append WeftCommand definitions to this array; commands/index.ts concatenates it.
import { z } from "zod";
import { formatCents } from "@weft/contracts";
import type { WeftCommand } from "../shared/deps";
import { notFound, readCommand, responseFormatField } from "../demo/define";
import { getWorker } from "../people/queries";
import { nameRef } from "../people/names";
import { listEnrollments, listPlans } from "../benefits/queries";

const PlansInput = z.object({ ...responseFormatField });
type PlansInput = z.infer<typeof PlansInput>;
const listPlansCmd = readCommand({
  name: "benefits.list_plans", domain: "benefits",
  summary: "List benefit plans with per-period prices and enrollment counts.",
  description: "List the company's benefit plans (simulated carriers): category, type, pre-tax code, employee price per period for each coverage tier and the employer contribution, in cents with displays, plus the active enrollment count per plan.",
  input: PlansInput,
  async run(_i: PlansInput, ctx, deps) {
    const plans = await listPlans(deps.tx, ctx.companyId);
    const enr = await listEnrollments(deps.tx, ctx.companyId);
    const data = plans.map((p) => {
      const prices = JSON.parse(p.pricesJson) as Record<string, number>;
      return {
        id: p.id, name: p.name, carrier: p.carrier, category: p.category, type: p.type, pretax_code: p.pretaxCode,
        prices: Object.fromEntries(Object.entries(prices).map(([k, v]) => [k, { cents: v, display: formatCents(v) }])),
        match: p.matchJson ? JSON.parse(p.matchJson) : null,
        active_enrollments: enr.filter((e) => e.planId === p.id && e.status === "active").length,
      };
    });
    return { data: { count: data.length, plans: data }, summary: `Listed ${data.length} plans` };
  },
});

const EnrInput = z.object({ worker_id: z.string(), ...responseFormatField });
type EnrInput = z.infer<typeof EnrInput>;
const getEnrollment = readCommand({
  name: "benefits.get_enrollment", domain: "benefits",
  summary: "A worker's benefit enrollments with per-period amounts.",
  description: "Read one worker's benefit enrollments: plan, coverage tier, employee amount per period in cents with display (or the 401(k) deferral in basis points), status and effective dates.",
  input: EnrInput,
  async run(i: EnrInput, ctx, deps) {
    const w = await getWorker(deps.tx, ctx.companyId, i.worker_id);
    if (!w) throw notFound("worker", i.worker_id);
    const plans = new Map((await listPlans(deps.tx, ctx.companyId)).map((p) => [p.id, p]));
    const rows = await listEnrollments(deps.tx, ctx.companyId, w.id);
    const enrollments = rows.map((e) => ({
      id: e.id, plan_id: e.planId, plan: plans.get(e.planId)?.name ?? e.planId, tier: e.tier, status: e.status,
      employee_cents: e.employeeCents, employee_display: e.employeeCents === null ? null : formatCents(e.employeeCents), deferral_bps: e.deferralBps,
      effective_from: e.effectiveFrom, effective_to: e.effectiveTo,
    }));
    return { data: { worker: nameRef(w.firstName, w.lastName, w.id), count: enrollments.length, enrollments }, summary: `Read ${enrollments.length} enrollments` };
  },
});

export const benefitsCommands: WeftCommand[] = [listPlansCmd, getEnrollment];
