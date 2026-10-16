// New-hire portal commands (w2-onboarding): click-to-sign, Form W-4, the state certificate, direct deposit, the I-9
// simulation and the benefits election. All are human only and act on the calling persona's own record.
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  BenefitsSelection, I9Submission, PORTAL_TASK_ORDER, Refused, STATE_WITHHOLDING_FORMS, StateWithholdingSubmission, W4Submission,
  type ExecContext, type PortalTaskKind,
} from "@weft/contracts";
import {
  bankAccounts, benefitEnrollments, benefitPlans, documents, offers, onboardingSubmissions, onboardingTasks, payRates, signatures, taxProfiles, uploads, workers, type DbTx,
} from "@weft/db";
import { canonicalJson } from "../shared/canonical-json";
import { sha256Hex } from "../shared/hash";
import type { CommandDeps } from "../shared/deps";
import { DomainRefusal, nextActionSeq, notFound, riskOf, writeCommand } from "../demo/define";
import { displayName, workEmail } from "../people/names";
import { docSha, formRecordText } from "../documents/templates";
import { assertTransition, isPastExpiry } from "./offers";
import { legalName, loadPersona, normName, requirePersona, type Persona } from "./persona";
import { envelopeSignatures, refuseBuiltinWhenEnveloped } from "../esign/envelopes";

type Event = { type: string; subjectRef: string; payload: Record<string, string> };
const STATE_TZ: Record<string, string> = { CA: "America/Los_Angeles", NY: "America/New_York", TX: "America/Chicago", CO: "America/Denver" };
/** Tasks the agent's new-hire routine completes (wave 1 rt_new_hire); they do not gate activation. */
const AGENT_TASKS = ["it_accounts", "device", "state_registration"] as const;

/** Portal tasks for a work state, in PORTAL_TASK_ORDER; state_withholding only when the state has a form. */
export function portalKindsFor(state: string | null): PortalTaskKind[] {
  return PORTAL_TASK_ORDER.filter((k) => k !== "state_withholding" || (state !== null && (STATE_WITHHOLDING_FORMS[state] ?? null) !== null));
}

function checkTypedName(p: Persona, typed: string) {
  if (normName(typed) !== normName(legalName(p.offer))) {
    throw new DomainRefusal("DOMAIN_NAME_MISMATCH", "The typed name does not match the legal name on the offer", `Type your full legal name: ${legalName(p.offer)}`, null);
  }
}

async function requireHired(tx: DbTx, p: Persona) {
  const [w] = await tx.select().from(workers).where(eq(workers.id, p.workerId)).limit(1);
  if (!w || p.offer.status !== "accepted") throw new DomainRefusal("DOMAIN_SIGN_OFFER_FIRST", "Sign the offer letter first", "The checklist opens once the offer is signed", null);
  return w;
}

async function openTask(tx: DbTx, workerId: string, kind: PortalTaskKind) {
  const [t] = await tx.select().from(onboardingTasks).where(and(eq(onboardingTasks.workerId, workerId), eq(onboardingTasks.kind, kind))).limit(1);
  if (!t) throw new DomainRefusal("DOMAIN_NO_TASK", `No ${kind} task on this checklist`, null, null);
  if (t.status === "done") throw new DomainRefusal("DOMAIN_ALREADY_SUBMITTED", `${kind} is already done`, "Ask HR to reopen it", null);
  return t;
}

/** Marks a portal task done and, when every employee task is done, turns the worker active. */
export async function completePortalTask(tx: DbTx, workerId: string, kind: PortalTaskKind, now: string): Promise<{ events: Event[]; activated: boolean }> {
  await tx.update(onboardingTasks).set({ status: "done", doneAt: now, blockedReason: null }).where(and(eq(onboardingTasks.workerId, workerId), eq(onboardingTasks.kind, kind)));
  const events: Event[] = [{ type: "onboarding.task_completed", subjectRef: workerId, payload: { worker_id: workerId, kind } }];
  const all = await tx.select().from(onboardingTasks).where(eq(onboardingTasks.workerId, workerId));
  const activated = all.filter((t) => t.owner === "employee").every((t) => t.status === "done");
  if (activated) {
    await tx.update(workers).set({ status: "active", updatedAt: now }).where(and(eq(workers.id, workerId), eq(workers.status, "onboarding")));
    events.push({ type: "worker.onboarding_completed", subjectRef: workerId, payload: { worker_id: workerId } });
  }
  return { events, activated };
}

