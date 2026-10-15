// people.* writes: pay rate changes (R2, reversible) and the demo offer acceptance (human_only).
import { and, eq, isNull, lt, desc, sql } from "drizzle-orm";
import { z } from "zod";
import { formatCents } from "@weft/contracts";
import { bankAccounts, offers, onboardingTasks, payRates, taxProfiles, workers } from "@weft/db";
import { canonicalJson } from "../shared/canonical-json";
import { sha256Hex } from "../shared/hash";
import type { WeftCommand } from "../shared/deps";
import { dayBefore, DomainRefusal, nextActionSeq, notFound, riskOf, writeCommand } from "../demo/define";
import { nameRef, workEmail } from "./names";
import { currentPayRate, getWorker } from "./queries";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const per = (kind: string) => (kind === "hourly" ? "an hour" : kind === "contract_monthly" ? "a month" : "a year");

const SetPayInput = z.object({ worker_id: z.string(), amount_cents: z.number().int(), effective_from: isoDate });
type SetPayInput = z.infer<typeof SetPayInput>;

async function payContext(i: SetPayInput, companyId: string, tx: Parameters<WeftCommand["run"]>[2]["tx"]) {
  const w = await getWorker(tx, companyId, i.worker_id);
  if (!w) throw notFound("worker", i.worker_id);
  if (i.amount_cents <= 0) throw new DomainRefusal("DOMAIN_BAD_AMOUNT", "amount_cents must be positive", "Pass the new annual salary (or hourly rate) in cents", { worker_id: i.worker_id, amount_cents: 13_924_000, effective_from: i.effective_from });
  const current = await currentPayRate(tx, w.id, dayBefore(i.effective_from)) ?? await currentPayRate(tx, w.id, i.effective_from);
  return { w, current };
}

export const setPayRate = writeCommand({
  name: "people.set_pay_rate", summary: "Change a worker's pay rate from an effective date.",
  description: "Propose a new pay rate for worker_id: amount_cents (annual salary or hourly rate, same kind as today) effective from effective_from. Closes the current rate the day before. R2: always needs a human approval; reversible with people.revert_pay_rate.",
  input: SetPayInput, domain: "people", needs: "edit", effect: "write", risk: riskOf("R2"), approval: "always",
  reversible: { reverse: "people.revert_pay_rate" }, lease: (i) => `worker:${i.worker_id}:pay`,
  async preview(i, ctx, deps) {
    const { w, current } = await payContext(i, ctx.companyId, deps.tx);
    const kind = current?.kind ?? "salary";
    const before = current ? formatCents(current.amountCents) : "none";
    return {
      title: `Change pay for ${nameRef(w.firstName, w.lastName, w.id)} to ${formatCents(i.amount_cents)} ${per(kind)} from ${i.effective_from}`,
      diff: [{ label: kind === "hourly" ? "Hourly rate" : "Annual salary", before, after: formatCents(i.amount_cents) }],
      content: [], moneyCents: null, subjectRef: w.id,
      subjectHash: sha256Hex(canonicalJson({ worker: w.id, rate: current?.id ?? null, amount: current?.amountCents ?? null })),
      evidence: current ? [{ label: "Current pay rate", ref: current.id }] : [],
    };
  },
  async run(i, ctx, deps) {
    const { w, current } = await payContext(i, ctx.companyId, deps.tx);
    const tx = deps.tx;
    const open = await tx.select().from(payRates).where(and(eq(payRates.workerId, w.id), isNull(payRates.effectiveTo), lt(payRates.effectiveFrom, i.effective_from)));
    for (const r of open) await tx.update(payRates).set({ effectiveTo: dayBefore(i.effective_from) }).where(eq(payRates.id, r.id));
    const id = await deps.newId("prt_");
    const kind = current?.kind ?? "salary";
    await tx.insert(payRates).values({ id, workerId: w.id, kind, amountCents: i.amount_cents, currency: current?.currency ?? "USD", effectiveFrom: i.effective_from, effectiveTo: null, createdActionSeq: await nextActionSeq(tx) });
    await tx.update(workers).set({ updatedAt: ctx.now }).where(eq(workers.id, w.id));
    return {
      data: { pay_rate_id: id, worker_id: w.id, previous_pay_rate_id: current?.id ?? null, amount_cents: i.amount_cents, amount_display: formatCents(i.amount_cents), effective_from: i.effective_from, closed_pay_rate_ids: open.map((r) => r.id) },
      summary: `Set pay for ${nameRef(w.firstName, w.lastName, w.id)} to ${formatCents(i.amount_cents)} ${per(kind)} from ${i.effective_from}`,
      reverseArgs: { pay_rate_id: id },
      events: [{ type: "pay_rate.created", subjectRef: w.id, payload: { worker_id: w.id, pay_rate_id: id } }],
    };
  },
});

