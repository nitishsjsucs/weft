import { z } from "zod";
import * as E from "./enums";
import { Money, Rate, Currency } from "./money";
// API DTOs (zod). Money is `{amount, currency, display}`; internal rows use *_cents integers.
const iso = z.string();            // ISO-8601 timestamp from the sim clock
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const id = (p: string) => z.string().startsWith(p);

export const Company = z.object({ id: id("cmp_"), legalName: z.string(), domain: z.string(), ein: z.string(), hqState: E.WorkState, foundedOn: date });
export type Company = z.infer<typeof Company>;
export const Workplace = z.object({ id: id("wkp_"), name: z.string(), kind: E.WorkplaceKind, city: z.string().nullable(), state: z.string().nullable(), country: z.string() });
export type Workplace = z.infer<typeof Workplace>;
export const Department = z.object({ id: id("dpt_"), name: z.string(), leadWorkerId: z.string().nullable() });
export type Department = z.infer<typeof Department>;
export const PaySchedule = z.object({ id: id("ps_"), name: z.string(), frequency: E.PayFrequency, region: E.PayRegion, autopay: z.boolean() });
export type PaySchedule = z.infer<typeof PaySchedule>;

export const Worker = z.object({
  id: id("wrk_"), employeeNumber: z.string().nullable(), type: E.WorkerType, workerType: E.WorkerClass, status: E.WorkerStatus,
  firstName: z.string(), lastName: z.string(), displayName: z.string(), workEmail: z.string(), title: z.string(),
  departmentId: z.string().nullable(), managerId: z.string().nullable(), workplaceId: z.string().nullable(),
  workState: z.string().nullable(), country: z.string(), currency: Currency, timezone: z.string(),
  startDate: date, endDate: date.nullable(), ssnMasked: z.string().nullable(), payScheduleId: z.string().nullable(),
});
export type Worker = z.infer<typeof Worker>;

export const PayRate = z.object({ id: id("prt_"), workerId: id("wrk_"), kind: E.PayRateKind, amount: Money, effectiveFrom: date, effectiveTo: date.nullable(), createdActionSeq: z.number().int().nullable() });
export type PayRate = z.infer<typeof PayRate>;

export const Offer = z.object({
  id: id("offr_"), candidateFirst: z.string(), candidateLast: z.string(), candidateEmail: z.string(), title: z.string(),
  departmentId: z.string(), workplaceId: z.string(), workState: z.string(), managerId: z.string().nullable(),
  base: Money, payKind: E.PayRateKind, startDate: date, status: E.OfferStatus, acceptedAt: iso.nullable(), workerId: z.string().nullable(),
});
export type Offer = z.infer<typeof Offer>;

export const OnboardingTask = z.object({ id: id("obt_"), workerId: id("wrk_"), kind: E.OnboardingTaskKind, status: E.OnboardingTaskStatus, owner: E.OnboardingTaskOwner, dueOn: date.nullable(), doneAt: iso.nullable(), blockedReason: z.string().nullable() });
export type OnboardingTask = z.infer<typeof OnboardingTask>;

export const Flag = z.object({ rule: E.FlagRule, severity: E.FlagSeverity, message: z.string(), evidence: z.record(z.string(), z.unknown()) });
export type Flag = z.infer<typeof Flag>;

export const TaxLine = z.object({ code: z.string(), jurisdiction: z.string(), payer: E.TaxPayer, taxableWagesCents: z.number().int(), rate: Rate.nullable(), amountCents: z.number().int() });
export type TaxLine = z.infer<typeof TaxLine>;

/** SPEC 7.4: the 12 totals fields. */
export const TOTALS_FIELDS = ["cashRequirement", "grossPay", "netPay", "reimbursements", "workerTaxes", "employerTaxes", "preTaxDeductions", "postTaxDeductions", "workerBenefitContributions", "employerBenefitContributions", "transactionFees", "totalCost"] as const;
export const Totals = z.object(Object.fromEntries(TOTALS_FIELDS.map((k) => [k, Money])) as Record<(typeof TOTALS_FIELDS)[number], typeof Money>);
export type Totals = z.infer<typeof Totals>;

