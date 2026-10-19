// tax.* writes: rate change impact (read), notice-checked rate updates (R2) and their revert, state registration
// with the agency simulator (R3, always) and the system record of its completion (system_only, R1).
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { employerTaxRates, notices, simRegistrations, taxAccounts, workers, type DbTx } from "@weft/db";
import { canonicalJson } from "../shared/canonical-json";
import { sha256Hex } from "../shared/hash";
import type { WeftCommand } from "../shared/deps";
import { DomainRefusal, nextActionSeq, notFound, ptDateOf, rateDisplay, rateSub, readCommand, responseFormatField, riskOf, writeCommand } from "../demo/define";
import { getNotice, parseExtract } from "../notices/queries";
import { refreshOpenDrafts, STALE_SUBMIT_NOTE } from "../payroll/lifecycle";
import { rateChangeImpact } from "./impact";
import { AGENCY_LABELS, CO_NEW_EMPLOYER_RATES, effectiveRate } from "./queries";

const Code = z.enum(["sui", "ett"]);
const Jurisdiction = z.enum(["CA", "NY", "TX", "CO"]);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const RateStr = z.string().regex(/^\d+(\.\d+)?$/);

async function account(tx: DbTx, companyId: string, id: string) {
  const [a] = await tx.select().from(taxAccounts).where(and(eq(taxAccounts.companyId, companyId), eq(taxAccounts.id, id))).limit(1);
  if (!a) throw notFound("tax account", id);
  return a;
}

// tax.rate_change_impact ---------------------------------------------------------------------------------------
const ImpactInput = z.object({ jurisdiction: Jurisdiction, code: Code, new_rate: RateStr, effective_from: isoDate.optional(), ...responseFormatField });
type ImpactInput = z.infer<typeof ImpactInput>;
export const rateChangeImpactCmd = readCommand({
  name: "tax.rate_change_impact", domain: "tax",
  summary: "Effect of a new employer rate on YTD employer tax and the next run.",
  description: "Compute the effect of changing an employer rate (jurisdiction, code, new_rate) from the YTD ledger: rate_delta, affected_count, unaffected_count, YTD employer tax before and after, the credit total, and per-worker cents with displays, plus the change on the open draft run for workers still under the wage base.",
  input: ImpactInput,
  async run(i: ImpactInput, ctx, deps) {
    const date = i.effective_from ?? ptDateOf(ctx.now);
    const cur = await effectiveRate(deps.tx, ctx.companyId, i.jurisdiction, i.code, date);
    if (!cur) throw new DomainRefusal("DOMAIN_NO_CURRENT_RATE", `No ${i.jurisdiction} ${i.code} rate in effect on ${date}`, "Check tax.get_rates for the jurisdiction", null);
    const impact = await rateChangeImpact(deps.tx, { companyId: ctx.companyId, jurisdiction: i.jurisdiction, code: i.code, oldRate: cur.rate, newRate: i.new_rate, year: Number(date.slice(0, 4)), wageBaseCents: cur.wageBaseCents });
    const workersOut = i.response_format === "detailed" ? impact.workers : impact.workers.map((w) => ({ worker_id: w.worker_id, name: w.name, credit_cents: w.credit_cents, credit_display: w.credit_display, next_run_change_cents: w.next_run_change_cents, next_run_change_display: w.next_run_change_display }));
    return { data: { ...impact, current_rate_id: cur.id, workers: workersOut }, summary: `Checked ${impact.employees_in_state} ${i.jurisdiction} employees` };
  },
});

// tax.update_rate --------------------------------------------------------------------------------------------
const UpdateInput = z.object({ tax_account_id: z.string(), code: Code, rate: RateStr, effective_from: isoDate, source_notice_id: z.string() });
type UpdateInput = z.infer<typeof UpdateInput>;