const RevertPayInput = z.object({ pay_rate_id: z.string() });
export const revertPayRate = writeCommand({
  name: "people.revert_pay_rate", summary: "Undo a pay rate change (rollback only).",
  description: "Reverse command of people.set_pay_rate, run only by a human rollback: ends the given rate before it starts and reopens the rate it replaced.",
  input: RevertPayInput, domain: "people", needs: "approve", effect: "write", risk: riskOf("R2"), approval: "always", access: "human_only", reversible: false,
  async preview(i, ctx, deps) {
    const [r] = await deps.tx.select().from(payRates).where(eq(payRates.id, i.pay_rate_id)).limit(1);
    if (!r) throw notFound("pay rate", i.pay_rate_id);
    return { title: `Undo pay rate ${r.id} (${formatCents(r.amountCents)} from ${r.effectiveFrom})`, diff: [], content: [], moneyCents: null, subjectRef: r.workerId, subjectHash: sha256Hex(canonicalJson({ rate: r.id, to: r.effectiveTo })), evidence: [{ label: "Pay rate", ref: r.id }] };
  },
  async run(i, ctx, deps) {
    const tx = deps.tx;
    const [r] = await tx.select().from(payRates).where(eq(payRates.id, i.pay_rate_id)).limit(1);
    if (!r) throw notFound("pay rate", i.pay_rate_id);
    const w = await getWorker(tx, ctx.companyId, r.workerId);
    if (!w) throw notFound("worker", r.workerId);
    await tx.update(payRates).set({ effectiveTo: dayBefore(r.effectiveFrom) }).where(eq(payRates.id, r.id));
    const [prev] = await tx.select().from(payRates).where(and(eq(payRates.workerId, r.workerId), eq(payRates.effectiveTo, dayBefore(r.effectiveFrom)), sql`${payRates.id} != ${r.id}`)).orderBy(desc(payRates.effectiveFrom)).limit(1);
    if (prev) await tx.update(payRates).set({ effectiveTo: null }).where(eq(payRates.id, prev.id));
    return { data: { reverted_pay_rate_id: r.id, restored_pay_rate_id: prev?.id ?? null }, summary: `Reverted pay rate ${r.id} for ${nameRef(w.firstName, w.lastName, w.id)}` };
  },
});

// Demo self-onboarding bundle (SPEC 9.2): W-4 single, CO state profile, Sim Federal Credit Union account. HR-entered.
export const DEMO_BUNDLE = { w4: { version: "2020", filingStatus: "single" }, bank: { name: "Sim Federal Credit Union" } } as const;
const STATE_TZ: Record<string, string> = { CA: "America/Los_Angeles", NY: "America/New_York", TX: "America/Chicago", CO: "America/Denver" };

export const ONBOARDING_TEMPLATE = [
  { kind: "sign_offer", owner: "employee", done: true },
  { kind: "federal_w4", owner: "employee", done: true },
  { kind: "state_withholding", owner: "employee", done: true },
  { kind: "direct_deposit", owner: "employee", done: true },
  { kind: "i9_sim", owner: "hr", done: false },
  { kind: "benefits_selection", owner: "employee", done: false },
  { kind: "it_accounts", owner: "agent", done: false },
  { kind: "device", owner: "agent", done: false },
  { kind: "state_registration", owner: "agent", done: false },
] as const;

