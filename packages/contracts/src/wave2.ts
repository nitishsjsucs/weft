import { z } from "zod";
// Wave 2 shared contracts (docs/wave2.md). Landed by the wave 2 architect before the tracks start; additive only.
// Tracks implement against these types and must not change their shape; additions go to
// packages/contracts/src/ext/<track-id>.ts plus a note in .scratch/contract-requests/<track-id>.md.
const e = <T extends [string, ...string[]]>(...v: T) => z.enum(v);
const id = (p: string) => z.string().startsWith(p);
const iso = z.string();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// ---------- w2-onboarding: offers, e-signature, documents, new-hire portal ----------

/** The offer lifecycle shown in the offer builder. Stored values match OfferStatus in enums.ts ("voided" is shown as Void). */
export const OfferLifecycle = e("draft", "sent", "viewed", "accepted", "voided", "expired"); export type OfferLifecycle = z.infer<typeof OfferLifecycle>;
export const OFFER_TRANSITIONS: Record<OfferLifecycle, readonly OfferLifecycle[]> = {
  draft: ["sent", "voided"], sent: ["viewed", "voided", "expired"], viewed: ["accepted", "voided", "expired"],
  accepted: [], voided: [], expired: [],
};

/** The canonical new-hire checklist, in portal order. state_withholding appears only when the work state needs a form. */
export const PortalTaskKind = e("sign_offer", "sign_confidentiality", "federal_w4", "state_withholding", "direct_deposit", "i9_sim", "benefits_selection");
export type PortalTaskKind = z.infer<typeof PortalTaskKind>;
export const PORTAL_TASK_ORDER: readonly PortalTaskKind[] = PortalTaskKind.options;
/** Work states whose own withholding certificate the portal collects (TX has no income tax). */
export const STATE_WITHHOLDING_FORMS: Record<string, { form: string; title: string } | null> = {
  CA: { form: "DE 4", title: "California employee withholding allowance certificate" },
  NY: { form: "IT-2104", title: "New York employee withholding allowance certificate" },
  CO: { form: "DR 0004", title: "Colorado employee withholding certificate" },
  TX: null,
};

export const DocumentKind = e("offer_letter", "confidentiality_agreement", "w4", "state_withholding", "i9", "direct_deposit_auth", "benefits_election", "cobra_notice", "final_pay_statement");
export type DocumentKind = z.infer<typeof DocumentKind>;
/** Library tabs: Signed, Sent (awaiting the signer), Pending (not yet sent). Void documents stay listed under their last tab. */
export const DocumentStatus = e("pending", "sent", "signed", "voided"); export type DocumentStatus = z.infer<typeof DocumentStatus>;
export const WorkerDocument = z.object({
  id: id("doc_"), companyId: z.string(), workerId: id("wrk_").nullable(), offerId: id("offr_").nullable(), kind: DocumentKind, title: z.string(),
  status: DocumentStatus, sha256: z.string().regex(/^[0-9a-f]{64}$/), createdAt: iso, sentAt: iso.nullable(), signedAt: iso.nullable(),
});
export type WorkerDocument = z.infer<typeof WorkerDocument>;
/** Click-to-sign record. The same signer, timestamp and document hash go into the action row's args. */
export const SignatureRecord = z.object({
  id: id("sig_"), documentId: id("doc_"), signerPrincipalId: z.string(), signerName: z.string(), typedName: z.string().min(2).max(120),
  signedAt: iso, documentSha256: z.string().regex(/^[0-9a-f]{64}$/), actionSeq: z.number().int().nullable(),
});
export type SignatureRecord = z.infer<typeof SignatureRecord>;