/** Checks the args against the notice's deterministic extract; mismatches refuse with the derived values. */
async function checkAgainstNotice(i: UpdateInput, companyId: string, tx: DbTx) {
  const acct = await account(tx, companyId, i.tax_account_id);
  const n = await getNotice(tx, companyId, i.source_notice_id);
  if (!n) throw notFound("notice", i.source_notice_id);
  const ex = parseExtract(n.extractedJson);
  if (!ex) throw new DomainRefusal("DOMAIN_NO_EXTRACT", `Notice ${n.id} has no extracted fields`, "Only parsed rate notices can drive a rate change", null);
  const r = ex.rates.find((x) => x.code === i.code) ?? ex.rates[0];
  const derived = r && ex.effectiveFrom && n.taxAccountId
    ? { tax_account_id: n.taxAccountId, code: r.code, rate: r.newRate, effective_from: ex.effectiveFrom, source_notice_id: n.id }
    : null;
  const ok = derived && derived.tax_account_id === i.tax_account_id && derived.code === i.code && derived.rate === i.rate && derived.effective_from === i.effective_from && acct.accountNumber === ex.accountNumber;
  if (!ok) {
    const hint = derived ? `The notice ${n.id} says: account ${ex.accountNumber} (${derived.tax_account_id}), ${derived.code} ${derived.rate} (${rateDisplay(derived.rate)}) effective ${derived.effective_from}` : `Notice ${n.id} carries no rate change for ${i.code}`;
    // The message repeats the derived values: an executor that takes hints only from the static errorHints still shows them.
    throw new DomainRefusal("DOMAIN_NOTICE_MISMATCH", `The rate change does not match the notice's extracted fields. ${hint}`, hint, derived);
  }
  if (!["unemployment", "combined"].includes(acct.accountType)) throw new DomainRefusal("DOMAIN_NOT_A_RATE_ACCOUNT", `${acct.id} is a ${acct.accountType} account`, null, derived);
  return { acct, notice: n, extract: ex, oldRate: r!.oldRate };
}

/** True when two decimal rate strings are the same rate ("0.034" and "0.0340"), compared exactly without floats. */
export function sameRate(a: string, b: string): boolean { return rateSub(a, b) === "0"; }

/**
 * The rates a rate-change notice states, when every one is already the rate in effect on the notice's effective date
 * for its account's jurisdiction: the notice confirms them and changes nothing. Null when the notice has no parsed
 * rate, no account or effective date, or any stated rate differs from the one in effect.
 */
export async function ratesAlreadyInEffect(tx: DbTx, companyId: string, n: { kind: string; taxAccountId: string | null; extractedJson: string | null }): Promise<{ code: string; rate: string; rate_id: string; effective_from: string }[] | null> {
  if (n.kind !== "rate_change" || !n.taxAccountId) return null;
  const ex = parseExtract(n.extractedJson);
  if (!ex?.effectiveFrom || !ex.rates.length) return null;
  const [acct] = await tx.select().from(taxAccounts).where(and(eq(taxAccounts.companyId, companyId), eq(taxAccounts.id, n.taxAccountId))).limit(1);
  if (!acct) return null;
  const out: { code: string; rate: string; rate_id: string; effective_from: string }[] = [];
  for (const r of ex.rates) {
    const cur = await effectiveRate(tx, companyId, acct.jurisdiction, r.code, ex.effectiveFrom);
    if (!cur || !sameRate(cur.rate, r.newRate)) return null;
    out.push({ code: r.code, rate: cur.rate, rate_id: cur.id, effective_from: cur.effectiveFrom });
  }
  return out;
}

/**
 * A notice that states the rate already in effect on its effective date changes nothing (review fix group
 * notices-and-proposals): refused in preview and in run, so no proposal reads "3.4% to 3.4%" and no new rate row
 * supersedes an identical one. The notice is acknowledged instead.
 */
function refuseNoChange(jurisdiction: string, code: string, cur: { id: string; rate: string; effectiveFrom: string } | null, rate: string, noticeId: string): void {
  if (!cur || !sameRate(cur.rate, rate)) return;
  throw new DomainRefusal("DOMAIN_NO_CHANGE",
    `${jurisdiction} ${code.toUpperCase()} is already ${rateDisplay(cur.rate)} effective ${cur.effectiveFrom} (${cur.id}); notice ${noticeId} confirms the rate in effect, so there is nothing to change`,
    `Do not propose a rate change: say the notice confirms the ${jurisdiction} ${code.toUpperCase()} rate in effect. A person can record it with notices.acknowledge`,
    { notice_id: noticeId, rate_id: cur.id, rate: cur.rate });
}

