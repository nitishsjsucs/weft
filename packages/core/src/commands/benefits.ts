// benefits.* commands. Owner: t2-world (wave 2 additions: w2-benefits-contractors). Append WeftCommand definitions to this array; commands/index.ts concatenates it.
import { z } from "zod";
import { and, desc, eq, inArray } from "drizzle-orm";
import { actions, benefitReconFindings, workers } from "@weft/db";
import { formatCents, hasCarrierPeek } from "@weft/contracts";
import type { WeftCommand } from "../shared/deps";
import { DomainRefusal, notFound, ptDateOf, readCommand, responseFormatField, riskOf, writeCommand } from "../demo/define";
import { getWorker } from "../people/queries";
import { nameRef } from "../people/names";
import { listEnrollments, listPlans } from "../benefits/queries";
import { canonicalJson } from "../shared/canonical-json";
import { sha256Hex } from "../shared/hash";
import { CARRIER_BILLING_EMAIL, computeFindings, disputeMessage, getFinding, hasStoredInvoice, listFindings, RECON_CARRIER, storeFindings, toFindingDto, type ReconInvoice } from "../benefits/recon";
import { listOpenEnrollment, OPEN_ENROLLMENT_DEADLINE, OPEN_ENROLLMENT_PLAN_YEAR, openEnrollmentStragglers, recordNudges } from "../benefits/enrollment";
import { emitBenefitsWave2Event } from "../contractors/events";

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

// ---------- wave 2 (w2-benefits-contractors): carrier reconciliation and open enrollment ----------
const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month is YYYY-MM");
const findingView = (f: ReturnType<typeof toFindingDto>, names: Map<string, string>, plans: Map<string, string>) => ({
  id: f.id, kind: f.kind, status: f.status, worker: f.workerId ? `${names.get(f.workerId) ?? f.workerId} (${f.workerId})` : null, plan: f.planId ? plans.get(f.planId) ?? f.planId : null,
  billed_cents: f.billedCents, billed_display: formatCents(f.billedCents), expected_cents: f.expectedCents, expected_display: formatCents(f.expectedCents),
  deducted_cents: f.deductedCents, deducted_display: formatCents(f.deductedCents), detail: f.detail,
});
async function lookups(deps: Parameters<WeftCommand["run"]>[2], companyId: string) {
  const people = await deps.tx.select({ id: workers.id, f: workers.firstName, l: workers.lastName }).from(workers).where(eq(workers.companyId, companyId));
  const names = new Map(people.map((p) => [p.id, `${p.f} ${p.l} (demo)`]));
  const plans = new Map((await listPlans(deps.tx, companyId)).map((p) => [p.id, p.name]));
  return { names, plans };
}

const ReconcileInput = z.object({ month: Month.optional() });
type ReconcileInput = z.infer<typeof ReconcileInput>;
const reconcileCmd = writeCommand({
  name: "benefits.reconcile", summary: "Reconcile a month's carrier invoice against enrollments and paycheck deductions.",
  description: "Fetch the simulated carrier invoice for a month (YYYY-MM, default the current sim month) and compare every line with the enrollments on file and that month's paycheck deductions. Writes findings (terminated but billed, missing dependent, wrong tier and others) with billed, expected and deducted cents. Idempotent per month and carrier.",
  input: ReconcileInput, domain: "benefits", needs: "edit", effect: "write", risk: riskOf("R1"), approval: "never", reversible: false, preview: null,
  async run(input: ReconcileInput, ctx, deps) {
    const i = { month: input.month ?? ptDateOf(ctx.now).slice(0, 7) };
    const fresh = !(await hasStoredInvoice(deps.tx, i.month));
    const invoice = (await deps.sims.carrier.invoice(i.month)) as ReconInvoice;
    const drafts = await computeFindings(deps.tx, ctx.companyId, invoice);
    const res = await storeFindings(deps.tx, ctx.companyId, i.month, invoice.carrier, drafts, ctx.now, (p) => deps.newId(p));
    if (fresh) await emitBenefitsWave2Event(deps.tx, ctx.now, { type: "benefits.invoice_received", payload: { month: i.month, carrier: invoice.carrier } }, invoice.id ?? `carrier:${i.month}`, { attended: ctx.principal.kind === "human", requestedBy: ctx.principal.id });
    const { names, plans } = await lookups(deps, ctx.companyId);
    const findings = res.rows.map((r) => findingView(toFindingDto(r), names, plans));
    return {
      data: { month: i.month, carrier: invoice.carrier, invoice_lines: invoice.lines.length, invoice_total_cents: invoice.totalCents, invoice_total_display: formatCents(invoice.totalCents), count: findings.length, created: res.created, unchanged: res.unchanged, resolved: res.resolved, findings },
      summary: `Reconciled ${invoice.carrier} ${i.month}: ${findings.length} findings (${res.created} new)`,
    };
  },
});