/** A server-written, signed form record: document plus signature row, with the same signer, time and hash. */
async function signedRecord(deps: CommandDeps, ctx: ExecContext, p: Persona, kind: string, title: string, lines: [string, string][]) {
  const body = formRecordText(title, legalName(p.offer), lines);
  const id = await deps.newId("doc_");
  const sha = docSha(body);
  await deps.tx.insert(documents).values({ id, companyId: ctx.companyId, workerId: p.workerId, offerId: p.offer.id, kind, title, status: "signed", bodyText: body, sha256: sha, createdAt: ctx.now, sentAt: ctx.now, signedAt: ctx.now });
  const sig = await deps.newId("sig_");
  await deps.tx.insert(signatures).values({ id: sig, documentId: id, signerPrincipalId: p.principal.id, signerName: p.principal.display, typedName: legalName(p.offer), signedAt: ctx.now, documentSha256: sha, actionSeq: await nextActionSeq(deps.tx) });
  return { documentId: id, signatureId: sig, sha };
}

async function submission(deps: CommandDeps, ctx: ExecContext, workerId: string, kind: string, masked: Record<string, unknown>, documentId: string | null) {
  const id = await deps.newId("obs_");
  await deps.tx.insert(onboardingSubmissions).values({ id, workerId, kind, maskedJson: JSON.stringify(masked), documentId, submittedAt: ctx.now, actionSeq: await nextActionSeq(deps.tx) });
  return id;
}

const sigLine = (p: Persona, now: string, sha: string) => `signed by ${p.principal.display} (${p.principal.id}) at ${now}, sha256 ${sha}`;

// documents.sign -----------------------------------------------------------------------------------
const SignInput = z.object({ document_id: z.string(), typed_name: z.string().min(2).max(120), document_sha256: z.string().regex(/^[0-9a-f]{64}$/) });