export const updateRate = writeCommand({
  name: "tax.update_rate", summary: "Change an employer tax rate from an agency notice.",
  description: "Propose an employer rate change (tax_account_id, code, rate as a decimal string, effective_from) backed by source_notice_id. Checked against the notice's extracted fields; a mismatch is refused with the derived values. R2: always needs approval. The old row is kept (superseded); reversible with tax.revert_rate.",
  input: UpdateInput, domain: "tax", needs: "edit", effect: "write", risk: riskOf("R2"), approval: "always",
  reversible: { reverse: "tax.revert_rate" }, lease: (i) => `rate:${i.tax_account_id}:${i.code}`,
  errorHints: { DOMAIN_NOTICE_MISMATCH: { hint: "Use the account, code, rate and effective date from the notice's extracted fields", example: { tax_account_id: "txa_0002", code: "sui", rate: "0.015", effective_from: "2026-01-01", source_notice_id: "ntc_0002" } } },
  async preview(i, ctx, deps) {
    const { acct, notice } = await checkAgainstNotice(i, ctx.companyId, deps.tx);
    const cur = await effectiveRate(deps.tx, ctx.companyId, acct.jurisdiction, i.code, i.effective_from);
    refuseNoChange(acct.jurisdiction, i.code, cur, i.rate, notice.id);
    const old = cur?.rate ?? "0";
    const impact = await rateChangeImpact(deps.tx, { companyId: ctx.companyId, jurisdiction: acct.jurisdiction, code: i.code, oldRate: old, newRate: i.rate, year: Number(i.effective_from.slice(0, 4)), wageBaseCents: cur?.wageBaseCents ?? 0 });
    const code = i.code.toUpperCase();
    const diff = [
      { label: `${acct.jurisdiction} ${code} rate`, before: rateDisplay(old), after: rateDisplay(i.rate) },
      { label: `YTD employer ${code} (${impact.employees_in_state} ${acct.jurisdiction} employees paid in ${i.effective_from.slice(0, 4)})`, before: impact.ytd_before_display, after: impact.ytd_after_display },
    ];
    if (impact.next_run) diff.push({ label: `Employer ${code} on the ${shortDate(impact.next_run.payday, false)} run (${impact.next_run.affected_count} workers under the wage base)`, before: impact.next_run.before_display, after: impact.next_run.after_display });
    return {
      title: `Update ${acct.jurisdiction} ${code} rate ${rateDisplay(old)} to ${rateDisplay(i.rate)} effective ${shortDate(i.effective_from, true)} on account ${acct.accountNumber} for ${impact.employees_in_state} ${acct.jurisdiction} employees paid in ${i.effective_from.slice(0, 4)}`,
      diff, content: [], moneyCents: null, subjectRef: `${acct.id}:${i.code}`,
      subjectHash: sha256Hex(canonicalJson({ rate: cur?.id ?? null, value: old, notice: notice.id })),
      evidence: [{ label: "Notice", ref: notice.id }, ...(cur ? [{ label: "Current rate", ref: cur.id }] : [])],
    };
  },
  async run(i, ctx, deps) {
    const tx = deps.tx;
    const { acct, notice } = await checkAgainstNotice(i, ctx.companyId, tx);
    const cur = await effectiveRate(tx, ctx.companyId, acct.jurisdiction, i.code, i.effective_from);
    refuseNoChange(acct.jurisdiction, i.code, cur, i.rate, notice.id);
    const seq = await nextActionSeq(tx);
    if (cur && cur.effectiveFrom >= i.effective_from) await tx.update(employerTaxRates).set({ supersededActionSeq: seq }).where(eq(employerTaxRates.id, cur.id));
    else if (cur) await tx.update(employerTaxRates).set({ effectiveTo: dayBeforeIso(i.effective_from) }).where(eq(employerTaxRates.id, cur.id));
    const id = await deps.newId("etr_");
    await tx.insert(employerTaxRates).values({ id, companyId: ctx.companyId, jurisdiction: acct.jurisdiction, code: i.code, rate: i.rate, wageBaseCents: cur?.wageBaseCents ?? 0, effectiveFrom: i.effective_from, effectiveTo: cur?.effectiveFrom && cur.effectiveFrom >= i.effective_from ? cur.effectiveTo : null, source: `notice:${notice.id}`, createdActionSeq: seq, supersededActionSeq: null });
    if (notice.status === "new" || notice.status === "in_review") await tx.update(notices).set({ status: "proposed" }).where(eq(notices.id, notice.id));
    const superseded: string[] = [];
    const refreshed = await refreshOpenDrafts(tx, { newId: deps.newId, now: ctx.now, superseded }, ctx.companyId, i.effective_from);
    return {
      data: { rate_id: id, refreshed_drafts: refreshed, ...(superseded.length ? { superseded_submit_proposals: superseded, superseded_note: STALE_SUBMIT_NOTE } : {}), previous_rate_id: cur?.id ?? null, jurisdiction: acct.jurisdiction, code: i.code, rate: i.rate, rate_display: rateDisplay(i.rate), previous_rate: cur?.rate ?? null, effective_from: i.effective_from, source: `notice:${notice.id}` },
      summary: `Updated ${acct.jurisdiction} ${i.code.toUpperCase()} rate ${cur ? rateDisplay(cur.rate) : "none"} to ${rateDisplay(i.rate)} effective ${i.effective_from} (${id})`,
      reverseArgs: { rate_id: id },
    };
  },
});

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-01-01" to "Jan 1, 2026" (or "Jan 1" without the year). */
function shortDate(iso: string, year: boolean): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return `${MONTHS[(m ?? 1) - 1]} ${d}${year ? `, ${y}` : ""}`;
}