export const PayrollRun = z.object({
  id: id("pay_"), payScheduleId: z.string(), type: E.PayrollRunType, subtype: E.PayrollRunSubtype, status: E.PayrollRunStatus,
  periodStart: date, periodEnd: date, payday: date, approvalDeadline: iso, fundingMethod: z.literal("ach"),
  totals: Totals.nullable(), anomalySummary: z.object({ needsReview: z.number().int(), ready: z.number().int(), blocked: z.number().int(), excluded: z.number().int() }).nullable(),
  subjectHash: z.string().nullable(), taxDataVersion: z.string(), previousRunId: z.string().nullable(), excludedWorkerIds: z.array(z.string()),
  approvedBy: z.string().nullable(), approvedAt: iso.nullable(), submittedActionSeq: z.number().int().nullable(), bankBatchId: z.string().nullable(),
  settleAt: iso.nullable(), processedAt: iso.nullable(), paycheckCount: z.number().int(),
});
export type PayrollRun = z.infer<typeof PayrollRun>;

export const Paycheck = z.object({
  id: id("pyc_"), payrollRunId: id("pay_"), workerId: id("wrk_"), workerName: z.string(), status: E.PaycheckStatus, reviewGroup: E.ReviewGroup,
  hoursX100: z.number().int().nullable(), gross: Money, net: Money, reimbursements: Money, employeeTaxes: Money, companyTaxes: Money, companyBenefits: Money,
  earnings: z.array(z.object({ type: z.string(), amountCents: z.number().int(), hoursX100: z.number().int().nullable() })),
  deductions: z.array(z.object({ code: z.string(), pretax: z.boolean(), amountCents: z.number().int() })),
  benefits: z.array(z.object({ planId: z.string(), employeeCents: z.number().int(), employerCents: z.number().int() })),
  taxes: z.array(TaxLine), flags: z.array(Flag), explanation: z.string().nullable(), explanationSource: E.ExplanationSource.nullable(), explanationRunId: z.string().nullable(),
  trace: z.array(z.string()).optional(),
});
export type Paycheck = z.infer<typeof Paycheck>;

export const TaxAccount = z.object({ id: id("txa_"), jurisdiction: E.Jurisdiction, agency: E.AgencyCode, accountType: E.TaxAccountType, accountNumber: z.string().nullable(), status: E.TaxAccountStatus, depositSchedule: z.string().nullable(), registeredAt: iso.nullable(), simApplicationId: z.string().nullable() });
export type TaxAccount = z.infer<typeof TaxAccount>;
export const EmployerRate = z.object({ id: id("etr_"), jurisdiction: E.Jurisdiction, code: E.EmployerRateCode, rate: Rate, wageBase: Money, effectiveFrom: date, effectiveTo: date.nullable(), source: z.string(), createdActionSeq: z.number().int().nullable(), supersededActionSeq: z.number().int().nullable() });
export type EmployerRate = z.infer<typeof EmployerRate>;

/** Deterministic parser output: typed numbers, dates, enums and a matched account id. Not untrusted. */
export const NoticeExtract = z.object({
  agency: E.AgencyCode, formCode: z.string(), kind: E.AgencyNoticeKind, accountNumber: z.string().nullable(), taxAccountId: z.string().nullable(),
  taxYear: z.number().int().nullable(), effectiveFrom: date.nullable(), respondBy: date.nullable(),
  rates: z.array(z.object({ code: E.EmployerRateCode, oldRate: Rate.nullable(), newRate: Rate })).default([]),
  amountCents: z.number().int().nullable(), period: z.string().nullable(),
});
export type NoticeExtract = z.infer<typeof NoticeExtract>;
export const Notice = z.object({
  id: id("ntc_"), agency: E.AgencyCode, kind: E.AgencyNoticeKind, formCode: z.string(), title: z.string(), receivedAt: iso, respondBy: date.nullable(),
  status: E.NoticeStatus, taxAccountId: z.string().nullable(), fileName: z.string(), bodyText: z.string().optional(), extracted: NoticeExtract.nullable(),
  resolution: z.record(z.string(), z.unknown()).nullable(), responseConfirmation: z.string().nullable(),
});
export type Notice = z.infer<typeof Notice>;