async function acceptOffer(deps: CommandDeps, ctx: ExecContext, p: Persona): Promise<Event[]> {
  const tx = deps.tx, o = p.offer, now = ctx.now;
  assertTransition(o, "accepted");
  const rows = await tx.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM workers WHERE company_id = ${ctx.companyId} AND employee_number IS NOT NULL`);
  const employeeNumber = `EMP-${String((rows[0]?.n ?? 0) + 1).padStart(4, "0")}`;
  await tx.insert(workers).values({
    id: p.workerId, companyId: ctx.companyId, employeeNumber, type: "employee", workerType: "us_w2", status: "onboarding",
    firstName: o.candidateFirst, lastName: o.candidateLast, preferredName: null, personalEmail: o.candidateEmail, homeAddressJson: null,
    workEmail: workEmail(o.candidateFirst, o.candidateLast), title: o.title, departmentId: o.departmentId, managerId: o.managerId,
    workplaceId: o.workplaceId, workState: o.workState, country: "US", currency: "USD", timezone: STATE_TZ[o.workState] ?? "America/Los_Angeles",
    startDate: o.startDate, endDate: null, ssnLast4: null, payScheduleId: "ps_us_semimonthly", createdAt: now, updatedAt: now,
  });
  await tx.insert(payRates).values({ id: await deps.newId("prt_"), workerId: p.workerId, kind: o.payKind, amountCents: o.baseCents, currency: "USD", effectiveFrom: o.startDate, effectiveTo: null, createdActionSeq: await nextActionSeq(tx) });
  for (const kind of portalKindsFor(o.workState)) {
    await tx.insert(onboardingTasks).values({ id: await deps.newId("obt_"), workerId: p.workerId, kind, status: "pending", owner: "employee", dueOn: o.startDate, doneAt: null, blockedReason: null });
  }
  for (const kind of AGENT_TASKS) {
    await tx.insert(onboardingTasks).values({ id: await deps.newId("obt_"), workerId: p.workerId, kind, status: "pending", owner: "agent", dueOn: o.startDate, doneAt: null, blockedReason: null });
  }
  await tx.update(offers).set({ status: "accepted", acceptedAt: now, workerId: p.workerId }).where(eq(offers.id, o.id));
  p.offer = { ...o, status: "accepted", acceptedAt: now, workerId: p.workerId };
  return [
    { type: "worker.created", subjectRef: p.workerId, payload: { worker_id: p.workerId } },
    { type: "offer.accepted", subjectRef: o.id, payload: { offer_id: o.id, worker_id: p.workerId } },
  ];
}

/**
 * Wave 3 (w3-integrations-screening-esign): acceptance from a completed e-signature envelope. The same acceptance as the
 * built-in signature (worker, pay rate, checklist), then one signature row per document with the envelope as evidence.
 * Called only by documents.apply_esign_event after a re-read shows the envelope completed.
 */
export async function acceptFromEnvelope(deps: CommandDeps, ctx: ExecContext, offerId: string, personaId: string): Promise<Event[]> {
  const p = await loadPersona(deps.tx, ctx.companyId, personaId);
  if (!p || p.offer.id !== offerId) throw new DomainRefusal("DOMAIN_ESIGN_SIGNER", `The envelope signer ${personaId} is not the persona of ${offerId}`, null, null);
  const events = await acceptOffer(deps, ctx, p);
  const sigs = await envelopeSignatures(deps, ctx, offerId, personaId, legalName(p.offer));
  for (const kind of ["sign_offer", "sign_confidentiality"] as const) events.push(...(await completePortalTask(deps.tx, p.workerId, kind, ctx.now)).events);
  const docs = await deps.tx.select().from(documents).where(eq(documents.offerId, offerId));
  for (const d of docs.filter((x) => x.kind === "offer_letter" || x.kind === "confidentiality_agreement")) events.push({ type: "document.signed", subjectRef: d.id, payload: { document_id: d.id, worker_id: p.workerId } });
  void sigs;
  return events;
}

export const signDocument = writeCommand({
  name: "documents.sign", summary: "Sign a document by typing your name (new hire portal only).",
  description: "Human only, new hire persona: signs document_id with typed_name (the legal name on the offer) and document_sha256, the hash of the text the signer saw. The server recomputes the hash and refuses STALE_SUBJECT on a mismatch. Signing the offer letter accepts the offer and creates the worker as onboarding.",
  input: SignInput, domain: "people", needs: "view", effect: "write", risk: riskOf("R2"), approval: "always", access: "human_only", reversible: false,
  lease: (i) => `document:${i.document_id}`,
  async preview(i, ctx, deps) {
    const [d] = await deps.tx.select().from(documents).where(and(eq(documents.companyId, ctx.companyId), eq(documents.id, i.document_id))).limit(1);
    if (!d) throw notFound("document", i.document_id);
    return { title: `Sign ${d.title}`, diff: [{ label: "Document status", before: d.status, after: "signed" }], content: [], moneyCents: null, subjectRef: d.id, subjectHash: d.sha256, evidence: [{ label: "Document", ref: d.id }] };
  },
  async run(i, ctx, deps) {
    const tx = deps.tx;
    const p = await requirePersona(tx, ctx);
    const [d] = await tx.select().from(documents).where(and(eq(documents.companyId, ctx.companyId), eq(documents.id, i.document_id))).limit(1);
    if (!d || d.workerId !== p.workerId) throw notFound("document", i.document_id);
    if (d.status === "signed") throw new DomainRefusal("DOMAIN_ALREADY_SIGNED", `${d.id} is already signed`, null, null);
    if (d.status !== "sent") throw new DomainRefusal("DOMAIN_DOCUMENT_NOT_SIGNABLE", `${d.id} is ${d.status}`, null, null);
    if (d.kind !== "offer_letter" && d.kind !== "confidentiality_agreement") throw new DomainRefusal("DOMAIN_DOCUMENT_NOT_SIGNABLE", `${d.kind} is signed through its own form`, null, null);
    const recomputed = docSha(d.bodyText);
    if (recomputed !== d.sha256 || recomputed !== i.document_sha256) {
      throw new Refused("STALE_SUBJECT", `The document text changed: the signer saw sha256 ${i.document_sha256}, the server has ${recomputed}`, { hint: "Reload the document and sign again" });
    }
    checkTypedName(p, i.typed_name);
    // Wave 3: an offer sent as an e-signature envelope is accepted only from the completed envelope.
    await refuseBuiltinWhenEnveloped(tx, p.offer.id);
    const events: Event[] = [];
    if (d.kind === "offer_letter") {
      if (isPastExpiry(p.offer, ctx.now) || p.offer.status === "expired") throw new DomainRefusal("DOMAIN_OFFER_EXPIRED", `Offer ${p.offer.id} expired on ${p.offer.expiresOn}`, null, null);
      if (p.offer.status === "sent") throw new DomainRefusal("DOMAIN_OFFER_NOT_VIEWED", `Offer ${p.offer.id} has not been opened`, "Open the offer in the portal first", null);
      events.push(...await acceptOffer(deps, ctx, p));
    } else {
      await requireHired(tx, p);
    }
    const seq = await nextActionSeq(tx);
    const sigId = await deps.newId("sig_");
    await tx.insert(signatures).values({ id: sigId, documentId: d.id, signerPrincipalId: p.principal.id, signerName: p.principal.display, typedName: i.typed_name.trim(), signedAt: ctx.now, documentSha256: recomputed, actionSeq: seq });
    await tx.update(documents).set({ status: "signed", signedAt: ctx.now }).where(eq(documents.id, d.id));
    events.push({ type: "document.signed", subjectRef: d.id, payload: { document_id: d.id, worker_id: p.workerId } });
    const done = await completePortalTask(tx, p.workerId, d.kind === "offer_letter" ? "sign_offer" : "sign_confidentiality", ctx.now);
    events.push(...done.events);
    return {
      data: { signature_id: sigId, document_id: d.id, kind: d.kind, signer_principal_id: p.principal.id, signer_name: p.principal.display, signed_at: ctx.now, document_sha256: recomputed, offer_status: p.offer.status, worker_id: p.workerId, action_seq: seq },
      summary: `${d.title} ${sigLine(p, ctx.now, recomputed)}`,
      events,
    };
  },
});

// documents.submit_w4 ---------------------------------------------------------------------------------------
const FILING_LABEL: Record<string, string> = { single: "Single or married filing separately", mfj: "Married filing jointly", hoh: "Head of household" };
const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;
export const submitW4 = writeCommand({
  name: "documents.submit_w4", summary: "Submit Form W-4 (new hire portal only).",
  description: "Human only, new hire persona: submits the 2020 or later Form W-4 (filing status, step 2 checkbox, steps 3 and 4 in cents, exempt) signed with the typed legal name. Writes tax_profiles with source portal and completes federal_w4.",
  input: W4Submission, domain: "people", needs: "view", effect: "write", risk: riskOf("R1"), approval: "never", access: "human_only", reversible: false, preview: null,
  async run(i, ctx, deps) {
    const tx = deps.tx;
    const p = await requirePersona(tx, ctx);
    const w = await requireHired(tx, p);
    await openTask(tx, w.id, "federal_w4");
    checkTypedName(p, i.typedName);
    const fed = { w4Version: "2020", filingStatus: i.filingStatus, step2Checkbox: i.step2Checkbox, step3Cents: i.step3Cents, step4aCents: i.step4aCents, step4bCents: i.step4bCents, step4cCents: i.step4cCents, exempt: i.exempt ?? false, source: "portal" };
    const [existing] = await tx.select().from(taxProfiles).where(eq(taxProfiles.workerId, w.id)).limit(1);
    if (existing) await tx.update(taxProfiles).set(fed).where(eq(taxProfiles.workerId, w.id));
    else await tx.insert(taxProfiles).values({ workerId: w.id, ...fed, allowances: 0, stateFilingStatus: null, stateAllowances: 0 });
    const rec = await signedRecord(deps, ctx, p, "w4", "Form W-4 (2026), employee's withholding certificate", [
      ["Step 1(c) filing status", FILING_LABEL[i.filingStatus] ?? i.filingStatus], ["Step 2(c) two jobs", i.step2Checkbox ? "checked" : "not checked"],
      ["Step 3 dependents", dollars(i.step3Cents)], ["Step 4(a) other income", dollars(i.step4aCents)], ["Step 4(b) deductions", dollars(i.step4bCents)],
      ["Step 4(c) extra withholding per period", dollars(i.step4cCents)], ["Exempt", i.exempt ? "yes" : "no"],
    ]);
    await submission(deps, ctx, w.id, "federal_w4", { filingStatus: i.filingStatus, step2Checkbox: i.step2Checkbox, step3Cents: i.step3Cents, step4aCents: i.step4aCents, step4bCents: i.step4bCents, step4cCents: i.step4cCents, exempt: i.exempt ?? false }, rec.documentId);
    const done = await completePortalTask(tx, w.id, "federal_w4", ctx.now);
    return { data: { worker_id: w.id, document_id: rec.documentId, filing_status: i.filingStatus, source: "portal", activated: done.activated }, summary: `Form W-4 for ${displayName(w.firstName, w.lastName)} ${sigLine(p, ctx.now, rec.sha)}`, events: done.events };
  },
});

// documents.submit_state_withholding ------------------------------------------------------------------------
export const submitStateWithholding = writeCommand({
  name: "documents.submit_state_withholding", summary: "Submit the work state's withholding certificate (new hire portal only).",
  description: "Human only, new hire persona: submits the state certificate (DE 4 for CA, IT-2104 for NY, DR 0004 for CO; TX has none) with filing status, allowances, extra cents and the typed legal name. Writes the state fields of tax_profiles and completes state_withholding.",
  input: StateWithholdingSubmission, domain: "people", needs: "view", effect: "write", risk: riskOf("R1"), approval: "never", access: "human_only", reversible: false, preview: null,
  async run(i, ctx, deps) {
    const tx = deps.tx;
    const p = await requirePersona(tx, ctx);
    const w = await requireHired(tx, p);
    const form = w.workState ? STATE_WITHHOLDING_FORMS[w.workState] ?? null : null;
    if (!form) throw new DomainRefusal("DOMAIN_NO_STATE_FORM", `${w.workState ?? "No state"} has no state withholding certificate`, null, null);
    if (i.state !== w.workState) throw new DomainRefusal("DOMAIN_WRONG_STATE", `The certificate is for ${i.state}; the work state is ${w.workState}`, `Submit the ${form.form}`, null);
    await openTask(tx, w.id, "state_withholding");
    checkTypedName(p, i.typedName);
    const [profile] = await tx.select().from(taxProfiles).where(eq(taxProfiles.workerId, w.id)).limit(1);
    if (!profile) throw new DomainRefusal("DOMAIN_W4_FIRST", "Submit Form W-4 first", null, null);
    // Payroll has no state-exempt path yet, so an exempt claim is refused rather than signed and then ignored.
    if (i.exempt) throw new DomainRefusal("DOMAIN_STATE_EXEMPT_UNSUPPORTED", `Weft does not yet support an exempt ${form.form}; submit it without exempt`, null, null);
    await tx.update(taxProfiles).set({ stateFilingStatus: i.filingStatus, stateAllowances: i.allowances, stateExtraCents: i.extraCents ?? 0 }).where(eq(taxProfiles.workerId, w.id));
    const rec = await signedRecord(deps, ctx, p, "state_withholding", `${form.form}: ${form.title}`, [
      ["State", i.state], ["Filing status", i.filingStatus], ["Allowances", String(i.allowances)], ["Extra withholding per period", dollars(i.extraCents ?? 0)], ["Exempt", i.exempt ? "yes" : "no"],
    ]);
    await submission(deps, ctx, w.id, "state_withholding", { state: i.state, form: form.form, filingStatus: i.filingStatus, allowances: i.allowances, extraCents: i.extraCents ?? 0, exempt: i.exempt ?? false }, rec.documentId);
    const done = await completePortalTask(tx, w.id, "state_withholding", ctx.now);
    return { data: { worker_id: w.id, document_id: rec.documentId, form: form.form, activated: done.activated }, summary: `${form.form} for ${displayName(w.firstName, w.lastName)} ${sigLine(p, ctx.now, rec.sha)}`, events: done.events };
  },
});

// documents.submit_direct_deposit ---------------------------------------------------------------------------
// The API route validates the full numbers (ABA checksum), stores them in the vault and passes only the last 4
// digits and the vault reference here, so no action row, submission or bank row ever holds a full number.
const DdInput = z.object({
  bank_name: z.string().min(2).max(80), routing_last4: z.string().regex(/^\d{4}$/), account_last4: z.string().regex(/^\d{4}$/),
  account_type: z.enum(["checking", "savings"]), credential_ref: z.string().regex(/^vault:[a-z0-9][a-z0-9-]{1,62}$/), typed_name: z.string().min(2).max(120),
});
export const submitDirectDeposit = writeCommand({
  name: "documents.submit_direct_deposit", summary: "Set up direct deposit (new hire portal only).",
  description: "Human only, new hire persona: verifies the vaulted routing and account numbers with the bank verification simulator, then writes an active bank account holding only the last 4 digits and the vault reference, and completes direct_deposit.",
  input: DdInput, domain: "people", needs: "view", effect: "write", risk: riskOf("R2"), approval: "always", access: "human_only", reversible: false,
  async preview(i) {
    return { title: `Direct deposit to ${i.bank_name} account ending ${i.account_last4}`, diff: [{ label: "Bank account", before: "none", after: `ending ${i.account_last4}` }], content: [], moneyCents: null, subjectRef: i.credential_ref, subjectHash: sha256Hex(canonicalJson(i)), evidence: [] };
  },
  async run(i, ctx, deps) {
    const tx = deps.tx;
    const p = await requirePersona(tx, ctx);
    const w = await requireHired(tx, p);
    await openTask(tx, w.id, "direct_deposit");
    checkTypedName(p, i.typed_name);
    if (i.credential_ref !== `vault:bank-${w.id.replace(/_/g, "-")}`) throw new DomainRefusal("DOMAIN_BAD_CREDENTIAL", "The vault reference does not belong to this worker", null, null);
    const secret = JSON.parse(await deps.resolveCredential(i.credential_ref as `vault:${string}`)) as { routing: string; account: string };
    if (secret.routing.slice(-4) !== i.routing_last4 || secret.account.slice(-4) !== i.account_last4) throw new DomainRefusal("DOMAIN_BAD_CREDENTIAL", "The last 4 digits do not match the vaulted numbers", null, null);
    const v = await deps.sims.bankVerify.verify({ workerId: w.id, routing: secret.routing, accountLast4: i.account_last4 });
    if (v.status !== "verified") throw new DomainRefusal("DOMAIN_BANK_NOT_VERIFIED", `The bank could not verify this account: ${v.reason ?? "unknown reason"}`, "Check the account number with your bank", null);
    const id = await deps.newId("bnk_");
    await tx.update(bankAccounts).set({ status: "inactive" }).where(and(eq(bankAccounts.workerId, w.id), eq(bankAccounts.status, "active")));
    await tx.insert(bankAccounts).values({ id, workerId: w.id, bankName: i.bank_name, accountLast4: i.account_last4, routingLast4: i.routing_last4, credentialRef: i.credential_ref, status: "active", source: "portal" });
    const rec = await signedRecord(deps, ctx, p, "direct_deposit_auth", "Direct deposit authorization", [
      ["Bank", i.bank_name], ["Account type", i.account_type], ["Routing number", `ending ${i.routing_last4}`], ["Account number", `ending ${i.account_last4}`], ["Verification", "verified by the bank simulator"],
    ]);
    await submission(deps, ctx, w.id, "direct_deposit", { bankName: i.bank_name, accountType: i.account_type, routingLast4: i.routing_last4, accountLast4: i.account_last4, verified: true }, rec.documentId);
    const done = await completePortalTask(tx, w.id, "direct_deposit", ctx.now);
    return { data: { worker_id: w.id, bank_account_id: id, bank_name: i.bank_name, routing_last4: i.routing_last4, account_last4: i.account_last4, verification: v.status, document_id: rec.documentId, activated: done.activated }, summary: `Direct deposit for ${displayName(w.firstName, w.lastName)} to account ending ${i.account_last4}, ${sigLine(p, ctx.now, rec.sha)}`, events: done.events };
  },
});

// documents.submit_i9 ---------------------------------------------------------------------------------------
// The executor maps null to undefined before parsing, so the contract's nullable fields are also optional here.
const I9Input = I9Submission.extend({ expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), file_name: z.string().min(1).max(120), bytes: z.number().int().positive(), sha256: z.string().regex(/^[0-9a-f]{64}$/), storage_path: z.string().regex(/^uploads\/[0-9a-f]{64}\.bin$/) }).strict();
export function maskedUpload(u: { id: string; fileName: string; bytes: number; sha256: string }) {
  const kb = Math.max(1, Math.round(u.bytes / 1024));
  const ext = /\.[A-Za-z0-9]{1,5}$/.exec(u.fileName)?.[0] ?? "";
  return { id: u.id, fileName: `${u.fileName.slice(0, 2)}***${ext}`, bytes: u.bytes, sha256: `${u.sha256.slice(0, 8)}...`, masked: true as const, preview: `ID image on file (${kb} KB), hidden` };
}
export const submitI9 = writeCommand({
  name: "documents.submit_i9", summary: "Complete the I-9 section 1 simulation with an ID image (new hire portal only).",
  description: "Human only, new hire persona: records the I-9 section 1 simulation (citizenship, document kind, last 4 of the document number, expiry) and the uploaded ID image stored under the data dir. Responses show the upload masked only. Completes i9_sim.",
  input: I9Input, domain: "people", needs: "view", effect: "write", risk: riskOf("R1"), approval: "never", access: "human_only", reversible: false, preview: null,
  async run(i, ctx, deps) {
    const tx = deps.tx;
    const p = await requirePersona(tx, ctx);
    const w = await requireHired(tx, p);
    await openTask(tx, w.id, "i9_sim");
    checkTypedName(p, i.typedName);
    const id = await deps.newId("upl_");
    await tx.insert(uploads).values({ id, workerId: w.id, purpose: "i9_id_image", fileName: i.file_name, storagePath: i.storage_path, bytes: i.bytes, sha256: i.sha256, createdAt: ctx.now });
    const rec = await signedRecord(deps, ctx, p, "i9", "Form I-9 section 1 (simulation)", [
      ["Citizenship", i.citizenship.replace(/_/g, " ")], ["Document", i.documentKind.replace(/_/g, " ")], ["Document number", `ending ${i.documentNumberLast4}`], ["Expires", i.expiresOn ?? "n/a"], ["ID image", `upload ${id}, masked`],
    ]);
    await submission(deps, ctx, w.id, "i9_sim", { citizenship: i.citizenship, documentKind: i.documentKind, documentNumberLast4: i.documentNumberLast4, expiresOn: i.expiresOn ?? null, uploadId: id }, rec.documentId);
    const done = await completePortalTask(tx, w.id, "i9_sim", ctx.now);
    return { data: { worker_id: w.id, upload: maskedUpload({ id, fileName: i.file_name, bytes: i.bytes, sha256: i.sha256 }), document_id: rec.documentId, activated: done.activated }, summary: `I-9 section 1 for ${displayName(w.firstName, w.lastName)} with upload ${id}, ${sigLine(p, ctx.now, rec.sha)}`, events: done.events };
  },
});

// documents.submit_benefits ---------------------------------------------------------------------------------
const Election = BenefitsSelection.shape.elections.element;
const BenefitsInput = BenefitsSelection.extend({
  elections: z.array(Election.extend({ tier: Election.shape.tier.optional(), deferralBps: Election.shape.deferralBps.optional() })).max(8),
});
export const submitBenefits = writeCommand({
  name: "documents.submit_benefits", summary: "Elect benefits from the company plans (new hire portal only).",
  description: "Human only, new hire persona: elects plans (one per type; medical, dental and vision with a coverage tier; 401(k) with a deferral in basis points) or waives types. Writes active benefit enrollments from the start date, which flow into paychecks as pre-tax deductions, and completes benefits_selection.",
  input: BenefitsInput, domain: "people", needs: "view", effect: "write", risk: riskOf("R1"), approval: "never", access: "human_only", reversible: false, preview: null,
  async run(i, ctx, deps) {
    const tx = deps.tx;
    const p = await requirePersona(tx, ctx);
    const w = await requireHired(tx, p);
    await openTask(tx, w.id, "benefits_selection");
    checkTypedName(p, i.typedName);
    const plans = await tx.select().from(benefitPlans).where(eq(benefitPlans.companyId, ctx.companyId));
    const seen = new Set<string>();
    const rows: { planId: string; name: string; type: string; tier: string | null; employeeCents: number | null; deferralBps: number | null }[] = [];
    for (const e of i.elections) {
      const plan = plans.find((x) => x.id === e.planId);
      if (!plan) throw notFound("benefit plan", e.planId);
      if (seen.has(plan.type)) throw new DomainRefusal("DOMAIN_DUPLICATE_PLAN_TYPE", `More than one ${plan.type} plan elected`, "Pick one plan per type", null);
      seen.add(plan.type);
      const prices = JSON.parse(plan.pricesJson) as Record<string, number>;
      if (plan.type === "401k") {
        const match = JSON.parse(plan.matchJson ?? "{}") as { min_deferral_bps?: number; max_deferral_bps?: number };
        const bps = e.deferralBps ?? 0;
        if (bps < (match.min_deferral_bps ?? 0) || bps > (match.max_deferral_bps ?? 10_000)) throw new DomainRefusal("DOMAIN_BAD_DEFERRAL", `Deferral ${bps} bps is outside ${match.min_deferral_bps ?? 0} to ${match.max_deferral_bps ?? 10_000}`, null, null);
        rows.push({ planId: plan.id, name: plan.name, type: plan.type, tier: null, employeeCents: null, deferralBps: bps });
      } else if (plan.type === "hsa") {
        throw new DomainRefusal("DOMAIN_HSA_WITH_HR", "HSA contributions are set up with HR after you start", "Elect the HDHP now; HR sets the HSA amount", null);
      } else {
        if (!e.tier || typeof prices[e.tier] !== "number") throw new DomainRefusal("DOMAIN_BAD_TIER", `${plan.name} needs a coverage tier`, "Use ee, ee_spouse, ee_children or family", null);
        rows.push({ planId: plan.id, name: plan.name, type: plan.type, tier: e.tier, employeeCents: prices[e.tier]!, deferralBps: null });
      }
    }
    const ids: string[] = [];
    for (const r of rows) {
      const id = await deps.newId("ben_");
      ids.push(id);
      await tx.insert(benefitEnrollments).values({ id, workerId: w.id, planId: r.planId, tier: r.tier, employeeCents: r.employeeCents, deferralBps: r.deferralBps, status: "active", effectiveFrom: w.startDate, effectiveTo: null });
    }
    const rec = await signedRecord(deps, ctx, p, "benefits_election", "Benefits election", [
      ...rows.map((r): [string, string] => [r.name, r.tier ? `${r.tier}, ${dollars(r.employeeCents ?? 0)} per paycheck` : `${(r.deferralBps ?? 0) / 100}% of pay`]),
      ["Waived", i.waived.length ? i.waived.join(", ") : "none"],
    ]);
    await submission(deps, ctx, w.id, "benefits_selection", { elections: rows.map((r) => ({ planId: r.planId, tier: r.tier, employeeCents: r.employeeCents, deferralBps: r.deferralBps })), waived: i.waived }, rec.documentId);
    const done = await completePortalTask(tx, w.id, "benefits_selection", ctx.now);
    return { data: { worker_id: w.id, enrollment_ids: ids, document_id: rec.documentId, activated: done.activated }, summary: `Benefits election for ${displayName(w.firstName, w.lastName)}: ${rows.map((r) => r.name).join(", ") || "all waived"}, ${sigLine(p, ctx.now, rec.sha)}`, events: done.events };
  },
});

export const portalCommands = [signDocument, submitW4, submitStateWithholding, submitDirectDeposit, submitI9, submitBenefits];