/**
 * When a month was last reconciled: the latest benefits.reconcile in the action log for that month (an omitted month
 * argument meant the sim month at the time of the call), else the newest stored finding, else null.
 */
async function lastReconciledAt(deps: Parameters<WeftCommand["run"]>[2], companyId: string, month: string): Promise<string | null> {
  const logged = await deps.tx.select({ ts: actions.ts, args: actions.argsJson }).from(actions).where(eq(actions.command, "benefits.reconcile")).orderBy(desc(actions.seq));
  for (const a of logged) {
    let m: unknown = null;
    try { m = (JSON.parse(String(a.args)) as { month?: unknown }).month; } catch { m = null; }
    if ((typeof m === "string" ? m : ptDateOf(a.ts).slice(0, 7)) === month) return a.ts;
  }
  const [row] = await deps.tx.select({ at: benefitReconFindings.createdAt }).from(benefitReconFindings)
    .where(and(eq(benefitReconFindings.companyId, companyId), eq(benefitReconFindings.month, month))).orderBy(desc(benefitReconFindings.createdAt)).limit(1);
  return row?.at ?? null;
}

const PREVIEW_LABEL = "preview: computed now from the carrier's current bill, not stored and not a reconciliation; a person runs the reconciliation from the Benefits screen";

const FindingsInput = z.object({ month: Month.optional(), status: z.enum(["open", "disputed", "resolved", "dismissed"]).optional(), ...responseFormatField });
type FindingsInput = z.infer<typeof FindingsInput>;
const listFindingsCmd = readCommand({
  name: "benefits.list_findings", domain: "benefits",
  summary: "List carrier reconciliation findings, and whether the month was reconciled at all.",
  description: "List stored carrier reconciliation findings, for one month (YYYY-MM) or status if given: kind, worker, plan, billed, expected and deducted cents with displays. Rows exist only once a month is reconciled: reconciled and last_reconciled_at say if it was (default the current month). An empty list for a month never reconciled is not a clean bill; preview, if present, is computed now and not stored.",
  input: FindingsInput,
  async run(i: FindingsInput, ctx, deps) {
    const month = i.month ?? ptDateOf(ctx.now).slice(0, 7);
    const rows = await listFindings(deps.tx, ctx.companyId, { month: i.month, status: i.status });
    const { names, plans } = await lookups(deps, ctx.companyId);
    const findings = rows.map((r) => findingView(toFindingDto(r), names, plans));
    const reconciled = await hasStoredInvoice(deps.tx, month);
    const last = reconciled ? await lastReconciledAt(deps, ctx.companyId, month) : null;
    // Never benefits.reconcile's path: carrier.invoice stores the invoice on its first call, and this is a read.
    let preview: { label: string; month: string; count: number; findings: (Omit<ReturnType<typeof findingView>, "id"> & { id: null })[] } | null = null;
    if (!reconciled && hasCarrierPeek(deps.sims.carrier)) {
      const drafts = await computeFindings(deps.tx, ctx.companyId, (await deps.sims.carrier.peekInvoice(month)) as ReconInvoice);
      // A preview row has no id: nothing is stored, so there is nothing to dispute or cite until the month is reconciled.
      const views = drafts.map((d) => ({ ...findingView(toFindingDto({ ...d, id: "", companyId: ctx.companyId, month, carrier: RECON_CARRIER, status: "preview", createdAt: ctx.now }), names, plans), id: null }));
      preview = { label: PREVIEW_LABEL, month, count: views.length, findings: views };
    }
    const scope = `${i.status ? `${i.status} ` : ""}findings ${i.month ? `for ${i.month}` : "across all months"}`;
    const state = reconciled
      ? `${month} was reconciled${last ? ` at ${last}` : ""}`
      : `${month} has never been reconciled, so no findings are stored for it and an empty list is not a clean bill${preview ? `; preview (not stored): ${preview.count} possible findings from the carrier's current bill` : ""}`;
    return {
      data: { month: i.month ?? null, status_filter: i.status ?? null, count: findings.length, findings, reconciled_month: month, reconciled, last_reconciled_at: last, preview },
      summary: `${findings.length === 0 ? "No" : findings.length} stored ${scope}; ${state}`,
    };
  },
});