export const BenefitPlan = z.object({ id: id("bpl_"), carrier: z.string(), category: E.BenefitCategory, type: E.BenefitType, name: z.string(), pretaxCode: E.PretaxCode, prices: z.record(z.string(), z.number().int()), match: z.record(z.string(), z.unknown()).nullable() });
export type BenefitPlan = z.infer<typeof BenefitPlan>;
export const Enrollment = z.object({ id: id("ben_"), workerId: id("wrk_"), planId: id("bpl_"), tier: E.CoverageTier.nullable(), employeeCents: z.number().int().nullable(), deferralBps: z.number().int().nullable(), status: E.EnrollmentStatus, effectiveFrom: date, effectiveTo: date.nullable() });
export type Enrollment = z.infer<typeof Enrollment>;
export const ItAccount = z.object({ id: id("ita_"), workerId: id("wrk_"), system: E.ItSystem, handle: z.string(), groups: z.array(z.string()), status: E.ItAccountStatus, simRef: z.string().nullable() });
export type ItAccount = z.infer<typeof ItAccount>;
export const Device = z.object({ id: id("dev_"), workerId: id("wrk_"), model: z.string(), status: E.DeviceStatus, orderRef: z.string().nullable(), price: Money });
export type Device = z.infer<typeof Device>;

export const Action = z.object({
  seq: z.number().int(), actionId: id("act_"), ts: iso, actorKind: E.ActorKind, actorId: z.string(), onBehalfOf: z.string().nullable(),
  agentRunId: z.string().nullable(), routineRunId: z.string().nullable(), proposalId: z.string().nullable(), command: z.string(),
  resultId: z.string().nullable(), summary: z.string(), reversible: E.Reversibility, reversesSeq: z.number().int().nullable(),
  reversedBySeq: z.number().int().nullable(), notReversibleReason: z.string().nullable(), prevHash: z.string(), hash: z.string(),
});
export type Action = z.infer<typeof Action>;

export const RoutineRunDto = z.object({
  id: id("rtr_"), routineId: id("rt_"), runKey: z.string(), triggerRef: z.string(),
  status: z.enum(["queued", "running", "waiting_approval", "waiting_event", "done", "failed", "cancelled", "skipped"]),
  agentRunId: z.string().nullable(), summary: z.string().nullable(), leftForHuman: z.array(z.string()), overdue: z.boolean(), attended: z.boolean(),
  startedAt: iso.nullable(), endedAt: iso.nullable(), costUsdMicros: z.number().int(),
});
export type RoutineRunDto = z.infer<typeof RoutineRunDto>;

export const ChatMessageDto = z.object({ id: z.string(), channel: E.ChatChannel, author: z.string(), text: z.string(), card: z.record(z.string(), z.unknown()).nullable(), ts: iso, inbound: z.boolean() });
export type ChatMessageDto = z.infer<typeof ChatMessageDto>;

export const Stats = z.object({ employees: z.number().int(), contractors: z.number().int(), simulatedAgencies: z.number().int(), runsLogged: z.number().int(), actionsLogged: z.number().int(), realAgenciesContacted: z.literal(0), payrollsProcessed: z.number().int() });
export type Stats = z.infer<typeof Stats>;

export const Health = z.object({ ok: z.boolean(), version: z.string(), provider: z.object({ id: z.string(), model: z.string(), label: z.string(), live: z.boolean() }), clock: z.object({ now: iso, rate: z.number() }), testMode: z.boolean(), stubs: z.array(z.string()) });
export type Health = z.infer<typeof Health>;

export const Page = <T extends z.ZodType>(item: T) => z.object({ hasMore: z.boolean(), count: z.number().int(), data: z.array(item) });