/** Federal Form W-4 (2020 or later). Feeds tax_profiles; dollars as integer cents. */
export const W4Submission = z.object({
  filingStatus: e("single", "mfj", "hoh"), step2Checkbox: z.boolean(),
  step3Cents: z.number().int().min(0), step4aCents: z.number().int().min(0), step4bCents: z.number().int().min(0), step4cCents: z.number().int().min(0),
  exempt: z.boolean().default(false), typedName: z.string().min(2).max(120),
}).strict();
export type W4Submission = z.infer<typeof W4Submission>;
export const StateWithholdingSubmission = z.object({
  state: z.string().length(2), filingStatus: z.string().min(1).max(32), allowances: z.number().int().min(0).max(99),
  extraCents: z.number().int().min(0).default(0), exempt: z.boolean().default(false), typedName: z.string().min(2).max(120),
}).strict();
export type StateWithholdingSubmission = z.infer<typeof StateWithholdingSubmission>;

/** ABA routing number checksum: 3(d1+d4+d7) + 7(d2+d5+d8) + (d3+d6+d9) is a multiple of 10. */
export function abaChecksumOk(routing: string): boolean {
  if (!/^\d{9}$/.test(routing)) return false;
  const d = routing.split("").map(Number);
  const sum = 3 * (d[0]! + d[3]! + d[6]!) + 7 * (d[1]! + d[4]! + d[7]!) + (d[2]! + d[5]! + d[8]!);
  return sum % 10 === 0;
}
export const DirectDepositSubmission = z.object({
  bankName: z.string().min(2).max(80), routing: z.string().refine(abaChecksumOk, "routing number fails the ABA checksum"),
  account: z.string().regex(/^\d{4,17}$/), accountType: e("checking", "savings"), typedName: z.string().min(2).max(120),
}).strict();
export type DirectDepositSubmission = z.infer<typeof DirectDepositSubmission>;
export const BankVerificationStatus = e("pending", "verified", "failed"); export type BankVerificationStatus = z.infer<typeof BankVerificationStatus>;

export const I9DocumentKind = e("us_passport", "permanent_resident_card", "drivers_license_and_ssn_card");
export const I9Submission = z.object({
  citizenship: e("citizen", "noncitizen_national", "permanent_resident", "authorized_alien"), documentKind: I9DocumentKind,
  documentNumberLast4: z.string().regex(/^[A-Za-z0-9]{4}$/), expiresOn: date.nullable(), typedName: z.string().min(2).max(120),
}).strict();
export type I9Submission = z.infer<typeof I9Submission>;
/** Uploaded ID image: stored under the data dir only, never in the DB; the API returns the masked view. */
export const MaskedUpload = z.object({ id: id("upl_"), fileName: z.string(), bytes: z.number().int(), sha256: z.string(), masked: z.literal(true), preview: z.string() });
export type MaskedUpload = z.infer<typeof MaskedUpload>;

export const BenefitsSelection = z.object({
  elections: z.array(z.object({ planId: id("bpl_"), tier: e("ee", "ee_spouse", "ee_children", "family").nullable(), deferralBps: z.number().int().min(0).max(10000).nullable() })).max(8),
  waived: z.array(e("medical", "dental", "vision", "hsa", "401k")).default([]), typedName: z.string().min(2).max(120),
}).strict();
export type BenefitsSelection = z.infer<typeof BenefitsSelection>;

export const PortalTask = z.object({ kind: PortalTaskKind, title: z.string(), status: e("pending", "done", "blocked"), doneAt: iso.nullable(), documentId: id("doc_").nullable() });
export type PortalTask = z.infer<typeof PortalTask>;
export const PortalView = z.object({
  worker: z.object({ id: id("wrk_"), displayName: z.string(), title: z.string(), workState: z.string().nullable(), startDate: date }),
  offerId: id("offr_").nullable(), tasks: z.array(PortalTask), done: z.number().int(), total: z.number().int(), payrollReady: z.boolean(),
});
export type PortalView = z.infer<typeof PortalView>;

// ---------- w2-offboarding: termination, access revocation, off-cycle ----------