const AcceptInput = z.object({ offer_id: z.string() });
type AcceptInput = z.infer<typeof AcceptInput>;

async function loadSentOffer(i: AcceptInput, companyId: string, tx: Parameters<WeftCommand["run"]>[2]["tx"]) {
  const [o] = await tx.select().from(offers).where(and(eq(offers.companyId, companyId), eq(offers.id, i.offer_id))).limit(1);
  if (!o) throw notFound("offer", i.offer_id);
  if (o.status !== "sent") throw new DomainRefusal("DOMAIN_OFFER_NOT_SENT", `Offer ${o.id} is ${o.status}, not sent`, "Only a sent offer can be accepted", null);
  return o;
}

export const acceptOffer = writeCommand({
  name: "people.accept_offer", summary: "Demo control: mark an offer accepted and create the onboarding worker.",
  description: "Demo control (human only): marks a sent offer accepted, creates the worker as onboarding with the next employee number, the pay rate, the checklist and the demo self-onboarding bundle (W-4 single, state profile, Sim Federal Credit Union account), then emits offer.accepted.",
  input: AcceptInput, domain: "people", needs: "edit", effect: "write", risk: riskOf("R2"), approval: "always", access: "human_only", reversible: false,
  async preview(i, ctx, deps) {
    const o = await loadSentOffer(i, ctx.companyId, deps.tx);
    return { title: `Mark offer ${o.id} accepted for ${nameRef(o.candidateFirst, o.candidateLast, o.id)} starting ${o.startDate}`, diff: [{ label: "Offer status", before: o.status, after: "accepted" }], content: [], moneyCents: null, subjectRef: o.id, subjectHash: sha256Hex(canonicalJson({ offer: o.id, status: o.status })), evidence: [{ label: "Offer", ref: o.id }] };
  },
  async run(i, ctx, deps) {
    const tx = deps.tx;
    const o = await loadSentOffer(i, ctx.companyId, tx);
    const now = ctx.now;
    const wid = await deps.newId("wrk_");
    const [{ n }] = await tx.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM workers WHERE company_id = ${ctx.companyId} AND employee_number IS NOT NULL`) as [{ n: number }];
    const employeeNumber = `EMP-${String(n + 1).padStart(4, "0")}`;
    const seq = await nextActionSeq(tx);
    await tx.insert(workers).values({
      id: wid, companyId: ctx.companyId, employeeNumber, type: "employee", workerType: "us_w2", status: "onboarding",
      firstName: o.candidateFirst, lastName: o.candidateLast, preferredName: null, personalEmail: null, homeAddressJson: null,
      workEmail: workEmail(o.candidateFirst, o.candidateLast), title: o.title, departmentId: o.departmentId, managerId: o.managerId,
      workplaceId: o.workplaceId, workState: o.workState, country: "US", currency: "USD", timezone: STATE_TZ[o.workState] ?? "America/Los_Angeles",
      startDate: o.startDate, endDate: null, ssnLast4: null, payScheduleId: "ps_us_semimonthly", createdAt: now, updatedAt: now,
    });
    const prt = await deps.newId("prt_");
    await tx.insert(payRates).values({ id: prt, workerId: wid, kind: o.payKind, amountCents: o.baseCents, currency: "USD", effectiveFrom: o.startDate, effectiveTo: null, createdActionSeq: seq });
    await tx.insert(taxProfiles).values({ workerId: wid, w4Version: "2020", filingStatus: "single", step2Checkbox: false, step3Cents: 0, step4aCents: 0, step4bCents: 0, step4cCents: 0, allowances: 0, stateFilingStatus: o.workState === "CO" ? null : "single", stateAllowances: 0, exempt: false, source: "demo_bundle" });
    const bnk = await deps.newId("bnk_");
    const digits = wid.replace(/\D/g, "").padStart(4, "0").slice(-4);
    await tx.insert(bankAccounts).values({ id: bnk, workerId: wid, bankName: DEMO_BUNDLE.bank.name, accountLast4: digits, routingLast4: "0000", credentialRef: `vault:bank-${wid}`, status: "active", source: "demo_bundle" });
    const tasks: string[] = [];
    for (const t of ONBOARDING_TEMPLATE) {
      const id = await deps.newId("obt_");
      tasks.push(id);
      await tx.insert(onboardingTasks).values({ id, workerId: wid, kind: t.kind, status: t.done ? "done" : "pending", owner: t.owner, dueOn: o.startDate, doneAt: t.done ? now : null, blockedReason: null });
    }
    await tx.update(offers).set({ status: "accepted", acceptedAt: now, workerId: wid }).where(eq(offers.id, o.id));
    return {
      data: { offer_id: o.id, worker_id: wid, employee_number: employeeNumber, pay_rate_id: prt, bank_account_id: bnk, onboarding_task_ids: tasks, status: "onboarding" },
      summary: `Accepted offer ${o.id}: created ${nameRef(o.candidateFirst, o.candidateLast, wid)} (${employeeNumber}) as onboarding`,
      events: [
        { type: "worker.created", subjectRef: wid, payload: { worker_id: wid } },
        { type: "offer.accepted", subjectRef: o.id, payload: { offer_id: o.id, worker_id: wid } },
      ],
    };
  },
});

// people.update_profile ----------------------------------------------------------------------------------------
// Employee-editable fields (preferred name, personal email, home address) are untrusted text (harness 6.2), so the
// command is human_only: no agent or MCP caller ever writes them, and the output names the changed fields only.
const Address = z.object({ line1: z.string().min(1).max(120), line2: z.string().max(120).optional(), city: z.string().min(1).max(80), state: z.string().regex(/^[A-Z]{2}$/), postal_code: z.string().regex(/^\d{5}$/) }).strict();
const ProfileInput = z.object({
  worker_id: z.string(),
  preferred_name: z.string().max(80).optional(),
  personal_email: z.string().max(120).regex(/^[^@\s]+@[a-z0-9.-]+\.example$/i, "use a *.example address (demo data)").optional(),
  home_address: Address.optional(),
});
export const updateProfile = writeCommand({
  name: "people.update_profile", summary: "Edit a worker's own profile fields (preferred name, personal email, home address).",
  description: "Human only: sets the employee-editable profile fields preferred_name, personal_email (a *.example address) and home_address. Empty preferred_name or personal_email clears the field. These fields are untrusted text; the result lists the changed field names only.",
  input: ProfileInput, domain: "people", needs: "edit", effect: "write", risk: riskOf("R1"), approval: "never", access: "human_only", reversible: false,
  lease: (i) => `worker:${i.worker_id}:profile`, preview: null,
  async run(i, ctx, deps) {
    const w = await getWorker(deps.tx, ctx.companyId, i.worker_id);
    if (!w) throw notFound("worker", i.worker_id);
    const set: Partial<typeof workers.$inferInsert> = {};
    if (i.preferred_name !== undefined) set.preferredName = i.preferred_name.trim() || null;
    if (i.personal_email !== undefined) set.personalEmail = i.personal_email.trim() || null;
    if (i.home_address !== undefined) set.homeAddressJson = JSON.stringify(i.home_address);
    const fields = Object.keys(set).map((k) => ({ preferredName: "preferred_name", personalEmail: "personal_email", homeAddressJson: "home_address" })[k as "preferredName"]).sort();
    if (fields.length === 0) throw new DomainRefusal("DOMAIN_NOTHING_TO_UPDATE", "No profile field given", "Pass preferred_name, personal_email or home_address", { worker_id: w.id, preferred_name: "Sam" });
    await deps.tx.update(workers).set({ ...set, updatedAt: ctx.now }).where(eq(workers.id, w.id));
    return { data: { worker_id: w.id, updated: fields }, summary: `Updated ${fields.join(", ")} for ${nameRef(w.firstName, w.lastName, w.id)}` };
  },
});
