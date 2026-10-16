import { z } from "zod";
// Every status and kind enum of SPEC 6, as zod enums plus inferred types.
const e = <T extends [string, ...string[]]>(...v: T) => z.enum(v);

export const WorkplaceKind = e("office", "remote"); export type WorkplaceKind = z.infer<typeof WorkplaceKind>;
export const WorkerType = e("employee", "contractor"); export type WorkerType = z.infer<typeof WorkerType>;
export const WorkerClass = e("us_w2", "us_1099", "global_contractor"); export type WorkerClass = z.infer<typeof WorkerClass>;
export const WorkerStatus = e("draft", "invited", "onboarding", "active", "offboarding", "inactive"); export type WorkerStatus = z.infer<typeof WorkerStatus>;
export const PayRateKind = e("salary", "hourly", "contract_monthly"); export type PayRateKind = z.infer<typeof PayRateKind>;
export const PayFrequency = e("semimonthly", "biweekly", "monthly"); export type PayFrequency = z.infer<typeof PayFrequency>;
export const PayRegion = e("us", "global"); export type PayRegion = z.infer<typeof PayRegion>;
export const TimeSource = e("seed", "import"); export type TimeSource = z.infer<typeof TimeSource>;
export const W4Version = e("2020", "pre2020"); export type W4Version = z.infer<typeof W4Version>;
export const FilingStatus = e("single", "mfj", "hoh"); export type FilingStatus = z.infer<typeof FilingStatus>;
export const HrSource = e("seed", "hr", "demo_bundle"); export type HrSource = z.infer<typeof HrSource>;
export const OfferStatus = e("draft", "sent", "viewed", "accepted", "voided", "expired"); export type OfferStatus = z.infer<typeof OfferStatus>;
export const OnboardingTaskKind = e("sign_offer", "federal_w4", "state_withholding", "direct_deposit", "i9_sim", "benefits_selection", "it_accounts", "device", "state_registration", "sign_confidentiality"); export type OnboardingTaskKind = z.infer<typeof OnboardingTaskKind>;
export const OnboardingTaskStatus = e("pending", "done", "blocked"); export type OnboardingTaskStatus = z.infer<typeof OnboardingTaskStatus>;
export const OnboardingTaskOwner = e("employee", "hr", "agent"); export type OnboardingTaskOwner = z.infer<typeof OnboardingTaskOwner>;
export const PrincipalKind = e("human", "agent", "service"); export type PrincipalKind = z.infer<typeof PrincipalKind>;
export const HumanRole = e("admin", "payroll_admin", "hr_manager", "employee"); export type HumanRole = z.infer<typeof HumanRole>;
export const ApiKeyScope = e("mcp", "cli", "admin"); export type ApiKeyScope = z.infer<typeof ApiKeyScope>;
export const ApiKeySurface = e("mcp", "api"); export type ApiKeySurface = z.infer<typeof ApiKeySurface>;

export const PayrollRunType = e("us", "global"); export type PayrollRunType = z.infer<typeof PayrollRunType>;
export const PayrollRunSubtype = e("regular", "off_cycle", "bonus", "dismissal"); export type PayrollRunSubtype = z.infer<typeof PayrollRunSubtype>;
export const PayrollRunStatus = e("draft", "pending", "processing", "processed", "failed", "voided"); export type PayrollRunStatus = z.infer<typeof PayrollRunStatus>;
export const PaycheckStatus = e("draft", "processing", "processed", "failed", "blocked", "excluded"); export type PaycheckStatus = z.infer<typeof PaycheckStatus>;
export const ReviewGroup = e("needs_review", "ready"); export type ReviewGroup = z.infer<typeof ReviewGroup>;
export const ExplanationSource = e("agent", "template"); export type ExplanationSource = z.infer<typeof ExplanationSource>;
export const FlagRule = e("GROSS_CHANGE", "HOURS_SPIKE", "NEW_IN_RUN", "MISSING_FROM_RUN", "PRORATED", "MISSING_BANK_ACCOUNT", "UNREGISTERED_STATE", "NEGATIVE_NET", "TOTAL_CHANGE"); export type FlagRule = z.infer<typeof FlagRule>;
export const FlagSeverity = e("info", "review", "block"); export type FlagSeverity = z.infer<typeof FlagSeverity>;
export const TaxPayer = e("employee", "employer"); export type TaxPayer = z.infer<typeof TaxPayer>;