function dayBeforeIso(date: string): string { return new Date(Date.parse(`${date}T12:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10); }

// tax.revert_rate (rollback only) ------------------------------------------------------------------------------
const RevertInput = z.object({ rate_id: z.string() });
export const revertRate = writeCommand({
  name: "tax.revert_rate", summary: "Undo an employer rate change (rollback only).",
  description: "Reverse command of tax.update_rate, run only by a human rollback: supersedes the given rate and inserts a new row restoring the rate it replaced. Every row is kept.",
  input: RevertInput, domain: "tax", needs: "approve", effect: "write", risk: riskOf("R2"), approval: "always", access: "human_only", reversible: false,
  async preview(i, ctx, deps) {
    const [r] = await deps.tx.select().from(employerTaxRates).where(and(eq(employerTaxRates.companyId, ctx.companyId), eq(employerTaxRates.id, i.rate_id))).limit(1);
    if (!r) throw notFound("rate", i.rate_id);
    return { title: `Undo ${r.jurisdiction} ${r.code.toUpperCase()} rate ${rateDisplay(r.rate)} (${r.id})`, diff: [], content: [], moneyCents: null, subjectRef: r.id, subjectHash: sha256Hex(canonicalJson({ rate: r.id, sup: r.supersededActionSeq })), evidence: [{ label: "Rate", ref: r.id }] };
  },
  async run(i, ctx, deps) {
    const tx = deps.tx;
    const [r] = await tx.select().from(employerTaxRates).where(and(eq(employerTaxRates.companyId, ctx.companyId), eq(employerTaxRates.id, i.rate_id))).limit(1);
    if (!r) throw notFound("rate", i.rate_id);
    if (r.supersededActionSeq !== null) throw new DomainRefusal("DOMAIN_ALREADY_SUPERSEDED", `${r.id} is already superseded`, null, null);
    const seq = await nextActionSeq(tx);
    const prior = (await tx.select().from(employerTaxRates).where(and(eq(employerTaxRates.companyId, ctx.companyId), eq(employerTaxRates.jurisdiction, r.jurisdiction), eq(employerTaxRates.code, r.code))).orderBy(asc(employerTaxRates.id)))
      .filter((x) => x.id !== r.id && x.supersededActionSeq !== null && x.effectiveFrom === r.effectiveFrom).at(-1);
    await tx.update(employerTaxRates).set({ supersededActionSeq: seq }).where(eq(employerTaxRates.id, r.id));
    let restored: string | null = null;
    if (prior) {
      restored = await deps.newId("etr_");
      await tx.insert(employerTaxRates).values({ id: restored, companyId: ctx.companyId, jurisdiction: r.jurisdiction, code: r.code, rate: prior.rate, wageBaseCents: prior.wageBaseCents, effectiveFrom: prior.effectiveFrom, effectiveTo: prior.effectiveTo, source: `revert:${r.id}`, createdActionSeq: seq, supersededActionSeq: null });
    }
    const superseded: string[] = [];
    const refreshed = await refreshOpenDrafts(tx, { newId: deps.newId, now: ctx.now, superseded }, ctx.companyId, r.effectiveFrom);
    return { data: { reverted_rate_id: r.id, restored_rate_id: restored, rate: prior?.rate ?? null, refreshed_drafts: refreshed, ...(superseded.length ? { superseded_submit_proposals: superseded } : {}) }, summary: `Reverted ${r.jurisdiction} ${r.code.toUpperCase()} rate ${r.id}${prior ? ` to ${rateDisplay(prior.rate)}` : ""}` };
  },
});

// tax.register_state_account -----------------------------------------------------------------------------------
const RegisterInput = z.object({ tax_account_id: z.string() });
type RegisterInput = z.infer<typeof RegisterInput>;
async function registrable(i: RegisterInput, companyId: string, tx: DbTx) {
  const a = await account(tx, companyId, i.tax_account_id);
  if (a.status !== "not_registered" && a.status !== "needs_info") throw new DomainRefusal("DOMAIN_ALREADY_REGISTERED", `${a.id} is ${a.status}`, "Only not_registered or needs_info accounts can be registered", null);
  if (!a.credentialRef?.startsWith("vault:")) throw new DomainRefusal("DOMAIN_NO_CREDENTIAL", `${a.id} has no portal credential in the vault`, "Ask a human to store the agency portal credential (vault.request)", null);
  return a;
}
export const registerStateAccount = writeCommand({
  name: "tax.register_state_account", summary: "Register a state tax account with the agency simulator.",
  description: "Propose registering a not-yet-registered state account (tax_account_id, from tax.list_registrations) with its agency simulator: withholding or unemployment. R3, always needs approval; not reversible (filed with the agency). The account becomes awaiting_state and activates when the agency completes, about 2 business days later.",
  input: RegisterInput, domain: "tax", needs: "edit", effect: "external", risk: riskOf("R3"), approval: "always", reversible: false,
  lease: (i) => `tax_account:${i.tax_account_id}`,
  async preview(i, ctx, deps) {
    const a = await registrable(i, ctx.companyId, deps.tx);
    const label = AGENCY_LABELS[a.agency] ?? a.agency;
    return { title: `Register ${a.jurisdiction} ${a.accountType} account with ${label} (${a.id})`, diff: [{ label: `${a.jurisdiction} ${a.accountType} account`, before: a.status, after: "awaiting_state" }], content: [], moneyCents: null, subjectRef: a.id, subjectHash: sha256Hex(canonicalJson({ account: a.id, status: a.status })), evidence: [{ label: "Tax account", ref: a.id }] };
  },
  async run(i, ctx, deps) {
    const tx = deps.tx;
    const a = await registrable(i, ctx.companyId, tx);
    const credential = await deps.resolveCredential(a.credentialRef as `vault:${string}`);
    const res = await deps.sims.agency.register({ companyId: ctx.companyId, agency: a.agency as never, accountType: a.accountType as never, credential });
    await tx.update(taxAccounts).set({ status: res.status, simApplicationId: res.applicationId }).where(eq(taxAccounts.id, a.id));
    return {
      data: { tax_account_id: a.id, application_id: res.applicationId, status: res.status, complete_at: res.completeAt, agency: a.agency, not_reversible_reason: "Filed with the agency simulator" },
      summary: `Submitted ${a.jurisdiction} ${a.accountType} registration to ${AGENCY_LABELS[a.agency] ?? a.agency} (${res.applicationId})`,
      events: [{ type: "tax_account.registration_submitted", subjectRef: a.id, payload: { tax_account_id: a.id, application_id: res.applicationId } }],
    };
  },
});

// tax.record_registration (system_only) ------------------------------------------------------------------------
const RecordInput = z.object({ application_id: z.string() });
export const recordRegistration = writeCommand({
  name: "tax.record_registration", summary: "System: record an agency registration result.",
  description: "System command (svc_events): records a completed simulator registration: activates the account with its synthetic number, inserts new-employer rates (source registration:<id>), writes a registration_confirmed notice and emits tax_account.activated. A needs_info result sets the account to needs_info.",
  input: RecordInput, domain: "tax", needs: "edit", effect: "write", risk: riskOf("R1"), approval: "never", access: "system_only", reversible: false,
  preview: null,
  async run(i, ctx, deps) {
    const tx = deps.tx;
    const [reg] = await tx.select().from(simRegistrations).where(eq(simRegistrations.id, i.application_id)).limit(1);
    if (!reg) throw notFound("registration", i.application_id);
    const [a] = await tx.select().from(taxAccounts).where(and(eq(taxAccounts.companyId, ctx.companyId), eq(taxAccounts.simApplicationId, reg.id))).limit(1);
    if (!a) throw notFound("tax account for registration", reg.id);
    if (reg.status === "needs_info" || reg.status === "needs_info_sent") {
      await tx.update(taxAccounts).set({ status: "needs_info" }).where(eq(taxAccounts.id, a.id));
      return { data: { tax_account_id: a.id, status: "needs_info" }, summary: `${a.jurisdiction} ${a.accountType} registration needs information (${reg.id})` };
    }
    if (reg.status !== "completed" || !reg.accountNumber) throw new DomainRefusal("DOMAIN_NOT_COMPLETE", `${reg.id} is ${reg.status}`, null, null);
    if (a.status === "active") return { data: { tax_account_id: a.id, status: "active", account_number: a.accountNumber }, summary: `${a.id} already active` };
    const today = ptDateOf(ctx.now);
    await tx.update(taxAccounts).set({ status: "active", accountNumber: reg.accountNumber, registeredAt: ctx.now }).where(eq(taxAccounts.id, a.id));
    const seq = await nextActionSeq(tx);
    const rateIds: string[] = [];
    if (a.jurisdiction === "CO" && a.accountType === "unemployment") {
      for (const r of CO_NEW_EMPLOYER_RATES) {
        const id = await deps.newId("etr_");
        rateIds.push(id);
        await tx.insert(employerTaxRates).values({ id, companyId: ctx.companyId, jurisdiction: a.jurisdiction, code: r.code, rate: r.rate, wageBaseCents: r.wageBaseCents, effectiveFrom: today.slice(0, 4) + "-01-01", effectiveTo: null, source: `registration:${reg.id}`, createdActionSeq: seq, supersededActionSeq: null });
      }
    }
    const nid = await deps.newId("ntc_");
    const label = AGENCY_LABELS[a.agency] ?? a.agency;
    await tx.insert(notices).values({
      id: nid, companyId: ctx.companyId, agency: a.agency, kind: "registration_confirmed", formCode: "Registration confirmation", title: `${label} registration confirmed`,
      receivedAt: ctx.now, respondBy: null, status: "resolved", taxAccountId: a.id, fileName: `${a.agency.toUpperCase()}_REGISTRATION_${reg.id}.txt`,
      bodyText: `SIMULATED AGENCY NOTICE. Generated by the Weft ${label} simulator. Not a real government document.\n\nRegistration complete for Larkspur Robotics, Inc. (demo).\nAccount type: ${a.accountType}\nEmployer Account Number: ${reg.accountNumber}\nApplication: ${reg.id}\n`,
      extractedJson: JSON.stringify({ agency: a.agency, formCode: "Registration confirmation", kind: "registration_confirmed", accountNumber: reg.accountNumber, taxAccountId: a.id, taxYear: null, effectiveFrom: today, respondBy: null, rates: [], amountCents: null, period: null }),
      draftsJson: "[]", resolutionJson: JSON.stringify({ outcome: "account_activated", application_id: reg.id }), responseConfirmation: null,
    });
    const affected = (await tx.select({ id: workers.id }).from(workers).where(and(eq(workers.companyId, ctx.companyId), eq(workers.workState, a.jurisdiction)))).map((w) => w.id).sort();
    return {
      data: { tax_account_id: a.id, status: "active", account_number: reg.accountNumber, rate_ids: rateIds, notice_id: nid, worker_ids: affected },
      summary: `Activated ${a.jurisdiction} ${a.accountType} account ${reg.accountNumber} (${a.id})`,
      events: [{ type: "tax_account.activated", subjectRef: a.id, payload: { tax_account_id: a.id, worker_ids: affected.join(",") } }],
    };
  },
});

export const taxWriteCommands: WeftCommand[] = [rateChangeImpactCmd, updateRate, revertRate, registerStateAccount, recordRegistration];