export const TerminationKind = e("voluntary", "involuntary", "layoff", "end_of_contract"); export type TerminationKind = z.infer<typeof TerminationKind>;
export const OffboardingStepKind = e("final_pay", "directory_suspend", "sso_deactivate", "group_removal", "app_removal", "device_lock", "cobra_notice", "benefits_terminate");
export type OffboardingStepKind = z.infer<typeof OffboardingStepKind>;
export const OFFBOARDING_STEP_ORDER: readonly OffboardingStepKind[] = OffboardingStepKind.options;
/** Steps that only ever run as proposals a human approves. */
export const OFFBOARDING_PROPOSAL_STEPS: readonly OffboardingStepKind[] = ["final_pay", "directory_suspend", "sso_deactivate", "device_lock"];
export const OffboardingStepStatus = e("pending", "proposed", "done", "skipped", "failed"); export type OffboardingStepStatus = z.infer<typeof OffboardingStepStatus>;
export const OffboardingCaseStatus = e("open", "complete", "cancelled"); export type OffboardingCaseStatus = z.infer<typeof OffboardingCaseStatus>;
export const TerminationInput = z.object({
  workerId: id("wrk_"), kind: TerminationKind, lastDay: date, reasonNote: z.string().max(400).default(""), payUnusedPto: z.boolean().default(true),
}).strict();
export type TerminationInput = z.infer<typeof TerminationInput>;
export const OffboardingStep = z.object({ id: id("ofs_"), caseId: id("ofb_"), kind: OffboardingStepKind, status: OffboardingStepStatus, proposalId: id("prp_").nullable(), actionSeq: z.number().int().nullable(), doneAt: iso.nullable(), detail: z.string() });
export type OffboardingStep = z.infer<typeof OffboardingStep>;
export const OffboardingCase = z.object({ id: id("ofb_"), workerId: id("wrk_"), kind: TerminationKind, lastDay: date, status: OffboardingCaseStatus, createdAt: iso, steps: z.array(OffboardingStep) });
export type OffboardingCase = z.infer<typeof OffboardingCase>;
/** Off-cycle request the agent computes: missed pay with a mid-period raise plus a bonus. */
export const OffCycleRequest = z.object({
  workerIds: z.array(id("wrk_")).min(1).max(50), periodStart: date, periodEnd: date, payday: date,
  reason: e("missed_payroll", "bonus", "correction", "final_pay"), bonusCents: z.record(z.string(), z.number().int().min(0)).default({}),
}).strict();
export type OffCycleRequest = z.infer<typeof OffCycleRequest>;

// ---------- w2-benefits-contractors: carrier reconciliation, open enrollment, contractor payouts ----------

export const ReconFindingKind = e("terminated_but_billed", "missing_dependent", "wrong_tier", "billed_not_enrolled", "enrolled_not_billed", "amount_mismatch");
export type ReconFindingKind = z.infer<typeof ReconFindingKind>;
export const ReconFindingStatus = e("open", "disputed", "resolved", "dismissed"); export type ReconFindingStatus = z.infer<typeof ReconFindingStatus>;
export const ReconFinding = z.object({
  id: id("rcf_"), month: z.string().regex(/^\d{4}-\d{2}$/), carrier: z.string(), kind: ReconFindingKind, workerId: id("wrk_").nullable(), planId: id("bpl_").nullable(),
  billedCents: z.number().int(), expectedCents: z.number().int(), deductedCents: z.number().int(), status: ReconFindingStatus, detail: z.string(),
});
export type ReconFinding = z.infer<typeof ReconFinding>;
export const OpenEnrollmentStatus = e("not_started", "in_progress", "elected", "waived"); export type OpenEnrollmentStatus = z.infer<typeof OpenEnrollmentStatus>;
/** Payment rail lifecycle for contractor payouts (the existing contractor_payments.status keeps scheduled, paid, failed). */
export const RailStatus = e("pending", "sent", "delivered", "returned"); export type RailStatus = z.infer<typeof RailStatus>;
export const ContractorPayout = z.object({
  id: id("cpy_"), workerId: id("wrk_"), amountMinor: z.number().int(), currency: z.string().length(3), fxRate: z.string(), usdCents: z.number().int(),
  railStatus: RailStatus, railRef: z.string().nullable(), scheduledFor: date, sentAt: iso.nullable(), deliveredAt: iso.nullable(),
});
export type ContractorPayout = z.infer<typeof ContractorPayout>;