// finding_id is optional only so the registry's all-null sample parses; a call without it is refused.
const DisputeInput = z.object({ finding_id: z.string().startsWith("rcf_").optional() });
type DisputeInput = z.infer<typeof DisputeInput>;
async function disputable(i: DisputeInput, companyId: string, deps: Parameters<WeftCommand["run"]>[2]) {
  if (!i.finding_id) throw new DomainRefusal("DOMAIN_FINDING_REQUIRED", "finding_id is required", "List open findings with benefits.list_findings and pass one id", { finding_id: "rcf_0001" });
  const f = await getFinding(deps.tx, companyId, i.finding_id);
  if (!f) throw notFound("finding", i.finding_id);
  if (f.status !== "open") throw new DomainRefusal("DOMAIN_NOT_OPEN", `Finding ${f.id} is ${f.status}; only open findings can be disputed`, "List open findings with benefits.list_findings", { finding_id: f.id });
  const { names, plans } = await lookups(deps, companyId);
  const msg = disputeMessage(f, f.workerId ? names.get(f.workerId) ?? null : null, f.planId ? plans.get(f.planId) ?? null : null);
  return { f, msg };
}
const disputeFindingCmd = writeCommand({
  name: "benefits.dispute_finding", summary: "Propose a dispute of one reconciliation finding with a drafted carrier message.",
  description: "Draft a dispute message to the simulated carrier for one open reconciliation finding (finding_id). Always a proposal: the preview shows the full message; approval sends it through the email simulator and marks the finding disputed.",
  input: DisputeInput, domain: "benefits", needs: "edit", effect: "external", risk: riskOf("R3"), approval: "always", reversible: false,
  async preview(i: DisputeInput, ctx, deps) {
    const { f, msg } = await disputable(i, ctx.companyId, deps);
    return {
      title: `Dispute ${f.kind.replace(/_/g, " ")} on the ${f.month} ${f.carrier} invoice`,
      diff: [{ label: "Finding status", before: f.status, after: "disputed" }],
      content: [{ label: "To", text: CARRIER_BILLING_EMAIL }, { label: "Subject", text: msg.subject }, { label: "Message to be sent", text: msg.body }],
      moneyCents: null, subjectRef: f.id, subjectHash: sha256Hex(canonicalJson({ id: f.id, status: f.status, billed: f.billedCents, expected: f.expectedCents, deducted: f.deductedCents })),
      evidence: [{ label: "Finding", ref: f.id }],
    };
  },
  async run(i: DisputeInput, ctx, deps) {
    const { f, msg } = await disputable(i, ctx.companyId, deps);
    const { id } = await deps.sims.email.send({ to: CARRIER_BILLING_EMAIL, from: "benefits@larkspur.example", subject: msg.subject, body: msg.body, kind: "generic", relatedRef: f.id });
    await deps.tx.update(benefitReconFindings).set({ status: "disputed" }).where(eq(benefitReconFindings.id, f.id));
    return { data: { finding_id: f.id, status: "disputed", email_id: id, to: CARRIER_BILLING_EMAIL }, summary: `Dispute about the ${f.kind.replace(/_/g, " ")} on the ${f.month} ${f.carrier} invoice emailed to ${CARRIER_BILLING_EMAIL}` };
  },
});

