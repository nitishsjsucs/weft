// Simulator interfaces (SPEC 8). Simulators write only sim_* tables and store only vault names, never credentials.
import type { AgencyCode, AgencyNoticeKind as NoticeKind, ChatChannel, FaultKind, FaultMode, ItSystem, NoticeScenario, TaxAccountType as AccountType } from "./enums";
import type { NoticeExtract } from "./domain";
import type { BankVerifySim, EmailSim, PaymentRailSim } from "./wave2";
import type { VendorConnectors } from "./wave3";

export type { AgencyCode, AccountType, NoticeScenario, ChatChannel, ItSystem };

/** Fault targets such as `agency.CO.register`, `agency.CA.fileResponse`, `bank.submitBatch`, `idp.createAccount`. */
export type FaultTarget = `agency.${string}.${"register" | "fileResponse"}` | "bank.submitBatch" | "idp.createAccount" | "devices.order" | "chat.post" | `${string}.${string}`;
export interface ArmedFault { target: FaultTarget; kind: FaultKind; mode: FaultMode; armed: boolean; firedCount: number }
export type FaultDecision = { fire: false } | { fire: true; kind: FaultKind };

export interface IdpAccount { ref: string; workerId: string; system: ItSystem; handle: string; groups: string[]; status: "active" | "provisioning" | "suspended" }
export interface DeviceCatalogItem { sku: string; name: string; priceCents: number; etaBusinessDays: number }
export interface ApprovalCard { proposalId: string; headline: string; risk: string; moneyCents: number | null }   // display P0, buttons P1
export interface ChatMessage { id: string; channel: ChatChannel; author: string; text: string; card: ApprovalCard | null; ts: string; inbound: boolean }
export interface CarrierInvoice { month: string; carrier: string; lines: { workerId: string; planId: string; amountCents: number }[]; totalCents: number }

export type SimEventType = "sim.registration_completed" | "sim.registration_needs_info" | "sim.bank_batch_settled" | "sim.bank_batch_returned" | "sim.device_delivered";
export type SimEvent = { type: SimEventType; subjectRef: string; payload: Record<string, string> };   // ids only

export interface AgencySim {
  register(req: { companyId: string; agency: AgencyCode; accountType: AccountType; credential: string }): Promise<{ applicationId: string; status: "awaiting_state" | "needs_info"; completeAt: string }>;
  fileResponse(req: { agency: AgencyCode; noticeId: string; body: string; credential: string }): Promise<{ confirmation: string }>;
  renderScenario(name: NoticeScenario): Promise<{ agency: AgencyCode; formCode: string; kind: NoticeKind; title: string; fileName: string; bodyText: string; extracted: NoticeExtract; respondBy: string }>;
  tick(now: string): Promise<SimEvent[]>;      // completes registrations
}
export interface BankSim { submitBatch(req: { payrollRunId: string; entries: { workerId: string; amountCents: number; accountRef: string }[]; credential: string; settleAt: string }): Promise<{ batchId: string; settleAt: string }>; tick(now: string): Promise<SimEvent[]> }
export interface IdpSim { createAccount(req: { workerId: string; system: ItSystem; handle: string; groups: string[]; credential: string }): Promise<{ ref: string; status: "active" | "provisioning" }>; suspend(ref: string): Promise<void>; list(workerId?: string): Promise<IdpAccount[]>; clearGroups(ref: string): Promise<{ removed: string[] }> }   // clearGroups: wave 2 (w2-offboarding)
export interface DeviceSim { catalog(): DeviceCatalogItem[]; order(req: { workerId: string; sku: string; shipTo: string }): Promise<{ orderRef: string; eta: string; priceCents: number }>; tick(now: string): Promise<SimEvent[]>; lock(req: { workerId: string; deviceId: string; reason: string }): Promise<{ lockRef: string; lockedAt: string }> }   // lock: wave 2 (w2-offboarding)
export interface ChatSim { post(msg: { channel: ChatChannel; author: string; text: string; card?: ApprovalCard }): Promise<{ id: string }>; list(channel: ChatChannel, afterId?: string): Promise<ChatMessage[]> }
export interface CarrierSim { invoice(month: string): Promise<CarrierInvoice> }   // P1
export interface FaultInjector { arm(f: { target: FaultTarget; kind: FaultKind; mode: FaultMode }): Promise<void>; disarm(target: FaultTarget): Promise<void>; check(target: FaultTarget): Promise<FaultDecision>; list(): Promise<ArmedFault[]> }
export interface Simulators {
  agency: AgencySim; bank: BankSim; idp: IdpSim; devices: DeviceSim; chat: ChatSim; carrier: CarrierSim; faults: FaultInjector;
  email: EmailSim; rail: PaymentRailSim; bankVerify: BankVerifySim;   // wave 2
  vendors: VendorConnectors;   // wave 3: simulated Greenhouse, Workday, Checkr, HireRight, DocuSign (real adapters overlay in apps/api compose)
  tick(now: string): Promise<SimEvent[]>;
}