export const Jurisdiction = e("US", "CA", "NY", "TX", "CO"); export type Jurisdiction = z.infer<typeof Jurisdiction>;
export const WorkState = e("CA", "NY", "TX", "CO"); export type WorkState = z.infer<typeof WorkState>;
export const AgencyCode = e("irs", "ca_edd", "ny_dtf", "ny_dol", "tx_twc", "co_dor", "co_cdle"); export type AgencyCode = z.infer<typeof AgencyCode>;
export const TaxAccountType = e("federal", "withholding", "unemployment", "combined"); export type TaxAccountType = z.infer<typeof TaxAccountType>;
export const TaxAccountStatus = e("not_registered", "needs_info", "awaiting_state", "active"); export type TaxAccountStatus = z.infer<typeof TaxAccountStatus>;
export const EmployerRateCode = e("sui", "ett"); export type EmployerRateCode = z.infer<typeof EmployerRateCode>;
export const AgencyNoticeKind = e("rate_change", "missing_filing", "late_deposit_penalty", "deposit_schedule_change", "futa_credit_reduction", "benefit_charge", "registration_confirmed"); export type AgencyNoticeKind = z.infer<typeof AgencyNoticeKind>;
export const NoticeStatus = e("new", "in_review", "proposed", "resolved", "escalated"); export type NoticeStatus = z.infer<typeof NoticeStatus>;
export const NoticeScenario = e("ca_de2088_rate_change", "ca_de2088_injection", "ny_missing_filing", "irs_deposit_schedule_change"); export type NoticeScenario = z.infer<typeof NoticeScenario>;
export const FilingStatusKind = e("draft", "filed", "accepted", "rejected"); export type FilingStatusKind = z.infer<typeof FilingStatusKind>;

export const BenefitCategory = e("health", "health_savings", "retirement"); export type BenefitCategory = z.infer<typeof BenefitCategory>;
export const BenefitType = e("medical", "dental", "vision", "hsa", "401k"); export type BenefitType = z.infer<typeof BenefitType>;
export const PretaxCode = e("section125_medical", "hsa_cafeteria", "401k_traditional"); export type PretaxCode = z.infer<typeof PretaxCode>;
export const CoverageTier = e("ee", "ee_spouse", "ee_children", "family"); export type CoverageTier = z.infer<typeof CoverageTier>;
export const EnrollmentStatus = e("active", "pending", "terminated"); export type EnrollmentStatus = z.infer<typeof EnrollmentStatus>;
export const ItSystem = e("google_ws", "chat", "github", "sso"); export type ItSystem = z.infer<typeof ItSystem>;
export const ItAccountStatus = e("provisioning", "active", "suspended"); export type ItAccountStatus = z.infer<typeof ItAccountStatus>;
export const DeviceStatus = e("ordered", "shipped", "delivered", "assigned"); export type DeviceStatus = z.infer<typeof DeviceStatus>;
export const ContractorPaymentStatus = e("scheduled", "paid", "failed");   // rail lifecycle: RailStatus in wave2.ts export type ContractorPaymentStatus = z.infer<typeof ContractorPaymentStatus>;
export const ChatChannel = e("#people-ops", "#payroll", "#new-hires", "#general"); export type ChatChannel = z.infer<typeof ChatChannel>;

export const ActorKind = e("human", "agent", "routine", "system"); export type ActorKind = z.infer<typeof ActorKind>;
export const Reversibility = e("yes", "no", "na"); export type Reversibility = z.infer<typeof Reversibility>;
export const ApprovalAttempt = e("approve", "deny", "dismiss", "start", "expire"); export type ApprovalAttempt = z.infer<typeof ApprovalAttempt>;
export const RunTrigger = z.union([z.literal("chat"), z.literal("mcp"), z.literal("api"), z.string().regex(/^routine:rtr_/)]); export type RunTrigger = z.infer<typeof RunTrigger>;
export const SimBatchStatus = e("submitted", "settled", "returned"); export type SimBatchStatus = z.infer<typeof SimBatchStatus>;
export const FaultKind = e("error", "delay", "needs_info", "return"); export type FaultKind = z.infer<typeof FaultKind>;
export const FaultMode = e("once", "always"); export type FaultMode = z.infer<typeof FaultMode>;
export const LlmMode = e("scripted", "openai", "claude", "mlx", "llama"); export type LlmMode = z.infer<typeof LlmMode>;