const OeInput = z.object({ status: z.enum(["not_started", "in_progress", "elected", "waived"]).optional(), ...responseFormatField });
type OeInput = z.infer<typeof OeInput>;
const listOpenEnrollmentCmd = readCommand({
  name: "benefits.list_open_enrollment", domain: "benefits",
  summary: "List open enrollment status per eligible employee for the next plan year.",
  description: "List open enrollment rows for the 2027 plan year: employee, status (not_started, in_progress, elected, waived), nudges sent and the last nudge time, optionally filtered by status. The deadline is 2026-11-13.",
  input: OeInput,
  async run(i: OeInput, ctx, deps) {
    const rows = await listOpenEnrollment(deps.tx, ctx.companyId, { status: i.status });
    const counts = rows.reduce<Record<string, number>>((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {});
    return { data: { plan_year: OPEN_ENROLLMENT_PLAN_YEAR, deadline: OPEN_ENROLLMENT_DEADLINE, count: rows.length, counts, people: rows.map((r) => ({ id: r.id, worker: `${r.name} (${r.workerId})`, status: r.status, nudges: r.nudges, last_nudged_at: r.lastNudgedAt })) }, summary: `Listed ${rows.length} open enrollment rows` };
  },
});

/** The channel line is anonymous (benefits participation is personal); each person gets their own email. */
const nudgeText = (n: number) => `Open enrollment for ${OPEN_ENROLLMENT_PLAN_YEAR} closes ${OPEN_ENROLLMENT_DEADLINE}. ${n} ${n === 1 ? "person still needs" : "people still need"} to choose; each has a personal reminder by email. Elect or waive in Benefits.`;
const personalText = (name: string) => `Hi ${name}, open enrollment for ${OPEN_ENROLLMENT_PLAN_YEAR} closes ${OPEN_ENROLLMENT_DEADLINE} and you have not chosen yet. Elect or waive your benefits in Weft Benefits.`;
const NudgeInput = z.object({});
type NudgeInput = z.infer<typeof NudgeInput>;
const nudgeOpenEnrollmentCmd = writeCommand({
  name: "benefits.nudge_open_enrollment", summary: "Remind each person who has not elected, privately, plus an anonymous count in #general.",
  description: "Email a personal reminder to every employee whose 2027 open enrollment is not started or in progress, with the 2026-11-13 deadline, post one anonymous count in #general (no names), and count one nudge for each. Does nothing when everyone has chosen.",
  input: NudgeInput, domain: "comms", needs: "edit", effect: "external", risk: riskOf("R3"), approval: "always", reversible: false,
  async preview(_i: NudgeInput, ctx, deps) {
    const left = await openEnrollmentStragglers(deps.tx, ctx.companyId);
    const text = nudgeText(left.length);
    return { title: `Remind ${left.length} people about open enrollment by email, with an anonymous count in #general`, diff: [], content: [{ label: "Content to be sent", text }, ...(left[0] ? [{ label: "Each personal email reads like", text: personalText(left[0].name) }] : [])], moneyCents: null, subjectRef: "chat:#general", subjectHash: sha256Hex(canonicalJson({ ids: left.map((r) => r.id), at: ctx.now.slice(0, 10) })), evidence: [] };
  },
  async run(_i: NudgeInput, ctx, deps) {
    const left = await openEnrollmentStragglers(deps.tx, ctx.companyId);
    if (left.length === 0) return { data: { nudged: 0, message_id: null }, summary: "Everyone has chosen; no nudge sent" };
    const emails = new Map((await deps.tx.select({ id: workers.id, workEmail: workers.workEmail }).from(workers).where(inArray(workers.id, left.map((r) => r.workerId)))).map((w) => [w.id, w.workEmail]));
    const emailIds: string[] = [];
    for (const r of left) {
      const to = emails.get(r.workerId);
      if (to) emailIds.push((await deps.sims.email.send({ to, from: "benefits@larkspur.example", subject: `Choose your ${OPEN_ENROLLMENT_PLAN_YEAR} benefits by ${OPEN_ENROLLMENT_DEADLINE}`, body: personalText(r.name), kind: "nudge", relatedRef: r.workerId })).id);
    }
    const { id } = await deps.sims.chat.post({ channel: "#general", author: "Weft agent", text: nudgeText(left.length) });
    await recordNudges(deps.tx, left.map((r) => r.id), ctx.now);
    return { data: { nudged: left.length, message_id: id, email_ids: emailIds, workers: left.map((r) => r.workerId) }, summary: `Reminded ${left.length} people by email, with an anonymous count in #general` };
  },
});

export const benefitsCommands: WeftCommand[] = [listPlansCmd, getEnrollment, reconcileCmd, listFindingsCmd, disputeFindingCmd, listOpenEnrollmentCmd, nudgeOpenEnrollmentCmd];