// ---------- simulators added in wave 2 (implementations in packages/sim/src/{email,rail,bank-verify}.ts) ----------

export interface EmailMessage { id: string; to: string; from: string; subject: string; body: string; kind: "offer_invite" | "portal_invite" | "nudge" | "cobra_notice" | "generic"; relatedRef: string | null; ts: string }
export interface EmailSim { send(msg: Omit<EmailMessage, "id" | "ts">): Promise<{ id: string }>; list(to?: string): Promise<EmailMessage[]> }
export interface PaymentRailSim { send(req: { paymentId: string; amountMinor: number; currency: string; credential: string }): Promise<{ railRef: string; status: "pending" }>; tick(now: string): Promise<{ type: "sim.rail_delivered"; subjectRef: string; payload: Record<string, string> }[]> }
export interface BankVerifySim { verify(req: { workerId: string; routing: string; accountLast4: string }): Promise<{ status: "verified" | "failed"; reason: string | null }> }

// ---------- w2-memory: recall, dossiers, coarsening ----------

/** research/harness.md 18 item 4: at most 4 searches, hits within 1,200 tokens, once per run, always the one-pager. */
export const RECALL_BUDGET = { maxSearches: 4, maxTokens: 1200, onePager: "knowledge/company/one-pager.md" } as const;
export const RecallItem = z.object({ path: z.string(), title: z.string(), excerpt: z.string(), score: z.number(), asOf: iso });
export type RecallItem = z.infer<typeof RecallItem>;
export const DossierSubject = z.string().regex(/^(wrk|txa|bpl|ntc|cmp)_[A-Za-z0-9_]+$/);
export const Dossier = z.object({ subjectRef: DossierSubject, path: z.string(), refreshedAt: iso, facts: z.array(z.object({ text: z.string(), sourceRef: z.string() })).max(40) });
export type Dossier = z.infer<typeof Dossier>;
export const CoarsenLevel = e("hourly", "daily", "weekly", "monthly"); export type CoarsenLevel = z.infer<typeof CoarsenLevel>;

// ---------- w2-providers-sandbox ----------

export const LocalProviderConfig = z.object({ baseUrl: z.string().url(), model: z.string(), reasoning: z.literal("off").default("off"), strictJson: z.literal(true).default(true) });
export type LocalProviderConfig = z.infer<typeof LocalProviderConfig>;

// ---------- new event types (validated by WAVE2_EVENT_BODIES; the frozen EventBody union is unchanged) ----------
const ref = (p: string) => z.string().startsWith(p);
const ev = <T extends string, P extends z.ZodRawShape>(type: T, payload: P) => z.object({ type: z.literal(type), payload: z.object(payload).strict() });
export const Wave2EventBody = z.discriminatedUnion("type", [
  ev("offer.sent", { offer_id: ref("offr_") }),
  ev("offer.viewed", { offer_id: ref("offr_") }),
  ev("document.signed", { document_id: ref("doc_"), worker_id: ref("wrk_") }),
  ev("onboarding.task_completed", { worker_id: ref("wrk_"), kind: z.string() }),
  ev("worker.terminated", { worker_id: ref("wrk_"), case_id: ref("ofb_") }),
  ev("offboarding.step_done", { case_id: ref("ofb_"), step_id: ref("ofs_") }),
  ev("benefits.invoice_received", { month: z.string(), carrier: z.string() }),
  ev("sim.rail_delivered", { payment_id: ref("cpy_") }),
]);
export type Wave2EventBody = z.infer<typeof Wave2EventBody>;
export const WAVE2_EVENT_TYPES = Wave2EventBody.options.map((o) => o.shape.type.value);

/** Id prefixes added in wave 2. */
export const WAVE2_ID_PREFIXES = ["doc_", "sig_", "upl_", "obs_", "ofb_", "ofs_", "rcf_", "oen_", "eml_", "simr_", "simk_"] as const;
